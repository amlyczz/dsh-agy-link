// Filesystem scanners for post-turn background activity inside a conversation's
// `.system_generated/` directory (completion messages, task logs, subagents).
//
// Slice 2 of #156: a CLI turn can hand work to a detached process, a scheduled
// task, or a subagent. Those keep running after the `-p` process exits and write
// their outcome here; polling these files is what turns "it finished" into a
// wakeup instead of a result the user has to go looking for.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { WakeNoticeItem } from './schedule-parse.ts'

export interface WatchedTaskLog {
  file: string
  path: string
  terminalReported: boolean
}

export interface BrainScanState {
  seenMessageKeys: Set<string>
  knownTaskLogs: Map<string, WatchedTaskLog>
  knownSubagents: Map<string, string>
  seenWakeKeys: Set<string>
}

// agy writes the outcome of a detached job into `.system_generated/messages/`
// as a completion message; the `tasks/*.log` file only holds the job's raw
// stdout/stderr and, on agy 1.5.14, ends with whatever the command printed (a
// test summary, a gate banner, nothing at all). The marker below therefore
// mostly matches mocked fixtures and transports that append an exit line; the
// message path is the authoritative one for real runs.
const TERMINAL_LOG_RE = /(?:The command exited with code \d+|Command exited with code \d+|\[exit code \d+\]|\[command timed out)/i
const TASK_SENDER_RE = /(?:^|\/)task-(\d+)$/
const TASK_LOG_URI_RE = /Log:\s*file:\/\/([^\s]+)/i
const TASK_RESULT_RE = /finished with (?:result|status):?\s*([^\n]{0,160})/i

/**
 * The language server emits this when it restarts, not when a job finished.
 * Waking the session for it would be a false positive the user cannot act on,
 * so it is deliberately ignored (see the counter-example test).
 */
const SERVER_STOP_NOTICE_RE = /stopped due to server restart/i

function rawContent(rawObj: unknown): string {
  if (!rawObj || typeof rawObj !== 'object') return ''
  const content = (rawObj as { content?: unknown }).content
  return typeof content === 'string' ? content : ''
}

function readTailText(filePath: string): string {
  try {
    const st = statSync(filePath)
    if (!st.isFile() || st.size === 0) return ''
    const raw = readFileSync(filePath, 'utf8')
    return raw.length <= 4096 ? raw : raw.slice(-4096)
  } catch {
    return ''
  }
}

export function listSubagentStates(brainDir: string): Map<string, string> {
  const dir = join(brainDir, '.system_generated', 'subagents')
  const out = new Map<string, string>()
  if (!existsSync(dir)) return out
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
          conversationId?: unknown
          state?: unknown
        }
        const id = typeof parsed.conversationId === 'string' && parsed.conversationId !== ''
          ? parsed.conversationId
          : file.slice(0, -5)
        const state = typeof parsed.state === 'string' ? parsed.state : ''
        out.set(id, state)
      } catch {
        // ignore a partially written descriptor
      }
    }
  } catch {
    // ignore missing dir
  }
  return out
}

/**
 * Pull the detached task id out of a completion message.
 *
 * Real agy sends the outcome as a message from `<conversation>/task-<n>` with
 * "Task id ... finished with result: Command exited with code 0." in the body,
 * and the matching `tasks/task-<n>.log` only contains the command's own output.
 * Reading the sender is therefore what tells us a background job finished; the
 * log file is just where the output is.
 */
export function taskIdFromMessage(rawObj: unknown): string | undefined {
  if (!rawObj || typeof rawObj !== 'object') return undefined
  const sender = (rawObj as { sender?: unknown }).sender
  if (typeof sender === 'string') {
    const m = TASK_SENDER_RE.exec(sender.trim())
    if (m?.[1]) return `task-${m[1]}`
  }
  return undefined
}

/** Absolute path of the task log a completion message points at, if it names one. */
export function taskLogFromMessage(rawObj: unknown): string | undefined {
  if (!rawObj || typeof rawObj !== 'object') return undefined
  const content = (rawObj as { content?: unknown }).content
  if (typeof content !== 'string') return undefined
  const m = TASK_LOG_URI_RE.exec(content)
  const raw = m?.[1]
  if (raw === undefined || raw === '') return undefined
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export function summarizeWakeMessage(rawObj: unknown, fallbackName: string): { dedupKey: string; sender?: string; text: string } | null {
  if (!rawObj || typeof rawObj !== 'object') return null
  const obj = rawObj as {
    id?: unknown
    sender?: unknown
    content?: unknown
    renderDetails?: { messageTitle?: unknown } | unknown
  }
  const id = typeof obj.id === 'string' && obj.id.trim() !== '' ? obj.id.trim() : ''
  const rawSender = typeof obj.sender === 'string' ? obj.sender.trim() : ''
  const details = obj.renderDetails && typeof obj.renderDetails === 'object' ? (obj.renderDetails as { messageTitle?: unknown }) : undefined
  const title = typeof details?.messageTitle === 'string' ? details.messageTitle.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
  const content = typeof obj.content === 'string' ? obj.content.replace(/\s+/g, ' ').trim().slice(0, 240) : ''
  if (title === '' && content === '') return null
  const text = title !== '' && content !== '' && !content.toLowerCase().includes(title.toLowerCase()) ? `${title} — ${content}` : (content || title)
  return {
    dedupKey: id !== '' ? id : fallbackName,
    ...(rawSender !== '' ? { sender: rawSender } : {}),
    text,
  }
}

/**
 * Record everything already present so the first poll only reports what
 * arrived *after* the turn ended. Returns true when a subagent was still alive.
 */
export function baselineSessionBrain(st: BrainScanState, brainDir: string): boolean {
  const msgBase = join(brainDir, '.system_generated', 'messages')
  for (const dir of [msgBase, join(msgBase, 'undelivered')]) {
    if (!existsSync(dir)) continue
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.json')) continue
        st.seenMessageKeys.add(file.slice(0, -5))
        try {
          const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { id?: unknown }
          if (typeof parsed?.id === 'string' && parsed.id.trim() !== '') st.seenMessageKeys.add(parsed.id.trim())
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }
  const tasksDir = join(brainDir, '.system_generated', 'tasks')
  if (existsSync(tasksDir)) {
    try {
      for (const file of readdirSync(tasksDir)) {
        if (!file.endsWith('.log')) continue
        const full = join(tasksDir, file)
        st.knownTaskLogs.set(file, { file, path: full, terminalReported: TERMINAL_LOG_RE.test(readTailText(full)) })
      }
    } catch {
      // ignore
    }
  }
  const subStates = listSubagentStates(brainDir)
  st.knownSubagents.clear()
  let hasAlive = false
  for (const [id, state] of subStates) {
    st.knownSubagents.set(id, state)
    if (state === '' || state === 'SUBAGENT_STATE_ALIVE') hasAlive = true
  }
  return hasAlive
}

/** Collapse whitespace so a wrapped copy of the same sentence still matches. */
function flatText(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * One scan of the brain directory; reports new messages, finished tasks, and
 * subagent transitions.
 *
 * `alreadyDelivered` holds text the host has already shown the user (an ACP
 * post-turn report written straight into the transcript). agy mirrors that same
 * narration into `.system_generated/messages`, so without this the model would
 * be woken to re-read a sentence already on screen.
 */
export function pollSessionBrainDir(
  st: BrainScanState,
  brainDir: string,
  onNotice: (item: WakeNoticeItem) => void,
  alreadyDelivered: readonly string[] = [],
): { stoppedByServer: boolean } {
  const delivered = new Set(alreadyDelivered.map(flatText).filter((t) => t !== ''))
  const msgBase = join(brainDir, '.system_generated', 'messages')
  for (const dir of [msgBase, join(msgBase, 'undelivered')]) {
    if (!existsSync(dir)) continue
    try {
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
        const stem = file.slice(0, -5)
        if (st.seenMessageKeys.has(stem)) continue
        st.seenMessageKeys.add(stem)
        let parsed: unknown
        try { parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) } catch { continue }
        const summary = summarizeWakeMessage(parsed, stem)
        if (!summary || st.seenMessageKeys.has(summary.dedupKey)) continue
        st.seenMessageKeys.add(summary.dedupKey)
        if (SERVER_STOP_NOTICE_RE.test(summary.text)) return { stoppedByServer: true }
        if (delivered.has(flatText(summary.text))) continue
        const finishedTask = taskIdFromMessage(parsed)
        if (finishedTask !== undefined) {
          // A detached job reported its outcome. This is the only reliable
          // "it finished" signal agy gives us: the log file itself is just the
          // command's output and carries no exit marker.
          const wakeKey = `task-done:${finishedTask}`
          const known = st.knownTaskLogs.get(`${finishedTask}.log`)
          if (known !== undefined) known.terminalReported = true
          if (st.seenWakeKeys.has(wakeKey)) continue
          st.seenWakeKeys.add(wakeKey)
          const result = TASK_RESULT_RE.exec(rawContent(parsed))?.[1]?.trim()
          const logPath = taskLogFromMessage(parsed) ?? known?.path
          onNotice({
            kind: 'task-log',
            label: `Task ${finishedTask} finished`,
            detail: result !== undefined && result !== '' ? result : summary.text,
            sender: finishedTask,
            ...(logPath !== undefined ? { logPath } : {}),
          })
          continue
        }
        const wakeKey = `msg:${summary.dedupKey}`
        if (st.seenWakeKeys.has(wakeKey)) continue
        st.seenWakeKeys.add(wakeKey)
        const sender = summary.sender
        onNotice({
          kind: 'message',
          label: sender ? `Message from ${sender.includes('/') ? sender.slice(sender.lastIndexOf('/') + 1) : sender}` : 'Background message',
          detail: summary.text,
          ...(sender ? { sender } : {}),
        })
      }
    } catch {
      // ignore
    }
  }

  const tasksDir = join(brainDir, '.system_generated', 'tasks')
  if (existsSync(tasksDir)) {
    try {
      for (const file of readdirSync(tasksDir)) {
        if (!file.endsWith('.log')) continue
        const full = join(tasksDir, file)
        let entry = st.knownTaskLogs.get(file)
        if (!entry) {
          entry = { file, path: full, terminalReported: false }
          st.knownTaskLogs.set(file, entry)
        }
        if (entry.terminalReported) continue
        const match = TERMINAL_LOG_RE.exec(readTailText(full))
        if (!match) continue
        entry.terminalReported = true
        const taskId = file.slice(0, -4)
        const wakeKey = `task-exit:${taskId}`
        if (!st.seenWakeKeys.has(wakeKey)) {
          st.seenWakeKeys.add(wakeKey)
          onNotice({ kind: 'task-log', label: `Task ${taskId} finished`, detail: match[0], sender: taskId, logPath: full })
        }
      }
    } catch {
      // ignore
    }
  }

  for (const [subId, newState] of listSubagentStates(brainDir)) {
    const prev = st.knownSubagents.get(subId)
    st.knownSubagents.set(subId, newState)
    if ((prev === undefined || prev === '' || prev === 'SUBAGENT_STATE_ALIVE') && newState !== '' && newState !== 'SUBAGENT_STATE_ALIVE') {
      const wakeKey = `sub-state:${subId}:${newState}`
      if (!st.seenWakeKeys.has(wakeKey)) {
        st.seenWakeKeys.add(wakeKey)
        onNotice({ kind: 'subagent', label: `Subagent ${subId}`, detail: `Subagent transitioned to ${newState}`, sender: subId })
      }
    }
  }
  return { stoppedByServer: false }
}
