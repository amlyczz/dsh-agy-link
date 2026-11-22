// Filesystem scanners for post-turn background activity inside a conversation's
// `.system_generated/` directory (completion messages, task logs, subagents).
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

const TERMINAL_LOG_RE = /(?:The command exited with code \d+|Command exited with code \d+|\[exit code \d+\]|\[command timed out)/i
const SERVER_STOP_NOTICE_RE = /stopped due to server restart/i

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
        // ignore partial descriptor write
      }
    }
  } catch {
    // ignore missing dir
  }
  return out
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

export function pollSessionBrainDir(
  st: BrainScanState,
  brainDir: string,
  onNotice: (item: WakeNoticeItem) => void,
  alreadyDelivered: readonly string[] = [],
): { stoppedByServer: boolean } {
  // agy writes the same narration into BOTH the ACP stream and this message
  // directory. The stream copy was already shown (or woken on), so the file copy
  // is the same event seen twice: waking on it costs a second model turn.
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
