// Persistent `agy acp` stdio JSON-RPC client process.
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { PermissionMode } from '../../common/types.ts'
import { preemptAgyAutoUpdate } from '../../host/auto-updater.ts'
import { killTree } from '../../runtime/agy/process.ts'
import { consoleOutputEncoding, makeLineDecoder } from '../../runtime/agy/console.ts'
import { withAgyQuietEnv } from '../../runtime/agy/env.ts'
import { awaitAuthEvidence, classifyIdentity, readAuthEmailFromLog, type AuthEvidence } from './identity.ts'
import { extractAvailableCommands, pickPermissionOption, type AvailableCommand, type JsonRpcResponse } from './protocol.ts'
import { runAcpTurn, type AcpPromptOptions } from './turn.ts'
import { collectAdvertisedModelIds } from './session-models.ts'
import { buildAcpSpawnArgs, resolveAcpLogFile, spawnAcpChild } from './spawn.ts'

export interface AcpProcessOptions {
  bin: string
  cwd: string
  env?: NodeJS.ProcessEnv
  permissionMode: PermissionMode
  sandbox?: boolean
  agent?: string
  addDirs?: readonly string[]
  preemptAutoUpdate?: boolean
  log?: (msg: string) => void
  /** Directory for the per-process `acp-*.log` (default: <state>/logs). */
  logDir?: string
  /** Explicit log file path (tests / diagnostics); overrides `logDir`. */
  logFile?: string
  /**
   * Account this process is SUPPOSED to authenticate as. When set, the identity
   * agy reports in its own log (`applyAuthResult: email=...`) is compared after
   * the first session is opened: the machine-wide credential slot can be
   * refreshed by another agy at its own hourly mark, and a mismatch means this
   * process is silently spending someone else's quota.
   */
  expectedEmail?: string
  /** Account has its own isolated HOME; a keyring fallback means the wrong account. */
  expectedIsolated?: boolean
}

/** How a requested session id was resolved when the session was opened. */
export type AcpSessionOpenStatus = 'cached' | 'resumed' | 'loaded' | 'created'

export interface AcpOpenSessionResult {
  sessionId: string
  status: AcpSessionOpenStatus
  /**
   * True when a resume/load was requested but the server could not prove it
   * restored anything (a stale id or a foreign account). The caller must then
   * rebuild the context instead of silently continuing on an empty session.
   */
  resumeFailed: boolean
}

/** Absolute stderr kept per process; older bytes are dropped from the front. */
const STDERR_MAX_CHARS = 256 * 1024

interface PendingRpc {
  resolve: (res: Record<string, unknown>) => void
  reject: (err: Error) => void
  timer?: NodeJS.Timeout
  /** RPC name: lets `isBusy` tell a long turn from a short control request. */
  method: string
}

export class AcpProcess extends EventEmitter {
  private child: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingRpc>()
  private readonly sessionListeners = new Map<string, Set<(u: Record<string, unknown>) => void>>()
  private readonly openSessions = new Set<string>()
  // Last mode/model/effort actually applied per session. `set_config_option` is
  // not idempotent on agy's side: every call logs `Switching model in session
  // <sid> to: …` and re-runs the switch even when the value is identical (real
  // logs show the same target three turns in a row). DSH opens the session
  // again on every turn, so an unchanged turn used to re-apply its settings
  // before each prompt (issue #167).
  private readonly sessionConfigs = new Map<string, { mode: string; model: string; effort: string }>()
  /** Advertised model ids per session (atomic `${model}-${effort}` switch). */
  private readonly sessionModels = new Map<string, Set<string>>()
  private buffer = ''
  /**
   * Rolling stderr window plus absolute character offsets, so a failure can be
   * classified from THIS turn's stderr only. The previous transport fed the
   * whole tail into every failure, which let one old warning poison later
   * classifications.
   */
  private stderrBuffer = ''
  private stderrStart = 0
  private stderrEnd = 0
  private logFile: string | null = null
  /** Identity agy reported for THIS process (cached: the log line never changes). */
  private authEmail: string | null = null
  /** The identity probe already ran for this process — never wait on it twice. */
  private identityProbeDone = false
  private identityProbe: Promise<AuthEvidence> | null = null
  private alive = false
  private supportsInlineImages = false
  private activePrompts = 0
  private readonly rebuiltSessions = new Set<string>()
  private availableCommands: AvailableCommand[] = []
  private initPromise: Promise<Record<string, unknown>> | null = null
  lastUsedAt = Date.now()

  constructor(private readonly opts: AcpProcessOptions) {
    super()
  }

  isAlive(): boolean { return this.alive && this.child !== null }
  get advertisedCommands(): readonly AvailableCommand[] { return this.availableCommands }
  /** Foreground prompts own the process until completion, timeout or cancellation. */
  hasActivePrompt(): boolean { return this.activePrompts > 0 }
  /** Live child pid, or null before start / after exit (stray reconciliation). */
  get pid(): number | null { return this.child?.pid ?? null }
  /** A `session/prompt` is still in flight — the child is mid-turn, however quiet (#182). */
  get isBusy(): boolean {
    for (const p of this.pending.values()) if (p.method === 'session/prompt') return true
    return false
  }
  get sessionCount(): number { return this.openSessions.size }
  /** Tail of the process stderr (diagnostics / crash messages). */
  get stderr(): string { return this.stderrBuffer.slice(-4096) }
  /** Absolute stderr offset right now; pass it to `readStderrSince` later. */
  stderrOffset(): number { return this.stderrEnd }
  /** stderr text produced since `offset` ('' when the window already rotated past it). */
  readStderrSince(offset: number): string {
    const from = Math.max(offset, this.stderrStart)
    if (from >= this.stderrEnd) return ''
    return this.stderrBuffer.slice(from - this.stderrStart)
  }
  /** Path of the agy ACP log this process writes (null until started). */
  get logFilePath(): string | null { return this.logFile }
  /** True when the remote `agy acp` advertised `promptCapabilities.image === true`. */
  get supportsImageBlocks(): boolean { return this.supportsInlineImages }
  hasOpenSession(sessionId: string): boolean { return this.openSessions.has(sessionId) }
  consumeRebuiltSession(sessionId: string): boolean { return this.rebuiltSessions.delete(sessionId) }

  /**
   * The account agy authenticated as, read from its own `--log-file`. Gate 2:
   * the credential slot is machine-wide, so the account we dispatched is no
   * proof of the account this process loaded — another agy can refresh the slot
   * at its own hourly mark and hand this process the wrong identity.
   * Returns null until agy has written the line (a few seconds after start).
   */
  readAuthEmail(): string | null {
    if (this.authEmail !== null) return this.authEmail
    const email = readAuthEmailFromLog(this.logFile)
    if (email !== null) this.authEmail = email
    return email
  }

  private appendStderr(text: string): void {
    if (text === '') return
    this.stderrBuffer += text
    this.stderrEnd += text.length
    if (this.stderrBuffer.length > STDERR_MAX_CHARS) {
      const drop = this.stderrBuffer.length - STDERR_MAX_CHARS
      this.stderrBuffer = this.stderrBuffer.slice(drop)
      this.stderrStart += drop
    }
  }

  /**
   * Reserve a per-process log path so `agy acp --log-file` writes somewhere the
   * plugin owns and can read after an empty turn. agy logs the real cause of a
   * silent failure (proxy connect errors, executor construction) only there —
   * the JSON-RPC stream and stderr both stay empty.
   */
  private resolveLogFile(): string {
    if (this.logFile === null) {
      this.logFile = resolveAcpLogFile(this.opts.logFile, this.opts.logDir)
    }
    return this.logFile
  }

  subscribeSession(sessionId: string, listener: (u: Record<string, unknown>) => void): () => void {
    let set = this.sessionListeners.get(sessionId)
    if (!set) {
      set = new Set()
      this.sessionListeners.set(sessionId, set)
    }
    set.add(listener)
    return () => {
      const current = this.sessionListeners.get(sessionId)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.sessionListeners.delete(sessionId)
    }
  }

  private ensureStarted(): void {
    if (this.child !== null) return
    const env = withAgyQuietEnv(this.opts.env ?? process.env)
    if (this.opts.preemptAutoUpdate !== false) preemptAgyAutoUpdate(env)
    const args = buildAcpSpawnArgs(this.opts, this.resolveLogFile())

    const child = spawnAcpChild(this.opts, args, env)
    this.child = child
    this.alive = true
    child.stdin?.on('error', () => {})

    const outDec = makeLineDecoder(consoleOutputEncoding())
    const errDec = makeLineDecoder(consoleOutputEncoding())
    child.stdout?.on('data', (chunk: Buffer) => this.consumeStdout(outDec.push(chunk)))
    child.stderr?.on('data', (chunk: Buffer) => this.appendStderr(errDec.push(chunk)))
    child.on('close', (code, sig) => {
      this.consumeStdout(outDec.flush() + '\n')
      this.appendStderr(errDec.flush())
      this.alive = false
      this.child = null
      const err = new Error(`agy acp exited (code=${String(code)}, signal=${String(sig)}): ${this.stderr.slice(-240)}`)
      for (const [, p] of this.pending) {
        if (p.timer) clearTimeout(p.timer)
        p.reject(err)
      }
      this.pending.clear()
      this.openSessions.clear()
      this.sessionConfigs.clear()
      this.sessionModels.clear()
      this.emit('exit', code, sig)
    })
    child.on('error', (err) => {
      this.alive = false
      this.appendStderr(String(err))
    })
  }

  private consumeStdout(text: string): void {
    if (text === '') return
    this.buffer += text
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '').trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (line !== '') this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    // ANY inbound frame is activity so streaming mirrored-tool runs do not look idle.
    this.lastUsedAt = Date.now()
    if ((typeof msg.id === 'number' || typeof msg.id === 'string') && typeof msg.method === 'string') {
      this.handleServerRequest(msg.id, msg.method, (msg.params ?? {}) as Record<string, unknown>)
      return
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (p.timer) clearTimeout(p.timer)
      const resp = msg as unknown as JsonRpcResponse
      if (resp.error) {
        p.reject(new Error(resp.error.message || `ACP error ${resp.error.code}`))
      } else {
        p.resolve(resp.result ?? {})
      }
      return
    }
    if (msg.method === 'session/update' && msg.params && typeof msg.params === 'object') {
      const params = msg.params as { sessionId?: unknown; update?: unknown }
      const sid = typeof params.sessionId === 'string' ? params.sessionId : ''
      const update = params.update && typeof params.update === 'object' ? (params.update as Record<string, unknown>) : null
      if (sid && update) {
        const cmds = extractAvailableCommands(update)
        if (cmds !== null) this.availableCommands = cmds
        const set = this.sessionListeners.get(sid)
        if (set) for (const cb of [...set]) cb(update)
      }
    }
  }

  private handleServerRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    if (method === 'session/request_permission') {
      const outcome = pickPermissionOption(params, this.opts.permissionMode)
      this.writeLine({ jsonrpc: '2.0', id, result: { outcome } })
      return
    }
    this.writeLine({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported client method: ${method}` } })
  }

  cancelSession(sessionId: string): void {
    this.notify('session/cancel', { sessionId })
  }

  private writeLine(payload: unknown): void {
    if (!this.child?.stdin || !this.alive) throw new Error('agy acp process is not running')
    this.child.stdin.write(JSON.stringify(payload) + '\n')
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
    this.ensureStarted()
    this.lastUsedAt = Date.now()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            if (this.pending.delete(id)) reject(new Error(`ACP request ${method} timed out after ${timeoutMs}ms`))
          }, timeoutMs)
        : undefined
      timer?.unref?.()
      this.pending.set(id, { resolve, reject, method, ...(timer ? { timer } : {}) })
      try {
        this.writeLine({ jsonrpc: '2.0', id, method, params })
      } catch (e) {
        this.pending.delete(id)
        if (timer) clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.alive || !this.child) return
    this.lastUsedAt = Date.now()
    try {
      this.writeLine({ jsonrpc: '2.0', method, params })
    } catch {
      // ignore closed pipe
    }
  }

  async ensureInitialized(): Promise<Record<string, unknown>> {
    if (!this.initPromise) {
      this.initPromise = this.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 25_000)
        .then((res) => {
          const caps = (res.agentCapabilities ?? res.capabilities) as
            | { promptCapabilities?: { image?: unknown } }
            | undefined
          this.supportsInlineImages = caps?.promptCapabilities?.image === true
          return res
        })
        .catch((err) => {
          this.initPromise = null
          throw err
        })
    }
    return this.initPromise
  }

  /**
   * Restore a previously persisted session. `session/resume` answering means
   * the conversation was found under this account; `session/load` answers
   * successfully even for an id that does not exist (it opens an EMPTY
   * session), so a load only counts when the replay it produced carries
   * evidence: replayed update events or a non-zero cachedReadTokens usage.
   */
  private async restoreSession(
    sessionId: string,
    cwd: string,
  ): Promise<{ sessionId: string; status: AcpSessionOpenStatus } | null> {
    try {
      const r = await this.request('session/resume', { sessionId, cwd, mcpServers: [] }, 30_000)
      const sid = typeof r.sessionId === 'string' && r.sessionId !== '' ? r.sessionId : sessionId
      this.rememberModels(sid, r)
      return { sessionId: sid, status: 'resumed' }
    } catch {
      // -32603 cannot distinguish "wrong account" from "no such session";
      // fall through to a load and judge it by its replay evidence.
    }
    let replayed = 0
    let cachedReadTokens = 0
    const unsub = this.subscribeSession(sessionId, (u) => {
      const kind = typeof u.sessionUpdate === 'string' ? u.sessionUpdate : ''
      if (
        kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' ||
        kind === 'user_message_chunk' || kind === 'tool_call' || kind === 'tool_call_update'
      ) {
        replayed += 1
      }
      if (kind === 'usage_update') {
        const raw = u.cachedReadTokens ?? u.cache_read_tokens ?? u.cached_read_tokens
        const n = typeof raw === 'number' ? raw : Number.NaN
        if (Number.isFinite(n) && n > cachedReadTokens) cachedReadTokens = n
      }
    })
    try {
      const r = await this.request('session/load', { sessionId, cwd, mcpServers: [] }, 30_000)
      const sid = typeof r.sessionId === 'string' && r.sessionId !== '' ? r.sessionId : sessionId
      this.rememberModels(sid, r)
      // Give the replay a moment to arrive before judging it.
      if (replayed === 0) await new Promise((r2) => setTimeout(r2, 300))
      if (replayed === 0 && cachedReadTokens === 0) return null
      return { sessionId: sid, status: 'loaded' }
    } catch {
      return null
    } finally {
      unsub()
    }
  }

  async openSession(opts: {
    cwd: string
    resumeId?: string
    addDirs?: readonly string[]
    model?: string
    effort?: string
    mode?: PermissionMode
  }): Promise<AcpOpenSessionResult> {
    await this.ensureInitialized()
    let sid = ''
    let status: AcpSessionOpenStatus = 'created'
    let resumeFailed = false
    if (opts.resumeId) {
      if (this.openSessions.has(opts.resumeId)) {
        sid = opts.resumeId
        status = 'cached'
      } else {
        const restored = await this.restoreSession(opts.resumeId, opts.cwd)
        if (restored !== null) {
          sid = restored.sessionId
          status = restored.status
        } else {
          // A silently empty session would look like a fresh conversation and
          // lose all context without a word: report it so the caller rebuilds.
          resumeFailed = true
        }
      }
    }
    if (sid === '') {
      const params: Record<string, unknown> = { cwd: opts.cwd, mcpServers: [] }
      if (opts.addDirs && opts.addDirs.length > 0) params.additionalDirectories = [...opts.addDirs]
      const r = await this.request('session/new', params, 30_000)
      sid = typeof r.sessionId === 'string' ? r.sessionId : ''
      if (sid === '') throw new Error('ACP session/new returned empty sessionId')
      this.rememberModels(sid, r)
      if (opts.resumeId && sid !== opts.resumeId) {
        this.rebuiltSessions.add(sid)
      }
    }
    this.openSessions.add(sid)
    await this.applySessionConfig(sid, opts)
    return { sessionId: sid, status, resumeFailed }
  }

  /** Record the model ids a session advertises for the atomic switch path. */
  private rememberModels(sid: string, r: Record<string, unknown>): void {
    const ids = collectAdvertisedModelIds(r)
    if (ids.size > 0) this.sessionModels.set(sid, ids)
  }

  /**
   * Apply mode/model/effort to a session, skipping whatever is already in
   * effect. A resumed session starts with an empty cache, so its settings are
   * sent once — we cannot know what the server restored.
   *
   * A model change also resets the effort to that model's default (agy logs
   * `Switching model in session <sid> to: X (High)` and then `… (Low)` for the
   * follow-up thought_level call), so the effort has to be re-sent whenever the
   * model changed, and the cached effort is dropped when no new one is given.
   */
  private async applySessionConfig(sid: string, opts: { model?: string; effort?: string; mode?: PermissionMode }): Promise<void> {
    const mode = opts.mode ?? this.opts.permissionMode
    const model = opts.model?.trim() ?? ''
    const effort = opts.effort?.trim() ?? ''
    const prev = this.sessionConfigs.get(sid)
    if (prev?.mode !== mode && mode !== 'skip') {
      await this.request('session/set_mode', { sessionId: sid, modeId: mode }, 15_000).catch(() => undefined)
    }
    const modelChanged = model !== '' && prev?.model !== model
    // Prefer ONE atomic switch when the server advertises an id that already
    // carries the effort (`gemini-4-hydrogen-xhigh`). agy's model switch resets
    // thought_level to the new model's default, so the two-step path needs a
    // follow-up call; the atomic one does not (issue #167 suggestion).
    let appliedAtomically = false
    if (modelChanged) {
      const atomicId = effort !== '' && !model.endsWith('-' + effort) ? `${model}-${effort}` : model
      if (this.sessionModels.get(sid)?.has(atomicId)) {
        appliedAtomically = await this.request('session/set_model', { sessionId: sid, modelId: atomicId }, 15_000)
          .then(() => true)
          .catch(() => false)
      }
      if (!appliedAtomically) {
        await this.request('session/set_config_option', { sessionId: sid, configId: 'model', value: model }, 15_000)
          .catch(() => undefined)
      }
    }
    const effortToSend = effort !== '' ? effort : modelChanged ? '' : (prev?.effort ?? '')
    if (!appliedAtomically && effortToSend !== '' && (modelChanged || prev?.effort !== effortToSend)) {
      await this.request('session/set_config_option', { sessionId: sid, configId: 'thought_level', value: effortToSend }, 15_000)
        .catch(() => undefined)
    }
    // Remember what we just applied so the next turn can skip an unchanged
    // openSession config (issue #167), then prove the process is the account we
    // dispatched (Gate 2) before returning.
    this.sessionConfigs.set(sid, {
      mode,
      model: model === '' ? (prev?.model ?? '') : model,
      effort: effortToSend === '' ? '' : effortToSend,
    })
    // Prove the process is the account we dispatched (Gate 2) before the caller
    // starts a turn on it.
    await this.assertIdentity()
  }

  /**
   * Gate 2: prove this process is running as the account we dispatched.
   * agy prints its resolved identity to the `--log-file` a few seconds after
   * start; the slot is machine-wide, so a mismatched identity means another agy
   * refreshed it under us and this turn would bill the wrong account.
   * Failing here (instead of silently answering) lets the caller reinstall the
   * slot and retry once.
   */
  private async assertIdentity(): Promise<void> {
    const expected = (this.opts.expectedEmail ?? '').trim().toLowerCase()
    if (expected === '') return
    if (this.authEmail !== null) return this.checkIdentity(this.authEmail, expected)
    if (this.identityProbeDone) return
    this.identityProbe ??= awaitAuthEvidence(this.logFile, () => this.isAlive()).finally(() => {
      this.identityProbeDone = true
    })
    const evidence = await this.identityProbe
    // Only a DIFFERENT account in the log is actionable; an identity agy could not
    // prove because its userinfo lookup died on the network is retried, not flagged.
    const verdict = classifyIdentity(evidence, expected, this.opts.expectedIsolated === true)
    if (verdict.kind === 'mismatch' || verdict.kind === 'unproven') throw new Error(verdict.message)
    if (evidence.email === null) return
    this.authEmail = evidence.email
  }

  private checkIdentity(actual: string, expected: string): void {
    if (actual === expected) return
    throw new Error(`ACP identity mismatch: agy authenticated as ${actual}, expected ${expected}`)
  }

  async prompt(opts: AcpPromptOptions): Promise<Record<string, unknown>> {
    const effectiveOpts = this.supportsInlineImages ? opts : { ...opts, images: undefined }
    this.activePrompts++
    try {
      return await runAcpTurn(this, effectiveOpts)
    } finally {
      this.activePrompts--
      if (!this.hasActivePrompt()) this.lastUsedAt = Date.now()
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    this.openSessions.delete(sessionId)
    this.sessionConfigs.delete(sessionId)
    this.sessionModels.delete(sessionId)
    this.rebuiltSessions.delete(sessionId)
    this.sessionListeners.delete(sessionId)
    if (!this.isAlive()) return
    await this.request('session/close', { sessionId }, 10_000).catch(() => undefined)
  }

  /** Graceful close: end stdin and let agy flush SQLite, then kill remainder. */
  async closeGracefully(timeoutMs: number): Promise<void> {
    if (!this.isAlive()) {
      this.close()
      return
    }
    const c = this.child
    try { c?.stdin?.end() } catch { /* ignore */ }
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      timer.unref?.()
      this.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    if (!exited) this.close()
    else this.alive = false
  }

  close(): void {
    this.alive = false
    const c = this.child
    this.child = null
    this.initPromise = null
    if (!c) return
    try { c.stdin?.end() } catch { /* ignore */ }
    // agy spawns helpers that ignore SIGTERM and orphan if only bare kill() runs.
    killTree(c)
  }
}
