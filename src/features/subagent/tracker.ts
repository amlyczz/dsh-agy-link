// Subagent Activity Tracker: monitors background subagents and task transcripts
// in agy's brain directory, streaming real-time progress events into DSH's
// reasoning channel so the user sees 1:1 what agy and its workers are doing.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  extractQuotaErrorModel,
  isTransientBurstRateLimit,
  looksLikeHardRateLimit,
  looksLikeTosViolation,
  parseResetDurationMs,
  type AgyEvent,
} from '../../common/types.ts'
import { findBrainDir } from '../../runtime/agy/db/paths.ts'
import { TaskActivityTracker } from './task-activity.ts'
import { ParentQuotaMonitor, type SubagentQuotaExhaustedInfo } from './parent-quota.ts'
import { attachSubagentTracker, detachSubagentTracker, SUBAGENT_LIVE_WINDOW_MS, type SubagentSnapshot, type SubagentSnapshotItem } from './live.ts'

export type { SubagentQuotaExhaustedInfo }

export interface SubagentTrackerOptions {
  conversationId?: string
  /** DSH session id, so the header badge can scope this tracker's subagents. */
  sessionKey?: string
  accountHome?: string
  /**
   * True when attaching to a resumed multi-turn conversation: pre-existing
   * subagent transcripts are baselined at current EOF so previous turns'
   * subagent history is never replayed.
   */
  resumed?: boolean
  onEvent: (event: AgyEvent) => void
  onQuotaExhausted?: (info: SubagentQuotaExhaustedInfo) => void
  noteActivity?: () => void
  pollIntervalMs?: number
  /** Reports failures that are not ordinary file churn (a half-written row, a file being rotated). */
  log?: (message: string) => void
}

/**
 * Swallow the failures a live transcript produces by design — a row still being
 * written, a file replaced under us — and surface anything else, so a plain code
 * bug cannot hide behind an empty `catch`.
 */
function noteFailure(log: ((message: string) => void) | undefined, what: string, err: unknown): void {
  if (err instanceof SyntaxError) return
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') return
  log?.(`subagent tracker: ${what} — ${String(err)}`)
}

interface TranscriptCursor {
  /** Bytes of `transcript.jsonl` already consumed. */
  offset: number
  /** Incremental UTF-8 decoder so split multi-byte characters never corrupt. */
  decoder: StringDecoder
  /** Trailing partial line from the last read (the file ends without a newline). */
  rest: string
}

function createTranscriptCursor(offset = 0): TranscriptCursor {
  return { offset, decoder: new StringDecoder('utf8'), rest: '' }
}

function fileSizeOrZero(logPath: string): number {
  try {
    const st = statSync(logPath)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  }
}

function readTranscriptDelta(logPath: string, cursor: TranscriptCursor): string[] {
  let size: number
  try {
    const st = statSync(logPath)
    if (!st.isFile()) return []
    size = st.size
  } catch {
    return []
  }
  if (size < cursor.offset) {
    cursor.offset = 0
    cursor.decoder = new StringDecoder('utf8')
    cursor.rest = ''
  }
  if (size === cursor.offset) return []

  const length = size - cursor.offset
  const buffer = Buffer.allocUnsafe(length)
  let bytesRead = 0
  try {
    const fd = openSync(logPath, 'r')
    try {
      bytesRead = readSync(fd, buffer, 0, length, cursor.offset)
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
  if (bytesRead <= 0) return []
  cursor.offset += bytesRead

  const chunk = cursor.rest + cursor.decoder.write(buffer.subarray(0, bytesRead))
  const parts = chunk.split('\n')
  cursor.rest = parts.pop() ?? ''
  return parts.filter((line) => line.trim() !== '')
}

export function extractAuthoritativeSubagentQuotaError(text: string, fromParentSystemMessage: boolean): boolean {
  if (!text) return false
  if (!looksLikeHardRateLimit(text) || isTransientBurstRateLimit(text) || looksLikeTosViolation(text)) {
    return false
  }
  if (fromParentSystemMessage) {
    return /The subagent\b[\s\S]*?\bencountered an error/i.test(text)
  }
  if (/Command exited with code\b/i.test(text)) return false
  return /image failed to generate|failed to generate content|cloudcode-pa\.googleapis\.com|RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED|Individual quota reached|agent executor error/i.test(
    text,
  )
}

interface TrackedSubagent {
  conversationId: string
  role: string
  typeName: string
  brainDir: string
  /** Last observed descriptor state (e.g. SUBAGENT_STATE_ALIVE / KILLED). */
  state?: string
  /** True once descriptor reached a non-active state (stop polling transcript). */
  terminal: boolean
  cursor: TranscriptCursor
  /** Lines consumed so far — the fallback step index when a row carries none. */
  lines: number
  startedAt: number; lastAt: number; lastAction: string
}

function isActiveSubagentState(state: string | undefined): boolean {
  return state === undefined || state === '' || state === 'SUBAGENT_STATE_ALIVE'
}

function isTerminalTranscriptStatus(status: unknown): status is string {
  return typeof status === 'string' && /^(ERROR|FAILED|CANCELED|CANCELLED)$/i.test(status.trim())
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

function parseJsonObj(v: unknown): Record<string, unknown> {
  if (!v) return {}
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v)
      if (p && typeof p === 'object' && !Array.isArray(p)) return p as Record<string, unknown>
    } catch {
      // ignore
    }
  }
  return {}
}

function stringArg(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v !== '') return stripQuotes(v)
  }
  return ''
}

export function formatSubagentAction(role: string, tool: string, rawArgs: unknown): string {
  const args = parseJsonObj(rawArgs)
  const prefix = `[子代理 · ${role}]`
  switch (tool) {
    case 'view_file':
    case 'read_file': {
      const p = stringArg(args, 'Path', 'path', 'TargetFile', 'target_file', 'AbsolutePath', 'targetFile')
      const name = p ? basename(p.replace(/\\/g, '/')) : ''
      return `${prefix} 正在查阅文件: ${name || p || 'file'}`
    }
    case 'edit_file':
    case 'replace_file_content':
    case 'write_file':
    case 'create_file': {
      const p = stringArg(args, 'Path', 'path', 'TargetFile', 'target_file', 'AbsolutePath')
      const name = p ? basename(p.replace(/\\/g, '/')) : ''
      return `${prefix} 正在修改/创建文件: ${name || p || 'file'}`
    }
    case 'search_web':
    case 'web_search': {
      const q = stringArg(args, 'query', 'Query', 'q')
      return `${prefix} 正在检索网络: "${q.slice(0, 80)}"`
    }
    case 'grep_search':
    case 'find_by_name': {
      const q = stringArg(args, 'pattern', 'Pattern', 'query', 'Query', 'filename', 'Target')
      return `${prefix} 正在检索代码: "${q.slice(0, 60)}"`
    }
    case 'list_dir':
    case 'ls': {
      const p = stringArg(args, 'Path', 'path', 'Directory', 'dir')
      return `${prefix} 正在浏览目录: ${p || '.'}`
    }
    case 'run_command':
    case 'bash':
    case 'execute_command': {
      const summary = stringArg(args, 'toolSummary', 'description', 'Description')
      const cmd = stringArg(args, 'CommandLine', 'command_line', 'command', 'cmd')
      return `${prefix} 正在执行终端命令: ${summary || cmd.slice(0, 70)}`
    }
    case 'generate_image': {
      const p = stringArg(args, 'prompt', 'Prompt', 'image_name')
      return `${prefix} 正在生成参考图像: ${p.slice(0, 60)}`
    }
    case 'send_message': {
      return `${prefix} 阶段调研完成，正在向主代理提交报告`
    }
    case 'invoke_subagent': {
      const r = stringArg(args, 'Role', 'role', 'TypeName', 'typeName')
      return `${prefix} 启动协同专员: ${r || 'subagent'}`
    }
    case 'manage_subagents': {
      const a = stringArg(args, 'Action', 'action')
      return `${prefix} 正在协调子代理状态 (${a || 'status'})`
    }
    case 'schedule': {
      return `${prefix} 设置后台定时任务`
    }
    default: {
      return `${prefix} 执行操作: ${tool}`
    }
  }
}

export class SubagentTracker {
  private conversationId: string
  private readonly accountHome: string | undefined
  private brainDir: string | null = null
  private readonly trackedSubagents = new Map<string, TrackedSubagent>()
  private readonly seenStepKeys = new Set<string>()
  private readonly taskActivity: TaskActivityTracker
  private readonly parentQuota = new ParentQuotaMonitor()
  private timer: NodeJS.Timeout | null = null
  private active = false
  private polling = false
  private readonly pollIntervalMs: number
  private parentCursor: TranscriptCursor = createTranscriptCursor()
  private sessionKey: string
  setSessionKey(key: string): void { this.sessionKey = key }
  private parentLines = 0

  constructor(private readonly opts: SubagentTrackerOptions) {
    this.conversationId = opts.conversationId ?? ''
    this.accountHome = opts.accountHome
    this.sessionKey = opts.sessionKey ?? ''
    this.pollIntervalMs = opts.pollIntervalMs ?? 500
    this.taskActivity = new TaskActivityTracker(opts.log)
  }

  /** Follow the conversation agy reported in its stream-json init/result envelope. */
  setConversationId(cid: string): void {
    if (cid === '' || cid === this.conversationId) return
    this.conversationId = cid
    this.brainDir = null
    this.baselined = false
    this.parentCursor = createTranscriptCursor()
    this.parentLines = 0
    this.taskActivity.reset()
    this.parentQuota.reset()
    if (this.active) {
      if (this.opts.resumed === true) {
        this.baselined = true
        this.baselineExisting()
      }
      this.poll()
    }
  }

  private baselined = false

  start(): void {
    if (this.active) return
    this.active = true
    attachSubagentTracker(this.sessionKey, this)
    if (this.opts.resumed === true && !this.baselined && this.conversationId !== '') {
      this.baselined = true
      this.baselineExisting()
    }
    this.poll()
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs)
    this.timer.unref?.()
  }

  private baselineExisting(): void {
    try {
      if (!this.brainDir) {
        this.brainDir = findBrainDir(this.conversationId, this.accountHome)
      }
      if (!this.brainDir) return
      const parentLog = join(this.brainDir, '.system_generated', 'logs', 'transcript.jsonl')
      this.parentCursor = createTranscriptCursor(fileSizeOrZero(parentLog))
      this.taskActivity.baseline(this.brainDir)
      this.parentQuota.baseline(this.brainDir)
      this.scanSubagentsForConv(this.conversationId, true)
      for (const cid of Array.from(this.trackedSubagents.keys())) {
        this.scanSubagentsForConv(cid, true)
      }
    } catch (err) {
      noteFailure(this.opts.log, 'baseline', err)
    }
  }

  stop(): void {
    try {
      if (this.active && !this.polling && this.conversationId !== '') {
        this.poll()
      }
    } finally {
      this.active = false
      // agy keeps a finished descriptor at ALIVE, so only the round ending proves it stopped.
      for (const s of this.trackedSubagents.values()) if (!s.terminal) { s.terminal = true; s.lastAt = Date.now(); s.lastAction = '已结束（回合结束）' }
      detachSubagentTracker(this.sessionKey, this)
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    }
  }

  /** Perform one final synchronous scan even after `stop()` halted the interval. */
  flush(): void {
    this.poll(true)
  }

  /** Run one scan across parent transcript, known conversations, and subagents. */
  poll(force = false): void {
    if (this.polling || (!this.active && !force)) return
    if (!this.conversationId) return
    this.polling = true
    try {
      if (!this.brainDir) {
        this.brainDir = findBrainDir(this.conversationId, this.accountHome)
      }
      if (!this.brainDir) return

      this.pollParentTranscript()
      this.parentQuota.poll(this.brainDir, (hit) => {
        const key = `parent-retry-loop-${this.conversationId}`
        this.emitSubagentEvent(key, '[主对话] 连续触发配额限流，正在中断重试...\n', hit)
        this.opts.onQuotaExhausted?.(hit)
      })
      this.taskActivity.poll(this.brainDir, (ev) => {
        this.emitSubagentEvent(ev.stepKey, ev.text, ev.raw)
      })

      // Collect directories to inspect for subagents
      const convsToScan = [this.conversationId, ...Array.from(this.trackedSubagents.keys())]
      for (const cid of convsToScan) {
        this.scanSubagentsForConv(cid)
      }

      // Read incremental logs from all still-active subagents
      for (const sub of this.trackedSubagents.values()) {
        if (!sub.terminal) this.pollSubagentTranscript(sub)
      }
    } catch (err) {
      // A poll races a live writer: keep the interval alive, but not silently.
      noteFailure(this.opts.log, 'poll', err)
    } finally {
      this.polling = false
    }
  }

  private pollParentTranscript(): void {
    if (!this.brainDir) return
    const logPath = join(this.brainDir, '.system_generated', 'logs', 'transcript.jsonl')
    for (const line of readTranscriptDelta(logPath, this.parentCursor)) {
      try {
        const o = JSON.parse(line) as {
          step_index?: unknown
          source?: unknown
          type?: unknown
          content?: unknown
        }
        this.parentLines += 1
        if (o.source !== 'SYSTEM' || o.type !== 'SYSTEM_MESSAGE' || typeof o.content !== 'string') continue
        if (!extractAuthoritativeSubagentQuotaError(o.content, true)) continue
        const stepIdx = typeof o.step_index === 'number' ? o.step_index : this.parentLines
        const qKey = `parent-quota-${stepIdx}`
        if (this.seenStepKeys.has(qKey)) continue
        const roleMatch = o.content.match(/The subagent\s+(.+?)\s+(?:\([^)]+\)\s+)?(?:with id|encountered an error)/i)
        const role = roleMatch?.[1]?.trim()
        const model = extractQuotaErrorModel(o.content)
        const resetMs = parseResetDurationMs(o.content)
        const prefix = role ? `[子代理 · ${role}]` : '[子代理]'
        this.emitSubagentEvent(qKey, `${prefix} 额度已用尽，正在准备切换账号...\n`, o)
        this.opts.onQuotaExhausted?.({
          source: 'parent-system-message',
          errorText: o.content,
          ...(role ? { role } : {}),
          ...(model ? { model } : {}),
          ...(resetMs !== undefined ? { resetMs } : {}),
        })
      } catch {
        // skip malformed line
      }
    }
  }

  private emitSubagentEvent(stepKey: string, text: string, raw: unknown): void {
    if (this.seenStepKeys.has(stepKey)) return
    this.seenStepKeys.add(stepKey)
    this.opts.onEvent({
      kind: 'step',
      stepKey,
      stepKind: 'subagent',
      text,
      raw,
    })
    this.opts.noteActivity?.()
  }

  private scanSubagentsForConv(cid: string, baselineOnly = false): void {
    const bDir = cid === this.conversationId ? this.brainDir : findBrainDir(cid, this.accountHome)
    if (!bDir) return
    const subagentsDir = join(bDir, '.system_generated', 'subagents')
    if (!existsSync(subagentsDir)) return

    let files: string[]
    try {
      files = readdirSync(subagentsDir)
    } catch {
      return
    }

    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const fullPath = join(subagentsDir, f)
      try {
        const raw = readFileSync(fullPath, 'utf8')
        const obj = JSON.parse(raw) as {
          conversationId?: unknown
          subagentDescriptor?: { typeName?: unknown; role?: unknown }
          state?: unknown
        }
        const subId = typeof obj?.conversationId === 'string' ? obj.conversationId : f.replace(/\.json$/, '')
        if (!subId) continue

        const rawState = typeof obj?.state === 'string' && obj.state.trim() !== '' ? obj.state.trim() : undefined
        const existing = this.trackedSubagents.get(subId)
        if (existing) {
          if (!existing.terminal && rawState !== undefined && rawState !== existing.state && !isActiveSubagentState(rawState)) {
            this.pollSubagentTranscript(existing)
            existing.state = rawState
            existing.terminal = true
            existing.lastAt = Date.now()
            existing.lastAction = `已停止 (${rawState})`
            const stateKey = `subagent-state-${subId}-${rawState}`
            if (baselineOnly) {
              this.seenStepKeys.add(stateKey)
            } else {
              this.emitSubagentEvent(stateKey, `[子代理 · ${existing.role}] 协同专员已停止 (${rawState})\n`, obj)
            }
          }
          continue
        }

        const desc = obj?.subagentDescriptor
        const role = typeof desc?.role === 'string' && desc.role !== '' ? desc.role : '专员'
        const typeName = typeof desc?.typeName === 'string' && desc.typeName !== '' ? desc.typeName : 'Subagent'

        const subBrainDir = findBrainDir(subId, this.accountHome) ?? join(bDir, '..', subId)
        const active = isActiveSubagentState(rawState)
        const logPath = join(subBrainDir, '.system_generated', 'logs', 'transcript.jsonl')
        const initialOffset = baselineOnly ? fileSizeOrZero(logPath) : 0
        // Baseline rows are history: freshness comes from the descriptor mtime.
        const descMtime = baselineOnly ? statSync(fullPath).mtimeMs : Date.now()
        const tracked: TrackedSubagent = {
          conversationId: subId,
          role,
          typeName,
          brainDir: subBrainDir,
          state: rawState,
          terminal: !active,
          cursor: createTranscriptCursor(initialOffset),
          lines: 0,
          startedAt: descMtime, lastAt: descMtime,
          lastAction: active ? `已启动协同专员 (${typeName})` : `未保持运行 (${rawState ?? 'unknown'})`,
        }
        this.trackedSubagents.set(subId, tracked)

        // Announce spawn only when the descriptor represents an active subagent.
        const spawnKey = `subagent-spawn-${subId}`
        if (baselineOnly) {
          this.seenStepKeys.add(spawnKey)
        } else if (active) {
          this.emitSubagentEvent(spawnKey, `[子代理 · ${role}] 已启动协同专员 (${typeName})\n`, obj)
        } else {
          this.seenStepKeys.add(spawnKey)
          // Even a subagent that terminated before the first poll can leave an
          // authoritative 429 quota error in this turn's transcript; scan once
          // in quota-only mode without emitting stale tool/chat chatter.
          this.pollSubagentTranscript(tracked, true)
          if (rawState !== undefined) {
            this.emitSubagentEvent(
              `subagent-state-${subId}-${rawState}`,
              `[子代理 · ${role}] 协同专员未保持运行 (${rawState})\n`,
              obj,
            )
          }
        }
      } catch (err) {
        noteFailure(this.opts.log, `descriptor ${f}`, err)
      }
    }
  }

  private pollSubagentTranscript(sub: TrackedSubagent, quotaOnly = false): void {
    const logPath = join(sub.brainDir, '.system_generated', 'logs', 'transcript.jsonl')
    for (const line of readTranscriptDelta(logPath, sub.cursor)) {
      try {
        const o = JSON.parse(line) as {
          step_index?: unknown
          source?: unknown
          type?: unknown
          status?: unknown
          content?: unknown
          tool_calls?: Array<{ name?: unknown; args?: unknown }>
        }
        sub.lines += 1
        const stepIdx = typeof o.step_index === 'number' ? o.step_index : sub.lines
        const baseKey = `subagent-${sub.conversationId}-${stepIdx}`

        if (!quotaOnly) {
          if (Array.isArray(o.tool_calls) && o.tool_calls.length > 0) {
            for (let tcIdx = 0; tcIdx < o.tool_calls.length; tcIdx++) {
              const tc = o.tool_calls[tcIdx]!
              const toolName = typeof tc?.name === 'string' ? tc.name : ''
              if (toolName === '') continue
              const msg = formatSubagentAction(sub.role, toolName, tc.args)
              sub.lastAction = msg
              sub.lastAt = Date.now()
              this.emitSubagentEvent(`${baseKey}-tc-${tcIdx}`, `${msg}\n`, o)
            }
          } else if (o.type === 'PLANNER_RESPONSE' && typeof o.content === 'string' && o.content.trim() !== '') {
            const firstLine = o.content.trim().split('\n')[0]!.replace(/^#+\s*/, '').slice(0, 100)
            if (firstLine !== '') {
              this.emitSubagentEvent(`${baseKey}-content`, `[子代理 · ${sub.role}] 阶段进展: ${firstLine}\n`, o)
            }
          }
        }
        if (isTerminalTranscriptStatus(o.status)) {
          if (!quotaOnly) {
            this.emitSubagentEvent(`${baseKey}-status`, `[子代理 · ${sub.role}] 执行异常/中止 (${o.status})\n`, o)
          }
          if (
            /^(ERROR|FAILED)$/i.test(o.status.trim())
            && typeof o.content === 'string'
            && extractAuthoritativeSubagentQuotaError(o.content, false)
          ) {
            const qKey = `subagent-quota-${sub.conversationId}-${stepIdx}`
            if (!this.seenStepKeys.has(qKey)) {
              const model = extractQuotaErrorModel(o.content)
              const resetMs = parseResetDurationMs(o.content)
              this.emitSubagentEvent(qKey, `[子代理 · ${sub.role}] 额度已用尽，正在准备切换账号...\n`, o)
              this.opts.onQuotaExhausted?.({
                source: 'subagent-transcript',
                errorText: o.content,
                role: sub.role,
                conversationId: sub.conversationId,
                ...(model ? { model } : {}),
                ...(resetMs !== undefined ? { resetMs } : {}),
              })
            }
          }
        }
      } catch {
        // skip malformed line
      }
    }
  }

  snapshot(): SubagentSnapshot {
    const items: SubagentSnapshotItem[] = [...this.trackedSubagents.values()].map((s) => ({
      conversationId: s.conversationId, role: s.role, typeName: s.typeName,
      ...(s.state === undefined ? {} : { state: s.state }),
      running: !s.terminal && Date.now() - s.lastAt <= SUBAGENT_LIVE_WINDOW_MS, lastAction: s.lastAction, startedAt: s.startedAt, lastAt: s.lastAt,
    }))
    return { total: items.length, running: items.filter((i) => i.running).length, items }
  }
}
