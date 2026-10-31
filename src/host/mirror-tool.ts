// agy_tool — the native-UI mirror (v0.3).
//
// The adapter cuts each completed agy tool step into a finish:tool-calls span
// addressed to THIS tool. It executes instantly (the output was already
// recorded by the agy child process) and returns it as the tool result, so
// DSH records genuine tool/call + tool/result session events and renders the
// activity with its own dedicated tool-card UI. presentCall/presentResult map
// the mirrored agy tool onto the provider-neutral card vocabulary: agy
// run_command becomes a terminal card, write_to_file an inline diff card, and
// reads/searches generic cards with the right icon kind. Presenters are pure
// functions of the arguments, so session-log replays render identically.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  DiffCallView,
  GenericCallView,
  TerminalCallView,
  TerminalResultView,
  DiffResultView,
  GenericResultView,
  ToolCallView,
  ToolResultView,
} from '@deepseek-ai/dsh-tools'
import type { RunRegistry } from './recording.ts'

export const MIRROR_TOOL_NAME = 'agy_tool'

/** The only tool this DSH deployment lets a model call directly. */
export const WRAPPER_TOOL_NAME = 'run_code'

/**
 * Retrieve the committed HEAD content of a file via git, for computing
 * line diffs on full-file writes. Pure & safe: catches all failures (not in git,
 * untracked, git missing, binary) and returns null in <=500ms.
 */
export function getGitHeadContent(filePath: string, execFn = execFileSync): string | null {
  if (!filePath || typeof filePath !== 'string' || filePath === 'file') return null
  try {
    const resolved = path.resolve(filePath)
    const dir = path.dirname(resolved)
    const toplevel = execFn('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 500,
      windowsHide: true,
    })
    const root = typeof toplevel === 'string' ? toplevel.trim() : ''
    if (!root) return null
    const relPath = path.relative(root, resolved).replace(/\\/g, '/')
    if (relPath.startsWith('..')) return null
    const content = execFn('git', ['show', `HEAD:${relPath}`], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 500,
      windowsHide: true,
    })
    const str = typeof content === 'string' ? content : ''
    if (str.includes('\u0000')) return null
    return str
  } catch {
    return null
  }
}

/**
 * Build the run_code tool-call arguments that replay one recorded agy tool
 * step. The deployment's tool-dispatch policy only allows `run_code` as a
 * direct model call (everything else must be invoked from inside a
 * program), so the span cut addresses run_code with a generated program
 * whose single statement calls the registered mirror tool — the inner
 * dispatch is what renders the native tool card.
 */
export function buildMirrorRunCode(
  runId: string,
  eventIndex: number,
  toolName: string,
  brief?: string,
): { code: string; description: string } {
  const invocation = JSON.stringify({ run: runId, step: eventIndex })
  const label = brief !== undefined && brief !== ''
    ? brief
    : toolName
  return {
    code:
      '// dsh-agy-link mirror: replay recorded agy tool step ' +
      eventIndex +
      ' (' +
      toolName +
      ')\n' +
      "return await tools['agy_tool'](" +
      invocation +
      ')',
    // Keep the wire tool name visible but surface a human preview first so
    // Code Mode rows are not a wall of "replay agy tool step N".
    description: brief !== undefined && brief !== '' ? brief + ' · ' + toolName : toolName,
  }
}

/** Short human preview for a recorded tool step (used in Code Mode titles). */
export function toolStepBrief(toolName: string, args: unknown, server?: string): string {
  const unwrapped = unwrapMcpTool(toolName, args)
  const effTool = unwrapped.tool
  const a = unwrapped.input
  const effServer = server ?? unwrapped.server
  const pickStr = (...keys: string[]): string => {
    for (const k of keys) {
      const v = a[k]
      if (typeof v === 'string' && v.trim() !== '') return v.trim()
    }
    return ''
  }
  if (effTool === 'run_command' || effTool === 'execute_command' || effTool === 'ops_bash' || effTool === 'bash' || effTool === 'sh' || effTool === 'shell') {
    const cmd = pickStr('CommandLine', 'command_line', 'Command', 'command', 'Cmd', 'cmd')
    return cmd !== '' ? '$ ' + cmd.slice(0, 80) : 'run command'
  }
  if (effTool === 'view_file' || effTool === 'read_file' || effTool === 'read') {
    return 'read ' + (pickStr('AbsolutePath', 'absolute_path', 'Path', 'path', 'TargetFile', 'File') || 'file')
  }
  if (effTool === 'write_to_file' || effTool === 'create_file' || effTool === 'write_file') {
    return 'write ' + (pickStr('TargetFile', 'target_file', 'Path', 'path', 'AbsolutePath', 'File') || 'file')
  }
  if (effTool === 'replace_file_content' || effTool === 'edit_file' || effTool === 'edit') {
    return 'edit ' + (pickStr('TargetFile', 'target_file', 'Path', 'path', 'AbsolutePath', 'File') || 'file')
  }
  if (effTool === 'grep_search' || effTool === 'search' || effTool === 'ops_grep' || effTool === 'ops_glob' || effTool === 'glob' || effTool === 'find_by_name' || effTool === 'search_files' || effTool === 'search_file_content' || effTool === 'grep') {
    const rawPat = a.pattern ?? a.Pattern ?? a.query ?? a.Query ?? a.SearchPattern
    const pat = Array.isArray(rawPat) ? rawPat.join(', ') : (typeof rawPat === 'string' ? rawPat.trim() : '')
    return pat !== '' ? 'search ' + pat.slice(0, 80) : 'search'
  }
  if (effTool === 'search_web' || effTool === 'web_search') {
    return 'search web ' + (pickStr('query', 'Query', 'search_query', 'q') || '')
  }
  if (effTool === 'read_url_content' || effTool === 'web_fetch' || effTool === 'fetch_web_page') {
    return 'fetch ' + (pickStr('Url', 'url', 'target_url', 'targetUrl') || 'url')
  }
  if (effTool === 'list_dir' || effTool === 'list_directory' || effTool === 'ls') {
    return 'ls ' + (pickStr('DirectoryPath', 'directory_path', 'Path', 'path', 'AbsolutePath') || '.')
  }
  if (effTool === 'manage_task') {
    const action = pickStr('Action', 'action') || 'manage'
    const id = pickStr('TaskId', 'taskId', 'task_id')
    return id !== '' ? 'task ' + action + ' ' + id : 'task ' + action
  }
  if (effTool === 'schedule') {
    const prompt = pickStr('Prompt', 'prompt')
    const cron = pickStr('CronExpression', 'cron_expression')
    const dur = pickStr('DurationSeconds', 'duration_seconds')
    const timing = cron ? 'cron ' + cron : dur ? dur + 's' : ''
    return timing ? 'schedule ' + timing : (prompt ? 'schedule ' + prompt.slice(0, 40) : 'schedule')
  }
  if (effTool === 'invoke_subagent') {
    const subs = a.Subagents ?? a.subagents
    const firstRole = Array.isArray(subs) && subs.length > 0 && typeof (subs[0] as { Role?: unknown }).Role === 'string'
      ? (subs[0] as { Role: string }).Role
      : ''
    return firstRole ? 'subagent: ' + firstRole : 'invoke subagent'
  }
  if (effTool === 'send_message') {
    const recipient = pickStr('Recipient', 'recipient', 'to')
    return recipient ? 'msg ' + recipient : 'send message'
  }
  return effServer ? effServer + ': ' + effTool : effTool
}

/** Extract the (run, step) cursor embedded by buildMirrorRunCode. */
export function parseMirrorInvocation(code: string): { run: string; step: number } | null {
  const m = /tools\['agy_tool'\]\((\{"run":.*?,"step":\d+\})\)/.exec(code)
  if (m === null) return null
  try {
    const v = JSON.parse(m[1] as string) as { run?: unknown; step?: unknown }
    if (typeof v.run === 'string' && typeof v.step === 'number') return { run: v.run, step: v.step }
    return null
  } catch {
    return null
  }
}

/** agy serializes some tool args as a JSON string; presenters get an object. */
function toolInput(args: { input?: unknown }): Record<string, unknown> {
  const raw = args.input
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : { value: parsed }
    } catch {
      return { value: raw }
    }
  }
  return { value: raw }
}

export interface UnwrappedToolCall {
  tool: string
  input: Record<string, unknown>
  server?: string
  isMcp: boolean
}

export function cleanString(val: unknown): string {
  if (typeof val !== 'string') return ''
  let s = val.trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim()
  }
  return s
}

export function parseInnerArgs(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    let s = raw.trim()
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      try {
        const unquoted = JSON.parse(s) as unknown
        if (typeof unquoted === 'string') s = unquoted.trim()
      } catch {
        // ignore
      }
    }
    try {
      const parsed = JSON.parse(s) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      return { value: parsed }
    } catch {
      return { value: raw }
    }
  }
  return { value: raw }
}

export function unwrapMcpTool(toolName: string, rawArgs: unknown): UnwrappedToolCall {
  const input = toolInput({ input: rawArgs })
  const isMetaMcp = /^(call_mcp_tool|callMcpTool|call_mcp|mcp_call)$/i.test(toolName)
  if (isMetaMcp) {
    const server = cleanString(pick(input, 'ServerName', 'server_name', 'serverName', 'server'))
    const innerTool = cleanString(pick(input, 'ToolName', 'tool_name', 'toolName', 'name', 'tool'))
    const rawInner = input.Arguments ?? input.arguments ?? input.args ?? input.parameters ?? input.params ?? input.input
    const innerInput = parseInnerArgs(rawInner)
    if (innerTool !== '') {
      return {
        tool: innerTool,
        input: innerInput,
        ...(server !== '' ? { server } : {}),
        isMcp: true,
      }
    }
  }

  if (toolName.startsWith('mcp__')) {
    const parts = toolName.slice(5).split('__')
    if (parts.length >= 2) {
      const server = parts[0]
      const innerTool = parts.slice(1).join('__')
      return { tool: innerTool, input, ...(server ? { server } : {}), isMcp: true }
    }
  }

  return { tool: toolName, input, isMcp: false }
}

export function cleanResultText(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed) as { content?: unknown }
      if (Array.isArray(obj?.content)) {
        const parts: string[] = []
        for (const item of obj.content) {
          const blk = item as { type?: string; text?: unknown }
          if (blk?.type === 'text' && typeof blk.text === 'string') {
            parts.push(blk.text)
          }
        }
        if (parts.length > 0) return parts.join('\n')
      }
    } catch {
      // not JSON
    }
  }
  return text
}

/**
 * agy serializes tool args with PascalCase keys (CommandLine, AbsolutePath,
 * SearchDirectory, TargetFile, TargetContent, ReplacementContent, CodeContent…);
 * pick() accepts all casing spellings so cards always read the real field
 * instead of falling back to raw JSON.
 */
function pick(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = input[k]
    if (typeof v === 'string') return v
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return undefined
}

/** Native pending-card projection for one mirrored agy tool call. */
export function presentMirrorCall(args: unknown): ToolCallView | undefined {
  const a = args as { tool?: unknown; input?: unknown; server?: unknown }
  const unwrapped = unwrapMcpTool(typeof a?.tool === 'string' ? a.tool : '', a?.input)
  const name = unwrapped.tool
  const input = unwrapped.input
  const server = typeof a?.server === 'string' && a.server !== '' ? a.server : unwrapped.server
  switch (name) {
    case 'run_command':
    case 'bash':
    case 'execute_command':
    case 'ops_bash':
    case 'sh':
    case 'shell': {
      const command = pick(input, 'CommandLine', 'command_line', 'command', 'cmd', 'Cmd') ?? JSON.stringify(input)
      const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
      const cwd = pick(input, 'Cwd', 'cwd', 'WorkingDirectory', 'working_directory', 'workdir', 'WorkDir')
      const view: TerminalCallView = {
        card: 'terminal',
        title: command,
        ...(desc !== undefined ? { description: desc } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      }
      return view
    }
    case 'replace_file_content':
    case 'edit_file':
    case 'replace_in_file':
    case 'edit': {
      const path =
        pick(
          input,
          'TargetFile',
          'target_file',
          'path',
          'file_path',
          'Path',
          'FilePath',
          'AbsolutePath',
          'targetFile',
        ) ?? 'file'
      const oldText =
        pick(
          input,
          'TargetContent',
          'target_content',
          'old_string',
          'oldText',
          'OldString',
          'OldText',
          'targetContent',
        ) ?? null
      const newText =
        pick(
          input,
          'ReplacementContent',
          'replacement_content',
          'new_string',
          'newText',
          'content',
          'NewString',
          'NewText',
          'Content',
          'replacementContent',
        ) ?? ''
      const desc = pick(input, 'Description', 'description', 'Instruction', 'instruction', 'toolAction', 'toolSummary')
      const view: DiffCallView = {
        card: 'diff',
        title: desc ? `${desc} · ${path}` : 'Edit ' + path,
        diffs: [{ path, oldText, newText }],
        locations: [{ path }],
      }
      return view
    }
    case 'write_to_file':
    case 'write_file':
    case 'create_file': {
      const path =
        pick(
          input,
          'TargetFile',
          'target_file',
          'path',
          'file_path',
          'filename',
          'Path',
          'FilePath',
          'FileName',
          'AbsolutePath',
          'targetFile',
        ) ?? 'file'
      const content =
        pick(
          input,
          'CodeContent',
          'code_content',
          'content',
          'Content',
          'FileContents',
          'contents',
          'codeContent',
        ) ?? ''
      const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
      const oldText = pick(input, 'old_string', 'oldText', 'OldString', 'OldText') ?? getGitHeadContent(path)
      const view: DiffCallView = {
        card: 'diff',
        title: desc ? `${desc} · ${path}` : 'Write ' + path,
        diffs: [{ path, oldText, newText: content }],
        locations: [{ path }],
      }
      return view
    }
    case 'read_file':
    case 'view_file':
    case 'read':
    case 'open_file': {
      const path =
        pick(
          input,
          'AbsolutePath',
          'absolute_path',
          'TargetFile',
          'target_file',
          'path',
          'file_path',
          'filename',
          'Path',
          'FilePath',
          'FileName',
          'targetFile',
        ) ?? ''
      const offset =
        typeof input.offset === 'number'
          ? input.offset
          : typeof input.Offset === 'number'
            ? input.Offset
            : typeof input.StartLine === 'number'
              ? input.StartLine - 1
              : typeof input.start_line === 'number'
                ? (input.start_line as number) - 1
                : undefined
      const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
      const view: GenericCallView = {
        card: 'generic',
        title: desc ? `${desc} · ${path}` : 'Read ' + path,
        kind: 'read',
        ...(path !== '' ? { locations: [{ path, ...(offset !== undefined ? { line: offset + 1 } : {}) }] } : {}),
      }
      return view
    }
    case 'find_by_name':
    case 'glob':
    case 'ops_glob':
    case 'search_files': {
      const rawPat = input.pattern ?? input.Pattern ?? input.query ?? input.Query ?? input.regex ?? input.Regex ?? input.QueryString
      const q = Array.isArray(rawPat) ? rawPat.join(', ') : (typeof rawPat === 'string' ? rawPat : (pick(input, 'pattern', 'Pattern', 'query', 'Query', 'regex', 'Regex', 'QueryString') ?? ''))
      const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
      const title = desc ?? (q !== '' ? 'Search ' + q : 'Search')
      const view: GenericCallView = { card: 'generic', title, kind: 'search' }
      return view
    }
    case 'grep_search':
    case 'search':
    case 'ops_grep':
    case 'search_file_content':
    case 'grep': {
      const rawPat = input.query ?? input.Query ?? input.pattern ?? input.Pattern ?? input.regex ?? input.Regex ?? input.QueryString
      const q = Array.isArray(rawPat) ? rawPat.join(', ') : (typeof rawPat === 'string' ? rawPat : (pick(input, 'query', 'Query', 'pattern', 'Pattern', 'regex', 'Regex', 'QueryString') ?? ''))
      const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
      const title = desc ?? (q !== '' ? 'Search ' + q : 'Search')
      const view: GenericCallView = { card: 'generic', title, kind: 'search' }
      return view
    }
    case 'list_dir':
    case 'ls': {
      const path =
        pick(
          input,
          'DirectoryPath',
          'directory_path',
          'path',
          'directory',
          'Path',
          'Directory',
          'SearchDirectory',
          'search_directory',
          'AbsolutePath',
        ) ?? ''
      const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
      const view: GenericCallView = { card: 'generic', title: desc ?? (path !== '' ? 'List ' + path : 'List directory') }
      return view
    }
    case 'delete_file':
    case 'remove_file':
    case 'rm': {
      const path =
        pick(
          input,
          'TargetFile',
          'target_file',
          'path',
          'file_path',
          'Path',
          'FilePath',
          'AbsolutePath',
        ) ?? ''
      const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
      const view: GenericCallView = { card: 'generic', title: desc ?? ('Delete ' + path), kind: 'delete' }
      return view
    }
    case 'ask_question': {
      const questions = input.questions
      const firstQ =
        Array.isArray(questions) && questions.length > 0 && typeof (questions[0] as { question?: unknown }).question === 'string'
          ? (questions[0] as { question: string }).question
          : undefined
      const title = firstQ ? `Ask Question: ${firstQ}` : 'Ask Question'
      return { card: 'generic', title, rawInput: input }
    }
    case 'search_web':
    case 'web_search': {
      const q = pick(input, 'query', 'Query', 'search_query', 'q') ?? ''
      const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
      const title = desc ?? (q !== '' ? 'Web search ' + q : 'Web search')
      const view: GenericCallView = { card: 'generic', title, kind: 'search', rawInput: input }
      return view
    }
    case 'read_url_content':
    case 'web_fetch':
    case 'fetch_web_page':
    case 'fetch_url': {
      const url = pick(input, 'Url', 'url', 'target_url', 'targetUrl') ?? ''
      const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
      return { card: 'generic', title: desc ?? (url ? `Fetch ${url}` : 'Fetch URL'), kind: 'fetch', rawInput: input }
    }
    case 'manage_task': {
      const action = pick(input, 'Action', 'action') ?? 'manage'
      const taskId = pick(input, 'TaskId', 'taskId', 'task_id')
      const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
      const title = desc ?? (taskId ? `Task ${action} (${taskId})` : `Task ${action}`)
      return { card: 'generic', title, kind: 'execute', rawInput: input }
    }
    case 'schedule': {
      const prompt = pick(input, 'Prompt', 'prompt')
      const cron = pick(input, 'CronExpression', 'cron_expression')
      const duration = pick(input, 'DurationSeconds', 'duration_seconds')
      const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
      const timing = cron ? `cron ${cron}` : duration ? `${duration}s timer` : ''
      const title = desc ?? (timing ? `Schedule ${timing}` : (prompt ? `Schedule: ${prompt}` : 'Schedule'))
      return { card: 'generic', title, kind: 'other', rawInput: input }
    }
    case 'invoke_subagent': {
      const subs = input.Subagents ?? input.subagents
      const firstRole = Array.isArray(subs) && subs.length > 0 && typeof (subs[0] as { Role?: unknown; role?: unknown }).Role === 'string'
        ? ((subs[0] as { Role: string }).Role)
        : Array.isArray(subs) && subs.length > 0 && typeof (subs[0] as { TypeName?: unknown; typeName?: unknown }).TypeName === 'string'
          ? ((subs[0] as { TypeName: string }).TypeName)
          : undefined
      const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
      const title = desc ?? (firstRole ? `Subagent: ${firstRole}` : 'Invoke subagent')
      return { card: 'generic', title, kind: 'execute', rawInput: input }
    }
    case 'send_message': {
      const recipient = pick(input, 'Recipient', 'recipient', 'to')
      const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
      const title = desc ?? (recipient ? `Message subagent ${recipient}` : 'Send message')
      return { card: 'generic', title, kind: 'other', rawInput: input }
    }
    case 'generate_image': {
      const prompt = pick(input, 'Prompt', 'prompt', 'ImageName', 'image_name') ?? ''
      return { card: 'generic', title: prompt ? `Generate Image: ${prompt}` : 'Generate Image' }
    }
    default: {
      const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
      const fallbackTitle = server ? `${server}: ${name}` : (name !== '' ? name : 'agy tool')
      const view: GenericCallView = { card: 'generic', title: desc ?? fallbackTitle, rawInput: input }
      return view
    }
  }
}

/** Native completed-card projection for one mirrored agy tool call. */
export function presentMirrorResult(args: unknown, result: { content: unknown[]; isError: boolean }): ToolResultView | undefined {
  const a = args as { tool?: unknown; input?: unknown }
  const unwrapped = unwrapMcpTool(typeof a?.tool === 'string' ? a.tool : '', a?.input)
  const name = unwrapped.tool
  const rawText = resultText(result.content)
  const text = cleanResultText(rawText)
  switch (name) {
    case 'run_command':
    case 'bash':
    case 'execute_command':
    case 'ops_bash':
    case 'sh':
    case 'shell': {
      let exitCode: number | undefined
      const m = /The command exited with code (\d+)/i.exec(text) ?? /\[exit code (\d+)\]/i.exec(text)
      if (m && m[1]) {
        exitCode = parseInt(m[1], 10)
      } else if (/\[command timed out/i.test(text) || result.isError) {
        exitCode = 1
      }
      const view: TerminalResultView = { card: 'terminal', output: text, ...(exitCode !== undefined ? { exitCode } : {}) }
      return view
    }
    case 'replace_file_content':
    case 'write_to_file':
    case 'write_file':
    case 'create_file':
    case 'edit_file':
    case 'replace_in_file':
    case 'edit': {
      const call = presentMirrorCall(args)
      const diffs = call !== undefined && call.card === 'diff' ? call.diffs : []
      const view: DiffResultView = { card: 'diff', diffs }
      return view
    }
    default: {
      const view: GenericResultView = { card: 'generic', content: [{ type: 'text', text: clip(text, 4000) }] }
      return view
    }
  }
}

function resultText(content: unknown): string {
  const parts: string[] = []
  for (const b of Array.isArray(content) ? content : []) {
    const blk = b as { type?: string; text?: unknown }
    if (blk && blk.type === 'text' && typeof blk.text === 'string') parts.push(blk.text)
  }
  return parts.join('\n')
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '… (+' + (s.length - max) + ' chars)' : s
}

/** Short preview of the recorded step for the degraded-result message. */
function stepLabel(toolName: string, input: unknown): string {
  if (toolName === '') return ''
  return toolStepBrief(toolName, input)
}

/**
 * Degraded result for a mirrored step whose recording is gone (bridge
 * restarted, or the run was recycled while a wedged tool step held the span
 * for hours). It must NOT read like a harness error: the model used to
 * receive `no recorded agy run` and spent the whole turn reverse-engineering
 * this plugin instead of finishing the user's task (flash-blast incident,
 * 2026-10-10). The step really did run — only its replay is unavailable.
 */
export function recordingUnavailable(step: number, toolName: string, input?: unknown, reason?: string): string {
  const label = stepLabel(toolName, input)
  const why = reason !== undefined && reason !== ''
    ? reason
    : 'the step ran for a long time and the in-memory recording was recycled'
  return (
    '⚠ [agy bridge] This agy tool step executed, but its recorded output is no longer resident ' +
    'in the bridge (' + why + '). ' +
    'Nothing is wrong with the tool or the workspace, and there is nothing to debug here — ' +
    'do NOT investigate the bridge, its logs or this message; continue the user\'s task. ' +
    'If the output is needed, re-run the same operation as a new step. ' +
    'Step #' + step + (label !== '' ? ': ' + label : '')
  )
}

export function defineAgyMirrorTool(deps: { runs: RunRegistry }) {
  // Presenter-side enrichment: when the invocation carries only the
  // (run, step) cursor — which is all the generated run_code wrapper
  // embeds — resolve the tool name/input from the recording so cards still
  // render with full detail. Keeps replayed sessions identical to live ones.
  const enrichArgs = (args: Record<string, unknown>): Record<string, unknown> => {
    let tool = typeof args.tool === 'string' ? args.tool : ''
    let input = args.input
    let server = typeof args.server === 'string' ? args.server : undefined
    if (tool === '' || /^(call_mcp_tool|callMcpTool|call_mcp|mcp_call)$/i.test(tool)) {
      const runId = typeof args.run === 'string' ? args.run : ''
      const step = typeof args.step === 'number' ? args.step : -1
      const t = deps.runs.get(runId)?.toolEventAt(step) ?? null
      if (t !== null) {
        if (tool === '') tool = t.name
        input ??= t.args
      }
    }
    const unwrapped = unwrapMcpTool(tool, input)
    return {
      ...args,
      tool: unwrapped.tool,
      input: unwrapped.input,
      ...(unwrapped.server ? { server: unwrapped.server } : server ? { server } : {}),
    }
  }
  return defineTool({
    name: MIRROR_TOOL_NAME,
    description:
      'Internal to the dsh-agy-link bridge: replays one tool activity recorded from a Google Antigravity (agy) CLI run so it renders as a native tool card and rides the agent loop. Emitted automatically by the antigravity provider — do not call it directly.',
    parameters: {
      run: { type: 'string', required: true, description: 'Recording run id.' },
      step: { type: 'number', required: true, description: 'Recorded event index of the tool step.' },
      tool: { type: 'string', description: 'agy tool name that ran (optional — resolved from the recording).' },
      input: { type: 'json', description: 'agy tool arguments as recorded (optional — resolved from the recording).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    presentCall: (args) => presentMirrorCall(enrichArgs(args as Record<string, unknown>)),
    presentResult: (args, result) => presentMirrorResult(enrichArgs(args as Record<string, unknown>), result),
    async execute(args, exec) {
      void exec.signal
      const runId = typeof args.run === 'string' ? args.run : ''
      const step = typeof args.step === 'number' ? args.step : -1
      const toolName = typeof args.tool === 'string' ? args.tool : ''
      const input = toolInput(args as { input?: unknown })
      const rec = deps.runs.get(runId)
      if (rec === undefined) {
        // The recording was recycled (or the bridge restarted) while this
        // step's replay was still queued. Degrade to an explicit, task-facing
        // notice instead of throwing a harness-internal error at the model.
        return recordingUnavailable(step, toolName, input)
      }
      const t = rec.toolEventAt(step)
      if (t === null) {
        // Distinguish WHY the step cannot be replayed: an out-of-range or
        // non-tool event index is a cursor problem (the step may not even have
        // happened yet), not "the output was recycled" — blaming recycling
        // there would send the model hunting for lost output that never was
        // recorded. `rec.length` bounds the recording; toolEventAt only
        // resolves completed tool steps.
        const ev = step >= 0 && step < rec.length ? rec.eventAt(step) : undefined
        const reason = ev === undefined
          ? 'the step index is outside this recording — the step has not been recorded (yet), or the bridge restarted'
          : 'event #' + step + ' in this recording is not a completed tool step'
        return recordingUnavailable(step, toolName !== '' ? toolName : 'unknown', input, reason)
      }
      if (t.error !== undefined) {
        throw new Error('agy tool ' + t.name + ' failed: ' + t.error)
      }
      const out = t.output
      if (out === undefined || out === null) return ''
      if (typeof out === 'string') return out
      try {
        return JSON.stringify(out, null, 2)
      } catch {
        return String(out)
      }
    },
  })
}
