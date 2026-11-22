// Pure extraction and formatting helpers for post-turn background wakeups.
import type { Message } from '@deepseek-ai/dsh-llm'
import type { ReadableRecordingLike } from '../../common/background-types.ts'
import type { AgyEvent } from '../../common/types.ts'
import { isAgyLinkNoticeSource } from '../../common/agy-link-source.ts'
import { pick, unwrapMcpTool } from '../../provider/mirror/args.ts'

const BACKGROUND_TOOL_NAMES = new Set([
  'run_command',
  'bash',
  'execute_command',
  'ops_bash',
  'sh',
  'shell',
  'invoke_subagent',
  'run_workflow',
  'swarm',
])

export interface PendingScheduleSignal {
  readonly stepKey: string
  readonly delayMs: number
  readonly durationSeconds: number
  readonly prompt: string
  readonly timerCondition: string
  readonly cronExpression?: string
}

export interface PendingBackgroundToolSignal {
  readonly stepKey: string
  readonly toolName: string
  readonly taskId?: string
  readonly summary: string
}

export interface ExtractedBackgroundSignals {
  readonly schedules: readonly PendingScheduleSignal[]
  readonly backgroundTools: readonly PendingBackgroundToolSignal[]
  readonly ignoredRecurringCron: boolean
}

export interface WakeNoticeItem {
  readonly kind: 'schedule' | 'task-log' | 'message' | 'subagent' | 'acp'
  readonly label: string
  readonly detail: string
  readonly sender?: string
  readonly logPath?: string
}

function numArg(input: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const raw = input[k]
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    if (typeof raw === 'string' && raw.trim() !== '') {
      const n = Number(raw.trim())
      if (Number.isFinite(n)) return n
    }
  }
  return undefined
}

function clipText(text: string, maxChars: number): string {
  const flat = text.replace(/\r/g, '').replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  return flat.slice(0, Math.max(0, maxChars - 1)) + '…'
}

/** ACP statuses that mean the tool call has not reached a terminal state yet. */
const ACP_LIVE_STATUSES = new Set(['pending', 'in_progress', 'running', 'active'])

/**
 * True when a tool call had not finished when the turn ended — the signal that
 * it was handed off to the background. `RUNNING` is what the CLI transport
 * reports; ACP never says RUNNING (it only knows pending / in_progress /
 * completed), so a live ACP status counts as well. A call that already received
 * a terminal update is never treated as background, however live it looked
 * earlier in the same turn.
 */
function isStillLive(state: string | undefined, rawStatus: string | undefined): boolean {
  // Compare case-insensitively: the recorder maps CLI statuses to upper case
  // (RUNNING / DONE) while callers and fixtures sometimes hand over the raw
  // lower-case vocabulary. Both spellings mean the same thing.
  const mapped = (state ?? '').toLowerCase()
  if (mapped === 'done' || mapped === 'error' || mapped === 'canceled' || mapped === 'cancelled') return false
  if (mapped === 'running' || mapped === 'active' || mapped === 'pending' || mapped === 'in_progress') return true
  const status = (rawStatus ?? '').toLowerCase()
  if (status !== '' && ACP_LIVE_STATUSES.has(status)) return true
  return ACP_LIVE_STATUSES.has(mapped)
}

/** Cheap pre-filter: could this call plausibly start a background job? */
function hasBackgroundTaskHint(input: Record<string, unknown>, ev: Extract<AgyEvent, { kind: 'step' }>): boolean {
  if (typeof input.bgTaskId === 'string') return true
  const text = typeof ev.tool?.output === 'string' ? ev.tool.output : ev.text
  if (/\b(task-\d+)\b/i.test(text)) return true
  try {
    return /\b(task-\d+)\b/i.test(JSON.stringify(input))
  } catch {
    return false
  }
}

/** True when a user message was injected by dsh-agy-link's own background wake watcher. */
export function isBackgroundWakeupNotice(msg: Message | undefined): boolean {
  if (!msg || msg.role !== 'user') return false
  return isAgyLinkNoticeSource((msg as unknown as { source?: { kind?: unknown; form?: unknown } }).source)
}

export function extractAttemptBackgroundSignals(
  rec: ReadableRecordingLike,
  now = Date.now(),
): ExtractedBackgroundSignals {
  const schedules: PendingScheduleSignal[] = []
  const backgroundTools: PendingBackgroundToolSignal[] = []
  let ignoredRecurringCron = false

  // Track which tool steps had later substantial assistant/tool progress
  // well after the schedule call (indicating in-turn self-wakeup).
  const scheduleCandidates: Array<{ index: number; ts: number; item: PendingScheduleSignal }> = []
  // Last event seen per tool call, filled in the first pass and judged in the
  // second one (see the comment there).
  const toolCalls = new Map<string, {
    toolName: string
    name: string
    input: Record<string, unknown>
    event: Extract<AgyEvent, { kind: 'step' }>
  }>()

  for (let i = 0; i < rec.length; i++) {
    const ev = rec.eventAt(i)
    if (!ev || ev.kind !== 'step' || ev.stepKind !== 'tool' || !ev.tool) continue
    const unwrapped = unwrapMcpTool(ev.tool.name, ev.tool.args)
    const name = unwrapped.tool.toLowerCase()
    const input = unwrapped.input
    const evTs = rec.eventTimestampAt?.(i) ?? now

    if (name === 'schedule') {
      const cron = pick(input, 'CronExpression', 'cron_expression')
      const duration = numArg(input, 'DurationSeconds', 'duration_seconds')
      const prompt = pick(input, 'Prompt', 'prompt') ?? 'Check scheduled task progress and continue.'
      const cond = pick(input, 'TimerCondition', 'timer_condition') ?? 'never'
      if (cron && (!duration || duration <= 0)) {
        ignoredRecurringCron = true
        continue
      }
      if (duration !== undefined && duration > 0 && ev.state !== 'ERROR' && ev.state !== 'CANCELED' && ev.state !== 'CANCELLED') {
        scheduleCandidates.push({
          index: i,
          ts: evTs,
          item: {
            stepKey: ev.stepKey,
            delayMs: Math.max(500, Math.round(duration * 1000)),
            durationSeconds: duration,
            prompt: clipText(prompt, 500),
            timerCondition: cond,
            ...(cron ? { cronExpression: cron } : {}),
          },
        })
      }
      continue
    }

    // Remember the LAST event of every tool call: its final state decides
    // whether the call was a background job still running when the turn ended.
    if (BACKGROUND_TOOL_NAMES.has(name) || hasBackgroundTaskHint(input, ev)) {
      toolCalls.set(ev.stepKey, { toolName: unwrapped.tool, name, input, event: ev })
    }
  }

  for (const call of toolCalls.values()) {
    // `stillLive` is the state of the LAST event seen for this call:
    //   • CLI reports terminal states in place (DONE / ERROR) and marks a job
    //     that is still running as RUNNING.
    //   • ACP reports `in_progress` / `pending` while the tool lives and sends a
    //     `completed` update for the same toolCallId when it finishes. A call
    //     still not terminal when the turn ended is exactly the background job
    //     we must keep watching; a call that DID get a terminal update is not,
    //     however live it looked earlier.
    if (!isStillLive(call.event.state, call.event.rawStatus)) continue
    const output = typeof call.event.tool?.output === 'string' ? call.event.tool.output : call.event.text
    const taskMatch = /\b(task-\d+)\b/i.exec(output) ?? /\b(task-\d+)\b/i.exec(JSON.stringify(call.input))
    const taskId = taskMatch?.[1] ?? (typeof call.input.bgTaskId === 'string' ? call.input.bgTaskId : undefined)
    if (!BACKGROUND_TOOL_NAMES.has(call.name) && taskId === undefined) continue
    const cmd = pick(call.input, 'CommandLine', 'command_line', 'command', 'cmd', 'Role', 'role', 'Description', 'description')
    backgroundTools.push({
      stepKey: call.event.stepKey,
      toolName: call.toolName,
      ...(taskId ? { taskId } : {}),
      summary: cmd ? clipText(cmd, 120) : (taskId ?? call.toolName),
    })
  }

  for (const cand of scheduleCandidates) {
    const elapsed = Math.max(0, now - cand.ts)
    let sawSubstantialLaterWork = false
    for (let j = cand.index + 1; j < rec.length; j++) {
      const later = rec.eventAt(j)
      if (!later || later.kind !== 'step') continue
      if (later.stepKind === 'tool' && later.tool?.name.toLowerCase() !== 'schedule') {
        sawSubstantialLaterWork = true
        break
      }
      const laterText = later.stepKind === 'subagent' ? later.text : ''
      if (laterText.includes('[后台通知') && laterText.toLowerCase().includes(cand.item.stepKey.toLowerCase())) {
        sawSubstantialLaterWork = true
        break
      }
    }
    if (sawSubstantialLaterWork && elapsed >= cand.item.delayMs) {
      continue
    }
    const remainingMs = Math.max(500, cand.item.delayMs - elapsed)
    schedules.push({ ...cand.item, delayMs: remainingMs })
  }

  return { schedules, backgroundTools, ignoredRecurringCron }
}

export function matchesTimerCondition(condition: string, sender: string | undefined): boolean {
  const cond = condition.trim()
  if (cond === '' || cond.toLowerCase() === 'never') return false
  if (cond.toLowerCase() === 'any') return true
  if (!sender) return false
  const normSender = sender.trim().toLowerCase()
  const normCond = cond.toLowerCase()
  return normSender === normCond || normSender.endsWith('/' + normCond) || normSender.includes(normCond)
}

export function buildWakeupMessageText(items: readonly WakeNoticeItem[]): { summary: string; text: string } {
  const first = items[0]
  const summary =
    items.length === 1 && first
      ? clipText(`${first.label}: ${first.detail}`, 115)
      : clipText(`${items.length} background task updates (${first?.label ?? 'agy'})`, 115)

  const lines = [
    '[Background Task Wakeup · dsh-agy-link]',
    'One or more background activities or scheduled timers for this Antigravity session triggered after the previous turn ended:',
    '',
  ]
  for (const item of items) {
    lines.push(`- [${item.kind}] ${item.label}: ${item.detail}`)
    if (item.logPath) {
      lines.push(`  Log: ${item.logPath}`)
    }
  }
  lines.push(
    '',
    'Please inspect the updated state/output, execute any follow-up action requested by the scheduled task or finished job, and report the result concisely. Do not claim completion if the task is still incomplete or failed.',
  )
  return { summary, text: lines.join('\n') }
}