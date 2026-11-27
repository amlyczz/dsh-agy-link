// Incremental monitoring of agy background task logs (`tasks/*.log`) and
// completion/system notices (`messages/*.json`, `messages/undelivered/*.json`)
// inside a conversation's brain directory.
//
// Why this lives beside SubagentTracker: agy records background `run_command`
// stdout/stderr to `.system_generated/tasks/task-<N>.log` and writes
// completion/cancel/system notices to `.system_generated/messages/*.json`.
// Reading only newly appended bytes and unseen message files keeps the DSH
// stream alive during long background jobs without spawning extra agy turns.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { SubagentSnapshotItem } from './live.ts'

const MAX_READ_BYTES_PER_POLL = 128 * 1024
const MAX_LINES_PER_POLL = 20
const MAX_LINE_CHARS = 220
const MAX_MESSAGE_CHARS = 240
const TASK_DONE_RE = /\b(completed|finished|exited|done|succeeded|failed|crashed|cancelled|canceled|stopped|terminated|killed)\b|已完成|已结束|已退出|已中止|已取消|执行失败/i

interface TrackedTaskLog {
  taskId: string
  filePath: string
  offset: number
  decoder: StringDecoder
  rest: string
  seq: number
  sawActivity: boolean
  completed: boolean
  startedAt: number
  lastAt: number
  lastLine: string
}

export interface ActiveTaskLogSummary {
  taskId: string
  lastLine: string
  startedAt: number
  lastAt: number
}

export interface BackgroundActivityEvent {
  stepKey: string
  text: string
  raw: unknown
}

function noteWarn(log: ((msg: string) => void) | undefined, context: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err)
  log?.(`[task-activity] ${context}: ${detail}`)
}

function clipSingleLine(text: string, maxChars: number): string {
  const single = text.replace(/\r/g, '').replace(/\s+/g, ' ').trim()
  if (single.length <= maxChars) return single
  return single.slice(0, Math.max(0, maxChars - 1)) + '…'
}

export function formatTaskLogLine(taskId: string, line: string): string {
  return `[后台任务 · ${taskId}] ${clipSingleLine(line, MAX_LINE_CHARS)}`
}

export function summarizeMessageJson(rawObj: unknown, fallbackName = 'message'): { dedupKey: string; text: string } | null {
  if (!rawObj || typeof rawObj !== 'object') return null
  const obj = rawObj as {
    id?: unknown
    sender?: unknown
    content?: unknown
    renderDetails?: { messageTitle?: unknown } | unknown
  }
  const id = typeof obj.id === 'string' && obj.id.trim() !== '' ? obj.id.trim() : ''
  const rawSender = typeof obj.sender === 'string' ? obj.sender.trim() : ''
  const senderLabel = rawSender.includes('/') ? rawSender.slice(rawSender.lastIndexOf('/') + 1) : (rawSender || 'system')
  const details = obj.renderDetails && typeof obj.renderDetails === 'object'
    ? (obj.renderDetails as { messageTitle?: unknown })
    : undefined
  const title = typeof details?.messageTitle === 'string' ? clipSingleLine(details.messageTitle, 120) : ''
  const content = typeof obj.content === 'string' ? clipSingleLine(obj.content, MAX_MESSAGE_CHARS) : ''
  if (title === '' && content === '') return null

  const body =
    title !== '' && content !== '' && !content.toLowerCase().includes(title.toLowerCase())
      ? `${title} — ${content}`
      : (content !== '' ? content : title)
  return {
    dedupKey: id !== '' ? id : fallbackName,
    text: `[后台通知 · ${senderLabel}] ${body}`,
  }
}

function listFilesSafe(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(suffix))
      .sort()
  } catch {
    return []
  }
}

export class TaskActivityTracker {
  private readonly logs = new Map<string, TrackedTaskLog>()
  private readonly seenMessageFiles = new Set<string>()
  private readonly seenMessageIds = new Set<string>()
  private baselined = false

  private readonly log?: (msg: string) => void

  constructor(log?: (msg: string) => void) {
    this.log = log
  }

  reset(): void {
    this.logs.clear()
    this.seenMessageFiles.clear()
    this.seenMessageIds.clear()
    this.baselined = false
  }

  /** Record pre-existing logs and messages at EOF so resumed runs only emit new activity. */
  baseline(brainDir: string): void {
    this.baselined = true
    this.scanTaskLogs(brainDir, true, () => {})
    this.scanMessages(brainDir, true, () => {})
  }

  poll(brainDir: string, emit: (ev: BackgroundActivityEvent) => void): void {
    try {
      this.scanTaskLogs(brainDir, false, emit)
      this.scanMessages(brainDir, false, emit)
    } catch (err) {
      noteWarn(this.log, 'poll', err)
    }
  }

  private scanTaskLogs(brainDir: string, baselineOnly: boolean, emit: (ev: BackgroundActivityEvent) => void): void {
    const tasksDir = join(brainDir, '.system_generated', 'tasks')
    for (const file of listFilesSafe(tasksDir, '.log')) {
      const taskId = file.slice(0, -4)
      const fullPath = join(tasksDir, file)
      let tracked = this.logs.get(file)
      if (!tracked) {
        let initialOffset = 0
        if (baselineOnly || this.baselined) {
          // On a resumed conversation's initial baseline pass, seek to EOF of
          // pre-existing logs. Files created *after* baseline start at 0.
          if (baselineOnly) {
            try {
              const st = statSync(fullPath)
              if (st.isFile()) initialOffset = st.size
            } catch {
              initialOffset = 0
            }
          }
        }
        const now = Date.now()
        tracked = {
          taskId,
          filePath: fullPath,
          offset: initialOffset,
          decoder: new StringDecoder('utf8'),
          rest: '',
          seq: 0,
          sawActivity: !baselineOnly,
          completed: baselineOnly,
          startedAt: now,
          lastAt: now,
          lastLine: '',
        }
        this.logs.set(file, tracked)
      }
      if (baselineOnly) continue
      this.pollSingleTaskLog(tracked, emit)
    }
  }

  /** Mark every tracked task finished when the enclosing turn settles. */
  markAllStopped(now = Date.now()): void {
    for (const t of this.logs.values()) {
      if (!t.completed) {
        t.completed = true
        t.lastAt = now
      }
    }
  }

  /** Running background tasks observed during THIS turn (excluding baselined history). */
  activeTasks(now: number, liveWindowMs: number): ActiveTaskLogSummary[] {
    const out: ActiveTaskLogSummary[] = []
    for (const t of this.logs.values()) {
      if (!t.sawActivity || t.completed) continue
      if (now - t.lastAt > liveWindowMs) continue
      out.push({
        taskId: t.taskId,
        lastLine: t.lastLine,
        startedAt: t.startedAt,
        lastAt: t.lastAt,
      })
    }
    return out
  }

  /** Header-badge snapshot entries for active background tasks observed in this turn. */
  snapshotItems(now: number, liveWindowMs: number): SubagentSnapshotItem[] {
    const items: SubagentSnapshotItem[] = []
    for (const t of this.logs.values()) {
      if (!t.sawActivity) continue
      const running = !t.completed && now - t.lastAt <= liveWindowMs
      items.push({
        conversationId: `task:${t.taskId}`,
        role: t.taskId,
        typeName: 'Background Task',
        state: running ? 'RUNNING' : 'COMPLETED',
        running,
        lastAction: t.lastLine !== '' ? t.lastLine : '后台任务运行中…',
        startedAt: t.startedAt,
        lastAt: t.lastAt,
      })
    }
    return items
  }

  private pollSingleTaskLog(tracked: TrackedTaskLog, emit: (ev: BackgroundActivityEvent) => void): void {
    let size: number
    try {
      const st = statSync(tracked.filePath)
      if (!st.isFile()) return
      size = st.size
    } catch {
      return
    }
    if (size < tracked.offset) {
      tracked.offset = 0
      tracked.decoder = new StringDecoder('utf8')
      tracked.rest = ''
    }
    if (size === tracked.offset) return

    const toRead = Math.min(size - tracked.offset, MAX_READ_BYTES_PER_POLL)
    const buffer = Buffer.allocUnsafe(toRead)
    let bytesRead = 0
    try {
      const fd = openSync(tracked.filePath, 'r')
      try {
        bytesRead = readSync(fd, buffer, 0, toRead, tracked.offset)
      } finally {
        closeSync(fd)
      }
    } catch {
      return
    }
    if (bytesRead <= 0) return
    tracked.offset += bytesRead
    const now = Date.now()
    if (!tracked.sawActivity) tracked.startedAt = now
    tracked.sawActivity = true
    tracked.completed = false
    tracked.lastAt = now

    const chunk = tracked.rest + tracked.decoder.write(buffer.subarray(0, bytesRead))
    const parts = chunk.split('\n')
    tracked.rest = size > tracked.offset ? '' : (parts.pop() ?? '')
    if (size > tracked.offset) {
      // Fast-forward huge backlog bursts so one runaway log poll cannot stall the loop.
      tracked.offset = size
      tracked.decoder = new StringDecoder('utf8')
    }
    const lines = parts.map((l) => l.trim()).filter((l) => l !== '')
    if (lines.length === 0) return
    tracked.lastLine = clipSingleLine(lines[lines.length - 1] ?? '', MAX_LINE_CHARS)

    const skipped = Math.max(0, lines.length - MAX_LINES_PER_POLL)
    const visible = skipped > 0 ? lines.slice(-MAX_LINES_PER_POLL) : lines
    if (skipped > 0) {
      tracked.seq += 1
      emit({
        stepKey: `task-log-${tracked.taskId}-${tracked.seq}`,
        text: `[后台任务 · ${tracked.taskId}] … 跳过 ${skipped} 行中间输出，最新日志如下\n`,
        raw: { kind: 'task-log', taskId: tracked.taskId, skipped },
      })
    }
    for (const line of visible) {
      tracked.seq += 1
      emit({
        stepKey: `task-log-${tracked.taskId}-${tracked.seq}`,
        text: `${formatTaskLogLine(tracked.taskId, line)}\n`,
        raw: { kind: 'task-log', taskId: tracked.taskId, line },
      })
    }
  }

  private scanMessages(brainDir: string, baselineOnly: boolean, emit: (ev: BackgroundActivityEvent) => void): void {
    const baseDir = join(brainDir, '.system_generated', 'messages')
    const dirs: Array<{ tag: string; path: string }> = [
      { tag: 'delivered', path: baseDir },
      { tag: 'undelivered', path: join(baseDir, 'undelivered') },
    ]
    for (const dir of dirs) {
      for (const file of listFilesSafe(dir.path, '.json')) {
        const fileKey = `${dir.tag}:${file}`
        if (this.seenMessageFiles.has(fileKey)) continue
        this.seenMessageFiles.add(fileKey)

        const stem = file.slice(0, -5)
        let parsed: unknown
        try {
          parsed = JSON.parse(readFileSync(join(dir.path, file), 'utf8'))
        } catch {
          continue
        }
        const summary = summarizeMessageJson(parsed, stem)
        if (!summary) continue
        if (this.seenMessageIds.has(summary.dedupKey)) continue
        this.seenMessageIds.add(summary.dedupKey)
        if (baselineOnly) continue

        if (TASK_DONE_RE.test(summary.text)) {
          const doneAt = Date.now()
          for (const t of this.logs.values()) {
            if (summary.text.includes(t.taskId)) {
              t.completed = true
              t.lastAt = doneAt
              t.lastLine = clipSingleLine(summary.text, MAX_LINE_CHARS)
            }
          }
        }

        emit({
          stepKey: `task-msg-${summary.dedupKey}`,
          text: `${summary.text}\n`,
          raw: parsed,
        })
      }
    }
  }
}
