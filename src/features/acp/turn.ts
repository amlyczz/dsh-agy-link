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
  /** Native inline image content blocks (sent when agy advertises promptCapabilities.image). */
  images?: readonly { data: string; mimeType: string }[]
  timeoutMs: number
  idleTimeoutMs?: number
  longToolIdleMs?: number
  maxTurnMs?: number
  /**
   * Release the turn once it is only waiting on a one-shot agy `schedule`
   * timer (issue #225). After this many quiet ms with no foreground tool open,
   * the prompt is cancelled on agy's side and resolved as `end_turn`; the host
   * re-arms the timer and wakes the session itself. 0 disables the release.
   */
  scheduleReleaseMs?: number
  /** Called when the turn was released for a pending schedule, before it resolves. */
  onScheduleRelease?: (info: { delayMs: number }) => void
  signal?: AbortSignal
  onUpdate: (update: Record<string, unknown>) => void
}

const TERMINAL_TOOL_STATUS = new Set(['completed', 'failed', 'error', 'cancelled', 'canceled'])

/** agy's built-in `schedule` tool (exact name, any case — the same test the post-turn extractor applies). */
export function isScheduleToolName(name: unknown): boolean {
  return typeof name === 'string' && name.trim().toLowerCase() === 'schedule'
}

/** The one-shot delay of a `schedule` call in seconds; 0 for cron-only / unknown. */
export function scheduleDurationSeconds(input: unknown): number {
  if (typeof input !== 'object' || input === null) return 0
  for (const k of ['DurationSeconds', 'duration_seconds']) {
    const raw = (input as Record<string, unknown>)[k]
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN
    if (Number.isFinite(n) && n > 0) return n
  }
  return 0
}

interface ScheduleCall {
  durationSeconds: number
  done: boolean
  failed: boolean
}

/** Stream one prompt to completion, enforcing the per-turn idle / wall-clock budgets. */
export async function runAcpTurn(host: AcpTurnHost, opts: AcpPromptOptions): Promise<Record<string, unknown>> {
  if (opts.signal?.aborted) {
    throw new Error('ACP session/prompt aborted')
  }
  const idleMs = Math.max(0, opts.idleTimeoutMs ?? opts.timeoutMs)
  const longToolIdleMs = Math.max(0, opts.longToolIdleMs ?? 0)
  const maxTurnMs = Math.max(0, opts.maxTurnMs ?? 0)
  const scheduleReleaseMs = Math.max(0, opts.scheduleReleaseMs ?? 0)
  const activeTools = new Set<string>()
  // One-shot `schedule` calls by toolCallId, so a turn that only waits on such
  // a timer can be released instead of holding the session open (issue #225).
  const schedules = new Map<string, ScheduleCall>()
  let lastActivityAt = Date.now()
  let releaseTimer: NodeJS.Timeout | null = null
  let settled = false
  let idleTimer: NodeJS.Timeout | null = null
  let turnTimer: NodeJS.Timeout | null = null
  let rejectPrompt: ((err: Error) => void) | null = null
  let resolvePrompt: ((res: Record<string, unknown>) => void) | null = null

  const clearTimers = () => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    if (turnTimer !== null) {
      clearTimeout(turnTimer)
      turnTimer = null
    }
    if (releaseTimer !== null) {
      clearTimeout(releaseTimer)
      releaseTimer = null
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

  /**
   * Release the turn when it is ONLY waiting on a one-shot schedule timer: the
   * timer is set (its call completed), no foreground tool is open, and the
   * model has been quiet for `scheduleReleaseMs`. agy would otherwise park the
   * cascade until the timer fires — the DSH turn never ended, new user messages
   * queued behind it, and the wake-up landed inside the same turn (issue #225).
   */
  const armScheduleRelease = () => {
    if (releaseTimer !== null) {
      clearTimeout(releaseTimer)
      releaseTimer = null
    }
    if (settled || scheduleReleaseMs <= 0) return
    const armed = [...schedules.values()].some((s) => s.durationSeconds > 0 && s.done && !s.failed)
    if (!armed) return
    // A real foreground tool still running means real work: never release then.
    for (const id of activeTools) if (!schedules.has(id)) return
    const quiet = Date.now() - lastActivityAt
    if (quiet < scheduleReleaseMs) {
      releaseTimer = setTimeout(() => {
        releaseTimer = null
        armScheduleRelease()
      }, scheduleReleaseMs - quiet)
      releaseTimer.unref?.()
      return
    }
    if (settled || resolvePrompt === null) return
    settled = true
    clearTimers()
    const delayMs = Math.max(500, Math.round(Math.max(...[...schedules.values()].map((s) => s.durationSeconds)) * 1000))
    // Cancelling kills the timer inside agy; the host re-arms it from the
    // recording and wakes the session itself (backgroundWakeup).
    host.cancelSession(opts.sessionId)
    opts.onScheduleRelease?.({ delayMs })
    resolvePrompt({ stopReason: 'end_turn', _agyScheduleRelease: true, _agyScheduleDelayMs: delayMs })
  }

  const onUpdate = (update: Record<string, unknown>) => {
    lastActivityAt = Date.now()
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const tcId = typeof update.toolCallId === 'string' && update.toolCallId !== '' ? update.toolCallId : ''
      const status = typeof update.status === 'string' ? update.status.toLowerCase() : ''
      if (tcId !== '') {
        // The first `tool_call` names the tool and carries its input; later
        // `tool_call_update`s for the same call only carry the status.
        const name = typeof update.name === 'string' && update.name !== '' ? update.name : update.title
        const tracked = schedules.get(tcId)
        if (isScheduleToolName(name) || (name === undefined && tracked !== undefined)) {
          const duration = scheduleDurationSeconds(update.rawInput ?? update.args) || tracked?.durationSeconds || 0
          if (duration > 0) {
            schedules.set(tcId, {
              durationSeconds: duration,
              done: tracked?.done === true || status === 'completed',
              failed: status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled',
            })
          }
        }
        if (TERMINAL_TOOL_STATUS.has(status)) activeTools.delete(tcId)
        else activeTools.add(tcId)
      }
    }
    armIdle()
    armScheduleRelease()
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
      resolvePrompt = resolve
      const promptBlocks: Array<Record<string, unknown>> =
        opts.images && opts.images.length > 0
          ? [
              ...opts.images.map((img) => ({ type: 'image', data: img.data, mimeType: img.mimeType })),
              { type: 'text', text: opts.text },
            ]
          : [{ type: 'text', text: opts.text }]
      host.request(
        'session/prompt',
        {
          sessionId: opts.sessionId,
          prompt: promptBlocks,
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
