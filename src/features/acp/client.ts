// Persistent `agy acp` stdio JSON-RPC client process.
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { PermissionMode } from '../../common/types.ts'
import { preemptAgyAutoUpdate } from '../../host/auto-updater.ts'
import { consoleOutputEncoding, makeLineDecoder } from '../../runtime/agy/console.ts'
import { isCmdShim, windowsQuote } from '../../runtime/agy/bin.ts'
import { nodeScriptEnv, withAgyQuietEnv } from '../../runtime/agy/env.ts'
import { pickPermissionOption, type JsonRpcResponse } from './protocol.ts'

export interface AcpProcessOptions {
  bin: string
  cwd: string
  env?: NodeJS.ProcessEnv
  permissionMode: PermissionMode
  sandbox?: boolean
  agent?: string
  preemptAutoUpdate?: boolean
  log?: (msg: string) => void
}

interface PendingRpc {
  resolve: (res: Record<string, unknown>) => void
  reject: (err: Error) => void
  timer?: NodeJS.Timeout
}

function spawnAcpChild(opts: AcpProcessOptions, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const isWin = process.platform === 'win32'
  if (isWin && isCmdShim(opts.bin)) {
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [opts.bin, ...args].map(windowsQuote).join(' ')], {
      cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: true, windowsHide: true,
    })
  }
  if (/\.(?:m?js|cjs)$/i.test(opts.bin)) {
    return spawn(process.execPath, [opts.bin, ...args], {
      cwd: opts.cwd, env: nodeScriptEnv(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
  }
  return spawn(opts.bin, args, { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
}

export class AcpProcess extends EventEmitter {
  private child: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingRpc>()
  private readonly sessionListeners = new Map<string, Set<(u: Record<string, unknown>) => void>>()
  private readonly openSessions = new Set<string>()
  private buffer = ''
  private stderrTail = ''
  private alive = false
  private initPromise: Promise<Record<string, unknown>> | null = null
  lastUsedAt = Date.now()

  constructor(private readonly opts: AcpProcessOptions) {
    super()
  }

  isAlive(): boolean { return this.alive && this.child !== null }
  get sessionCount(): number { return this.openSessions.size }
  get stderr(): string { return this.stderrTail }
  hasOpenSession(sessionId: string): boolean { return this.openSessions.has(sessionId) }

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
    const args = ['acp', '--disable-telemetry']
    if (this.opts.permissionMode === 'skip') args.push('--dangerously-skip-permissions')
    if (this.opts.sandbox) args.push('--sandbox')
    if (this.opts.agent && this.opts.agent.trim() !== '') args.push('--agent', this.opts.agent.trim())

    const child = spawnAcpChild(this.opts, args, env)
    this.child = child
    this.alive = true
    child.stdin?.on('error', () => {})

    const outDec = makeLineDecoder(consoleOutputEncoding())
    const errDec = makeLineDecoder(consoleOutputEncoding())
    child.stdout?.on('data', (chunk: Buffer) => this.consumeStdout(outDec.push(chunk)))
    child.stderr?.on('data', (chunk: Buffer) => {
      const t = errDec.push(chunk)
      if (t !== '') this.stderrTail = (this.stderrTail + t).slice(-4096)
    })
    child.on('close', (code, sig) => {
      this.consumeStdout(outDec.flush() + '\n')
      const errTail = errDec.flush()
      if (errTail !== '') this.stderrTail = (this.stderrTail + errTail).slice(-4096)
      this.alive = false
      this.child = null
      const err = new Error(`agy acp exited (code=${String(code)}, signal=${String(sig)}): ${this.stderrTail.slice(-240)}`)
      for (const [, p] of this.pending) {
        if (p.timer) clearTimeout(p.timer)
        p.reject(err)
      }
      this.pending.clear()
      this.openSessions.clear()
      this.emit('exit', code, sig)
    })
    child.on('error', (err) => {
      this.alive = false
      this.stderrTail = (this.stderrTail + String(err)).slice(-4096)
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
      this.pending.set(id, { resolve, reject, ...(timer ? { timer } : {}) })
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
        .catch((err) => {
          this.initPromise = null
          throw err
        })
    }
    return this.initPromise
  }

  async openSession(opts: {
    cwd: string
    resumeId?: string
    addDirs?: readonly string[]
    model?: string
    effort?: string
    mode?: PermissionMode
  }): Promise<string> {
    await this.ensureInitialized()
    let sid = opts.resumeId && this.openSessions.has(opts.resumeId) ? opts.resumeId : ''
    if (sid === '' && opts.resumeId) {
      for (const method of ['session/resume', 'session/load']) {
        try {
          const r = await this.request(method, { sessionId: opts.resumeId, cwd: opts.cwd, mcpServers: [] }, 30_000)
          sid = typeof r.sessionId === 'string' && r.sessionId !== '' ? r.sessionId : opts.resumeId
          break
        } catch {
          // try fallback
        }
      }
    }
    if (sid === '') {
      const params: Record<string, unknown> = { cwd: opts.cwd, mcpServers: [] }
      if (opts.addDirs && opts.addDirs.length > 0) params.additionalDirectories = [...opts.addDirs]
      const r = await this.request('session/new', params, 30_000)
      sid = typeof r.sessionId === 'string' ? r.sessionId : ''
      if (sid === '') throw new Error('ACP session/new returned empty sessionId')
    }
    this.openSessions.add(sid)
    const mode = opts.mode ?? this.opts.permissionMode
    if (mode !== 'skip') {
      await this.request('session/set_mode', { sessionId: sid, modeId: mode }, 15_000).catch(() => undefined)
    }
    if (opts.model && opts.model.trim() !== '') {
      await this.request('session/set_config_option', { sessionId: sid, configId: 'model', value: opts.model.trim() }, 15_000)
        .catch(() => undefined)
    }
    if (opts.effort && opts.effort.trim() !== '') {
      await this.request('session/set_config_option', { sessionId: sid, configId: 'thought_level', value: opts.effort.trim() }, 15_000)
        .catch(() => undefined)
    }
    return sid
  }

  async prompt(opts: {
    sessionId: string
    text: string
    timeoutMs: number
    idleTimeoutMs?: number
    longToolIdleMs?: number
    maxTurnMs?: number
    signal?: AbortSignal
    onUpdate: (update: Record<string, unknown>) => void
  }): Promise<Record<string, unknown>> {
    if (opts.signal?.aborted) {
      throw new Error('ACP session/prompt aborted')
    }
    let set = this.sessionListeners.get(opts.sessionId)
    if (!set) {
      set = new Set()
      this.sessionListeners.set(opts.sessionId, set)
    }

    const idleMs = Math.max(0, opts.idleTimeoutMs ?? opts.timeoutMs)
    const longToolIdleMs = Math.max(0, opts.longToolIdleMs ?? 0)
    const maxTurnMs = Math.max(0, opts.maxTurnMs ?? 0)
    const activeTools = new Set<string>()
    let settled = false
    let idleTimer: NodeJS.Timeout | null = null
    let turnTimer: NodeJS.Timeout | null = null
    let rejectPrompt: ((err: Error) => void) | null = null

    const clearTimers = () => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
      if (turnTimer !== null) {
        clearTimeout(turnTimer)
        turnTimer = null
      }
    }

    const failWith = (err: Error, cancel = true) => {
      if (settled) return
      settled = true
      clearTimers()
      if (cancel) this.cancelSession(opts.sessionId)
      rejectPrompt?.(err)
    }

    const armIdle = () => {
      if (settled || idleMs <= 0) return
      if (idleTimer !== null) clearTimeout(idleTimer)
      const budget = activeTools.size > 0 && longToolIdleMs > 0 ? Math.max(idleMs, longToolIdleMs) : idleMs
      idleTimer = setTimeout(() => {
        failWith(new Error(`ACP session/prompt timed out after ${budget}ms (idle)`))
      }, budget)
      idleTimer.unref?.()
    }

    const wrappedOnUpdate = (update: Record<string, unknown>) => {
      const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        const tcId = typeof update.toolCallId === 'string' && update.toolCallId !== '' ? update.toolCallId : ''
        const status = typeof update.status === 'string' ? update.status.toLowerCase() : ''
        if (tcId !== '') {
          if (status === 'completed' || status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled') {
            activeTools.delete(tcId)
          } else {
            activeTools.add(tcId)
          }
        }
      }
      armIdle()
      opts.onUpdate(update)
    }

    set.add(wrappedOnUpdate)
    const onAbort = () => failWith(new Error('ACP session/prompt aborted'))
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      armIdle()
      if (maxTurnMs > 0) {
        turnTimer = setTimeout(() => {
          failWith(new Error(`ACP session/prompt timed out after ${maxTurnMs}ms (maxTurn)`))
        }, maxTurnMs)
        turnTimer.unref?.()
      }
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        rejectPrompt = reject
        this.request(
          'session/prompt',
          {
            sessionId: opts.sessionId,
            prompt: [{ type: 'text', text: opts.text }],
          },
          0,
        ).then(
          (res) => {
            if (settled) return
            settled = true
            clearTimers()
            resolve(res)
          },
          (err) => {
            if (settled) return
            settled = true
            clearTimers()
            reject(err instanceof Error ? err : new Error(String(err)))
          },
        )
      })
    } finally {
      clearTimers()
      opts.signal?.removeEventListener('abort', onAbort)
      set.delete(wrappedOnUpdate)
      if (set.size === 0) this.sessionListeners.delete(opts.sessionId)
    }
  }

  close(): void {
    this.alive = false
    const c = this.child
    this.child = null
    this.initPromise = null
    if (c) {
      try { c.stdin?.end() } catch { /* ignore */ }
      if (process.platform === 'win32' && isCmdShim(this.opts.bin) && c.pid !== undefined) {
        try {
          spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
          return
        } catch {
          // fall back below
        }
      }
      try { c.kill() } catch { /* ignore */ }
    }
  }
}
