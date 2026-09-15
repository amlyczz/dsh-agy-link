// Native tool-card toolview for the agy_tool mirror (fix for DSH >= 0.1.5).
//
// WHY THIS EXISTS:
//   DSH's browser conversation UI renders each tool call by its *wire name*
//   through a hard-coded variant table (packages/client/ui-tool
//   src/client/tool/models/tool-call-model.ts TOOL_VARIANTS). The table knows
//   `bash`/`pwsh` -> terminal card, `write`/`edit` -> diff card,
//   `read`/`grep`/`glob` -> read/search rows, etc. It has NO entry for the
//   bridge's internal `agy_tool` mirror, and the browser never consults a
//   tool's `presentCall`/`presentResult` (those are declarative metadata for
//   other surfaces, not the card UI). As a result every mirrored agy step
//   (run_command, write_to_file, view_file, grep_search, ...) fell through to
//   a generic "agy_tool" row with raw JSON args — the "native tool card"
//   rendering regressed to a text blob.
//
//   The supported extension point is the keyed `tool.call.toolview` slot:
//   registering with `key: 'agy_tool'` makes DSH hand every agy_tool call to
//   this component, replacing the generic fallback row. The component is a
//   pure function of the frozen block: running call -> pending card; settled
//   result -> completed card. No host round-trip, no extra deps.
//
//   The card mapping mirrors the host-side presentMirrorCall/presentMirrorResult
//   vocabulary (src/host/mirror-tool.ts) so live and replayed sessions stay
//   identical: run_command -> terminal, write/edit -> diff, view/read ->
//   read row, grep/find -> search row, everything else -> compact generic.
//
// The view is self-contained (plain React + theme CSS variables); it does not
// import dsh-client-ui-tool internals, which are not a stable public API.

type ReactApi = {
	createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
	useState: <S>(initial: S) => [S, (next: S | ((prev: S) => S)) => void];
};
// Lazy-required: the pure card-model derivation above must be importable in a
// plain Node test runner (react is only a peer, present in the browser host).
function react(): ReactApi {
	const mod = require('react') as unknown
	if (mod === undefined || mod === null) {
		throw new Error('dsh-agy-link toolview requires react at render time (browser host)')
	}
	return mod as ReactApi
}

/**
 * Wrap a raw useState setter into a toggle: every call flips the previous
 * value. The raw setter itself must NEVER be called with no arguments —
 * `setState(undefined)` pins the state to a falsy value, so a second click
 * could never expand a collapsed card again (the regression this fixes).
 * Exported separately so the toggling contract is unit-testable in Node.
 */
export function makeToggle(setValue: (next: boolean | ((prev: boolean) => boolean)) => void): () => void {
	return () => setValue((prev: boolean) => !prev)
}

export function useToggle(initial: boolean = false): [boolean, () => void] {
	const R2 = react()
	const [value, setValue] = R2.useState(initial) as [boolean, (next: boolean | ((prev: boolean) => boolean)) => void]
	return [value, makeToggle(setValue)]
}

/** React.createElement bound helper (call inside render functions). */
function hx(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown {
	return react().createElement(type, props, ...children)
}

/** Minimal structural types (type-only; erased at build, no new runtime deps). */
type ToolResultBlock = {
  call: { name: string; argsRaw: string } | null
  content: readonly { type?: string; text?: string }[]
  isError: boolean
  error?: { name?: string; code?: string }
  parentCallId?: string
  subCalls?: readonly unknown[]
}
type RunningCallBlock = {
  name: string
  argsRaw: string
  parentCallId?: string
  subCalls?: readonly unknown[]
  call?: { name: string; argsRaw: string }
}
type ToolBlock = (ToolResultBlock | RunningCallBlock) & { kind?: string }
export type { ToolBlock }

/** Props the tool.call.toolview slot hands the registered component. */
export interface AgyToolViewProps {
  callId: string
  toolName: string
  block: ToolBlock
  cwd?: string
  home?: string
  openFile?: (path: string, opts?: unknown) => void
  inspect?: () => void
  loadImage?: unknown
}

// ---- argument parsing (mirrors host toolInput/pick) ----------------------

function parsedArgsRaw(block: ToolBlock): string {
  const settled = block as ToolResultBlock
  if ('call' in settled && settled.call !== null && typeof settled.call.argsRaw === 'string') {
    return settled.call.argsRaw
  }
  const running = block as RunningCallBlock
  if (typeof running.argsRaw === 'string') return running.argsRaw
  return ''
}

function parseArgs(block: ToolBlock): Record<string, unknown> | null {
  const raw = parsedArgsRaw(block)
  if (raw === '') return null
  try {
    const v = JSON.parse(raw) as unknown
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** agy tool name + PascalCase or camelCase input object from the mirror args. */
function mirrorInfo(block: ToolBlock): { tool: string; input: Record<string, unknown> } | null {
  const a = parseArgs(block)
  if (a === null) return null
  const tool = typeof a.tool === 'string' ? a.tool : ''
  if (tool === '') return null
  let input: Record<string, unknown> = {}
  const raw = a.input
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) input = raw as Record<string, unknown>
  else if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw) as unknown
      if (typeof p === 'object' && p !== null && !Array.isArray(p)) input = p as Record<string, unknown>
      else input = { value: raw }
    } catch {
      input = { value: raw }
    }
  }
  return { tool, input }
}

function pick(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = input[k]
    if (typeof v === 'string' && v !== '') return v
  }
  return undefined
}

function num(input: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = input[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

// ---- result text ----------------------------------------------------------

function resultText(block: ToolBlock): string {
  const settled = block as ToolResultBlock
  if (!Array.isArray(settled.content)) return ''
  const parts: string[] = []
  for (const b of settled.content) {
    if (b && typeof b === 'object' && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string') {
      parts.push((b as { text: string }).text)
    }
  }
  return parts.join('\n')
}

function isSettled(block: ToolBlock): boolean {
  return block.kind === 'tool-result' || 'content' in block
}

function isError(block: ToolBlock): boolean {
  const settled = block as ToolResultBlock
  return settled.isError === true || (settled.error !== undefined && settled.error !== null)
}

// ---- card classification (mirror of presentMirrorCall) ---------------------

const TERMINAL_TOOLS = new Set(['run_command', 'bash', 'execute_command'])
const DIFF_TOOLS = new Set(['replace_file_content', 'edit_file', 'replace_in_file', 'edit', 'write_to_file', 'write_file', 'create_file'])
const READ_TOOLS = new Set(['read_file', 'view_file', 'read', 'open_file'])
const SEARCH_TOOLS = new Set(['find_by_name', 'glob', 'search_files', 'grep_search', 'search', 'search_file_content', 'grep'])
const LIST_TOOLS = new Set(['list_dir', 'ls'])
const DELETE_TOOLS = new Set(['delete_file', 'remove_file', 'rm'])

export type CardKind = 'terminal' | 'diff' | 'read' | 'search' | 'list' | 'delete' | 'generic'

export interface MirrorCardModel {
  kind: CardKind
  /** Original agy tool wire name (run_command, write_to_file, ...). */
  tool?: string
  title: string
  /** terminal */
  command?: string
  cwd?: string
  output?: string
  /** diff */
  path?: string
  oldText?: string | null
  newText?: string
  location?: { path: string; line?: number }
  raw?: string
}

/** Build the display model for one agy_tool block (pending or settled). */
export function mirrorCardModel(block: ToolBlock, cwd?: string, home?: string): MirrorCardModel {
  const info = mirrorInfo(block)
  const out = resultText(block)
  if (info === null) {
    return { kind: 'generic', title: 'agy_tool', output: out, raw: parsedArgsRaw(block) }
  }
  const { tool, input } = info
  const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary', 'Instruction', 'instruction')

  if (TERMINAL_TOOLS.has(tool)) {
    const command = pick(input, 'CommandLine', 'command_line', 'command', 'cmd', 'Cmd') ?? JSON.stringify(input)
    const cwdVal = pick(input, 'Cwd', 'cwd', 'WorkingDirectory', 'working_directory') ?? cwd
    return {
      kind: 'terminal',
      tool,
      title: desc !== undefined ? desc + ' · ' + command : command,
      command,
      ...(cwdVal !== undefined ? { cwd: cwdVal } : {}),
      output: out,
    }
  }
  if (DIFF_TOOLS.has(tool)) {
    const rawPath = pick(input, 'TargetFile', 'target_file', 'path', 'file_path', 'Path', 'FilePath', 'AbsolutePath', 'targetFile', 'filename', 'FileName') ?? 'file'
    const path = relativize(rawPath, cwd, home)
    const oldText =
      pick(input, 'TargetContent', 'target_content', 'old_string', 'oldText', 'OldString', 'OldText', 'targetContent') ?? null
    const newText =
      pick(input, 'ReplacementContent', 'replacement_content', 'new_string', 'newText', 'content', 'NewString', 'NewText', 'Content', 'replacementContent', 'CodeContent', 'code_content', 'contents', 'FileContents', 'codeContent') ?? ''
    const action = (tool === 'write_to_file' || tool === 'write_file' || tool === 'create_file') ? 'Write' : 'Edit'
    const isGenericDesc = desc !== undefined && /^(file edit|editing file|write file|writing file|file write|edit file|editing|writing|file create|creating file)$/i.test(desc.trim())
    const title = desc !== undefined && !isGenericDesc && !desc.includes(path)
      ? `${action} ${path} · ${desc}`
      : `${action} ${path}`
    return { kind: 'diff', tool, title, path: rawPath, oldText, newText, output: out }
  }
  if (READ_TOOLS.has(tool)) {
    const path = pick(input, 'AbsolutePath', 'absolute_path', 'TargetFile', 'target_file', 'path', 'file_path', 'filename', 'Path', 'FilePath', 'FileName', 'targetFile') ?? ''
    const offset = num(input, 'offset', 'Offset') ?? num(input, 'StartLine', 'start_line')
    const line = offset !== undefined ? (offset > 0 && (tool === 'view_file' || tool === 'read_file') ? offset : offset + 1) : undefined
    return {
      kind: 'read',
      tool,
      title: desc ? `${desc} · ${path}` : path !== '' ? 'Read ' + path : 'Read',
      path,
      output: out,
      ...(path !== '' ? { location: { path, ...(line !== undefined ? { line } : {}) } } : {}),
    }
  }
  if (SEARCH_TOOLS.has(tool)) {
    const q = pick(input, 'query', 'Query', 'pattern', 'Pattern', 'regex', 'Regex', 'QueryString') ?? ''
    return { kind: 'search', tool, title: desc ?? (q !== '' ? 'Search ' + q : 'Search'), output: out }
  }
  if (LIST_TOOLS.has(tool)) {
    const path = pick(input, 'DirectoryPath', 'directory_path', 'path', 'directory', 'Path', 'Directory', 'SearchDirectory', 'search_directory', 'AbsolutePath') ?? ''
    return { kind: 'list', tool, title: desc ?? (path !== '' ? 'List ' + path : 'List directory'), output: out }
  }
  if (DELETE_TOOLS.has(tool)) {
    const path = pick(input, 'TargetFile', 'target_file', 'path', 'file_path', 'Path', 'FilePath', 'AbsolutePath') ?? ''
    return { kind: 'delete', tool, title: desc ?? 'Delete ' + path, output: out }
  }
  // Fallback: keep the mirror's own generic title from desc/input.
  const title = desc ?? (tool !== '' ? tool : 'agy_tool')
  return { kind: 'generic', tool, title, output: out, raw: parsedArgsRaw(block) }
}

// ---- small presentational helpers -------------------------------------------

function cls(...names: Array<string | false | null | undefined>): string {
  return names.filter((n): n is string => typeof n === 'string' && n !== '').join(' ')
}

const ROW_CSS = `
.agy-tv-row{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l1,#e2e8f0);border-radius:10px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,#fff));margin:4px 0;overflow:hidden;font:var(--dsw-font-13,13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif)}
.agy-tv-head{display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer;user-select:none;background:transparent;border:none;width:100%;text-align:left;color:var(--dsw-alias-label-primary,#0f172a)}
.agy-tv-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.agy-tv-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:5px;background:var(--dsw-alias-bg-layer-3,#f1f5f9);color:var(--dsw-alias-label-secondary,#334155)}
.agy-tv-title{min-width:0;flex:1;font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agy-tv-kind{flex:none;font-size:10px;font-weight:700;letter-spacing:.02em;text-transform:capitalize;padding:1px 6px;border-radius:5px;color:var(--dsw-alias-state-business-primary,#2563eb);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2563eb) 12%,transparent)}
.agy-tv-tool{flex:none;font-size:10px;font-weight:600;font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);color:var(--dsw-alias-label-tertiary,#64748b);background:var(--dsw-alias-bg-layer-3,#f1f5f9);border:.5px solid var(--dsw-alias-border-l1,#e2e8f0);border-radius:5px;padding:1px 6px;max-width:28%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agy-tv-label{font-size:10.5px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#64748b);margin:0 0 3px}
.agy-tv-preview{flex:none;max-width:32%;font-size:11px;color:var(--dsw-alias-label-caption,#94a3b8);font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:var(--dsw-alias-bg-layer-3,#f1f5f9);border-radius:5px;padding:1px 6px}
.agy-tv-state{flex:none;font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:999px}
.agy-tv-state-ok{color:var(--dsw-alias-state-success-primary,#059669);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#059669) 12%,transparent)}
.agy-tv-state-err{color:var(--dsw-alias-state-error-primary,#dc2626);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 12%,transparent)}
.agy-tv-state-run{color:var(--dsw-alias-state-business-primary,#2563eb);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2563eb) 12%,transparent)}
.agy-tv-body{display:none;padding:8px 10px;border-top:.5px solid var(--dsw-alias-border-l1,#e2e8f0)}
.agy-tv-open .agy-tv-body{display:block}
.agy-tv-term{font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-layer-1,#f8fafc);border:.5px solid var(--dsw-alias-border-l1,#e2e8f0);border-radius:7px;padding:8px 10px;color:var(--dsw-alias-label-primary,#0f172a)}
.agy-tv-term-cmd{color:var(--dsw-alias-label-tertiary,#64748b);font-size:11px;margin:0 0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agy-tv-term-cwd{color:var(--dsw-alias-label-caption,#94a3b8);font-size:11px;font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);padding:2px 8px;border-top-left-radius:7px;border-top-right-radius:7px;background:var(--dsw-alias-bg-layer-3,#f1f5f9);border:.5px solid var(--dsw-alias-border-l1,#e2e8f0);border-bottom:none}
.agy-tv-diff{font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;line-height:1.5;border:.5px solid var(--dsw-alias-border-l1,#e2e8f0);border-radius:7px;overflow:hidden}
.agy-tv-diff-path{font-size:11px;padding:4px 10px;background:var(--dsw-alias-bg-layer-3,#f1f5f9);color:var(--dsw-alias-label-secondary,#334155);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agy-tv-line{display:flex;gap:8px;padding:0 10px;min-height:20px;white-space:pre-wrap;word-break:break-word}
.agy-tv-line-del{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 12%,transparent);color:var(--dsw-alias-label-primary,#0f172a)}
.agy-tv-line-del .agy-tv-line-marker{color:var(--dsw-alias-state-error-primary,#dc2626);font-weight:700}
.agy-tv-line-add{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#059669) 12%,transparent);color:var(--dsw-alias-label-primary,#0f172a)}
.agy-tv-line-add .agy-tv-line-marker{color:var(--dsw-alias-state-success-primary,#059669);font-weight:700}
.agy-tv-line-marker{flex:none;width:14px;color:var(--dsw-alias-label-caption,#94a3b8);user-select:none}
.agy-tv-path{font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;color:var(--dsw-alias-state-business-primary,#2563eb);cursor:pointer;text-decoration:underline}
.agy-tv-raw{font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11.5px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,#334155);max-height:200px;overflow:auto}
`

const stateLabel = (kind: 'ok' | 'err' | 'run'): string => (kind === 'err' ? 'Error' : kind === 'run' ? 'Running' : 'Done')

function ChevronDown(): unknown {
  const h = hx
  return h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, style: { flex: 'none', color: 'var(--dsw-alias-label-tertiary,#64748b)' } },
    h('path', { d: 'M4 6l4 4 4-4', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
}

function StatusIcon({ kind }: { kind: CardKind }): unknown {
	const h = hx
  const color = kind === 'diff' ? 'var(--dsw-alias-state-success-primary,#059669)'
    : kind === 'delete' ? 'var(--dsw-alias-state-error-primary,#dc2626)'
      : 'var(--dsw-alias-label-secondary,#334155)'
  const icon =
    kind === 'terminal' ? 'M4 2l8 6-8 6z'
    : kind === 'diff' ? 'M4 8h8M8 4v8M3 3h6a2 2 0 012 2v6a2 2 0 01-2 2H3a2 2 0 01-2-2V5a2 2 0 012-2z'
    : kind === 'read' ? 'M4 3h8a1 1 0 011 1v9l-3-2-3 2-3-2V4a1 1 0 011-1z'
    : kind === 'search' ? 'M7 3a4 4 0 100 8 4 4 0 000-8zm4 4a4 4 0 01-.5 2L14 12.5 12.5 14 9 10.5'
    : kind === 'list' ? 'M3 5h10M3 8h10M3 11h6'
    : kind === 'delete' ? 'M3 5h10M6 5V3h4v2M5 5l.5 9h5L11 5'
    : 'M8 2a6 6 0 100 12A6 6 0 008 2zm0 2v4l3 2'
  return h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, style: { color, display: 'block' } },
    h('path', { d: icon, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
}

/** Render one line-diff hunk (oldText -> newText) with +/- markers. */
function DiffBody({ model, openFile, cwd, home }: { model: MirrorCardModel; openFile?: (p: string, o?: unknown) => void; cwd?: string; home?: string }): unknown {
	const h = hx
  const path = model.path ?? 'file'
  const oldText = model.oldText ?? ''
  const newText = model.newText ?? ''
  const pathLabel = relativize(path, cwd, home)
  const rows: unknown[] = []
  if (oldText !== '') {
    for (const line of oldText.split('\n')) {
      rows.push(h('div', { key: 'o' + rows.length, className: 'agy-tv-line agy-tv-line-del' },
        h('span', { className: 'agy-tv-line-marker' }, '-'),
        h('span', { style: { flex: 1 } }, line === '' ? ' ' : line)))
    }
  }
  if (newText !== '') {
    for (const line of newText.split('\n')) {
      rows.push(h('div', { key: 'n' + rows.length, className: 'agy-tv-line agy-tv-line-add' },
        h('span', { className: 'agy-tv-line-marker' }, '+'),
        h('span', { style: { flex: 1 } }, line === '' ? ' ' : line)))
    }
  }
  if (rows.length === 0) {
    rows.push(h('div', { key: 'empty', className: 'agy-tv-line' },
      h('span', { className: 'agy-tv-line-marker' }, ' '),
      h('span', { style: { flex: 1, color: 'var(--dsw-alias-label-tertiary,#64748b)' } }, '(no textual change)')))
  }
  const pathNode = openFile !== undefined
    ? h('span', { className: 'agy-tv-path', onClick: () => openFile(path) }, pathLabel)
    : h('span', { style: { cursor: 'default' } }, pathLabel)
  return h('div', { className: 'agy-tv-diff' },
    h('div', { className: 'agy-tv-diff-path' }, pathNode),
    ...rows)
}

function relativize(p: string, cwd?: string, home?: string): string {
  if (cwd && p.startsWith(cwd)) {
    const rel = p.slice(cwd.length).replace(/^[/\\]+/, '')
    return rel !== '' ? rel : p
  }
  if (home && p.startsWith(home)) return '~' + p.slice(home.length)
  return p
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\n… (+' + (s.length - max) + ' chars)' : s
}

/**
 * One-line preview of a card's body for the collapsed header: the first
 * non-empty output line, trimmed to a single compact row. Gives a collapsed
 * card a content cue (e.g. `pwd` -> `/Users/.../agy-spaces`) instead of a bare
 * title + state.
 */
export function previewLine(model: MirrorCardModel, cwd?: string, home?: string): string | undefined {
  // Diff cards cue the changed path first — a collapsed row whose preview is
  // the result text ("wrote") would tell the user nothing about WHAT changed.
  if (model.kind === 'diff') {
    const raw = model.path ?? 'file'
    const rel = relativize(raw, cwd, home)
    const display = rel.length > 40 ? '…' + rel.slice(-40) : rel
    return model.oldText != null ? `± ${display}` : `+ ${display}`
  }
  const out = model.output
  if (out !== undefined && out !== '') {
    const first = out.split('\n').find((l) => l.trim() !== '')
    if (first !== undefined && first.trim() !== '') return first.trim().slice(0, 80)
  }
  return undefined
}

/** Small "OUTPUT" caption above a card's result content. */
function OutputLabel(): unknown {
  const h = hx
  return h('div', { className: 'agy-tv-label' }, '输出')
}

function CardBody({ model, openFile, cwd, home }: { model: MirrorCardModel; openFile?: (p: string, o?: unknown) => void; cwd?: string; home?: string }): unknown {
	const h = hx
  switch (model.kind) {
    case 'terminal': {
      // Trim trailing blank lines: command output arrives with a trailing
      // newline from the shell (`pwd` -> "/path\n"), which would otherwise
      // render an empty last row under the text.
      const body = model.output !== undefined && model.output !== '' ? trimTrailingBlankLines(model.output) : '(no output)'
      return h('div', null,
        ...(model.command !== undefined && model.command !== '' && model.command !== model.title
          ? [h('div', { key: 'cmd', className: 'agy-tv-term-cmd' }, model.command)]
          : []),
        ...(model.cwd !== undefined && model.cwd !== '' ? [h('div', { key: 'cwd', className: 'agy-tv-term-cwd' }, '❯ ' + model.cwd)] : []),
        h(OutputLabel, { key: 'ol' }),
        h('pre', { className: 'agy-tv-term' }, clip(body, 8000)))
    }
    case 'diff':
      return h('div', null,
        h(OutputLabel, { key: 'ol' }),
        h(DiffBody, { model, openFile, cwd, home }))
    case 'read':
    case 'search':
    case 'list':
    case 'delete': {
      const body = model.output !== undefined && model.output !== '' ? trimTrailingBlankLines(model.output) : '(no output)'
      return h('div', null,
        h(OutputLabel, { key: 'ol' }),
        h('pre', { className: 'agy-tv-term' }, clip(body, 8000)))
    }
    default:
      return h('div', null,
        h(OutputLabel, { key: 'ol' }),
        h('pre', { className: 'agy-tv-raw' }, model.raw !== undefined && model.raw !== '' ? clip(model.raw, 4000) : '(no detail)'))
  }
}

export function trimTrailingBlankLines(s: string): string {
  return s.replace(/[\t ]*\r?\n[\t ]*(\r?\n[\t ]*)*$/, '\n')
}

/**
 * The keyed `tool.call.toolview` component for `agy_tool`. Renders the
 * recorded agy tool activity as a native-looking DSH tool card.
 * Receives the ToolCallOwnerProps: { callId, toolName, block, cwd, home,
 * openFile, loadImage, inspect } (locale/inject optional).
 */
export function AgyMirrorToolView(props: AgyToolViewProps): unknown {
	// Default-collapsed: keep the chat stream tidy and compact.
	// Users click the header to expand and inspect the output or diff.
	const [open, setOpen] = useToggle(false)
	const h = hx
  const { block, cwd, home, openFile, inspect } = props
  const settle = isSettled(block)
  const err = isError(block)
  const model = mirrorCardModel(block, cwd, home)
  const state: 'ok' | 'err' | 'run' = !settle ? 'run' : err ? 'err' : 'ok'
  const title = model.title !== '' ? model.title : 'agy tool'
  const preview = !open ? previewLine(model, cwd, home) : undefined
  const header = h('button', {
    type: 'button',
    className: 'agy-tv-head',
    onClick: (e: { stopPropagation: () => void }) => {
      e.stopPropagation()
      setOpen()
    },
    onDoubleClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
    title: inspect !== undefined
      ? (open ? 'Click to collapse · right-click to inspect' : 'Click to expand · right-click to inspect')
      : (open ? 'Click to collapse' : 'Click to expand'),
    onContextMenu: inspect !== undefined ? (e: { preventDefault: () => void }) => { e.preventDefault(); inspect() } : undefined,
  },
    h('span', { className: 'agy-tv-icon' }, h(StatusIcon, { kind: model.kind })),
    h('span', { className: 'agy-tv-kind' }, model.kind),
    ...(model.tool !== undefined && model.tool !== ''
      ? [h('span', { className: 'agy-tv-tool', title: model.tool }, model.tool)]
      : []),
    h('span', { className: 'agy-tv-title', title }, title),
    ...(preview !== undefined
      ? [h('span', { className: 'agy-tv-preview', title: preview }, preview)]
      : []),
    h('span', { className: cls('agy-tv-state', state === 'ok' ? 'agy-tv-state-ok' : state === 'err' ? 'agy-tv-state-err' : 'agy-tv-state-run') }, stateLabel(state)),
    h('span', { style: { display: 'inline-flex', transition: 'transform .15s ease', transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' } }, h(ChevronDown, null)),
  )
  return h('div', { className: cls('agy-tv-row', open && 'agy-tv-open') },
    header,
    h('div', { className: 'agy-tv-body' }, h(CardBody, { model, openFile, cwd, home })),
  )
}

/** Install the native tool-card toolview (call once from apply). */
export function installAgyToolView(ctx: {
	slots: {
		inject(name: string, register: () => () => void): void
		register(opts: { name: string; key?: string; id: string; order?: number; label?: string | (() => string); locale?: string }, C: (p: unknown) => unknown): () => void
	}
}): void {
	ctx.slots.inject('tool.call.toolview', () =>
		ctx.slots.register(
			{ name: 'tool.call.toolview', key: 'agy_tool', id: 'agy-tool-view', label: 'Antigravity tool' },
			AgyMirrorToolView as (p: unknown) => unknown,
		),
	)
}

// Keep the style insert alongside the component.
const gDoc = (globalThis as unknown as { document?: { getElementById(id: string): unknown; createElement(tag: string): { id?: string; textContent?: string }; head?: unknown; documentElement?: { appendChild(n: unknown): void } } }).document
if (gDoc !== undefined && gDoc !== null) {
	const styleId = 'dsh-agy-link-toolview-css'
	if (gDoc.getElementById(styleId) === null) {
		const st = gDoc.createElement('style')
		st.id = styleId
		st.textContent = ROW_CSS
		const host = (gDoc.head ?? gDoc.documentElement) as unknown as { appendChild(n: unknown): void }
		if (host) host.appendChild(st)
	}
}