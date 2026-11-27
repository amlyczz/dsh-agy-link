// Native tool-card projection for mirrored agy tool calls and results.
//
// MOVED VERBATIM from src/host/mirror-tool.ts (Phase 5h). The per-tool-family
// switch bodies were lifted into small helpers; every key list, fallback and
// case grouping is unchanged. Presenters stay pure functions of the arguments,
// so session-log replays render identically.
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
import { formatChecklistMarkdown, parseChecklistSteps, summarizeChecklist } from '../../common/checklist.ts'
import { isMirrorToolNotFoundText, MIRROR_TOOL_RELOAD_NOTICE } from '../../common/mirror-error.ts'
import { cleanToolOutput } from '../../common/tool-output.ts'
import { cleanResultText, pick, resultText, unwrapMcpTool, clip } from './args.ts'
import { getGitHeadContent } from './git-head.ts'

function presentTerminalCall(input: Record<string, unknown>): ToolCallView {
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

function presentEditCall(input: Record<string, unknown>): ToolCallView {
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

function presentWriteCall(input: Record<string, unknown>): ToolCallView {
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

function presentReadCall(input: Record<string, unknown>): ToolCallView {
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

function presentGlobCall(input: Record<string, unknown>): ToolCallView {
  const rawPat = input.pattern ?? input.Pattern ?? input.query ?? input.Query ?? input.regex ?? input.Regex ?? input.QueryString
  const q = Array.isArray(rawPat) ? rawPat.join(', ') : (typeof rawPat === 'string' ? rawPat : (pick(input, 'pattern', 'Pattern', 'query', 'Query', 'regex', 'Regex', 'QueryString') ?? ''))
  const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
  const title = desc ?? (q !== '' ? 'Search ' + q : 'Search')
  const view: GenericCallView = { card: 'generic', title, kind: 'search' }
  return view
}

function presentGrepCall(input: Record<string, unknown>): ToolCallView {
  const rawPat = input.query ?? input.Query ?? input.pattern ?? input.Pattern ?? input.regex ?? input.Regex ?? input.QueryString
  const q = Array.isArray(rawPat) ? rawPat.join(', ') : (typeof rawPat === 'string' ? rawPat : (pick(input, 'query', 'Query', 'pattern', 'Pattern', 'regex', 'Regex', 'QueryString') ?? ''))
  const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
  const title = desc ?? (q !== '' ? 'Search ' + q : 'Search')
  const view: GenericCallView = { card: 'generic', title, kind: 'search' }
  return view
}

function presentListCall(input: Record<string, unknown>): ToolCallView {
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

function presentDeleteCall(input: Record<string, unknown>): ToolCallView {
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

function presentAskCall(input: Record<string, unknown>): ToolCallView {
  const questions = input.questions
  const firstQ =
    Array.isArray(questions) && questions.length > 0 && typeof (questions[0] as { question?: unknown }).question === 'string'
      ? (questions[0] as { question: string }).question
      : undefined
  const title = firstQ ? `Ask Question: ${firstQ}` : 'Ask Question'
  return { card: 'generic', title, rawInput: input }
}

function presentWebSearchCall(input: Record<string, unknown>): ToolCallView {
  const q = pick(input, 'query', 'Query', 'search_query', 'q') ?? ''
  const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
  const title = desc ?? (q !== '' ? 'Web search ' + q : 'Web search')
  const view: GenericCallView = { card: 'generic', title, kind: 'search', rawInput: input }
  return view
}

function presentFetchCall(input: Record<string, unknown>): ToolCallView {
  const url = pick(input, 'Url', 'url', 'target_url', 'targetUrl') ?? ''
  const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
  return { card: 'generic', title: desc ?? (url ? `Fetch ${url}` : 'Fetch URL'), kind: 'fetch', rawInput: input }
}

function presentManageTaskCall(input: Record<string, unknown>): ToolCallView {
  const action = pick(input, 'Action', 'action') ?? 'manage'
  const taskId = pick(input, 'TaskId', 'taskId', 'task_id')
  const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
  const title = desc ?? (taskId ? `Task ${action} (${taskId})` : `Task ${action}`)
  return { card: 'generic', title, kind: 'execute', rawInput: input }
}

function presentScheduleCall(input: Record<string, unknown>): ToolCallView {
  const prompt = pick(input, 'Prompt', 'prompt')
  const cron = pick(input, 'CronExpression', 'cron_expression')
  const duration = pick(input, 'DurationSeconds', 'duration_seconds')
  const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
  const timing = cron ? `cron ${cron}` : duration ? `${duration}s timer` : ''
  const title = desc ?? (timing ? `Schedule ${timing}` : (prompt ? `Schedule: ${prompt}` : 'Schedule'))
  return { card: 'generic', title, kind: 'other', rawInput: input }
}

function cleanRole(raw?: string): string | undefined {
  if (!raw) return undefined
  let s = raw.trim()
  if (s.startsWith('"') && s.endsWith('"')) {
    try { s = JSON.parse(s) } catch { /* ignore */ }
  }
  return s || undefined
}

function presentSubagentCall(input: Record<string, unknown>): ToolCallView {
  const subs = input.Subagents ?? input.subagents
  const subRole = Array.isArray(subs) && subs.length > 0 && typeof (subs[0] as { Role?: unknown; role?: unknown }).Role === 'string'
    ? ((subs[0] as { Role: string }).Role)
    : Array.isArray(subs) && subs.length > 0 && typeof (subs[0] as { TypeName?: unknown; typeName?: unknown }).TypeName === 'string'
      ? ((subs[0] as { TypeName: string }).TypeName)
      : undefined
  const directRole = cleanRole(pick(input, 'Role', 'role'))
  const directTypeName = cleanRole(pick(input, 'TypeName', 'typeName'))
  const effRole = cleanRole(subRole) ?? (directRole && directTypeName ? `${directRole} (${directTypeName})` : (directRole ?? directTypeName))
  const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
  const title = desc ?? (effRole ? `Subagent: ${effRole}` : 'Invoke subagent')
  return { card: 'generic', title, kind: 'execute', rawInput: input }
}

function presentSendMessageCall(input: Record<string, unknown>): ToolCallView {
  const recipient = pick(input, 'Recipient', 'recipient', 'to')
  const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
  const title = desc ?? (recipient ? `Message subagent ${recipient}` : 'Send message')
  return { card: 'generic', title, kind: 'other', rawInput: input }
}

function presentGenerateImageCall(input: Record<string, unknown>): ToolCallView {
  const prompt = pick(input, 'Prompt', 'prompt', 'ImageName', 'image_name') ?? ''
  return { card: 'generic', title: prompt ? `Generate Image: ${prompt}` : 'Generate Image' }
}

function presentChecklistCall(input: Record<string, unknown>): ToolCallView {
  const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
  const steps = parseChecklistSteps(input)
  if (steps.length === 0) {
    return { card: 'generic', title: desc ?? 'Checklist', rawInput: input }
  }
  const sum = summarizeChecklist(steps)
  const title = desc ?? `Checklist · ${sum.done}/${sum.total} steps${sum.activeTitle ? ` · ${sum.activeTitle}` : ''}`
  return { card: 'generic', title, rawInput: input }
}

function presentFocusCall(input: Record<string, unknown>): ToolCallView {
  const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
  const focus = pick(input, 'focus', 'Focus', 'title', 'Title')
  const title = desc ?? (focus ? `Focus · ${focus}` : 'Focus')
  return { card: 'generic', title, rawInput: input }
}

function presentDefaultCall(input: Record<string, unknown>, name: string, server: string | undefined): ToolCallView {
  const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
  const fallbackTitle = server ? `${server}: ${name}` : (name !== '' ? name : 'agy tool')
  const view: GenericCallView = { card: 'generic', title: desc ?? fallbackTitle, rawInput: input }
  return view
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
    case 'shell':
    case 'pwsh':
    case 'powershell':
    case 'shell_command':
      return presentTerminalCall(input)
    case 'replace_file_content':
    case 'edit_file':
    case 'replace_in_file':
    case 'edit':
      return presentEditCall(input)
    case 'write_to_file':
    case 'write_file':
    case 'create_file':
    case 'write':
      return presentWriteCall(input)
    case 'read_file':
    case 'view_file':
    case 'read':
    case 'open_file':
      return presentReadCall(input)
    case 'find_by_name':
    case 'glob':
    case 'ops_glob':
    case 'search_files':
      return presentGlobCall(input)
    case 'grep_search':
    case 'search':
    case 'ops_grep':
    case 'search_file_content':
    case 'grep':
      return presentGrepCall(input)
    case 'list_dir':
    case 'ls':
    case 'list_directory':
      return presentListCall(input)
    case 'delete_file':
    case 'remove_file':
    case 'rm':
      return presentDeleteCall(input)
    case 'ask_question':
      return presentAskCall(input)
    case 'search_web':
    case 'web_search':
      return presentWebSearchCall(input)
    case 'read_url_content':
    case 'web_fetch':
    case 'fetch_web_page':
    case 'fetch_url':
      return presentFetchCall(input)
    case 'manage_task':
      return presentManageTaskCall(input)
    case 'schedule':
      return presentScheduleCall(input)
    case 'invoke_subagent':
      return presentSubagentCall(input)
    case 'send_message':
      return presentSendMessageCall(input)
    case 'generate_image':
      return presentGenerateImageCall(input)
    case 'update_steps':
    case 'todo_write':
      return presentChecklistCall(input)
    case 'update_focus':
      return presentFocusCall(input)
    default:
      return presentDefaultCall(input, name, server)
  }
}

function formatBackgroundTerminalOutput(text: string): string {
  const taskMatch = /\b(task-\d+)\b/i.exec(text)
  const isGenericRunning =
    /^Tool is running as a background task(?:\s*\([^)]+\))?(?::\s*.*)?$/i.test(text) ||
    /^Running in background\b/i.test(text)
  if (!isGenericRunning || /tasks[\\/]+task-\d+\.log/i.test(text)) {
    return text
  }
  const hint = taskMatch
    ? `[background] ${taskMatch[1]} running — live lines stream from .system_generated/tasks/${taskMatch[1]}.log; completion arrives via background message.`
    : '[background] running in background — awaiting completion notice.'
  return text === '' ? hint : `${text}\n${hint}`
}

function formatScheduleResultOutput(input: Record<string, unknown>, text: string): string {
  const cron = pick(input, 'CronExpression', 'cron_expression')
  const duration = pick(input, 'DurationSeconds', 'duration_seconds')
  const prompt = pick(input, 'Prompt', 'prompt')
  const timing = cron ? `cron ${cron}` : duration ? `${duration}s timer` : 'schedule'
  const header = prompt ? `[scheduled] ${timing} — ${prompt}` : `[scheduled] ${timing}`
  if (text === '' || /^Tool is running as a background task/i.test(text)) {
    return header
  }
  return `${header}\n${text}`
}

/** Native completed-card projection for one mirrored agy tool call. */
export function presentMirrorResult(args: unknown, result: { content: unknown[]; isError: boolean }): ToolResultView | undefined {
  const a = args as { tool?: unknown; input?: unknown }
  const unwrapped = unwrapMcpTool(typeof a?.tool === 'string' ? a.tool : '', a?.input)
  const name = unwrapped.tool
  const rawText = resultText(result.content)
  const cleanedText = cleanResultText(rawText)
  const transientMirrorMiss = result.isError && isMirrorToolNotFoundText(cleanedText)
  const text = transientMirrorMiss ? MIRROR_TOOL_RELOAD_NOTICE : cleanedText
  const effectiveIsError = transientMirrorMiss ? false : result.isError
  // agy's status envelope (Created At / Completed At / Command exited with code
  // N / Command output:) is not part of the payload: strip it before the card
  // body is built, and take the exit code from the parsed envelope.
  const cleaned = cleanToolOutput(name, text)
  const body = cleaned.body
  switch (name) {
    case 'run_command':
    case 'bash':
    case 'execute_command':
    case 'ops_bash':
    case 'sh':
    case 'shell': {
      let exitCode: number | undefined = cleaned.exitCode
      const m = /The command exited with code (\d+)/i.exec(text) ?? /\[exit code (\d+)\]/i.exec(text)
      if (m && m[1]) {
        exitCode = parseInt(m[1], 10)
      } else if (exitCode === undefined && (/\[command timed out/i.test(text) || effectiveIsError)) {
        exitCode = 1
      }
      const rendered = formatBackgroundTerminalOutput(body)
      const view: TerminalResultView = { card: 'terminal', output: rendered, ...(exitCode !== undefined ? { exitCode } : {}) }
      return view
    }
    case 'schedule': {
      const rendered = formatScheduleResultOutput(unwrapped.input, body)
      const view: GenericResultView = { card: 'generic', content: [{ type: 'text', text: clip(rendered, 4000) }] }
      return view
    }
    case 'update_steps':
    case 'todo_write': {
      const steps = parseChecklistSteps(unwrapped.input, body)
      const rendered = (body === '' || /^OK$/i.test(body.trim())) && steps.length > 0
        ? formatChecklistMarkdown(steps)
        : body
      const view: GenericResultView = { card: 'generic', content: [{ type: 'text', text: clip(rendered, 4000) }] }
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
      const view: GenericResultView = { card: 'generic', content: [{ type: 'text', text: clip(body, 4000) }] }
      return view
    }
  }
}