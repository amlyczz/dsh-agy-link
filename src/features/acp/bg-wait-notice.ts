// Early ACP session binding persistence + background-task wait visibility.
//
// Why this lives beside run-attempt.ts:
// 1. Persisting `conversationId` ONLY inside `finalizeAttempt` meant a manual
//    abort, crash, or DSH restart while agy was still holding a turn open for
//    a long background task lost the ACP session id on disk — forcing the next
//    turn into a cold 400k+ token re-compaction. Persisting an interim binding
//    on first real output makes the conversation immediately recoverable while
//    preserving the prior watermark until `finalizeAttempt` settles the turn.
// 2. When agy finishes streaming its visible reply text and then sits quietly
//    waiting on background tasks (`task-NNN.log`) before resolving the ACP
//    prompt, users saw an endlessly spinning Stop button with no clue why —
//    clicking Stop then sent `session/cancel` and killed the background work.
//    `BackgroundWaitMonitor` detects that quiet window once and emits a clear
//    live notice naming the running task(s).
import { confirmedPrefix } from '../../provider/system-budget.ts'
import type { AgyEvent } from '../../common/types.ts'
import type { createAttemptRecorder, AttemptDeps, AttemptInput } from '../../provider/attempt.ts'
import { mergeSentImageIds } from '../../provider/finalize.ts'

export interface ActiveBackgroundTaskSummary {
  taskId: string
  lastLine: string
  startedAt: number
  lastAt: number
}

/**
 * Durably persist an interim ACP conversation binding as soon as the session
 * produces its first real output. Preserves existing watermark/sentImageIds so
 * final settlement remains the single source of truth for message progression.
 */
export function persistInterimAcpBinding(opts: {
  deps: AttemptDeps
  input: AttemptInput
  recorder: ReturnType<typeof createAttemptRecorder>
  sid: string
}): boolean {
  const { deps, input, recorder, sid } = opts
  if (input.isAux || !input.persistBinding || input.sessionAccountKey === '' || sid === '') {
    return false
  }
  if (deps.isSuperseded(input.sessionKey, recorder.rec)) {
    return false
  }
  const existing = deps.store.get(input.sessionAccountKey)
  if (existing?.conversationId === sid) {
    return false
  }
  const resolvedCwd = input.binding?.cwd || existing?.cwd || input.workspaceRoot
  const inputTokens = input.binding?.lastInputTokens ?? existing?.lastInputTokens
  deps.store.set(input.sessionAccountKey, {
    conversationId: sid,
    lastMessageCount: input.binding?.lastMessageCount ?? existing?.lastMessageCount ?? 0,
    updatedAt: Date.now(),
    model: input.activeModel,
    ...confirmedPrefix(input.binding, sid),
    sentImageIds: mergeSentImageIds(input.binding?.sentImageIds ?? existing?.sentImageIds, []),
    ...(typeof inputTokens === 'number' && inputTokens > 0 ? { lastInputTokens: inputTokens } : {}),
    ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
  })
  return true
}

export interface BackgroundWaitMonitorOptions {
  /** Query currently running background tasks tracked for this turn. */
  getActiveTasks: () => readonly ActiveBackgroundTaskSummary[]
  /** Emit a single deduplicated notice into the live run stream. */
  emitNotice: (stepKey: string, text: string, raw: unknown) => void
  /** Quiet window after main text stops streaming before warning (default 12s). */
  quietMs?: number
  /** Polling cadence for checking the quiet window (default 3s). */
  checkIntervalMs?: number
  now?: () => number
}

/**
 * Watches an in-flight ACP turn for the "main text finished, now quietly
 * waiting on background task(s)" state and emits one clear explanation so the
 * user knows the turn is NOT stuck and that stopping will cancel those tasks.
 */
export class BackgroundWaitMonitor {
  private sawMainText = false
  private lastEventAt = 0
  private notified = false
  private timer: NodeJS.Timeout | null = null
  private readonly opts: BackgroundWaitMonitorOptions
  private readonly quietMs: number
  private readonly checkIntervalMs: number
  private readonly now: () => number

  constructor(opts: BackgroundWaitMonitorOptions) {
    this.opts = opts
    this.quietMs = opts.quietMs ?? 12_000
    this.checkIntervalMs = opts.checkIntervalMs ?? 3_000
    this.now = opts.now ?? (() => Date.now())
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => this.check(), this.checkIntervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  noteEvent(ev: AgyEvent): void {
    if (ev.kind === 'step' && ev.stepKind === 'subagent') return
    this.lastEventAt = this.now()
    if (ev.kind === 'step' && ev.stepKind === 'text' && ev.text.trim() !== '') {
      this.sawMainText = true
    }
  }

  check(): boolean {
    if (this.notified || !this.sawMainText || this.lastEventAt === 0) return false
    if (this.now() - this.lastEventAt < this.quietMs) return false
    const tasks = this.opts.getActiveTasks()
    if (tasks.length === 0) return false
    this.notified = true
    const ids = tasks.map((t) => t.taskId).join(', ')
    const text =
      `[后台等待] 主回复已输出完毕，agy 正在等待 ${tasks.length} 个后台任务（${ids}）完成后结束本回合；若此时点击停止，这些后台任务也会被一并中止。\n` +
      `[Background wait] Main reply finished; agy is waiting for ${tasks.length} background task(s) (${ids}) before ending this turn. Stopping now will also cancel them.\n`
    this.opts.emitNotice(`acp-bg-wait-${tasks[0]!.taskId}`, text, {
      kind: 'acp-bg-wait',
      tasks: tasks.map((t) => t.taskId),
    })
    return true
  }
}

export function createBackgroundWaitMonitor(
  subTracker: { activeBackgroundTasks: () => readonly ActiveBackgroundTaskSummary[] } | null,
  recorder: ReturnType<typeof createAttemptRecorder>,
): BackgroundWaitMonitor | null {
  if (!subTracker) return null
  return new BackgroundWaitMonitor({
    getActiveTasks: () => subTracker.activeBackgroundTasks(),
    emitNotice: (stepKey, text, raw) => recorder.rec.append({ kind: 'step', stepKey, stepKind: 'subagent', text, raw }),
  })
}

