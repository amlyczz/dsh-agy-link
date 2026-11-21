// Pure extraction and formatting helpers for post-turn background wakeups.
import type { Message } from '@deepseek-ai/dsh-llm'
import type { ReadableRecordingLike } from '../../common/background-types.ts'
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

/** True when a user message was injected by dsh-agy-link's own background wake watcher. */
export function isBackgroundWakeupNotice(msg: Message | undefined): boolean {
  if (!msg || msg.role !== 'user') return false
  const src = (msg as unknown as { source?: { kind?: unknown; plugin?: unknown; form?: unknown } }).source
  return src?.kind === 'plugin' && src?.plugin === 'agy-link' && src?.form === 'notice'
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

    if (ev.state === 'RUNNING') {
      const output = typeof ev.tool.output === 'string' ? ev.tool.output : ev.text
      const taskMatch = /\b(task-\d+)\b/i.exec(output) ?? /\b(task-\d+)\b/i.exec(JSON.stringify(input))
      const hasTaskId = taskMatch !== null || typeof input.bgTaskId === 'string'
      if (BACKGROUND_TOOL_NAMES.has(name) || hasTaskId) {
        const taskId = taskMatch?.[1] ?? (typeof input.bgTaskId === 'string' ? input.bgTaskId : undefined)
        const cmd = pick(input, 'CommandLine', 'command_line', 'command', 'cmd', 'Role', 'role', 'Description', 'description')
        backgroundTools.push({
          stepKey: ev.stepKey,
          toolName: unwrapped.tool,
          ...(taskId ? { taskId } : {}),
          summary: cmd ? clipText(cmd, 120) : (taskId ?? unwrapped.tool),
        })
      }
    }
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
