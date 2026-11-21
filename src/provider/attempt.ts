// Spawn/parse primitives for one agy attempt.
//
// This module owns the reusable, mostly-pure pieces extracted from
// AgyAdapter.streamAttempt:
//
//   - the argv/transport decision (buildAgyArgs / buildSpawnArgs),
//   - recording + parser + tool-watchdog state (createAttemptRecorder),
//   - the credential/concurrency slot handle (createAttemptSlot),
//   - the child spawn and first-event wiring (startAttemptProcess).
//
// The async outcome closure lives in ./attempt-outcome.ts (it also drives the
// credential-slot dispatch); the adapter calls runAgyAttempt from there.
import { LlmError, type Message } from '@deepseek-ai/dsh-llm'
import type { AgyEvent, AgyTransportMode, PluginConfig } from '../common/types.ts'
import type { AgyGenerateOptions } from '../common/protocol.ts'
import { createToolWatchdog, type ToolWatchdog } from './tool-watchdog.ts'
import { Err, looksLikeTosViolation } from '../common/types.ts'
import type { ManagedAccount, ModelFamily } from '../common/pool-types.ts'
import type { AccountPoolManager } from '../host/pool.ts'
import type { SessionBinding, SessionStore } from '../host/sessions.ts'
import { conversationsDirFor, diffConversations, snapshotConversations, type DirSnapshot } from '../host/discovery.ts'
import type { RunRecording, RunRegistry } from '../host/recording.ts'
import { StreamJsonParser } from '../host/parser.ts'
import type { RunningProcess } from '../host/runner.ts'
import {
  buildStreamInputLine,
  ensureIsolatedKeychain,
  shouldUsePromptStdin,
  startAgyProcess,
  stripNulBytes,
} from '../host/runner.ts'
import { agyHomeDirFor, snapshotAgyLogs, type AgyLogSnapshot } from '../host/agy-log.ts'
import { acquireCredentialSlot, armSlotHandoff, type SlotHandoff } from '../host/credential-slot.ts'
import { buildAgyEnv, pickProxy } from '../runtime/net/account-env.ts'
import type { SpawnLimiter } from './spawn-limiter.ts'
import { resolveModelSlug } from '../host/models.ts'
import type { RunTelemetry } from './finalize.ts'
import { SubagentTracker } from '../features/subagent/tracker.ts'
import {
  createLiveQuotaController,
  reportDirectToolQuota,
  type LiveQuotaFailoverState,
} from './quota-failover.ts'
import { AGY_PROMPT_SAFE_BYTES, trimToUtf8Bytes, utf8Bytes } from './prompt-text.ts'

export function brief(s: string): string {
  const flat = s.trim().replace(/\s+/g, ' ')
  return flat.length > 300 ? flat.slice(0, 300) + '...' : flat
}

/** What the attempt machinery needs from the adapter (nothing more). */
export interface AttemptDeps {
  /** Shared semaphore for cross-session concurrency (ADR-12). */
  acquire: (signal?: AbortSignal) => Promise<() => void>
  pool?: AccountPoolManager
  runs: RunRegistry
  store: SessionStore
  log?: (msg: string) => void
  /** Called with each run's parser so the host can keep the last stdout ring. */
  onParser?: (parser: StreamJsonParser) => void
  onRun?: (info: RunTelemetry) => void
  /** Adapter-private state, injected as callbacks. */
  clearInFlightPrompt: (sessionKey: string, prompt: string) => void
  registerActiveRun: (sessionKey: string, rec: RunRecording) => void
  unregisterActiveRun: (sessionKey: string, rec: RunRecording) => void
  isSuperseded: (sessionKey: string, rec: RunRecording) => boolean
  noteNetworkFailure: (sessionKey: string) => number
  clearNetworkStreak: (sessionKey: string) => void
  dropFailoverBudget: (sessionKey: string) => void
  clearRateLimitFailover: (sessionKey: string) => void
  sharesSingleEgress: () => boolean
  /** Per-account burst spacing throttle state (adapter-owned). */
  lastAccountSpawnTime: Map<string, number>
  minSpawnIntervalMs: number
  spawnLimiter?: SpawnLimiter
  /** Optional persistent ACP attempt driver injected by host. */
  runAcp?: (deps: AttemptDeps, input: AttemptInput, slot: AttemptSlot) => Promise<RunRecording | null>
}

/** Everything one attempt needs. Values are produced by streamAttempt. */
export interface AttemptInput {
  cfg: PluginConfig
  bin: string
  permissionMode: PluginConfig['permissionMode']
  sessionKey: string
  workspaceRoot: string
  isAux: boolean
  account: ManagedAccount | undefined
  /** Prompt BEFORE NUL sanitization (sanitized inside; used by argv/stdin). */
  prompt: string
  /** Resolved model slug (finalized telemetry / binding writes). */
  model: string
  activeModel: string
  effort: string | undefined
  addDirs: readonly string[]
  persistBinding: boolean
  binding: SessionBinding | undefined
  messages: readonly Message[]
  newlySentImageIds: readonly string[]
  sessionAccountKey: string
  family: ModelFamily
  signal: AbortSignal | undefined
  agyOnEvent: ((ev: AgyEvent) => void) | undefined
  agent?: string
  agySettings?: string
  jsonSchema?: string
  sandbox?: boolean
  transport?: AgyTransportMode
}

function serializeOpt(v: string | Record<string, unknown> | undefined): string | undefined {
  if (typeof v === 'string') return v.trim() !== '' ? v.trim() : undefined
  if (v && typeof v === 'object') return JSON.stringify(v)
  return undefined
}

export function resolveAttemptOverrides(options: AgyGenerateOptions, cfg: PluginConfig): Pick<AttemptInput, 'agent' | 'agySettings' | 'jsonSchema' | 'sandbox' | 'transport'> {
  const agent = typeof options.agyAgent === 'string' ? options.agyAgent.trim() : cfg.agent.trim()
  const agySettings = serializeOpt(options.agySettings) ?? serializeOpt(cfg.agySettings)
  const jsonSchema = serializeOpt(options.agyJsonSchema)
  const sandbox = options.agySandbox ?? cfg.sandbox
  const transport = options.agyTransport ?? cfg.transport
  return {
    ...(agent !== '' ? { agent } : {}),
    ...(agySettings !== undefined ? { agySettings } : {}),
    ...(jsonSchema !== undefined ? { jsonSchema } : {}),
    sandbox,
    transport,
  }
}

/** Pure argv builder for one agy call (same body as AgyAdapter.buildArgs). */
export function buildAgyArgs(opts: {
  prompt: string
  model: string
  effort?: string
  conversationId?: string
  permissionMode: PluginConfig['permissionMode']
  timeoutMs: number
  extraArgs: readonly string[]
  addDirs?: readonly string[]
  printTimeoutMinutes?: number
  /** Omit `-p <prompt>` and add `--input-format stream-json` (prompt rides stdin). */
  promptViaStdin?: boolean
  sandbox?: boolean
  agent?: string
  agySettings?: string
  jsonSchema?: string
}): string[] {
  const ptMins = opts.printTimeoutMinutes ?? Math.max(1, Math.ceil(opts.timeoutMs / 60_000))
  const args: string[] = ['--output-format', 'stream-json', '--print-timeout', ptMins + 'm']
  if (opts.permissionMode === 'skip') args.push('--dangerously-skip-permissions')
  else args.push('--mode', opts.permissionMode)
  if (opts.sandbox === true) args.push('--sandbox')
  if (opts.agent && opts.agent.trim() !== '') args.push('--agent', opts.agent.trim())
  if (opts.agySettings && opts.agySettings.trim() !== '') args.push('--settings', opts.agySettings.trim())
  if (opts.jsonSchema && opts.jsonSchema.trim() !== '') args.push('--json-schema', opts.jsonSchema.trim())
  const effectiveModel = resolveModelSlug(opts.model)
  if (effectiveModel !== '') args.push('--model', effectiveModel)
  // Claude 5.5 accepts --effort on its base slug (verified against agy 1.5.3);
  // a tiered slug plus the flag is rejected upstream, so callers must pass the
  // base slug here — the catalog folds the tiers for exactly that reason.
  const effortModel = effectiveModel.toLowerCase()
  // Claude 5.5 only: 4.6 keeps its documented no-effort behaviour.
  const isEffortCapable = effectiveModel === '' || effortModel.startsWith('gemini') || effortModel.startsWith('argon') || /^claude-(?:sonnet|opus)-5-5$/.test(effortModel)
  if (isEffortCapable && opts.effort && opts.effort !== '') args.push('--effort', opts.effort)
  if (opts.conversationId) args.push('--conversation', opts.conversationId)
  for (const d of opts.addDirs ?? []) args.push('--add-dir', d)
  args.push(...opts.extraArgs)
  if (opts.promptViaStdin) {
    args.push('--input-format', 'stream-json')
  } else {
    args.push('-p', opts.prompt)
  }
  return args
}

export interface SpawnPlan {
  /** NUL-sanitized prompt (what the child receives and what in-flight keys). */
  prompt: string
  args: string[]
  stdinPayload: string | undefined
}

/**
 * Sanitize the prompt, build the argv, and pick the transport. NULs are removed
 * before `spawn` can see them; an over-budget prompt is tail-trimmed below
 * agy's single-message ceiling (the live request sits at the head).
 */
export function buildSpawnArgs(
  input: AttemptInput,
  printTimeoutMinutes: number,
  log: ((msg: string) => void) | undefined,
): SpawnPlan {
  let prompt = stripNulBytes(input.prompt)
  if (utf8Bytes(prompt) > AGY_PROMPT_SAFE_BYTES) {
    log?.('prompt is ' + utf8Bytes(prompt) + ' B (> agy single-message budget) — trimming the tail')
    prompt = trimToUtf8Bytes(prompt, AGY_PROMPT_SAFE_BYTES)
  }
  const activeModelForArgs = input.activeModel === '' ? input.cfg.defaultModel : input.activeModel
  const conversationId = input.persistBinding && input.binding !== undefined ? input.binding.conversationId : undefined
  const base = {
    prompt,
    model: activeModelForArgs,
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(conversationId === undefined ? {} : { conversationId }),
    permissionMode: input.permissionMode,
    timeoutMs: input.cfg.timeoutMs,
    printTimeoutMinutes,
    extraArgs: input.cfg.extraArgs,
    addDirs: input.addDirs,
    sandbox: input.sandbox ?? input.cfg.sandbox,
    ...((input.agent ?? input.cfg.agent).trim() !== '' ? { agent: (input.agent ?? input.cfg.agent).trim() } : {}),
    ...((input.agySettings ?? input.cfg.agySettings).trim() !== '' ? { agySettings: (input.agySettings ?? input.cfg.agySettings).trim() } : {}),
    ...(input.jsonSchema && input.jsonSchema.trim() !== '' ? { jsonSchema: input.jsonSchema.trim() } : {}),
  }
  const argsBase = buildAgyArgs(base)
  // Decide transport: keep `-p <prompt>` for normal turns; switch to stdin
  // stream-json when the argv would approach the CreateProcess limit.
  const promptViaStdin = shouldUsePromptStdin(argsBase)
  const args = promptViaStdin ? buildAgyArgs({ ...base, promptViaStdin: true }) : argsBase
  const stdinPayload = promptViaStdin ? buildStreamInputLine(prompt) : undefined
  return { prompt, args, stdinPayload }
}

export interface AttemptRecorder {
  rec: RunRecording
  parser: StreamJsonParser
  conversationsDir: string
  before: DirSnapshot
  streamCid: string | null
  printTimeoutMinutes: number
  attachProcess: (proc: RunningProcess) => void
  feedLine: (line: string, onEvent: ((ev: AgyEvent) => void) | undefined, onFirstEvent: (() => void) | undefined) => void
  drain: (onEvent: ((ev: AgyEvent) => void) | undefined) => void
  flushTracker: () => void
  stop: () => void
  quotaFailover: () => LiveQuotaFailoverState | null
  cooledInLiveFamilies: () => ReadonlySet<ModelFamily>
  conversationId: () => string | null
}

/** Create the recording, parser, HOME snapshot and tool watchdog for one run. */
export function createAttemptRecorder(
  deps: AttemptDeps,
  cfg: PluginConfig,
  account: ManagedAccount | undefined,
  initialConversationId?: string,
  trackSubagents = true,
  quotaCtx?: { family: ModelFamily; activeModel: string },
): AttemptRecorder {
  const rec = deps.runs.create()
  rec.accountHome = account && account.dir ? account.dir : undefined
  const conversationsDir = conversationsDirFor(rec.accountHome)
  const before = snapshotConversations(conversationsDir)
  const parser = new StreamJsonParser()
  deps.onParser?.(parser)
  const watchdog = createToolWatchdog(deps.log, cfg)
  let attachedProc: RunningProcess | null = null
  let pendingQuotaKill = false
  const quotaCtrl = quotaCtx
    ? createLiveQuotaController({
        pool: deps.pool,
        account,
        inputFamily: quotaCtx.family,
        activeModel: quotaCtx.activeModel,
        emitNotice: (stepKey, text) => rec.append({ kind: 'step', stepKey, stepKind: 'subagent', text, raw: {} }),
        onTriggerKill: () => {
          if (attachedProc) attachedProc.kill('quota')
          else pendingQuotaKill = true
        },
      })
    : null
  const tracker = trackSubagents
    ? new SubagentTracker({
        conversationId: initialConversationId,
        resumed: Boolean(initialConversationId),
        accountHome: rec.accountHome,
        log: deps.log,
        onEvent: (ev) => rec.append(ev),
        ...(quotaCtrl ? { onQuotaExhausted: (info) => quotaCtrl.handleQuotaExhausted(info) } : {}),
        noteActivity: () => watchdog.markEvent(),
      })
    : undefined
  const state: AttemptRecorder = {
    rec,
    parser,
    conversationsDir,
    before,
    streamCid: initialConversationId ?? null,
    printTimeoutMinutes: watchdog.printTimeoutMinutes,
    attachProcess: (proc) => {
      attachedProc = proc
      watchdog.attach(proc)
      tracker?.start()
      if (pendingQuotaKill) proc.kill('quota')
      void proc.outcome.finally(() => tracker?.stop())
    },
    feedLine: (line, onEvent, onFirstEvent) => {
      watchdog.markEvent()
      // First output = agy resolved its credential; give the machine-wide slot
      // back so other accounts' sessions can run concurrently.
      onFirstEvent?.()
      for (const ev of parser.feed(line + '\n')) {
        if (ev.kind === 'init' && ev.conversationId) {
          state.streamCid = ev.conversationId
          tracker?.setConversationId(ev.conversationId)
        }
        if (ev.kind === 'result' && ev.conversationId !== '') {
          state.streamCid = ev.conversationId
          tracker?.setConversationId(ev.conversationId)
        }
        watchdog.trackStep(ev)
        rec.append(ev)
        reportDirectToolQuota(quotaCtrl, ev)
        if (typeof onEvent === 'function') {
          try {
            onEvent(ev)
          } catch {
            // contained: a listener must never break the stream
          }
        }
      }
    },
    drain: (onEvent) => {
      for (const ev of parser.flush()) {
        if (ev.kind === 'result' && ev.conversationId !== '') {
          state.streamCid = ev.conversationId
          tracker?.setConversationId(ev.conversationId)
        }
        rec.append(ev)
        if (typeof onEvent === 'function') {
          try {
            onEvent(ev)
          } catch {
            // contained
          }
        }
      }
    },
    flushTracker: () => {
      tracker?.flush()
    },
    stop: () => {
      watchdog.stop()
      tracker?.stop()
    },
    quotaFailover: () => quotaCtrl?.failoverState() ?? null,
    cooledInLiveFamilies: () => quotaCtrl?.cooledFamilies() ?? new Set<ModelFamily>(),
    conversationId: () => state.streamCid ?? diffConversations(before, conversationsDir).conversationId,
  }
  return state
}

export interface AttemptSlot {
  /** Release the concurrency slot + credential lease exactly once. */
  releaseOnce: () => void
  /** Arm the narrow credential hand-off (no-op without a lease). */
  armHandoff: () => SlotHandoff | null
}

export function createAttemptSlot(
  concurrencyRelease: (() => void) | null,
  credentialLease: Awaited<ReturnType<typeof acquireCredentialSlot>>,
  log: ((msg: string) => void) | undefined,
): AttemptSlot {
  let release = concurrencyRelease
  let released = false
  let handoff: SlotHandoff | null = null
  const releaseOnce = (): void => {
    if (released) return
    released = true
    if (handoff !== null) {
      handoff.dispose()
    } else {
      try {
        credentialLease?.release()
      } catch {
        // best-effort
      }
    }
    release?.()
    release = null
  }
  return {
    releaseOnce,
    armHandoff: () => {
      if (credentialLease === undefined) return null
      handoff = armSlotHandoff({
        release: () => {
          try {
            credentialLease?.release()
          } catch {
            // best-effort
          }
        },
        log,
      })
      return handoff
    },
  }
}

/** Abort-aware sleep: rejects with the same error text the call sites used. */
export function abortableDelay(ms: number, signal: AbortSignal | undefined, abortedMessage: string): Promise<void> {
  if (signal?.aborted) return Promise.reject(new LlmError(abortedMessage, Err.AGY_ERROR))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new LlmError(abortedMessage, Err.AGY_ERROR))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Bounded wait for an aborted run to settle, so a steer replacement never
 * overlaps the process it just killed on the same agy conversation.
 * Returns whether the run actually settled before the deadline.
 */
export async function waitForRunSettle(run: { isSettled: boolean }, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (run.isSettled) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return run.isSettled
}

function persistBindingOnResult(
  deps: AttemptDeps,
  input: AttemptInput,
  recorder: AttemptRecorder,
  ev: AgyEvent,
): void {
  if (
    ev.kind !== 'result' ||
    !ev.ok ||
    looksLikeTosViolation(ev.response) ||
    !input.persistBinding ||
    input.sessionAccountKey === '' ||
    deps.isSuperseded(input.sessionKey, recorder.rec)
  ) {
    return
  }
  const finalId = input.binding !== undefined ? input.binding.conversationId : (ev.conversationId || recorder.streamCid)
  if (!finalId) return
  const mergedImages =
    input.binding?.sentImageIds || input.newlySentImageIds.length > 0
      ? [...new Set([...(input.binding?.sentImageIds ?? []), ...input.newlySentImageIds])]
      : undefined
  deps.store.set(input.sessionAccountKey, {
    conversationId: finalId,
    lastMessageCount: input.messages.length,
    updatedAt: Date.now(),
    model: input.activeModel,
    ...(mergedImages && mergedImages.length > 0 ? { sentImageIds: mergedImages } : {}),
  })
}

export interface SpawnedAttempt {
  proc: RunningProcess
  runLogHome: string
  runLogsBefore: AgyLogSnapshot
}

/**
 * Spawn the child under the held slot. Installs the line callback (parser feed
 * + tool watchdog + first-event hand-off), registers the run for steer
 * preemption, and owns the "give the slot back" path for spawn failures.
 */
export async function startAttemptProcess(
  deps: AttemptDeps,
  input: AttemptInput,
  spawn: SpawnPlan,
  recorder: AttemptRecorder,
  slot: AttemptSlot,
): Promise<SpawnedAttempt> {
  const { cfg, account, sessionKey, workspaceRoot } = input
  const signal = input.signal
  // The acquire→spawn window can be arbitrarily long (all slots busy on long
  // tool runs). Re-check the signal here: addEventListener on an already-aborted
  // signal never fires, so the spawn below would run a full turn for a request
  // nobody is reading any more.
  if (signal?.aborted) {
    slot.releaseOnce()
    throw new LlmError('request aborted before the agy process was spawned', Err.AGY_ERROR)
  }
  // Only SECONDARY pool accounts get an isolated HOME. The primary account
  // rides the real system HOME (agy 1.1.15 keeps credentials in the macOS
  // Keychain); injecting HOME there signs agy out.
  if (account && account.dir) ensureIsolatedKeychain(account.dir)
  // Snapshot agy's per-run log set BEFORE spawning so evidence found after the
  // run can be attributed to THIS run (each invocation writes a fresh
  // cli-*.log). Only this log separates a genuine sign-out from a keyring
  // validation that died on the network.
  const runLogHome = agyHomeDirFor(account)
  const runLogsBefore = snapshotAgyLogs(runLogHome)
  // One shared precedence + env assembly (runtime/net/account-env.ts). The MCP
  // session id rides along so the bridge can resolve the calling agent
  // (issue #55); telemetry flags keep their historical behaviour here.
  const env = buildAgyEnv({
    ...(account === undefined ? {} : { account }),
    cfg,
    ...(sessionKey === '' ? {} : { sessionId: sessionKey }),
    telemetryFlags: cfg.disableTelemetry,
  })

  let proc: RunningProcess
  let spawned = false
  try {
    // Per-account burst spacing throttle with randomized jitter (prevents
    // high-frequency flood to Google endpoints). Suspension point INSIDE the
    // slot-owning window: a generator abandoned here must still give the slot
    // back — the finally below owns that.
    // TAT per-account + shared-egress burst spacing throttle (reserves slot
    // synchronously BEFORE await so parallel sessions never wake together).
    if (account) {
      const egressKey = pickProxy(account.proxyUrl, cfg.proxyUrl) || '__direct__'
      const delayMs = deps.spawnLimiter
        ? deps.spawnLimiter.reserveSpawnDelay(account.id, egressKey, deps.minSpawnIntervalMs)
        : Math.max(0, deps.minSpawnIntervalMs + Math.floor(Math.random() * 300) - (Date.now() - (deps.lastAccountSpawnTime.get(account.id) ?? 0)))
      if (delayMs > 0) {
        await abortableDelay(delayMs, signal, 'request aborted before the agy process was spawned')
      }
      deps.lastAccountSpawnTime.set(account.id, Date.now())
    }
    // Arm the narrow hand-off BEFORE the spawn: stdout can deliver the first
    // line before startAgyProcess() even returns, and that first line is the
    // proof that agy is past its credential read.
    const slotHandoff = slot.armHandoff()
    proc = startAgyProcess({
      bin: input.bin,
      args: spawn.args,
      cwd: workspaceRoot,
      timeoutMs: cfg.timeoutMs,
      // Wall-clock cap for the whole turn (issue #92): the idle watchdog is
      // re-armed by every output line, so a self-driving loop that keeps
      // printing never trips it. 0 disables (behaviour unchanged).
      maxTurnMs: cfg.maxTurnMinutes > 0 ? cfg.maxTurnMinutes * 60_000 : undefined,
      // A turn that legitimately waits on background work (a build, an
      // integration test, a Docker job it launched) prints `root agent idle;
      // waiting for N background task(s)`; the reaper must not treat that as an
      // orphan after 5 s (issue #144). 0 disables the reaper.
      idleGraceMs: cfg.idleGraceMinutes > 0 ? Math.round(cfg.idleGraceMinutes * 60_000) : 0,
      signal,
      env,
      stdinPayload: spawn.stdinPayload,
      preemptAutoUpdate: cfg.suppressAgyAutoUpdate,
      // stderr is liveness too: agy prints progress/diagnostics there while a
      // long step is running, and a run that only talks on stderr used to be
      // "idle" as far as the watchdog was concerned.
      stderrKeepalive: true,
      onLine: (line) => recorder.feedLine(
        line,
        (ev) => { persistBindingOnResult(deps, input, recorder, ev); input.agyOnEvent?.(ev) },
        () => slotHandoff?.onFirstEvent(),
      ),
    })
    spawned = true
    recorder.attachProcess(proc)
    if (!input.isAux && sessionKey !== '') {
      recorder.rec.requestAbort = () => proc.kill('abort')
      deps.registerActiveRun(sessionKey, recorder.rec)
    }
    // The abort listener in the runner never fires on an ALREADY-aborted
    // signal: an abort that arrived while this call queued on the semaphore
    // (or during the throttle sleep above) would otherwise run a full turn
    // nobody is reading. Kill immediately so the outcome closure settles this
    // run as ABORTED and returns the slot.
    if (signal?.aborted) proc.kill('abort')
  } catch (e) {
    slot.releaseOnce()
    deps.clearInFlightPrompt(sessionKey, spawn.prompt)
    throw new LlmError('failed to spawn agy: ' + brief(String(e)), Err.PROCESS_EXIT)
  } finally {
    // Generator abandoned while suspended inside the try (throttle sleep):
    // the async outcome closure below was never created, so nothing else would
    // ever return the concurrency slot. releaseOnce() no-ops when the catch
    // already released.
    if (!spawned) {
      slot.releaseOnce()
      deps.clearInFlightPrompt(sessionKey, spawn.prompt)
    }
  }
  return { proc, runLogHome, runLogsBefore }
}