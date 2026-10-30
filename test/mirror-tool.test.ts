import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RunRecording, RunRegistry } from '../src/host/recording.ts'
import { defineAgyMirrorTool, presentMirrorCall, buildMirrorRunCode, parseMirrorInvocation, toolStepBrief, unwrapMcpTool } from '../src/host/mirror-tool.ts'

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

test('registry eviction never drops live, pinned or most-recent runs', () => {
  const reg = new RunRegistry()
  const pinned = reg.create() // a span is driving this run for hours
  reg.pin(pinned.runId)
  const live = reg.create() // alive process, not settled
  const settled: RunRecording[] = []
  for (let i = 0; i < 12; i++) {
    const r = reg.create()
    r.settle(null)
    settled.push(r)
  }
  assert.equal(reg.get(pinned.runId), pinned, 'pinned run survives registry pressure')
  assert.equal(reg.get(live.runId), live, 'unsettled run survives registry pressure')
  assert.equal(reg.get(settled[11]!.runId), settled[11], 'most recent run is never the victim')
  assert.equal(reg.get(settled[0]!.runId), undefined, 'oldest settled run is evicted')
  assert.equal(reg.size, 8, 'settled runs are trimmed back to the cap')
  // Unpinning makes it evictable once it settles, but never while it is live.
  reg.unpin(pinned.runId)
  for (let i = 0; i < 12; i++) {
    const r = reg.create()
    r.settle(null)
  }
  assert.equal(reg.get(pinned.runId), pinned, 'still live, so still exempt')
  pinned.settle(null)
  for (let i = 0; i < 12; i++) {
    const r = reg.create()
    r.settle(null)
  }
  assert.equal(reg.get(pinned.runId), undefined, 'settled + unpinned run is reclaimable')
})

test('remember() refreshes recency so a re-registered run is not the victim', () => {
  const reg = new RunRegistry()
  const first = reg.create()
  first.settle(null)
  for (let i = 0; i < 7; i++) {
    const r = reg.create()
    r.settle(null)
  }
  // A continuation span re-registers the run it is about to consume: that must
  // move it to the most-recent position (Map.set alone keeps the old slot).
  reg.remember(first)
  assert.deepEqual(reg.runIds[reg.runIds.length - 1], first.runId)
  const fresh = reg.create()
  fresh.settle(null)
  assert.equal(reg.get(first.runId), first, 'the refreshed run survives the next eviction')
  assert.equal(reg.size, 8)
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
})

test('a lost recording degrades to a task-facing notice, never a harness error', async () => {
  const mirror = defineAgyMirrorTool({ runs: new RunRegistry() })
  // Missing run (evicted / bridge restarted while the step was queued).
  const gone = String(
    await mirror.execute(
      { run: 'missing', step: 56, tool: 'run_command', input: { CommandLine: './test.sh' } } as never,
      { signal: fakeSignal() } as never,
    ),
  )
  assert.ok(gone.includes('no longer resident'), gone)
  assert.ok(gone.includes('do NOT investigate the bridge'), gone)
  assert.ok(gone.includes('./test.sh'), gone)
  assert.ok(!/no recorded agy run/i.test(gone), 'must not leak the old internal error text')
  // Recording present, but the cursor is not a completed tool step.
  const reg = new RunRegistry()
  const rec = reg.create()
  rec.append({ kind: 'step', stepKey: 't1', stepKind: 'text', text: 'hi' } as never)
  const cursorOnly = String(
    await defineAgyMirrorTool({ runs: reg }).execute({ run: rec.runId, step: 0 } as never, { signal: fakeSignal() } as never),
  )
  assert.ok(cursorOnly.includes('no longer resident'), cursorOnly)
  assert.ok(cursorOnly.includes('not a completed tool step'), cursorOnly)
})

test('an out-of-range cursor blames the cursor, not a recycled output', async () => {
  const reg = new RunRegistry()
  const rec = reg.create()
  rec.append({ kind: 'step', stepKey: 't1', stepKind: 'tool', text: '', tool: { name: 'run_command', args: { command: 'ls' }, output: 'x' } } as never)
  const out = String(
    await defineAgyMirrorTool({ runs: reg }).execute({ run: rec.runId, step: 42 } as never, { signal: fakeSignal() } as never),
  )
  assert.ok(out.includes('outside this recording'), out)
  assert.ok(!out.includes('recycled'), 'must not claim the output was recycled: ' + out)
})

test('cursor-only invocations: execute + presenters resolve detail from the recording', async () => {
  // The run_code wrapper embeds only {run, step}; schema marks tool/input
  // optional and the registered presenters enrich from the recording.
  const reg = new RunRegistry()
  const rec = reg.create()
  rec.append({ kind: 'step', stepKey: 't1', stepKind: 'tool', text: '', tool: { name: 'run_command', args: { command: 'ls -la' }, output: 'x' } } as never)
  const mirror = defineAgyMirrorTool({ runs: reg })
  const cursor = { run: rec.runId, step: 0 }
  assert.equal(await mirror.execute(cursor as never, { signal: fakeSignal() } as never), 'x')
  const card = mirror.presentCall?.(cursor)
  assert.equal((card as { card: string } | undefined)?.card, 'terminal')
  assert.equal((card as { title?: string } | undefined)?.title, 'ls -la')
})

test('run_code wrapper round-trip: build -> parse recovers the cursor', () => {
  const built = buildMirrorRunCode('7d246c00-c0d1-4e3c-a25b-848881b81042', 15, 'run_command')
  assert.equal(built.description, 'run_command')
  assert.ok(built.code.includes("tools['agy_tool']({\"run\":\"7d246c00-c0d1-4e3c-a25b-848881b81042\",\"step\":15})"), built.code)
  assert.deepEqual(parseMirrorInvocation(built.code), { run: '7d246c00-c0d1-4e3c-a25b-848881b81042', step: 15 })
  assert.equal(parseMirrorInvocation('unrelated code'), null)
  const pretty = buildMirrorRunCode('r', 1, 'run_command', toolStepBrief('run_command', { command: 'ls -la' }))
  assert.equal(pretty.description, '$ ls -la · run_command')
})

test('cards read PascalCase agy arg keys (CommandLine, AbsolutePath, …)', () => {
  const term = presentMirrorCall({ tool: 'run_command', input: { CommandLine: 'ls -la', WorkingDirectory: '/tmp' } })
  assert.equal(term?.card, 'terminal')
  if (term?.card === 'terminal') {
    assert.equal(term.title, 'ls -la')
    assert.equal(term.cwd, '/tmp')
  }
  const read = presentMirrorCall({ tool: 'view_file', input: { AbsolutePath: '/tmp/a.txt' } })
  if (read?.card === 'generic') assert.equal(read.title, 'Read /tmp/a.txt')
  const search = presentMirrorCall({ tool: 'find_by_name', input: { Pattern: '*.ts', SearchDirectory: '/src' } })
  if (search?.card === 'generic') assert.equal(search.title, 'Search *.ts')
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
  const replaceContent = presentMirrorCall({
    tool: 'replace_file_content',
    input: {
      TargetFile: '/src/main.ts',
      TargetContent: 'const a = 1;',
      ReplacementContent: 'const a = 2;\nconst b = 3;',
      Description: 'Update constant a and add b',
    },
  })
  assert.equal(replaceContent?.card, 'diff')
  if (replaceContent?.card === 'diff') {
    assert.equal(replaceContent.title, 'Update constant a and add b · /src/main.ts')
    assert.equal(replaceContent.diffs[0]?.path, '/src/main.ts')
    assert.equal(replaceContent.diffs[0]?.oldText, 'const a = 1;')
    assert.equal(replaceContent.diffs[0]?.newText, 'const a = 2;\nconst b = 3;')
    assert.deepEqual(replaceContent.locations, [{ path: '/src/main.ts' }])
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
  const grep = presentMirrorCall({ tool: 'grep_search', input: { Query: 'function foo', SearchPath: '/src' } })
  if (grep?.card === 'generic') {
    assert.equal(grep.kind, 'search')
    assert.equal(grep.title, 'Search function foo')
  } else {
    assert.fail('expected generic grep search card')
  }
  const view = presentMirrorCall({ tool: 'view_file', input: { path: 'a.ts', offset: 3 } })
  if (view?.card === 'generic') {
    assert.equal(view.kind, 'read')
    assert.deepEqual(view.locations, [{ path: 'a.ts', line: 4 }])
  } else {
    assert.fail('expected generic read card for view_file')
  }
  const viewPascal = presentMirrorCall({ tool: 'view_file', input: { AbsolutePath: '/app/index.ts', StartLine: 10 } })
  if (viewPascal?.card === 'generic') {
    assert.equal(viewPascal.kind, 'read')
    assert.deepEqual(viewPascal.locations, [{ path: '/app/index.ts', line: 10 }])
  } else {
    assert.fail('expected generic read card for view_file PascalCase')
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
  const ask = presentMirrorCall({ tool: 'ask_question', input: { questions: [{ question: 'Which library to use?' }] } })
  assert.equal(ask?.card, 'generic')
  assert.equal(ask?.title, 'Ask Question: Which library to use?')
  const fetchUrl = presentMirrorCall({ tool: 'read_url_content', input: { Url: 'https://example.com/api' } })
  assert.equal(fetchUrl?.card, 'generic')
  assert.equal(fetchUrl?.kind, 'fetch')
  assert.equal(fetchUrl?.title, 'Fetch https://example.com/api')
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

test('presentMirrorResult keeps terminal output and repeats diffs for edit and replace_file_content', () => {
  const term = defineAgyMirrorTool({ runs: new RunRegistry() }).presentResult
  assert.ok(term !== undefined)
  // presenters soft-validate: args must carry the required run/step fields
  const t = term?.({ run: 'r', step: 0, tool: 'run_command', input: { command: 'ls' } }, { content: [{ type: 'text', text: 'a.txt' }], isError: false })
  assert.equal((t as { card: string } | undefined)?.card, 'terminal')
  assert.equal((t as { output?: string }).output, 'a.txt')
  const d = term?.({ run: 'r', step: 1, tool: 'write_to_file', input: { path: 'a', content: 'x' } }, { content: [{ type: 'text', text: 'wrote' }], isError: false })
  assert.equal((d as { card: string } | undefined)?.card, 'diff')
  assert.deepEqual((d as { diffs: Array<{ path: string }> }).diffs, [{ path: 'a', oldText: null, newText: 'x' }])
  const rep = term?.(
    { run: 'r', step: 2, tool: 'replace_file_content', input: { TargetFile: 'b.ts', TargetContent: 'old', ReplacementContent: 'new' } },
    { content: [{ type: 'text', text: 'replaced' }], isError: false },
  )
  assert.equal((rep as { card: string } | undefined)?.card, 'diff')
  assert.deepEqual((rep as { diffs: Array<{ path: string }> }).diffs, [{ path: 'b.ts', oldText: 'old', newText: 'new' }])
  const invalid = term?.({ tool: 'run_command' }, { content: [], isError: false })
  assert.equal(invalid, undefined, 'soft validation falls back to generic on bad args')
})

test('getGitHeadContent safely retrieves HEAD content or returns null', () => {
  const mockExec = ((cmd: string, args: string[]) => {
    if (args[0] === 'rev-parse') return '/repo\n'
    if (args[0] === 'show' && args[1] === 'HEAD:src/index.ts') return 'console.log("hello")\n'
    throw new Error('not found')
  }) as never
  const content = import('../src/host/mirror-tool.ts').then((m) => {
    assert.equal(m.getGitHeadContent('/repo/src/index.ts', mockExec), 'console.log("hello")\n')
    assert.equal(m.getGitHeadContent('/repo/outside.ts', mockExec), null)
    assert.equal(m.getGitHeadContent('', mockExec), null)
  })
  return content
})

test('presentMirrorCall and toolStepBrief support web search, task management, schedule and subagents', () => {
  const web = presentMirrorCall({ tool: 'search_web', input: { query: 'google antigravity cli' } })
  assert.equal(web?.card, 'generic')
  if (web?.card === 'generic') {
    assert.equal(web.kind, 'search')
    assert.equal(web.title, 'Web search google antigravity cli')
  }
  const task = presentMirrorCall({ tool: 'manage_task', input: { Action: 'status', TaskId: 'task-123' } })
  assert.equal(task?.card, 'generic')
  if (task?.card === 'generic') {
    assert.equal(task.kind, 'execute')
    assert.equal(task.title, 'Task status (task-123)')
  }
  const sched = presentMirrorCall({ tool: 'schedule', input: { DurationSeconds: 300, Prompt: 'Check build' } })
  assert.equal(sched?.card, 'generic')
  if (sched?.card === 'generic') {
    assert.equal(sched.title, 'Schedule 300s timer')
  }
  const subagent = presentMirrorCall({ tool: 'invoke_subagent', input: { Subagents: [{ Role: 'Code Reviewer' }] } })
  assert.equal(subagent?.card, 'generic')
  if (subagent?.card === 'generic') {
    assert.equal(subagent.title, 'Subagent: Code Reviewer')
  }
  const sendMsg = presentMirrorCall({ tool: 'send_message', input: { Recipient: 'agent-1' } })
  assert.equal(sendMsg?.card, 'generic')
  if (sendMsg?.card === 'generic') {
    assert.equal(sendMsg.title, 'Message subagent agent-1')
  }

  // toolStepBrief
  assert.equal(toolStepBrief('view_file', { AbsolutePath: '/foo/bar.ts' }), 'read /foo/bar.ts')
  assert.equal(toolStepBrief('search_web', { query: 'antigravity docs' }), 'search web antigravity docs')
  assert.equal(toolStepBrief('read_url_content', { Url: 'https://antigravity.google' }), 'fetch https://antigravity.google')
  assert.equal(toolStepBrief('manage_task', { Action: 'kill', TaskId: 'task-9' }), 'task kill task-9')
  assert.equal(toolStepBrief('invoke_subagent', { Subagents: [{ Role: 'Tester' }] }), 'subagent: Tester')
  assert.equal(toolStepBrief('send_message', { Recipient: 'agent-2' }), 'msg agent-2')
})

test('presentMirrorResult parses exit code from command output', () => {
  const term = defineAgyMirrorTool({ runs: new RunRegistry() }).presentResult
  assert.ok(term !== undefined)
  const ok = term?.(
    { run: 'r', step: 0, tool: 'run_command', input: { command: 'npm test' } },
    { content: [{ type: 'text', text: 'Tests passed\nThe command exited with code 0.\nOutput:\nall ok' }], isError: false },
  )
  assert.equal((ok as { exitCode?: number }).exitCode, 0)

  const fail = term?.(
    { run: 'r', step: 1, tool: 'run_command', input: { command: 'false' } },
    { content: [{ type: 'text', text: 'The command exited with code 1.' }], isError: true },
  )
  assert.equal((fail as { exitCode?: number }).exitCode, 1)

  const opsBashFail = term?.(
    { run: 'r', step: 2, tool: 'ops_bash', input: { command: 'exit 2' } },
    { content: [{ type: 'text', text: 'error line\n[exit code 2]' }], isError: false },
  )
  assert.equal((opsBashFail as { exitCode?: number }).exitCode, 2)

  const opsBashTimeout = term?.(
    { run: 'r', step: 3, tool: 'ops_bash', input: { command: 'sleep 60' } },
    { content: [{ type: 'text', text: '[command timed out after 30000ms]' }], isError: false },
  )
  assert.equal((opsBashTimeout as { exitCode?: number }).exitCode, 1)
})

test('unwrapMcpTool correctly unwraps call_mcp_tool and namespaced tools', () => {
  // agy JSON string format with quotes
  const unwrap1 = unwrapMcpTool('call_mcp_tool', {
    ServerName: '"dsh-ops"',
    ToolName: '"ops_bash"',
    Arguments: '{"command":"git status","workdir":"/app"}',
  })
  assert.equal(unwrap1.isMcp, true)
  assert.equal(unwrap1.tool, 'ops_bash')
  assert.equal(unwrap1.server, 'dsh-ops')
  assert.equal(unwrap1.input.command, 'git status')
  assert.equal(unwrap1.input.workdir, '/app')

  // object arguments format
  const unwrap2 = unwrapMcpTool('callMcpTool', {
    server_name: 'dsh-ops',
    tool_name: 'ops_grep',
    arguments: { pattern: 'test_func', path: 'src' },
  })
  assert.equal(unwrap2.isMcp, true)
  assert.equal(unwrap2.tool, 'ops_grep')
  assert.equal(unwrap2.server, 'dsh-ops')
  assert.equal(unwrap2.input.pattern, 'test_func')

  // namespaced mcp__ format
  const unwrap3 = unwrapMcpTool('mcp__dsh-ops__ops_glob', { pattern: ['**/*.ts'] })
  assert.equal(unwrap3.isMcp, true)
  assert.equal(unwrap3.tool, 'ops_glob')
  assert.equal(unwrap3.server, 'dsh-ops')

  // non-mcp tool unchanged
  const unwrap4 = unwrapMcpTool('run_command', { CommandLine: 'ls' })
  assert.equal(unwrap4.isMcp, false)
  assert.equal(unwrap4.tool, 'run_command')
  assert.equal(unwrap4.input.CommandLine, 'ls')
})

test('call_mcp_tool projects into native terminal and search cards', () => {
  // ops_bash via call_mcp_tool -> TerminalCallView
  const bashCall = presentMirrorCall({
    tool: 'call_mcp_tool',
    input: {
      ServerName: '"dsh-ops"',
      ToolName: '"ops_bash"',
      Arguments: '{"command":"git log -n 5 --oneline","workdir":"/workspace"}',
    },
  })
  assert.equal(bashCall?.card, 'terminal')
  if (bashCall?.card === 'terminal') {
    assert.equal(bashCall.title, 'git log -n 5 --oneline')
    assert.equal(bashCall.cwd, '/workspace')
  }

  // ops_glob via call_mcp_tool -> Search GenericCallView
  const globCall = presentMirrorCall({
    tool: 'call_mcp_tool',
    input: {
      ServerName: 'dsh-ops',
      ToolName: 'ops_glob',
      Arguments: { pattern: ['**/*.ts', '!node_modules/**'] },
    },
  })
  assert.equal(globCall?.card, 'generic')
  if (globCall?.card === 'generic') {
    assert.equal(globCall.kind, 'search')
    assert.equal(globCall.title, 'Search **/*.ts, !node_modules/**')
  }

  // custom generic MCP tool -> GenericCallView with server prefix
  const customCall = presentMirrorCall({
    tool: 'call_mcp_tool',
    input: {
      ServerName: 'task-tracker',
      ToolName: 'list_todos',
      Arguments: { limit: 10 },
    },
  })
  assert.equal(customCall?.card, 'generic')
  if (customCall?.card === 'generic') {
    assert.equal(customCall.title, 'task-tracker: list_todos')
  }

  // toolStepBrief unwraps MCP tools
  assert.equal(
    toolStepBrief('call_mcp_tool', {
      ServerName: '"dsh-ops"',
      ToolName: '"ops_bash"',
      Arguments: '{"command":"git status"}',
    }),
    '$ git status',
  )
  assert.equal(
    toolStepBrief('call_mcp_tool', {
      ServerName: 'dsh-ops',
      ToolName: 'ops_glob',
      Arguments: { pattern: ['*.json'] },
    }),
    'search *.json',
  )
  assert.equal(
    toolStepBrief('call_mcp_tool', {
      ServerName: 'my-service',
      ToolName: 'custom_query',
      Arguments: {},
    }),
    'my-service: custom_query',
  )
})

test('recorded call_mcp_tool step resolves and executes transparently', async () => {
  const reg = new RunRegistry()
  const rec = reg.create()
  rec.append({
    kind: 'step',
    stepKey: 't1',
    stepKind: 'tool',
    text: '',
    tool: {
      name: 'call_mcp_tool',
      args: {
        ServerName: '"dsh-ops"',
        ToolName: '"ops_bash"',
        Arguments: '{"command":"git branch"}',
      },
      output: '* main\n[exit code 0]',
    },
  } as never)

  const mirror = defineAgyMirrorTool({ runs: reg })
  const cursor = { run: rec.runId, step: 0 }
  assert.equal(await mirror.execute(cursor as never, { signal: fakeSignal() } as never), '* main\n[exit code 0]')

  const card = mirror.presentCall?.(cursor)
  assert.equal((card as { card: string } | undefined)?.card, 'terminal')
  assert.equal((card as { title?: string } | undefined)?.title, 'git branch')

  const res = mirror.presentResult?.(cursor, { content: [{ type: 'text', text: '* main\n[exit code 0]' }], isError: false })
  assert.equal((res as { card: string } | undefined)?.card, 'terminal')
  assert.equal((res as { exitCode?: number } | undefined)?.exitCode, 0)
})

