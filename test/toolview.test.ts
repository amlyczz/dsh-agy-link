import { test } from 'node:test'
import assert from 'node:assert/strict'
// The client module is browser-oriented (require('react'), globalThis.document);
// these tests exercise the pure card-model derivation before any React render.
import { mirrorCardModel, installAgyToolView, previewLine, trimTrailingBlankLines, makeToggle, type ToolBlock } from '../src/client/toolview.ts'

function settled(block: Partial<ToolResultBits>): ToolBlock {
  return {
    kind: 'tool-result',
    call: { name: 'agy_tool', argsRaw: JSON.stringify(block.args ?? {}) },
    content: block.content !== undefined ? block.content.map((text) => ({ type: 'text' as const, text })) : [],
    isError: block.isError ?? false,
    ...(block.error !== undefined ? { error: block.error as never } : {}),
  } as unknown as ToolBlock
}

interface ToolResultBits {
  args?: Record<string, unknown>
  content?: string[]
  isError?: boolean
  error?: { name: string; code: string }
}

function running(args: Record<string, unknown>): ToolBlock {
  return { name: 'agy_tool', argsRaw: JSON.stringify(args), turn: 1, step: 1, time: 0, subCalls: [] } as unknown as ToolBlock
}

test('mirrorCardModel: run_command -> terminal card with command and output', () => {
  const m = mirrorCardModel(
    settled({
      args: { run: 'r1', step: 3, tool: 'run_command', input: { CommandLine: 'ls -la', WorkingDirectory: '/tmp' } },
      content: ['a.txt\nb.txt'],
    }),
  )
  assert.equal(m.kind, 'terminal')
  assert.equal(m.tool, 'run_command')
  assert.equal(m.command, 'ls -la')
  assert.equal(m.cwd, '/tmp')
  assert.equal(m.output, 'a.txt\nb.txt')
})

test('mirrorCardModel: write_to_file -> diff card with path and content', () => {
  const m = mirrorCardModel(
    settled({
      args: { run: 'r1', step: 4, tool: 'write_to_file', input: { TargetFile: '/app/a.txt', CodeContent: 'hello' } },
      content: ['wrote'],
    }),
  )
  assert.equal(m.kind, 'diff')
  assert.equal(m.tool, 'write_to_file')
  assert.equal(m.path, '/app/a.txt')
  assert.equal(m.oldText, null)
  assert.equal(m.newText, 'hello')
})

test('mirrorCardModel: replace_file_content -> diff with old/new text', () => {
  const m = mirrorCardModel(
    settled({
      args: {
        run: 'r1', step: 5, tool: 'replace_file_content',
        input: { TargetFile: '/src/main.ts', TargetContent: 'const a = 1;', ReplacementContent: 'const a = 2;', Description: 'Update constant' },
      },
      content: ['updated'],
    }),
  )
  assert.equal(m.kind, 'diff')
  assert.equal(m.tool, 'replace_file_content')
  assert.equal(m.title, 'Edit /src/main.ts · Update constant')
  assert.equal(m.oldText as string | null, 'const a = 1;')
  assert.equal(m.newText, 'const a = 2;')
})

test('mirrorCardModel: replace_file_content with cwd relativizes title to Edit demo/old.txt', () => {
  const m = mirrorCardModel(
    settled({
      args: {
        run: 'r1', step: 6, tool: 'replace_file_content',
        input: {
          TargetFile: '/Users/test/workspace/demo/old.txt',
          TargetContent: 'line2',
          ReplacementContent: 'LINE2-CHANGED',
          toolAction: 'Editing file',
          toolSummary: 'File edit',
        },
      },
      content: ['ok'],
    }),
    '/Users/test/workspace',
  )
  assert.equal(m.kind, 'diff')
  assert.equal(m.tool, 'replace_file_content')
  assert.equal(m.title, 'Edit demo/old.txt')
  assert.equal(m.oldText, 'line2')
  assert.equal(m.newText, 'LINE2-CHANGED')
})

test('mirrorCardModel: view_file -> read card with location line', () => {
  const m = mirrorCardModel(
    settled({
      args: { run: 'r1', step: 6, tool: 'view_file', input: { AbsolutePath: '/app/index.ts', StartLine: 10 } },
      content: ['10 lines'],
    }),
  )
  assert.equal(m.kind, 'read')
  assert.equal(m.path, '/app/index.ts')
  assert.deepEqual(m.location, { path: '/app/index.ts', line: 10 })
})

test('mirrorCardModel: grep_search -> search card', () => {
  const m = mirrorCardModel(
    settled({
      args: { run: 'r1', step: 7, tool: 'grep_search', input: { Query: 'function foo', SearchPath: '/src' } },
      content: ['match'],
    }),
  )
  assert.equal(m.kind, 'search')
  assert.equal(m.tool, 'grep_search')
  assert.equal(m.title, 'Search function foo')
})

test('mirrorCardModel: unknown tool -> generic with raw args', () => {
  const m = mirrorCardModel(
    settled({
      args: { run: 'r1', step: 8, tool: 'brand_new_tool', input: { X: 1 } },
      content: ['x'],
    }),
  )
  assert.equal(m.kind, 'generic')
  assert.equal(m.title, 'brand_new_tool')
})

test('mirrorCardModel: running block (no result) still classifies terminal', () => {
  const m = mirrorCardModel(
    running({
      run: 'r1', step: 2, tool: 'run_command', input: { CommandLine: 'pwd' },
    }),
  )
  assert.equal(m.kind, 'terminal')
  assert.equal(m.command, 'pwd')
  assert.equal(m.output, '')
})

test('mirrorCardModel: no args -> generic fallback', () => {
  const m = mirrorCardModel({ kind: 'tool-result', call: null, content: [], isError: false } as unknown as ToolBlock)
  assert.equal(m.kind, 'generic')
})

test('mirrorCardModel: json-string input still projects (agy serializes some args)', () => {
  const m = mirrorCardModel(
    settled({
      args: { run: 'r1', step: 9, tool: 'run_command', input: JSON.stringify({ command: 'pwd' }) },
      content: ['/tmp'],
    }),
  )
  assert.equal(m.kind, 'terminal')
  assert.equal(m.command, 'pwd')
})

test('mirrorCardModel: errored tool keeps card kind + state', () => {
  const m = mirrorCardModel(
    settled({
      args: { run: 'r1', step: 10, tool: 'run_command', input: { CommandLine: 'false' } },
      content: [],
      isError: true,
      error: { name: 'Error', code: 'AGY_ERROR' },
    }),
  )
  assert.equal(m.kind, 'terminal')
  assert.equal(m.command, 'false')
})

test('installAgyToolView registers a keyed agy_tool toolview', () => {
  const registrations: { opts: { key?: string; id?: string } }[] = [];
  installAgyToolView({
    slots: {
      inject(_n: string, cb: () => () => void) { cb(); },
      register(opts: { key?: string; id?: string }) { registrations.push({ opts }); return () => {}; },
    },
  } as never);
  const keys = registrations.map((r) => r.opts.key);
  assert.ok(keys.includes('agy_tool'), 'agy_tool toolview registered');
  assert.ok(keys.includes('run_code'), 'run_code toolview registered for Code Mode wrappers');
  assert.equal(registrations.find((r) => r.opts.key === 'agy_tool')?.opts.id, 'agy-tool-view');
})

test('previewLine: terminal card previews the first non-empty output line', () => {
  const m = mirrorCardModel(
    settled({
      args: { run: 'r1', step: 1, tool: 'run_command', input: { CommandLine: 'pwd' } },
      content: ['\n/Users/tinytinycn/dsh-projects/agy-spaces\n\n'],
    }),
  )
  assert.equal(m.kind, 'terminal')
  assert.equal(previewLine(m), '/Users/tinytinycn/dsh-projects/agy-spaces')
})

test('previewLine: diff card previews the target path', () => {
  const m = mirrorCardModel(
    settled({
      args: { run: 'r1', step: 2, tool: 'write_to_file', input: { TargetFile: '/app/a.txt', CodeContent: 'hi' } },
      content: ['wrote'],
    }),
  )
  assert.equal(m.kind, 'diff')
  assert.equal(previewLine(m), '+ /app/a.txt')
})

test('previewLine: no output and unknown kind falls back to undefined', () => {
  const m = mirrorCardModel(
    settled({
      args: { run: 'r1', step: 3, tool: 'brand_new_tool', input: { X: 1 } },
      content: [],
    }),
  )
  assert.equal(m.kind, 'generic')
  assert.equal(previewLine(m), undefined)
})

test('trimTrailingBlankLines: collapses trailing blank rows but keeps one newline', () => {
  assert.equal(trimTrailingBlankLines('a\nb\n'), 'a\nb\n')
  assert.equal(trimTrailingBlankLines('a\nb\n\n\n  \n'), 'a\nb\n')
  assert.equal(trimTrailingBlankLines(''), '')
  assert.equal(trimTrailingBlankLines('x'), 'x')
})

test('makeToggle: flips back and forth across many clicks (collapse -> expand regression)', () => {
  // Simulate React useState with a state holder; the toggler is built from the
  // wrapped setter, so it must keep flipping regardless of how many times it
  // was clicked (the raw no-arg `setState(undefined)` bug died at the first
  // collapse — this guards the fix).
  let state = false
  const setValue = (next: boolean | ((prev: boolean) => boolean)) => {
    state = typeof next === 'function' ? (next as (prev: boolean) => boolean)(state) : next
  }
  const toggle = makeToggle(setValue)
  assert.equal(state, false) // collapsed by default
  toggle() // expand
  assert.equal(state, true)
  toggle() // collapse again
  assert.equal(state, false)
  toggle(); toggle(); toggle() // 3 more flips: true, false, true
  assert.equal(state, true)
  toggle()
  assert.equal(state, false)
})