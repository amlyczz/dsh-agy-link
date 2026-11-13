// Subagent Activity Tracker: monitors background subagents and task transcripts
// in agy's brain directory, streaming real-time progress events into DSH's
// reasoning channel so the user sees 1:1 what agy and its workers are doing.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { AgyEvent } from '../../common/types.ts'
import { findBrainDir } from '../../runtime/agy/db/paths.ts'

export interface SubagentTrackerOptions {
  conversationId?: string
  accountHome?: string
  onEvent: (event: AgyEvent) => void
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

interface TrackedSubagent {
  conversationId: string
  role: string
  typeName: string
  brainDir: string
  /** Bytes of `transcript.jsonl` already consumed. */
  offset: number
  /** Trailing partial line from the last read (the file ends without a newline). */
  rest: string
  /** Lines consumed so far — the fallback step index when a row carries none. */
  lines: number
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
  private timer: NodeJS.Timeout | null = null
  private active = false
  private polling = false
  private readonly pollIntervalMs: number

  constructor(private readonly opts: SubagentTrackerOptions) {
    this.conversationId = opts.conversationId ?? ''
    this.accountHome = opts.accountHome
    this.pollIntervalMs = opts.pollIntervalMs ?? 500
  }

  /** Follow the conversation agy reported in its stream-json init/result envelope. */
  setConversationId(cid: string): void {
    if (cid === '' || cid === this.conversationId) return
    this.conversationId = cid
    this.brainDir = null
    if (this.active) this.poll()
  }

  start(): void {
    if (this.active) return
    this.active = true
    this.poll()
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    this.active = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Run one scan across known conversations and subagents. */
  poll(): void {
    if (this.polling || !this.active) return
    if (!this.conversationId) return
    this.polling = true
    try {
      if (!this.brainDir) {
        this.brainDir = findBrainDir(this.conversationId, this.accountHome)
      }
      if (!this.brainDir) return

      // Collect directories to inspect for subagents
      const convsToScan = [this.conversationId, ...Array.from(this.trackedSubagents.keys())]
      for (const cid of convsToScan) {
        this.scanSubagentsForConv(cid)
      }

      // Read incremental logs from all tracked subagents
      for (const sub of this.trackedSubagents.values()) {
        this.pollSubagentTranscript(sub)
      }
    } catch (err) {
      // A poll races a live writer: keep the interval alive, but not silently.
      noteFailure(this.opts.log, 'poll', err)
    } finally {
      this.polling = false
    }
  }

  private scanSubagentsForConv(cid: string): void {
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
        if (!subId || this.trackedSubagents.has(subId)) continue

        const desc = obj?.subagentDescriptor
        const role = typeof desc?.role === 'string' && desc.role !== '' ? desc.role : '专员'
        const typeName = typeof desc?.typeName === 'string' && desc.typeName !== '' ? desc.typeName : 'Subagent'

        const subBrainDir = findBrainDir(subId, this.accountHome) ?? join(bDir, '..', subId)
        const tracked: TrackedSubagent = {
          conversationId: subId,
          role,
          typeName,
          brainDir: subBrainDir,
          offset: 0,
          rest: '',
          lines: 0,
        }
        this.trackedSubagents.set(subId, tracked)

        // Announce the spawn once, in the same `[子代理 · role]` shape as its actions.
        const spawnKey = `subagent-spawn-${subId}`
        if (!this.seenStepKeys.has(spawnKey)) {
          this.seenStepKeys.add(spawnKey)
          const ev: AgyEvent = {
            kind: 'step',
            stepKey: spawnKey,
            stepKind: 'subagent',
            text: `[子代理 · ${role}] 已启动协同专员 (${typeName})\n`,
            raw: obj,
          }
          this.opts.onEvent(ev)
          this.opts.noteActivity?.()
        }
      } catch (err) {
        noteFailure(this.opts.log, `descriptor ${f}`, err)
      }
    }
  }

  /**
   * Read the transcript lines appended since the last poll.
   *
   * agy rewrites nothing and only appends, so the tracker keeps a byte offset
   * instead of re-reading (and re-splitting) a transcript that grows to hundreds
   * of kilobytes: each poll costs one bounded read of the new bytes.
   */
  private readNewLines(sub: TrackedSubagent): string[] {
    const logPath = join(sub.brainDir, '.system_generated', 'logs', 'transcript.jsonl')
    let size: number
    try {
      const st = statSync(logPath)
      if (!st.isFile()) return []
      size = st.size
    } catch {
      return []
    }
    // A shrunk file means the conversation was recreated; start over.
    if (size < sub.offset) {
      sub.offset = 0
      sub.rest = ''
    }
    if (size === sub.offset) return []

    const length = size - sub.offset
    const buffer = Buffer.allocUnsafe(length)
    try {
      const fd = openSync(logPath, 'r')
      try {
        readSync(fd, buffer, 0, length, sub.offset)
      } finally {
        closeSync(fd)
      }
    } catch {
      return []
    }
    sub.offset = size

    // The tail may end mid-line while the writer is appending: keep it for the
    // next poll instead of parsing a truncated JSON row.
    const chunk = sub.rest + buffer.toString('utf8')
    const parts = chunk.split('\n')
    sub.rest = parts.pop() ?? ''
    return parts.filter((line) => line.trim() !== '')
  }

  private pollSubagentTranscript(sub: TrackedSubagent): void {
    for (const line of this.readNewLines(sub)) {
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

        if (Array.isArray(o.tool_calls) && o.tool_calls.length > 0) {
          for (let tcIdx = 0; tcIdx < o.tool_calls.length; tcIdx++) {
            const tc = o.tool_calls[tcIdx]!
            const toolName = typeof tc?.name === 'string' ? tc.name : ''
            if (toolName === '') continue
            const k = `${baseKey}-tc-${tcIdx}`
            if (this.seenStepKeys.has(k)) continue
            this.seenStepKeys.add(k)

            const msg = formatSubagentAction(sub.role, toolName, tc.args)
            const ev: AgyEvent = {
              kind: 'step',
              stepKey: k,
              stepKind: 'subagent',
              text: `${msg}\n`,
              raw: o,
            }
            this.opts.onEvent(ev)
            this.opts.noteActivity?.()
          }
        } else if (o.type === 'PLANNER_RESPONSE' && typeof o.content === 'string' && o.content.trim() !== '') {
          const k = `${baseKey}-content`
          if (this.seenStepKeys.has(k)) continue
          this.seenStepKeys.add(k)

          const firstLine = o.content.trim().split('\n')[0]!.replace(/^#+\s*/, '').slice(0, 100)
          if (firstLine !== '') {
            const ev: AgyEvent = {
              kind: 'step',
              stepKey: k,
              stepKind: 'subagent',
              text: `[子代理 · ${sub.role}] 阶段进展: ${firstLine}\n`,
              raw: o,
            }
            this.opts.onEvent(ev)
            this.opts.noteActivity?.()
          }
        }
      } catch {
        // skip malformed line
      }
    }
  }
}
