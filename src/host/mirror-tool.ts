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
): { code: string; description: string } {
  const invocation = JSON.stringify({ run: runId, step: eventIndex })
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
    description: 'replay agy tool step ' + eventIndex + ' · ' + toolName,
  }
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
  }
  return undefined
}

/** Native pending-card projection for one mirrored agy tool call. */
export function presentMirrorCall(args: unknown): ToolCallView | undefined {
  const a = args as { tool?: unknown; input?: unknown }
  const name = typeof a?.tool === 'string' ? a.tool : ''
  const input = toolInput(a as { input?: unknown })
  switch (name) {
    case 'run_command':
    case 'bash':
    case 'execute_command': {
      const command = pick(input, 'CommandLine', 'command_line', 'command', 'cmd', 'Cmd') ?? JSON.stringify(input)
      const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
      const cwd = pick(input, 'Cwd', 'cwd', 'WorkingDirectory', 'working_directory')
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
    case 'search_files': {
      const q = pick(input, 'pattern', 'Pattern', 'query', 'Query', 'regex', 'Regex', 'QueryString') ?? ''
      const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
      const title = desc ?? (q !== '' ? 'Search ' + q : 'Search')
      const view: GenericCallView = { card: 'generic', title, kind: 'search' }
      return view
    }
    case 'grep_search':
    case 'search':
    case 'search_file_content':
    case 'grep': {
      const q = pick(input, 'query', 'Query', 'pattern', 'Pattern', 'regex', 'Regex', 'QueryString') ?? ''
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
    case 'read_url_content': {
      const url = pick(input, 'Url', 'url') ?? ''
      const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
      return { card: 'generic', title: desc ?? (url ? `Fetch ${url}` : 'Fetch URL'), kind: 'fetch' }
    }
    case 'generate_image': {
      const prompt = pick(input, 'Prompt', 'prompt', 'ImageName', 'image_name') ?? ''
      return { card: 'generic', title: prompt ? `Generate Image: ${prompt}` : 'Generate Image' }
    }
    default: {
      const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary')
      const view: GenericCallView = { card: 'generic', title: desc ?? (name !== '' ? name : 'agy tool'), rawInput: input }
      return view
    }
  }
}

/** Native completed-card projection for one mirrored agy tool call. */
export function presentMirrorResult(args: unknown, result: { content: unknown[]; isError: boolean }): ToolResultView | undefined {
  const a = args as { tool?: unknown }
  const name = typeof a?.tool === 'string' ? a.tool : ''
  const text = resultText(result.content)
  switch (name) {
    case 'run_command':
    case 'bash':
    case 'execute_command': {
      const view: TerminalResultView = { card: 'terminal', output: text }
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

export function defineAgyMirrorTool(deps: { runs: RunRegistry }) {
  // Presenter-side enrichment: when the invocation carries only the
  // (run, step) cursor — which is all the generated run_code wrapper
  // embeds — resolve the tool name/input from the recording so cards still
  // render with full detail. Keeps replayed sessions identical to live ones.
  const enrichArgs = (args: Record<string, unknown>): Record<string, unknown> => {
    if (typeof args.tool === 'string' && args.tool !== '') return args
    const runId = typeof args.run === 'string' ? args.run : ''
    const step = typeof args.step === 'number' ? args.step : -1
    const t = deps.runs.get(runId)?.toolEventAt(step) ?? null
    if (t === null) return args
    return {
      ...args,
      tool: t.name,
      ...(args.input === undefined && t.args !== undefined ? { input: t.args } : {}),
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
      const toolName = typeof args.tool === 'string' ? args.tool : 'unknown'
      const rec = deps.runs.get(runId)
      if (rec === undefined) {
        throw new Error('agy_tool: no recorded agy run "' + runId + '" — this tool only replays bridge-recorded activity')
      }
      const t = rec.toolEventAt(step)
      if (t === null) {
        throw new Error('agy_tool: event ' + step + ' of run ' + runId + ' is not a completed tool step')
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
