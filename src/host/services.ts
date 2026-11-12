// Shared host services for dsh-agy-link.
//
// Everything apply() used to build inline — config/log/bin/version, the account
// store, pool, quota, warmup, model catalog, adapter, translation, override
// writer and the mutable boot status — is constructed here and returned as one
// plain object. The HTTP route modules in src/transport/http/routes/* and
// registerRoutes() consume that object, so index.ts stays a composition root.
// Deliberately a factory returning a plain object, not a DI container.
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { dshHome, overridesPath, readOverrides, resolveConfig, stateDir } from '../common/config.ts'
import { Err, PROVIDER_ID, type PluginConfig } from '../common/types.ts'
import type { ManagedAccount } from '../common/pool-types.ts'
import { AgyAdapter } from './adapter.ts'
import { AuthHelper } from './auth.ts'
import { TranslationService, TRANSLATION_RECORD_TYPE, type TranslationRecord } from './translate.ts'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ModelCatalog } from './models.ts'
import { RunRegistry } from './recording.ts'
import { resolveAgyBin, probeProcess } from './runner.ts'
import { SessionStore } from './sessions.ts'
import { AccountPoolManager } from './pool.ts'
import { PoolAuthFlow } from './pool-auth.ts'
import { QuotaService } from './quota.ts'
import { WarmupService } from './warmup.ts'
import { detectSystemProxy } from './wincred.ts'
import { buildAgyEnv } from '../runtime/net/account-env.ts'
import { StreamJsonParser } from './parser.ts'
import { defaultMediaDir, type ImageRefLike } from './media.ts'
import type { McpBridge } from './mcp-bridge.ts'
import { readAccountCredential } from './credential-backup.ts'

/** Cross-session concurrency limiter (ADR-12). max() <= 0 means unlimited. */
class Semaphore {
  private active = 0
  private queue: Array<() => void> = []
  constructor(private readonly max: () => number) {}
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error('aborted before semaphore acquisition')
    const limit = this.max()
    if (limit <= 0) {
      // Unlimited: native agy concurrency — Google rate limits and the
      // account pool's cooldowns are the natural regulators.
      this.active++
      return () => this.releaseOne()
    }
    if (this.active < limit) {
      this.active++
      return () => this.releaseOne()
    }
    return new Promise((resolve, reject) => {
      let entry: () => void
      const onAbort = () => {
        const idx = this.queue.indexOf(entry)
        if (idx >= 0) this.queue.splice(idx, 1)
        reject(new Error('aborted while waiting for semaphore slot'))
      }
      entry = () => {
        signal?.removeEventListener('abort', onAbort)
        this.active++
        resolve(() => this.releaseOne())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(entry)
    })
  }
  private releaseOne(): void {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }
}

export function createHostServices(ctx: Context, entryConfig: Record<string, unknown> = {}) {
  const tag = '[dsh-agy-link] '
  const log = (msg: string) => {
    const logger = (ctx as unknown as { logger?: { info?: (m: string) => void } }).logger
    logger?.info?.(tag + msg)
  };

  let binCache: string | null | undefined = undefined
  let versionCache: string | null = null
  let dormantReason: string | null = null
  let lastRun: {
    processOk: boolean
    processCode: string
    toolErrors: readonly string[]
    durationMs: number
    model: string
    tokenSpeed: { lastTps: number | null; avgTps: number | null; outputTokens: number; measuredSteps: number; generatingMs: number }
  } | null = null
  let lastParser = new StreamJsonParser()
  const getConfig = (): PluginConfig => resolveConfig(entryConfig)
  // The webview model picker caches its catalog snapshot and only re-reads
  // after the payload-free `llm/adapters-updated` event (consumers re-read
  // the registries instead of receiving state). Emit it whenever picker
  // output can change: hiddenModels writes and async catalog refreshes.
  const notifyPicker = (): void => {
    try {
      ctx.emit('llm/adapters-updated')
    } catch {
      // Host without the event — the picker simply stays on its snapshot.
    }
  }
  const bin = (): string | null => {
    if (binCache === undefined || binCache === null) binCache = resolveAgyBin(getConfig())
    return binCache
  }
  const version = () => versionCache
  const store = new SessionStore(join(stateDir(), 'sessions.json'))
  const pool = new AccountPoolManager()
  for (const account of pool.getAccounts()) {
    if (account.dir && !account.systemHome) {
      readAccountCredential(join(account.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), log)
    }
  }
  const quota = new QuotaService(
    pool,
    () => getConfig().proxyUrl || detectSystemProxy() || '',
    version,
    {
      bin: () => bin(),
      viaCli: () => getConfig().quotaViaCli,
      preemptAutoUpdate: () => getConfig().suppressAgyAutoUpdate,
    },
  )
  const warmup = new WarmupService(
    pool,
    quota,
    () => getConfig().proxyUrl || detectSystemProxy() || '',
    version,
    getConfig,
    log,
  )
  const semaphore = new Semaphore(() => getConfig().maxConcurrent)

  const getDiscoveryEnv = (account?: ManagedAccount): NodeJS.ProcessEnv =>
    buildAgyEnv({
      ...(account === undefined ? {} : { account }),
      cfg: getConfig(),
      telemetryFlags: true,
    })

  // Models agy refused `--effort` for (issue #67). Effort support is advisory in
  // our catalog — with the fallback list active, an agy build that rejects the
  // flag for a model would otherwise fail EVERY turn that asks for a level. The
  // refusal is learned once, persisted here, and the picker is told to re-read
  // the capabilities (the model's effort row then disappears).
  const effortUnsupportedPath = (): string => join(stateDir(), 'effort-unsupported.json')
  let effortUnsupportedCache: string[] | null = null
  const readEffortUnsupported = (): readonly string[] => {
    if (effortUnsupportedCache !== null) return effortUnsupportedCache
    try {
      const raw = existsSync(effortUnsupportedPath()) ? JSON.parse(readFileSync(effortUnsupportedPath(), 'utf8')) : []
      effortUnsupportedCache = Array.isArray(raw)
        ? raw.filter((m): m is string => typeof m === 'string' && m.trim() !== '')
        : []
    } catch {
      effortUnsupportedCache = []
    }
    return effortUnsupportedCache
  }
  const rememberEffortUnsupported = (model: string): void => {
    const known = readEffortUnsupported()
    if (known.some((m) => m.trim().toLowerCase() === model.trim().toLowerCase())) return
    effortUnsupportedCache = [...known, model]
    try {
      mkdirSync(stateDir(), { recursive: true })
      writeFileSync(effortUnsupportedPath(), JSON.stringify(effortUnsupportedCache, null, 2), 'utf8')
    } catch (e) {
      log('failed to persist the effort-unsupported list: ' + String(e))
    }
    notifyPicker()
  }

  /** The DSH session's own workspace (agy runs there, per the translation spec). */
  const sessionWorkspace = (sessionId: string): string | undefined => {
    const sessions = ctx.get('sessions') as { get(id: unknown): { header?: { cwd?: string } } | undefined } | undefined
    return sessions?.get(sessionId)?.header?.cwd
  }
  /**
   * Absolute path of a DSH session's raw log. Handed to agy in the translation
   * setup so it can read the conversation itself on demand (the bucket directory
   * name is derived from the workspace, so the session id is what we search by).
   */
  const sessionLogFile = (sessionId: string): string | undefined => {
    if (sessionId === '') return undefined
    try {
      const root = join(dshHome(), 'sessions')
      for (const bucket of readdirSync(root)) {
        const dir = join(root, bucket, 'session-' + sessionId)
        if (!existsSync(dir)) continue
        for (const name of readdirSync(dir)) {
          if (name.startsWith('session.') && name.endsWith('.jsonl.zstd')) return join(dir, name)
        }
      }
    } catch {
      // No sessions directory (or no permission): the setup simply omits the path.
    }
    return undefined
  }

  type SessionLike = {
    id?: string
    log?: readonly { type: string; seq?: number; data?: unknown }[]
    events?: readonly { type: string; seq?: number; data?: unknown }[]
    snapshotEvents?: (fromSeq?: unknown, toSeqExclusive?: unknown) => readonly { type: string; seq?: number; data?: unknown }[]
    ownEvents?: () => readonly { type: string; seq?: number; data?: unknown }[]
    append?: (type: string, data: unknown) => { seq?: number } | number
    header?: { cwd?: string }
  }
  type SessionsServiceLike = { get(id: unknown): SessionLike | undefined }
  const sessionsSvc = (): SessionsServiceLike | undefined =>
    (ctx.get('sessions') as SessionsServiceLike | undefined) ?? ((ctx as unknown as { sessions?: SessionsServiceLike }).sessions)
  const sessionAuto = new Map<string, boolean>()

  type AppendPluginRecord = (session: unknown, type: string, data: unknown) => number
  let appendPluginRecordPromise: Promise<AppendPluginRecord | null> | null = null
  const loadAppendPluginRecord = (): Promise<AppendPluginRecord | null> => {
    if (appendPluginRecordPromise === null) {
      appendPluginRecordPromise = (async () => {
        try {
          // Non-literal specifier: keeps this optional peer out of the build's
          // static resolution while still using the host-provided instance.
          const spec = '@deepseek-ai/dsh-session'
          const mod = (await import(spec)) as { appendPluginRecord?: AppendPluginRecord }
          return typeof mod.appendPluginRecord === 'function' ? mod.appendPluginRecord : null
        } catch (e) {
          log('translation records unavailable: ' + String(e))
          return null
        }
      })()
    }
    return appendPluginRecordPromise
  }

  // Live boot status the dormant probe (index.ts) writes and /status reads.
  const status = {
    get version(): string | null { return versionCache },
    set version(v: string | null) { versionCache = v },
    get dormantReason(): string | null { return dormantReason },
    set dormantReason(v: string | null) { dormantReason = v },
  }

  const catalog = new ModelCatalog(
    async (signal, accountId) => {
      const b = bin()
      if (!b) throw new Error('agy binary not found')
      // agy models has no --output-format flag (verified against 1.1.13);
      // it prints a two-column text table. parseModelsOutput handles both.
      const poolData = pool.getPoolData()
      const targetAcc = accountId ? pool.getAccount(accountId) : undefined
      const activeId = pool.getActiveAccountId('google') ?? poolData.lastActiveAccountId ?? poolData.primaryAccountId
      const candidateAccount = (targetAcc && targetAcc.enabled && !targetAcc.authRequired)
        ? targetAcc
        : (activeId ? pool.getAccount(activeId) : undefined)
        ?? (poolData.primaryAccountId ? pool.getAccount(poolData.primaryAccountId) : undefined)
        ?? pool.getAccounts().find((a) => a.enabled && !a.authRequired)

      let out = await probeProcess(b, ['models'], 30_000, signal, getDiscoveryEnv(candidateAccount), getConfig().suppressAgyAutoUpdate)

      // If probe failed or prompted to sign in, and candidate had no dir (system HOME),
      // try secondary accounts with isolated dir if available before giving up.
      if ((out.code !== 0 || out.stdout.includes('Please sign in') || /sign in|auth|not logged in/i.test(out.stderrTail)) && (!candidateAccount || !candidateAccount.dir)) {
        const secondary = pool.getAccounts().find((a) => a.enabled && !a.authRequired && a.dir)
        if (secondary) {
          const secondaryOut = await probeProcess(b, ['models'], 30_000, signal, getDiscoveryEnv(secondary), getConfig().suppressAgyAutoUpdate)
          if (secondaryOut.code === 0 && secondaryOut.stdout.trim() !== '') {
            out = secondaryOut
          }
        }
      }

      if (out.code !== 0 && out.stdout.trim() === '') {
        throw new Error('agy models failed: ' + (out.stderrTail.trim() !== '' ? out.stderrTail.trim().slice(-200) : 'exit ' + String(out.code)))
      }
      return { stdout: out.stdout, stderr: out.stderrTail }
    },
    getConfig().fallbackModels,
    getConfig().modelsCacheTtlMs,
    notifyPicker,
  )

  pool.onAccountSwitch = (newActiveId: string) => {
    notifyPicker()
    void catalog.forceRefreshAndNotify(newActiveId).catch(() => undefined)
  }

  const auth = new AuthHelper(bin, () => getConfig().suppressAgyAutoUpdate)
  const poolAuth = new PoolAuthFlow(pool, quota, log, { onUpdate: notifyPicker })
  const runs = new RunRegistry()

  const webServerPort: { current?: number } = {}

  const adapter = new AgyAdapter({
    getConfig,
    catalog,
    store,
    pool,
    bin,
    acquire: (signal) => semaphore.acquire(signal),
    log,
    runs,
    getMediaBaseUrl: () => (webServerPort.current ? `http://127.0.0.1:${webServerPort.current}/plugins/agy-link/media` : null),
    effortUnsupported: () => readEffortUnsupported(),
    onEffortUnsupported: (model) => rememberEffortUnsupported(model),
    sessionCwd: (sessionId) => sessionWorkspace(sessionId),
    sessionGoal: (sessionId) => {
      try {
        const agents = (ctx.get('agents') as { get(id: unknown): unknown } | undefined)
          ?? (ctx as unknown as { agents?: { get(id: unknown): unknown } }).agents
        const goals = (ctx.get('goals') as { get(agent: unknown): { id?: string; revision?: number; phase?: string; activation?: string } | undefined } | undefined)
          ?? (ctx as unknown as { goals?: { get(agent: unknown): { id?: string; revision?: number; phase?: string; activation?: string } | undefined } }).goals
        const agent = agents?.get(sessionId)
        if (agent && goals) {
          const g = goals.get(agent)
          // Only volunteer a completion target for a goal the driver would
          // actually keep driving: active AND armed. A paused/blocked/completed
          // goal, or a disarmed one, is under human control — synthesizing
          // update_goal(complete) for it would override the user and produced
          // duplicate call ids in the transcript (2026-11-07 incident).
          if (g?.id && g.phase === 'active' && (g.activation === undefined || g.activation === 'armed')) {
            return {
              goalId: g.id,
              revision: typeof g.revision === 'number' ? g.revision : 1,
            }
          }
          // The live view is authoritative: there is no active, armed goal.
          return null
        }
      } catch {
        // Fall back to inspecting the session log below.
      }

      type SessionWithEvents = {
        log?: readonly { type: string; data?: unknown }[]
        snapshotEvents?(): readonly { type: string; data?: unknown }[]
        ownEvents?(): readonly { type: string; data?: unknown }[]
        events?: readonly { type: string; data?: unknown }[]
      }
      const sessions = (ctx.get('sessions') as { get(id: unknown): SessionWithEvents | undefined } | undefined)
        ?? (ctx as unknown as { sessions?: { get(id: unknown): SessionWithEvents | undefined } }).sessions
      const session = sessions?.get(sessionId)
      // `undefined` = the goal service is unavailable and the log cannot tell;
      // the caller may then fall back to message-history detection.
      if (!session) return undefined
      const evs = session.snapshotEvents?.() ?? session.ownEvents?.() ?? session.log ?? session.events
      if (!evs) return undefined
      // Resolve the phase from the newest phase-defining operation. `edit` keeps
      // the phase, so keep walking back for it.
      for (let i = evs.length - 1; i >= 0; i--) {
        const ev = evs[i]
        if (ev?.type !== 'goal/change' || !ev.data || typeof ev.data !== 'object') continue
        const d = ev.data as { operation?: string; goal?: { id?: string; revision?: number }; cleared?: { id?: string } }
        switch (d.operation) {
          case 'clear':
            return null
          case 'pause':
          case 'block':
          case 'complete':
            return null
          case 'create':
          case 'resume':
            return d.goal?.id
              ? { goalId: d.goal.id, revision: typeof d.goal.revision === 'number' ? d.goal.revision : 1 }
              : null
          case 'edit':
            continue
          default:
            return null
        }
      }
      return null
    },
    syncSessionModel: (sessionId, model, effort) => {
      if (!sessionId) return
      try {
        const sessions = (ctx.get('sessions') as { get(id: unknown): { append?: (type: string, data: unknown) => unknown } } | undefined)
          ?? (ctx as unknown as { sessions?: { get(id: unknown): { append?: (type: string, data: unknown) => unknown } } }).sessions
        const session = sessions?.get(sessionId)
        if (session && typeof session.append === 'function') {
          session.append('model/selection', {
            provider: PROVIDER_ID,
            model,
            ...(effort ? { reasoningEffort: effort } : {}),
          })
        }
      } catch {
        // safe containment
      }

      try {
        const agents = (ctx.get('agents') as { get(id: unknown): unknown; selectForNextRequest?: (a: unknown, s: unknown) => void } | undefined)
          ?? (ctx as unknown as { agents?: { get(id: unknown): unknown; selectForNextRequest?: (a: unknown, s: unknown) => void } }).agents
        const agent = agents?.get(sessionId)
        if (agent && agents && typeof agents.selectForNextRequest === 'function') {
          agents.selectForNextRequest(agent, {
            provider: PROVIDER_ID,
            model,
            ...(effort ? { reasoningEffort: effort } : {}),
          })
        }
      } catch {
        // safe containment
      }
    },
    onRun: (info) => {
      lastRun = info
    },
    onParser: (p) => {
      lastParser = p
    },
    readImage: async (ref: ImageRefLike) => {
      const svc = (ctx.get('attachments') as { readImage?: (r: ImageRefLike) => Promise<{ data?: Uint8Array } | null> } | undefined)
        ?? (ctx as unknown as { attachments?: { readImage?: (r: ImageRefLike) => Promise<{ data?: Uint8Array } | null> } }).attachments
      if (svc && typeof svc.readImage === 'function') {
        try {
          const stored = await svc.readImage(ref)
          if (stored?.data) return stored.data
        } catch {
          // fall through to disk read fallback
        }
      }
      try {
        const id = ref.attachmentId
        if (id && typeof id === 'string') {
          const diskPath = join(dshHome(), 'attachments', 'v1', 'objects', id.slice(0, 2), id)
          if (existsSync(diskPath)) {
            return readFileSync(diskPath)
          }
        }
      } catch {
        return null
      }
      return null
    },
  })

  const translation = new TranslationService({
    cfg: getConfig,
    catalog: () => catalog.get(),
    getSession: (id) => sessionsSvc()?.get(id),
    autoEnabled: (id) => sessionAuto.get(id) ?? getConfig().autoTranslate,
    sessionCwd: (id) => sessionWorkspace(id),
    sessionLogPath: (id) => sessionLogFile(id),
    log,
    run: async (req) => {
      const startedAt = Date.now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('translation timed out after ' + req.timeoutMs + 'ms')), Math.max(1_000, req.timeoutMs))
      timer.unref?.()
      const signal = req.signal === undefined ? controller.signal : AbortSignal.any([req.signal, controller.signal])
      try {
        const messages = [createUserMessage({ content: [{ type: 'text', text: req.prompt }], source: { kind: 'user' } })]
        // `purpose:'translation'` is this plugin's own route (see
        // AgyAdapter.stream): plan mode, no tool mirroring, and — unlike the
        // other aux purposes — a conversation of its OWN per DSH session, so the
        // persona is sent once and later translations carry only the text.
        const options = {
          provider: PROVIDER_ID,
          model: req.model,
          ...(req.sessionId === undefined ? {} : { sessionId: req.sessionId }),
          messages,
          maxTokens: req.maxTokens,
          ...(req.effort === undefined || req.effort === '' ? {} : { reasoningEffort: req.effort }),
          purpose: 'translation',
          signal,
          // One agy conversation per DSH session for translations: the PERSONA
          // (who agy is, which DSH session it serves, where that session's
          // history lives, plus a digest) is sent once. The short request line
          // still rides every call — measured on real agy, a bare text or even a
          // 6-char cue in a bound conversation produced an EMPTY or off-task
          // answer ("I am researching the codebase…"), while the one-liner
          // answered immediately every time.
          ...(getConfig().translateBindConversation && req.setup !== undefined
            ? { agyTranslateSession: { setup: req.setup, text: req.prompt } }
            : {}),
        } as unknown as GenerateOptions
        let text = ''
        let failure: { code?: string; message?: string } | null = null
        let finishKind: string | undefined
        const stream = ctx.llm.stream(options) as AsyncIterable<StreamChunk>
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') {
            text += chunk.text
          } else if (chunk.type === 'finish') {
            const reason = chunk.reason
            finishKind = reason.kind
            if (reason.kind === 'error' || reason.kind === 'aborted') {
              const f = (reason as { failure?: { code?: string; message?: string } }).failure
              failure = { ...(f?.code === undefined ? {} : { code: f.code }), ...(f?.message === undefined ? {} : { message: f.message }) }
            }
          }
        }
        const durationMs = Date.now() - startedAt
        if (failure !== null) {
          return { ok: false, text: text.trim(), durationMs, ...(failure.code === undefined ? {} : { code: failure.code }), ...(failure.message === undefined ? {} : { error: failure.message }) }
        }
        const trimmed = text.trim()
        if (trimmed === '') {
          // A clean stop with zero text is agy/Gemini returning an empty
          // candidate. Report it as its own (retryable) code, and leave the
          // finish kind + model in the host log so a recurrence is diagnosable.
          const detail = finishKind === undefined ? '' : ' (finish: ' + finishKind + ')'
          log('translation produced no text: model=' + req.model + ' effort=' + (req.effort === undefined || req.effort === '' ? '-' : req.effort) + ' durationMs=' + durationMs + detail)
          return { ok: false, text: '', durationMs, code: Err.EMPTY_RESPONSE, error: 'the translate model returned no text' + detail }
        }
        return { ok: true, text: trimmed, durationMs }
      } catch (e) {
        const err = e as { code?: string; message?: string }
        return { ok: false, text: '', durationMs: Date.now() - startedAt, ...(err.code === undefined ? {} : { code: err.code }), error: err.message ?? String(e) }
      } finally {
        clearTimeout(timer)
      }
    },
    appendRecord: async (sessionId, record: TranslationRecord) => {
      const session = sessionsSvc()?.get(sessionId)
      if (session === undefined) return null
      const append = await loadAppendPluginRecord()
      if (append !== null) {
        try {
          const res = append(session, TRANSLATION_RECORD_TYPE, record)
          if (typeof res === 'number') return res
        } catch (e) {
          log('failed to persist translation record via appendPluginRecord: ' + String(e))
        }
      }
      try {
        if (typeof session.append === 'function') {
          const res = session.append(TRANSLATION_RECORD_TYPE, record)
          if (typeof res === 'number') return res
          if (res !== null && typeof res === 'object' && typeof (res as { seq?: unknown }).seq === 'number') {
            return (res as { seq: number }).seq
          }
          return 0
        }
      } catch (e) {
        log('failed to persist translation record via session.append: ' + String(e))
      }
      return null
    },
  })

  const setOverride = (key: string, value: unknown): void => {
    const file = overridesPath()
    const current = readOverrides(file)
    current[key] = value
    binCache = undefined
    try {
      mkdirSync(stateDir(), { recursive: true })
      writeFileSync(file, JSON.stringify(current, null, 2), 'utf8')
    } catch (e) {
      log('failed to persist override: ' + String(e))
    }
  };

  const mediaDir = (): string => {
    const cfg = getConfig()
    return cfg.mediaDir !== '' ? cfg.mediaDir : defaultMediaDir(stateDir())
  }

  // One bridge can publish to several registries (global, pool accounts, and/or
  // workspace), so keep every restore hook it produced. Created here so the pool
  // routes and the bridge lifecycle in index.ts share the same mutable state.
  const bridgeState: { bridge: McpBridge | null; restores: Array<() => void> } = { bridge: null, restores: [] }

  return {
    getConfig, log, notifyPicker, bin, version, status, store, pool, quota, warmup,
    catalog, auth, poolAuth, runs, adapter, translation, setOverride,
    readEffortUnsupported, rememberEffortUnsupported, sessionsSvc, sessionAuto,
    get lastRun() { return lastRun },
    get lastParser() { return lastParser },
    mediaDir, bridgeState, webServerPort,
    // Filled in by the composition root (index.ts): the deployment-layout
    // anchor the media routes resolve mermaid/assets against, and the hook that
    // re-syncs the ask/mirror tools after a config write.
    hostDir: '',
    onConfigWritten: (_key: string, _value: unknown): void => undefined,
  }
}

export type HostServices = ReturnType<typeof createHostServices>
