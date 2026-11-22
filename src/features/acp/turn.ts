// One `session/prompt` turn over a live ACP process.
//
// The process outlives the turn, so the timeouts are all per-turn: an idle
// budget that stretches while a long tool runs, an optional hard cap, and an
// abort hook. Split out of client.ts to keep the transport file inside the
// module size budget; it talks to the process through a structural interface so
// the two files do not import each other.
export interface AcpTurnHost {
  subscribeSession(sessionId: string, listener: (u: Record<string, unknown>) => void): () => void
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  cancelSession(sessionId: string): void
}

export interface AcpPromptOptions {
  sessionId: string
  text: string
  timeoutMs: number
  idleTimeoutMs?: number
  longToolIdleMs?: number
  maxTurnMs?: number
  signal?: AbortSignal
  onUpdate: (update: Record<string, unknown>) => void
}

const TERMINAL_TOOL_STATUS = new Set(['completed', 'failed', 'error', 'cancelled', 'canceled'])

/** Stream one prompt to completion, enforcing the per-turn idle / wall-clock budgets. */
export async function runAcpTurn(host: AcpTurnHost, opts: AcpPromptOptions): Promise<Record<string, unknown>> {
  if (opts.signal?.aborted) {
    throw new Error('ACP session/prompt aborted')
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
    if (cancel) host.cancelSession(opts.sessionId)
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

  const onUpdate = (update: Record<string, unknown>) => {
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const tcId = typeof update.toolCallId === 'string' && update.toolCallId !== '' ? update.toolCallId : ''
      const status = typeof update.status === 'string' ? update.status.toLowerCase() : ''
      if (tcId !== '') {
        if (TERMINAL_TOOL_STATUS.has(status)) activeTools.delete(tcId)
        else activeTools.add(tcId)
      }
    }
    armIdle()
    opts.onUpdate(update)
  }

  const unsubscribe = host.subscribeSession(opts.sessionId, onUpdate)
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
      host.request(
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
    unsubscribe()
  }
}
