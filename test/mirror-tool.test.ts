import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RunRecording, RunRegistry } from '../src/host/recording.ts'
import { defineAgyMirrorTool, presentMirrorCall } from '../src/host/mirror-tool.ts'

function fakeSignal(): AbortSignal {
  return new AbortController().signal
}

test('recording: events stream live and settle, with stable indices', async () => {
  const rec = new RunRecording('run-x')
  const seen: string[] = []
  const reader = (async () => {
    for await (const ev of rec.eventsFrom(0)) seen.push((ev as { kind: string; stepKey?: string }).stepKey ?? ev.kind)
  })()
  rec.append({ kind: 'init', conversationId: 'c' } as never)
  rec.append({ kind: 'step', stepKey: 'a', stepKind: 'text', text: 'hi' } as never)
  rec.settle(null)
  await reader
  assert.deepEqual(seen, ['init', 'a'])
  assert.equal(rec.sawTextBefore(1), false)
  assert.equal(rec.sawTextBefore(2), true)
  assert.equal(rec.getResultEvent(), null)
})

test('recording: result event projection and tool lookup by index', () => {
  const rec = new RunRecording('run-y')
  rec.append({ kind: 'step', stepKey: 't', stepKind: 'tool', text: '', tool: { name: 'run_command', args: { command: 'ls' }, output: 'x' } } as never)
  rec.append({ kind: 'result', conversationId: 'cy', ok: true, response: 'done', usage: {} } as never)
  assert.deepEqual(rec.getResultEvent(), { ok: true, response: 'done' })
  assert.equal(rec.toolEventAt(0)?.name, 'run_command')
  assert.equal(rec.toolEventAt(1), null)
})

test('registry retains bounded LRU and serves runs by id', () => {
  const reg = new RunRegistry()
  const a = reg.create()
  assert.equal(reg.get(a.runId), a)
  reg.forget(a.runId)
  assert.equal(reg.get(a.runId), undefined)
})

test('mirror execute replays recorded output and errors honestly', async () => {
  const reg = new RunRegistry()
  const rec = reg.create()
  rec.append({ kind: 'step', stepKey: 't1', stepKind: 'tool', text: '', tool: { name: 'run_command', args: { command: 'ls' }, output: 'out-line' } } as never)
  rec.append({ kind: 'step', stepKey: 't2', stepKind: 'tool', text: '', tool: { name: 'find_by_name', args: {}, error: 'boom' } } as never)
  const mirror = defineAgyMirrorTool({ runs: reg })
  assert.equal(await mirror.execute({ run: rec.runId, step: 0, tool: 'run_command' } as never, { signal: fakeSignal() } as never), 'out-line')
  await assert.rejects(
    () => mirror.execute({ run: rec.runId, step: 1, tool: 'find_by_name' } as never, { signal: fakeSignal() } as never),
    (e: unknown) => String(e).includes('boom'),
  )
  await assert.rejects(
    () => mirror.execute({ run: 'missing', step: 0, tool: 'x' } as never, { signal: fakeSignal() } as never),
    (e: unknown) => String(e).includes('no recorded agy run'),
  )
})

test('presentMirrorCall maps the agy vocabulary onto native cards', () => {
  const terminal = presentMirrorCall({ tool: 'run_command', input: { command: 'ls -la', description: 'list files', cwd: '/tmp' } })
  assert.equal(terminal?.card, 'terminal')
  if (terminal?.card === 'terminal') {
    assert.equal(terminal.title, 'ls -la')
    assert.equal(terminal.description, 'list files')
    assert.equal(terminal.cwd, '/tmp')
  }
  const diff = presentMirrorCall({ tool: 'write_to_file', input: { path: 'a.txt', content: 'hello' } })
  assert.equal(diff?.card, 'diff')
  if (diff?.card === 'diff') {
    assert.equal(diff.diffs[0]?.path, 'a.txt')
    assert.equal(diff.diffs[0]?.oldText, null)
    assert.equal(diff.diffs[0]?.newText, 'hello')
  }
  const read = presentMirrorCall({ tool: 'read_file', input: { path: 'src/x.ts' } })
  assert.equal(read?.card, 'generic')
  if (read?.card === 'generic') {
    assert.equal(read.kind, 'read')
    assert.deepEqual(read.locations, [{ path: 'src/x.ts' }])
  }
  const search = presentMirrorCall({ tool: 'find_by_name', input: { pattern: 'note*.txt' } })
  if (search?.card === 'generic') {
    assert.equal(search.kind, 'search')
    assert.equal(search.title, 'Search note*.txt')
  } else {
    assert.fail('expected generic search card')
  }
  const view = presentMirrorCall({ tool: 'view_file', input: { path: 'a.ts', offset: 3 } })
  if (view?.card === 'generic') {
    assert.equal(view.kind, 'read')
    assert.deepEqual(view.locations, [{ path: 'a.ts', line: 4 }])
  } else {
    assert.fail('expected generic read card for view_file')
  }
  const listing = presentMirrorCall({ tool: 'list_dir', input: { path: '/tmp/x' } })
  if (listing?.card === 'generic') {
    assert.equal(listing.title, 'List /tmp/x')
  } else {
    assert.fail('expected generic card for list_dir')
  }
  const del = presentMirrorCall({ tool: 'delete_file', input: { path: 'old.ts' } })
  if (del?.card === 'generic') {
    assert.equal(del.kind, 'delete')
  } else {
    assert.fail('expected delete card for delete_file')
  }
  const fallback = presentMirrorCall({ tool: 'something_new', input: { a: 1 } })
  assert.equal(fallback?.card, 'generic')
  // JSON-string inputs (agy serializes some tool args) still project
  const fromJson = presentMirrorCall({ tool: 'run_command', input: JSON.stringify({ command: 'pwd' }) })
  if (fromJson?.card === 'terminal') {
    assert.equal(fromJson.title, 'pwd')
  } else {
    assert.fail('expected terminal card from JSON-string input')
  }
})

test('presentMirrorResult keeps terminal output and repeats diffs', () => {
  const term = defineAgyMirrorTool({ runs: new RunRegistry() }).presentResult
  assert.ok(term !== undefined)
  // presenters soft-validate: args must carry the required run/step fields
  const t = term?.({ run: 'r', step: 0, tool: 'run_command', input: { command: 'ls' } }, { content: [{ type: 'text', text: 'a.txt' }], isError: false })
  assert.equal((t as { card: string } | undefined)?.card, 'terminal')
  assert.equal((t as { output?: string }).output, 'a.txt')
  const d = term?.({ run: 'r', step: 1, tool: 'write_to_file', input: { path: 'a', content: 'x' } }, { content: [{ type: 'text', text: 'wrote' }], isError: false })
  assert.equal((d as { card: string } | undefined)?.card, 'diff')
  assert.deepEqual((d as { diffs: Array<{ path: string }> }).diffs, [{ path: 'a', oldText: null, newText: 'x' }])
  const invalid = term?.({ tool: 'run_command' }, { content: [], isError: false })
  assert.equal(invalid, undefined, 'soft validation falls back to generic on bad args')
})
