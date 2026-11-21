// Persistent warm agy translation worker pool for POSIX hosts.
// Eliminates the ~8-9s cold CLI/language-server startup + ~3s exit wait on
// subsequent translations by keeping at most one stream-json agy child alive
// (idle TTL + turn/char recycle) without `--add-dir` workspace crawling or
// SQLite/subagent overhead. Windows falls back to ctx.llm.stream to preserve
// serialized OS Credential Manager slot locking.
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import type { Writable, Readable } from 'node:stream'
import { modelFamilyOf, type ManagedAccount, type ModelFamily } from '../../common/pool-types.ts'
import {
  Err,
  isTransientBurstRateLimit,
  looksLikeAuthFailure,
  looksLikeAuthVerificationJitter,
  looksLikeEligibilityFailure,
  looksLikeHardRateLimit,
  looksLikeNetworkError,
  looksLikeRateLimit,
  looksLikeTosViolation,
  looksLikeValidationRequired,
  parseResetDurationMs,
  shouldMarkAuthRequired,
  type AgyEvent,
  type PluginConfig,
} from '../../common/types.ts'
import { resolveModelSlug } from '../../domain/models/parse.ts'
import { preemptAgyAutoUpdate } from '../../host/auto-updater.ts'
import { StreamJsonParser } from '../../host/parser.ts'
import type { AccountPoolManager } from '../../host/pool.ts'
import { parseEffortUnsupported, parseModelNotRecognized } from '../../provider/effort-policy.ts'
import { withAgyQuietEnv } from '../../runtime/agy/env.ts'
import { ensureIsolatedKeychain } from '../../runtime/agy/keychain.ts'
import { buildStreamInputLine, stripNulBytes } from '../../runtime/agy/process.ts'
import { buildAgyEnv } from '../../runtime/net/account-env.ts'
import type { TranslationRunnerRequest, TranslationRunnerResult } from './types.ts'

export const DEFAULT_IDLE_TTL_MS = 5 * 60_000
export const DEFAULT_MAX_TURNS = 8
export const DEFAULT_MAX_PROMPT_CHARS = 32_000
const STDERR_TAIL_CAP = 2048
const PRINT_TIMEOUT_ARG = '30m'

export interface WorkerProcessLike {
  readonly pid?: number
  stdin: Writable | null
  stdout: Readable | null
  stderr: Readable | null
  on(event: 'close', listener: (code: number | null) => void): this
  on(event: 'error', listener: (err: Error) => void): this
  kill(signal?: NodeJS.Signals | number): boolean
}

export type WorkerSpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    stdio: ['pipe', 'pipe', 'pipe']
    detached?: boolean
    windowsHide?: boolean
  },
) => WorkerProcessLike

export interface TranslationWorkerDeps {
  cfg: () => PluginConfig
  bin: () => string | null
  pool?: AccountPoolManager
  log: (msg: string) => void
  isEffortUnsupported?: (model: string) => boolean
  rememberEffortUnsupported?: (model: string, errText: string) => void
  spawn?: WorkerSpawnFn
  platform?: NodeJS.Platform
  idleTtlMs?: number
  maxTurns?: number
  maxPromptChars?: number
  now?: () => number
}

type TurnOutcome =
  | { kind: 'result'; ok: boolean; response: string; error?: string }
  | { kind: 'timeout'; error: string }
  | { kind: 'aborted'; error: string }
  | { kind: 'exit'; code: number | null; error?: string }

interface TurnWaiter {
  deltaText: string
  fullStepText: string
  resolve: (outcome: TurnOutcome) => void
}

interface ActiveWorker {
  key: string
  account: ManagedAccount | undefined
  model: string
  effort: string
  child: WorkerProcessLike
  parser: StreamJsonParser
  stderrTail: string
  turns: number
  promptChars: number
  lastUsedAt: number
  idleTimer: ReturnType<typeof setTimeout> | null
  closed: boolean
  activeTurn: TurnWaiter | null
}

function appendTail(prev: string, chunk: string): string {
  const next = prev + chunk
  return next.length > STDERR_TAIL_CAP ? next.slice(-STDERR_TAIL_CAP) : next
}

function killWorkerProcess(worker: ActiveWorker, platform: NodeJS.Platform): void {
  if (worker.idleTimer !== null) {
    clearTimeout(worker.idleTimer)
    worker.idleTimer = null
  }
  worker.closed = true
  const child = worker.child
  try {
    child.stdin?.end()
  } catch {
    // best-effort stdin close
  }
  if (platform !== 'win32' && typeof child.pid === 'number' && child.pid > 0) {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      // fall back to direct child kill
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // already exited
  }
}

function resetParserTurnStats(worker: ActiveWorker): void {
  worker.stderrTail = ''
  worker.parser.stats.lastResultError = undefined
  worker.parser.stats.sawAuthFailure = false
  worker.parser.stats.authFailureText = undefined
}

function attachWorkerStreams(
  worker: ActiveWorker,
  onClose: (w: ActiveWorker) => void,
): void {
  const dispatchEvents = (events: AgyEvent[]): void => {
    const waiter = worker.activeTurn
    if (!waiter) return
    for (const ev of events) {
      if (ev.kind === 'step' && ev.stepKind === 'text') {
        if (ev.fragment) waiter.deltaText += ev.text
        else if (ev.text !== '') waiter.fullStepText = ev.text
      } else if (ev.kind === 'result') {
        worker.activeTurn = null
        const text = (ev.response || waiter.deltaText || waiter.fullStepText).trim()
        waiter.resolve({
          kind: 'result',
          ok: ev.ok,
          response: text,
          ...(ev.error === undefined ? {} : { error: ev.error }),
        })
        return
      }
    }
  }
  worker.child.stdin?.on('error', () => undefined)
  worker.child.stdout?.on('data', (buf: Buffer | string) => {
    const chunk = typeof buf === 'string' ? buf : buf.toString('utf8')
    dispatchEvents(worker.parser.feed(chunk))
  })
  worker.child.stderr?.on('data', (buf: Buffer | string) => {
    const chunk = typeof buf === 'string' ? buf : buf.toString('utf8')
    worker.stderrTail = appendTail(worker.stderrTail, chunk)
  })
  worker.child.on('error', (err: Error) => {
    worker.closed = true
    onClose(worker)
    const waiter = worker.activeTurn
    if (waiter) {
      worker.activeTurn = null
      waiter.resolve({ kind: 'exit', code: null, error: err.message })
    }
  })
  worker.child.on('close', (code: number | null) => {
    worker.closed = true
    dispatchEvents(worker.parser.flush())
    onClose(worker)
    const waiter = worker.activeTurn
    if (waiter) {
      worker.activeTurn = null
      waiter.resolve({ kind: 'exit', code })
    }
  })
}

function awaitWorkerTurn(
  worker: ActiveWorker,
  prompt: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onKill: () => void,
): Promise<TurnOutcome> {
  resetParserTurnStats(worker)
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (outcome: TurnOutcome): void => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      worker.activeTurn = null
      resolve(outcome)
    }
    const onAbort = (): void => {
      onKill()
      finish({ kind: 'aborted', error: 'aborted by caller' })
    }
    worker.activeTurn = { deltaText: '', fullStepText: '', resolve: finish }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      onKill()
      finish({ kind: 'timeout', error: 'translation timed out after ' + timeoutMs + 'ms' })
    }, Math.max(1_000, timeoutMs))
    timer.unref?.()
    try {
      const line = buildStreamInputLine(prompt)
      if (!worker.child.stdin) throw new Error('translation worker stdin unavailable')
      worker.child.stdin.write(line, 'utf8')
    } catch (err) {
      onKill()
      finish({ kind: 'exit', code: null, error: err instanceof Error ? err.message : String(err) })
    }
  })
}

function waitForQueueOrAbort(
  queue: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (!signal) return queue.then(() => false)
  if (signal.aborted) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onAbort = (): void => resolve(true)
    signal.addEventListener('abort', onAbort, { once: true })
    void queue.then(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(signal.aborted)
    })
  })
}

export class TranslationWorkerPool {
  private worker: ActiveWorker | null = null
  private queue: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(private readonly deps: TranslationWorkerDeps) {}

  private platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /**
   * Attempt a fast translation via a persistent warm `agy` stream-json worker.
   * Returns `null` when unavailable (Windows, missing binary, or inside
   * default test harness without an injected `spawn`) so callers fall back cleanly.
   */
  async tryTranslate(req: TranslationRunnerRequest): Promise<TranslationRunnerResult | null> {
    if (this.disposed || this.platform() === 'win32') return null
    if (this.deps.spawn === undefined && process.env.NODE_TEST_CONTEXT !== undefined) return null
    if (!this.deps.bin()) return null

    const startedAt = this.now()
    let releaseQueue!: () => void
    const prevQueue = this.queue
    const gate = new Promise<void>((r) => {
      releaseQueue = r
    })
    this.queue = prevQueue.then(() => gate, () => gate)

    const abortedWhileWaiting = await waitForQueueOrAbort(prevQueue, req.signal)
    if (abortedWhileWaiting || this.disposed) {
      releaseQueue()
      return this.disposed
        ? null
        : { ok: false, text: '', code: 'ABORTED', error: 'aborted by caller', durationMs: this.now() - startedAt }
    }
    try {
      return await this.execute(req, startedAt)
    } finally {
      releaseQueue()
    }
  }

  dispose(): void {
    this.disposed = true
    this.dropWorker(this.worker)
  }

  private dropWorker(target: ActiveWorker | null): void {
    if (!target) return
    if (this.worker === target) this.worker = null
    killWorkerProcess(target, this.platform())
  }

  private armIdleTimer(target: ActiveWorker): void {
    if (target.idleTimer !== null) clearTimeout(target.idleTimer)
    const ttl = this.deps.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
    target.idleTimer = setTimeout(() => {
      if (this.worker === target && !target.activeTurn) {
        this.dropWorker(target)
      }
    }, ttl)
    target.idleTimer.unref?.()
  }

  private ensureWorker(
    bin: string,
    cfg: PluginConfig,
    account: ManagedAccount | undefined,
    model: string,
    effort: string,
    promptLen: number,
  ): ActiveWorker {
    const key = `${account?.id ?? 'default'}|${model}|${effort}`
    const maxTurns = this.deps.maxTurns ?? DEFAULT_MAX_TURNS
    const maxChars = this.deps.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS
    const idleTtlMs = this.deps.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
    const cur = this.worker
    if (cur && !cur.closed) {
      const expired = this.now() - cur.lastUsedAt > idleTtlMs
      const exhausted = cur.turns >= maxTurns || cur.promptChars + promptLen > maxChars
      if (cur.key === key && !expired && !exhausted) {
        if (cur.idleTimer !== null) {
          clearTimeout(cur.idleTimer)
          cur.idleTimer = null
        }
        return cur
      }
      this.dropWorker(cur)
    }
    if (account?.dir && !account.systemHome) {
      try {
        ensureIsolatedKeychain(account.dir)
      } catch {
        // best-effort isolated keychain check
      }
    }
    const env = withAgyQuietEnv(buildAgyEnv({ account, cfg, telemetryFlags: false }))
    if (cfg.suppressAgyAutoUpdate !== false) preemptAgyAutoUpdate(env, this.now())
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--mode', 'plan',
      '--model', model,
      '--print-timeout', PRINT_TIMEOUT_ARG,
    ]
    if (effort !== '') args.push('--effort', effort)
    const spawnFn: WorkerSpawnFn = this.deps.spawn ?? ((cmd, a, opts) => spawn(cmd, a, opts) as ChildProcess)
    const child = spawnFn(bin, args, {
      cwd: tmpdir(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: this.platform() !== 'win32',
      windowsHide: true,
    })
    const created: ActiveWorker = {
      key,
      account,
      model,
      effort,
      child,
      parser: new StreamJsonParser(),
      stderrTail: '',
      turns: 0,
      promptChars: 0,
      lastUsedAt: this.now(),
      idleTimer: null,
      closed: false,
      activeTurn: null,
    }
    attachWorkerStreams(created, (w) => {
      if (this.worker === w) this.worker = null
    })
    this.worker = created
    return created
  }

  private async execute(req: TranslationRunnerRequest, startedAt: number): Promise<TranslationRunnerResult | null> {
    if (req.signal?.aborted) {
      return { ok: false, text: '', code: 'ABORTED', error: 'aborted by caller', durationMs: this.now() - startedAt }
    }
    const bin = this.deps.bin()
    if (!bin) return null
    const cfg = this.deps.cfg()
    const resolvedModel = resolveModelSlug(req.model)
    const family: ModelFamily = modelFamilyOf(resolvedModel)
    const pool = this.deps.pool
    let account: ManagedAccount | undefined
    if (pool) {
      const selected = pool.selectAccount(family, resolvedModel)
      if (!selected) {
        if (pool.getAccounts().length > 0) {
          return { ok: false, text: '', code: Err.QUOTA, error: 'no eligible Antigravity account available', durationMs: this.now() - startedAt }
        }
      } else {
        account = selected
      }
    }
    const prompt = stripNulBytes(req.prompt)
    for (let effortAttempt = 0; effortAttempt < 2; effortAttempt++) {
      const wantedEffort = effortAttempt === 0 ? (req.effort ?? '').trim() : ''
      const effort = wantedEffort !== '' && !this.deps.isEffortUnsupported?.(resolvedModel) ? wantedEffort : ''
      const active = this.ensureWorker(bin, cfg, account, resolvedModel, effort, prompt.length)
      const outcome = await awaitWorkerTurn(active, prompt, req.timeoutMs, req.signal, () => this.dropWorker(active))
      const res = this.handleOutcome(active, outcome, prompt.length, family, resolvedModel, account, effort, effortAttempt === 0, startedAt)
      if (res === 'retry-without-effort') continue
      return res
    }
    return { ok: false, text: '', code: Err.AGY_ERROR, error: 'translation failed after effort retry', durationMs: this.now() - startedAt }
  }

  private handleOutcome(
    active: ActiveWorker,
    outcome: TurnOutcome,
    promptLen: number,
    family: ModelFamily,
    resolvedModel: string,
    account: ManagedAccount | undefined,
    effort: string,
    canRetryEffort: boolean,
    startedAt: number,
  ): TranslationRunnerResult | 'retry-without-effort' {
    const durationMs = this.now() - startedAt
    const pool = this.deps.pool
    const sawAuthFailure = active.parser.stats.sawAuthFailure
    if (outcome.kind === 'result' && outcome.ok) {
      if (looksLikeTosViolation(outcome.response)) {
        this.dropWorker(active)
        return this.mapFailure(outcome.response, pool, account, family, resolvedModel, true, durationMs, sawAuthFailure)
      }
      if (outcome.response === '') {
        this.finishHealthyTurn(active, promptLen)
        this.deps.log(`translation worker produced empty response: model=${resolvedModel} durationMs=${durationMs}`)
        return {
          ok: false,
          text: '',
          code: Err.EMPTY_RESPONSE,
          error: 'the translate model returned no text',
          ...(account ? { accountId: account.id } : {}),
          durationMs,
        }
      }
      if (account) pool?.recordSuccess(account.id, family)
      this.finishHealthyTurn(active, promptLen)
      return {
        ok: true,
        text: outcome.response,
        ...(account ? { accountId: account.id } : {}),
        durationMs,
      }
    }

    const errText = [
      ...(outcome.kind === 'result' ? [outcome.error, outcome.response] : [outcome.error]),
      active.parser.stats.lastResultError,
      active.parser.stats.authFailureText,
      active.stderrTail,
    ].filter((s): s is string => typeof s === 'string' && s.trim() !== '').join('\n')

    const refusedModel = parseEffortUnsupported(errText)
    if (canRetryEffort && effort !== '' && (refusedModel !== null || (/--effort/i.test(errText) && /not supported|unsupported/i.test(errText)))) {
      this.deps.rememberEffortUnsupported?.(refusedModel ?? resolvedModel, errText)
      this.dropWorker(active)
      return 'retry-without-effort'
    }

    this.dropWorker(active)
    if (outcome.kind === 'aborted') {
      return { ok: false, text: '', code: 'ABORTED', error: outcome.error, durationMs }
    }
    if (outcome.kind === 'timeout') {
      return { ok: false, text: '', code: Err.TIMEOUT, error: outcome.error, durationMs }
    }
    return this.mapFailure(errText, pool, account, family, resolvedModel, outcome.kind === 'result', durationMs, sawAuthFailure)
  }

  private finishHealthyTurn(active: ActiveWorker, promptLen: number): void {
    active.turns += 1
    active.promptChars += promptLen
    active.lastUsedAt = this.now()
    const maxTurns = this.deps.maxTurns ?? DEFAULT_MAX_TURNS
    const maxChars = this.deps.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS
    if (active.turns >= maxTurns || active.promptChars >= maxChars) {
      this.dropWorker(active)
    } else if (!active.closed) {
      this.armIdleTimer(active)
    }
  }

  private mapFailure(
    errText: string,
    pool: AccountPoolManager | undefined,
    account: ManagedAccount | undefined,
    family: ModelFamily,
    resolvedModel: string,
    wasResultEnvelope: boolean,
    durationMs: number,
    sawAuthFailure: boolean,
  ): TranslationRunnerResult {
    const accountPatch = account ? { accountId: account.id } : {}
    if (looksLikeTosViolation(errText)) {
      if (account) pool?.markAuthRequired(account.id, errText)
      return { ok: false, text: '', code: Err.AGY_ERROR, error: errText, ...accountPatch, durationMs }
    }
    if (looksLikeValidationRequired(errText)) {
      return { ok: false, text: '', code: Err.AGY_ERROR, error: errText, ...accountPatch, durationMs }
    }
    if (looksLikeHardRateLimit(errText) && !isTransientBurstRateLimit(errText)) {
      if (account && pool) {
        const resetMs = parseResetDurationMs(errText)
        const resetIso = resetMs ? new Date(this.now() + resetMs).toISOString() : undefined
        pool.recordFailure(account.id, family, errText, resetIso)
        if (pool.getActiveAccountId(family) === account.id) {
          pool.advanceAccount(account.id, family, resolvedModel)
        }
      }
      return { ok: false, text: '', code: Err.RATE_LIMIT, error: errText, ...accountPatch, durationMs }
    }
    if (looksLikeRateLimit(errText)) {
      return { ok: false, text: '', code: Err.OVERLOADED, error: errText, ...accountPatch, durationMs }
    }
    if (looksLikeNetworkError(errText) || looksLikeAuthVerificationJitter(errText)) {
      return { ok: false, text: '', code: Err.NETWORK, error: errText, ...accountPatch, durationMs }
    }
    const unrecog = parseModelNotRecognized(errText)
    if (unrecog || looksLikeEligibilityFailure(errText)) {
      if (account && pool) {
        if (unrecog && typeof (pool as unknown as { markModelUnsupported?: (id: string, m: string) => void }).markModelUnsupported === 'function') {
          ;(pool as unknown as { markModelUnsupported: (id: string, m: string) => void }).markModelUnsupported(account.id, unrecog)
        }
        pool.advanceAccount(account.id, family, resolvedModel)
      }
      return { ok: false, text: '', code: Err.ELIGIBILITY, error: errText, ...accountPatch, durationMs }
    }
    if (sawAuthFailure || looksLikeAuthFailure(errText)) {
      if (account && pool && shouldMarkAuthRequired(Err.AUTH, errText)) {
        pool.noteAuthFailure(account.id, errText)
        if (pool.getActiveAccountId(family) === account.id) {
          pool.advanceAccount(account.id, family, resolvedModel)
        }
      }
      return { ok: false, text: '', code: Err.AUTH, error: errText, ...accountPatch, durationMs }
    }
    return {
      ok: false,
      text: '',
      code: wasResultEnvelope ? Err.AGY_ERROR : Err.PROCESS_EXIT,
      error: errText || 'translation worker failed',
      ...accountPatch,
      durationMs,
    }
  }
}
