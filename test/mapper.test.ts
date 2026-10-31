import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { EventMapper, rewriteImageMarkdown, suffixDelta, usageFromRaw, rememberToolCallId, consumeToolBinding, expirePendingToolCalls, type ToolCallState } from '../src/host/mapper.ts'
import { mirrorCallId, parseMirrorCallId } from '../src/host/recording.ts'
import { parseMirrorInvocation } from '../src/host/mirror-tool.ts'

type FinishChunk = Extract<StreamChunk, { type: 'finish' }>
type UsageChunk = Extract<StreamChunk, { type: 'usage' }>
type ToolCallEnd = Extract<StreamChunk, { type: 'block-end' }> & { block: { type: 'tool-call'; id: string; name: string; arguments: string } }

/** Fresh mapper for one span of run r1 (cut on completed tools, like main turns). */
function newSpan(runId = 'r1', initialSawText = false, useCodeWrapper = false): EventMapper {
  return new EventMapper({ runId, cutOnTool: true, initialSawText, useCodeWrapper })
}

function mapAll(mapper: EventMapper, events: unknown[], startIdx = 0): StreamChunk[] {
  const out: StreamChunk[] = []
  let i = startIdx
  for (const ev of events) {
    out.push(...mapper.map(ev as never, i))
    i++
    if (mapper.isFinished) break
  }
  return out
}
function lastChunk(cs: StreamChunk[]): StreamChunk {
  const c = cs[cs.length - 1]
  assert.ok(c !== undefined)
  return c
}
function asFinish(c: StreamChunk): FinishChunk {
  assert.equal(c.type, 'finish')
  return c as FinishChunk
}
function asUsage(c: StreamChunk): UsageChunk {
  assert.equal(c.type, 'usage')
  return c as UsageChunk
}
function toolCallEnd(cs: StreamChunk[]): ToolCallEnd {
  const c = cs.find((x) => x.type === 'block-end' && (x as { block: { type: string } }).block.type === 'tool-call')
  assert.ok(c !== undefined, 'span must emit a tool-call block')
  return c as unknown as ToolCallEnd
}

test('suffixDelta grows by suffix and falls back to newline+full', () => {
  assert.equal(suffixDelta('', 'abc'), 'abc')
  assert.equal(suffixDelta('abc', 'abcdef'), 'def')
  assert.equal(suffixDelta('abc', 'abc'), '')
  assert.equal(suffixDelta('abc', 'xyz'), '\nxyz')
})

test('ok run without tools emits ordered protocol: blocks, usage, finish last', () => {
  const m = newSpan()
  const chunks = mapAll(m, [
    { kind: 'init', conversationId: 'c1' },
    { kind: 'step', stepKey: '1', stepKind: 'thinking', text: 'Think' },
    { kind: 'step', stepKey: '2', stepKind: 'text', text: 'Hi there' },
    { kind: 'result', conversationId: 'c1', ok: true, response: 'Hi there', usage: { input_tokens: 7, output_tokens: 4, thinking_tokens: 2, cache_read_tokens: 1 } },
  ])
  const types = chunks.map((c) => c.type)
  assert.deepEqual(types, [
    'block-start', 'reasoning-delta', 'block-end',
    'block-start', 'text-delta', 'block-end',
    'usage', 'finish',
  ])
  const finish = asFinish(lastChunk(chunks))
  assert.equal(finish.reason.kind, 'stop')
  const usage = asUsage(chunks[chunks.length - 2] as StreamChunk)
  assert.equal(usage.usage.inputTokens, 7)
  assert.equal(usage.usage.reasoningTokens, 2)
  assert.equal((finish.replayState as { response?: { conversationId?: string } } | undefined)?.response?.conversationId, 'c1')
  assert.equal(m.isFinished, true)
})

test('result usage reports the last PER-CALL step sample, never the cumulative envelope', () => {
  // Verified against agy 1.1.16: step_update usage is per-call (current
  // context), result usage is conversation-cumulative. Forwarding the
  // envelope made DSH's token meter see 76M tokens against a 1M window and
  // fire compaction every few turns.
  const tracker = {
    last: null as import('../src/common/types.ts').RawUsage | null,
    noteStepUsage(raw: import('../src/common/types.ts').RawUsage) {
      this.last = raw
    },
    finalUsage(resultRaw: import('../src/common/types.ts').RawUsage) {
      return this.last ?? resultRaw
    },
  }
  const m = new EventMapper({ runId: 'ru1', cutOnTool: true, usage: tracker })
  const chunks = mapAll(m, [
    { kind: 'init', conversationId: 'c1' },
    { kind: 'step', stepKey: '1', stepKind: 'text', text: 'part one', usage: { input_tokens: 15_000, output_tokens: 100 } },
    { kind: 'step', stepKey: '2', stepKind: 'text', text: 'part two', usage: { input_tokens: 16_800, output_tokens: 160 } },
    { kind: 'result', conversationId: 'c1', ok: true, response: 'part one part two', usage: { input_tokens: 31_800, output_tokens: 260 } },
  ])
  const usageChunks = chunks.filter((c) => c.type === 'usage')
  const finalUsage = asUsage(usageChunks[usageChunks.length - 1] as StreamChunk)
  // last per-call step sample (16.8k), NOT the cumulative 31.8k
  assert.equal(finalUsage.usage.inputTokens, 16_800)
  assert.equal(finalUsage.usage.outputTokens, 160)
})

test('result usage falls back to the envelope when no step carried usage', () => {
  const tracker = {
    last: null as import('../src/common/types.ts').RawUsage | null,
    noteStepUsage(raw: import('../src/common/types.ts').RawUsage) {
      this.last = raw
    },
    finalUsage(resultRaw: import('../src/common/types.ts').RawUsage) {
      return this.last ?? resultRaw
    },
  }
  const m = new EventMapper({ runId: 'ru2', cutOnTool: true, usage: tracker })
  const chunks = mapAll(m, [
    { kind: 'init', conversationId: 'c1' },
    { kind: 'step', stepKey: '1', stepKind: 'text', text: 'hi' },
    { kind: 'result', conversationId: 'c1', ok: true, response: 'hi', usage: { input_tokens: 14_726, output_tokens: 166 } },
  ])
  const usageChunks = chunks.filter((c) => c.type === 'usage')
  const finalUsage = asUsage(usageChunks[usageChunks.length - 1] as StreamChunk)
  assert.equal(finalUsage.usage.inputTokens, 14_726)
})

test('snapshot-style repeated steps stream as suffix deltas', () => {
  const m = newSpan()
  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '1', stepKind: 'text', text: 'Hello' },
    { kind: 'step', stepKey: '1', stepKind: 'text', text: 'Hello world' },
  ])
  const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as unknown as { text: string }).text)
  assert.deepEqual(deltas, ['Hello', ' world'])
})

test('completed tool step cuts the span into native agy_tool call in standard mode', () => {
  const m = newSpan('run-abc', false, false)
  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '2', stepKind: 'text', text: 'Working on it' },
    // ACTIVE has no payload yet: no cut
    { kind: 'step', stepKey: '3', stepKind: 'tool', state: 'ACTIVE', text: '', tool: { name: 'run_command', args: { command: 'ls' } } },
    { kind: 'step', stepKey: '3', stepKind: 'tool', state: 'DONE', text: '', tool: { name: 'run_command', args: { command: 'ls' }, output: 'a.txt' } },
    // later events must not map: the span already finished
    { kind: 'step', stepKey: '9', stepKind: 'text', text: 'after the cut' },
  ])
  const end = toolCallEnd(chunks)
  assert.equal(end.block.name, 'agy_tool')
  assert.equal(end.block.id, mirrorCallId('run-abc', 2))
  const args = JSON.parse(end.block.arguments) as { run: string; step: number; tool: string; input: Record<string, unknown> }
  assert.equal(args.run, 'run-abc')
  assert.equal(args.step, 2)
  assert.equal(args.tool, 'run_command')
  assert.deepEqual(args.input, { command: 'ls' })
  const finish = asFinish(lastChunk(chunks))
  assert.equal(finish.reason.kind, 'tool-calls')
  assert.equal(m.isFinished, true)
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
  assert.equal(text, 'Working on it')
})

test('completed call_mcp_tool step unwraps ops_bash in standard and code mode', () => {
  // Standard (native) mode
  const mNative = newSpan('run-mcp', false, false)
  const chunksNative = mapAll(mNative, [
    {
      kind: 'step',
      stepKey: '1',
      stepKind: 'tool',
      state: 'ACTIVE',
      text: '',
      tool: {
        name: 'call_mcp_tool',
        args: { ServerName: '"dsh-ops"', ToolName: '"ops_bash"', Arguments: '{"command":"git branch -a"}' },
      },
    },
    {
      kind: 'step',
      stepKey: '1',
      stepKind: 'tool',
      state: 'DONE',
      text: '',
      tool: {
        name: 'call_mcp_tool',
        args: { ServerName: '"dsh-ops"', ToolName: '"ops_bash"', Arguments: '{"command":"git branch -a"}' },
        output: '* main',
      },
    },
  ])

  // Verify live progress reasoning delta was unwrapped
  const reasoningDeltas = chunksNative.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
  assert.ok(reasoningDeltas.includes('ops_bash (dsh-ops)'), reasoningDeltas)

  // Verify tool-call block is unwrapped to ops_bash with server: dsh-ops
  const endNative = toolCallEnd(chunksNative)
  assert.equal(endNative.block.name, 'agy_tool')
  const argsNative = JSON.parse(endNative.block.arguments) as { run: string; step: number; tool: string; server?: string; input: Record<string, unknown> }
  assert.equal(argsNative.tool, 'ops_bash')
  assert.equal(argsNative.server, 'dsh-ops')
  assert.deepEqual(argsNative.input, { command: 'git branch -a' })

  // Code Mode
  const mCode = newSpan('run-mcp', false, true)
  const chunksCode = mapAll(mCode, [
    {
      kind: 'step',
      stepKey: '1',
      stepKind: 'tool',
      state: 'DONE',
      text: '',
      tool: {
        name: 'call_mcp_tool',
        args: { ServerName: '"dsh-ops"', ToolName: '"ops_bash"', Arguments: '{"command":"git branch -a"}' },
        output: '* main',
      },
    },
  ])
  const endCode = toolCallEnd(chunksCode)
  assert.equal(endCode.block.name, 'run_code')
  const argsCode = JSON.parse(endCode.block.arguments) as { code: string; description: string }
  assert.equal(argsCode.description, '$ git branch -a · ops_bash')
  assert.ok(argsCode.code.includes('replay recorded agy tool step 0 (ops_bash)'), argsCode.code)
})

test('completed tool step with state DONE cuts even when tool.output is undefined (replace_file_content)', () => {
  const m = newSpan('run-xyz', false, false)
  const chunks = mapAll(m, [
    // ACTIVE envelope: no cut
    { kind: 'step', stepKey: '30', stepKind: 'tool', state: 'ACTIVE', text: '', tool: { name: 'replace_file_content', args: { TargetFile: 'demo/old.txt' } } },
    // DONE envelope with NO output property (observed with agy file writing tools)
    { kind: 'step', stepKey: '30', stepKind: 'tool', state: 'DONE', text: '', tool: { name: 'replace_file_content', args: { TargetFile: 'demo/old.txt' } } },
    { kind: 'step', stepKey: '31', stepKind: 'text', text: 'should not be reached' },
  ])
  const end = toolCallEnd(chunks)
  assert.equal(end.block.name, 'agy_tool')
  assert.equal(end.block.id, mirrorCallId('run-xyz', 1))
  const args = JSON.parse(end.block.arguments) as { run: string; step: number; tool: string; input: Record<string, unknown> }
  assert.equal(args.run, 'run-xyz')
  assert.equal(args.step, 1)
  assert.equal(args.tool, 'replace_file_content')
  assert.deepEqual(args.input, { TargetFile: 'demo/old.txt' })
  const finish = asFinish(lastChunk(chunks))
  assert.equal(finish.reason.kind, 'tool-calls')
  assert.equal(m.isFinished, true)
})

test('completed tool step cuts the span into run_code wrapper in Code Mode', () => {
  const m = newSpan('run-abc', false, true)
  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '2', stepKind: 'text', text: 'Working on it' },
    { kind: 'step', stepKey: '3', stepKind: 'tool', state: 'DONE', text: '', tool: { name: 'run_command', args: { command: 'ls' }, output: 'a.txt' } },
  ])
  const end = toolCallEnd(chunks)
  assert.equal(end.block.name, 'run_code')
  assert.equal(end.block.id, mirrorCallId('run-abc', 1))
  const args = JSON.parse(end.block.arguments) as { code: string; description: string }
  const inv = parseMirrorInvocation(args.code)
  assert.ok(inv !== null, 'code embeds the agy_tool invocation')
  assert.equal(inv.run, 'run-abc')
  assert.equal(inv.step, 1)
  assert.ok(args.description.includes('run_command'), args.description)
  assert.ok(args.code.includes("tools['agy_tool']"), 'program calls the mirror tool')
})

test('erroring tool step cuts exactly like a successful one in both modes', () => {
  const mNative = newSpan('r1', false, false)
  const chunksNative = mapAll(mNative, [
    { kind: 'step', stepKey: '4', stepKind: 'tool', state: 'ERROR', text: '', tool: { name: 'find_by_name', args: { pattern: 'x' }, error: 'timed out' } },
  ])
  const endNative = toolCallEnd(chunksNative)
  assert.equal(endNative.block.name, 'agy_tool')
  assert.equal(asFinish(lastChunk(chunksNative)).reason.kind, 'tool-calls')

  const mCode = newSpan('r1', false, true)
  const chunksCode = mapAll(mCode, [
    { kind: 'step', stepKey: '4', stepKind: 'tool', state: 'ERROR', text: '', tool: { name: 'find_by_name', args: { pattern: 'x' }, error: 'timed out' } },
  ])
  const endCode = toolCallEnd(chunksCode)
  assert.equal(endCode.block.name, 'run_code')
  assert.equal(asFinish(lastChunk(chunksCode)).reason.kind, 'tool-calls')
})

test('auxiliary spans never cut on tools', () => {
  const m = new EventMapper({ runId: 'r2', cutOnTool: false })
  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '1', stepKind: 'tool', text: '', tool: { name: 'run_command', args: {}, output: 'x' } },
    { kind: 'result', conversationId: 'c', ok: true, response: 'done', usage: {} },
  ])
  assert.equal(chunks.some((c) => c.type === 'block-end' && (c as { block: { type: string } }).block.type === 'tool-call'), false)
  assert.equal(asFinish(lastChunk(chunks)).reason.kind, 'stop')
})

test('result text used when no text step streamed anywhere in the run', () => {
  const m = newSpan('r3')
  const chunks = mapAll(m, [
    { kind: 'result', conversationId: 'c2', ok: true, response: 'only final', usage: {} },
  ])
  const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as unknown as { text: string }).text)
  assert.deepEqual(deltas, ['only final'])
})

test('result fallback suppressed when an earlier span already streamed the text', () => {
  // Final span of a run whose text streamed in span 1: the result response
  // must NOT be duplicated as a fresh text block.
  const m = newSpan('r4', true)
  const chunks = mapAll(m, [
    { kind: 'result', conversationId: 'c4', ok: true, response: 'already streamed', usage: {} },
  ], 5)
  assert.equal(chunks.some((c) => c.type === 'text-delta'), false)
  assert.equal(asFinish(lastChunk(chunks)).reason.kind, 'stop')
})

test('agy 1.1.15 stream maps onto spans: thinking turn, tool cuts, fragments, result', () => {
  const events: unknown[] = [
    { kind: 'init', conversationId: 'c15' },
    // thinking-only turn (usage, no text)
    { kind: 'step', stepKey: '2', stepKind: 'text', text: '', usage: { thinking_tokens: 80 } },
    // tool call with output
    { kind: 'step', stepKey: '3', stepKind: 'tool', state: 'ACTIVE', text: '', tool: { name: 'run_command', args: { command: 'ls' } } },
    { kind: 'step', stepKey: '3', stepKind: 'tool', state: 'DONE', text: '', tool: { name: 'run_command', args: { command: 'ls' }, output: 'note1.txt' } },
    // failed tool call
    { kind: 'step', stepKey: '4', stepKind: 'tool', state: 'ERROR', text: '', tool: { name: 'find_by_name', args: { pattern: 'x' }, error: 'Find command timed out.' } },
    // streamed answer fragments
    { kind: 'step', stepKey: '5', stepKind: 'text', text: 'There are ', fragment: true },
    { kind: 'step', stepKey: '5', stepKind: 'text', text: '2 files.', fragment: true },
    { kind: 'result', conversationId: 'c15', ok: true, response: 'There are 2 files.', usage: { input_tokens: 9, output_tokens: 8, thinking_tokens: 95 } },
  ]
  // Span 1: thinking visibility (issue #43) + first tool cut. The
  // thinking-only DONE tail emits the bare banner (no prose available), and
  // the ACTIVE envelope emits exactly one pending-progress note.
  const s1 = newSpan('run15')
  const c1 = mapAll(s1, events, 0)
  const reasoning1 = c1.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
  assert.equal(reasoning1, '[agy · 80 tokens]\n[agy tool running: run_command — the result card streams when it finishes]\n')
  assert.ok(!reasoning1.includes('Chain-of-Thought') && !/tokens\].+tokens/s.test(reasoning1), 'no invented prose, no duplicate banner')
  assert.equal(toolCallEnd(c1).block.id, mirrorCallId('run15', 3))
  assert.equal(asFinish(lastChunk(c1)).reason.kind, 'tool-calls')
  // Span 2: second tool cut (the errored one)
  const s2 = newSpan('run15')
  const c2 = mapAll(s2, events.slice(4), 4)
  assert.equal(toolCallEnd(c2).block.id, mirrorCallId('run15', 4))
  assert.equal(asFinish(lastChunk(c2)).reason.kind, 'tool-calls')
  // Span 3: fragments + result → stop
  const s3 = newSpan('run15', false)
  const c3 = mapAll(s3, events.slice(5), 5)
  const text3 = c3.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
  assert.equal(text3, 'There are 2 files.')
  assert.equal(asFinish(lastChunk(c3)).reason.kind, 'stop')
})

test('one-shot answer step without DB prose shows the banner-only chip, never invented prose', () => {
  const m = newSpan('r-oneshot')
  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '2', stepKind: 'text', text: '1 + 1 等于 2。', usage: { input_tokens: 100, output_tokens: 50, thinking_tokens: 154 } },
    { kind: 'result', conversationId: 'c9', ok: true, response: '1 + 1 等于 2。', usage: {} },
  ])
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
  assert.equal(reasoning, '[agy · 154 tokens]\n', 'issue #43: thinking stays visible without a sqlite reader')
  assert.ok(!reasoning.includes('等于'), 'no invented thought prose')
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
  assert.equal(text, '1 + 1 等于 2。')
})

test('streamed answer: no empty thinking chip when only token counts exist', () => {
  const m = newSpan('r-tail')
  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '5', stepKind: 'text', text: 'There are ', fragment: true },
    { kind: 'step', stepKey: '5', stepKind: 'text', text: '2 files.', fragment: true, usage: { thinking_tokens: 15 } },
    { kind: 'result', conversationId: 'c9', ok: true, response: 'There are 2 files.', usage: {} },
  ])
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
  assert.equal(reasoning, '')
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
  assert.equal(text, 'There are 2 files.')
})

test('DONE tail with usage but no text does not emit banner-only thinking', () => {
  const m = newSpan('r-tail2')
  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '7', stepKind: 'text', text: 'Answer.', fragment: true },
    { kind: 'step', stepKey: '7', stepKind: 'text', text: '', usage: { thinking_tokens: 9 } },
    { kind: 'result', conversationId: 'c9', ok: true, response: 'Answer.', usage: {} },
  ])
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
  assert.equal(reasoning, '', 'no prose → no reasoning row')
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
  assert.equal(text, 'Answer.')
})

test('thinking turn with resolvedThoughts emits real thought text into reasoning block', () => {
  const thoughtsMap = new Map<number, string>([
    [1, 'Plan: check file status first, then decide whether to edit.'],
  ])
  const m = new EventMapper({
    runId: 'r-thoughts',
    cutOnTool: true,
    resolvedThoughts: thoughtsMap,
  })
  const chunks = mapAll(m, [
    { kind: 'init', conversationId: 'c1' },
    // absIndex = 1
    { kind: 'step', stepKey: '2', stepKind: 'text', text: '', usage: { thinking_tokens: 42 } },
    // absIndex = 2
    { kind: 'step', stepKey: '3', stepKind: 'tool', state: 'DONE', text: '', tool: { name: 'run_command', args: { command: 'ls' }, output: 'ok' } },
  ])
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
  assert.equal(reasoning, '[agy · 42 tokens] Plan: check file status first, then decide whether to edit.\n')
  // Block types order: reasoning start/delta/end, then tool-call
  const blockStarts = chunks.filter((c) => c.type === 'block-start').map((c) => (c as { blockType: string }).blockType)
  assert.deepEqual(blockStarts, ['reasoning', 'tool-call'])
})

test('streamed answer with deferred resolvedThoughts emits real thought text in trailing reasoning block', () => {
  const thoughtsMap = new Map<number, string>([
    [1, 'Double-checked 1+1=2, calculation is sound.'],
  ])
  const m = new EventMapper({
    runId: 'r-tail-thoughts',
    cutOnTool: true,
    resolvedThoughts: thoughtsMap,
  })
  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '5', stepKind: 'text', text: 'Result is 2.', fragment: true },
    // absIndex = 1: DONE tail with usage
    { kind: 'step', stepKey: '5', stepKind: 'text', text: '', usage: { thinking_tokens: 15 } },
    { kind: 'result', conversationId: 'c9', ok: true, response: 'Result is 2.', usage: {} },
  ])
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
  assert.equal(reasoning, '[agy · 15 tokens] Double-checked 1+1=2, calculation is sound.\n')
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
  assert.equal(text, 'Result is 2.')
})

test('streamed answer with eager resolvedThoughts emits leading reasoning block before first text fragment', () => {
  const thoughtsMap = new Map<number, string>([
    [0, 'Analyzing problem constraints and deciding algorithm.'],
  ])
  const m = new EventMapper({
    runId: 'r-lead-thoughts',
    cutOnTool: true,
    resolvedThoughts: thoughtsMap,
  })
  const chunks = mapAll(m, [
    // absIndex = 0: first ACTIVE text fragment
    { kind: 'step', stepKey: '1', stepKind: 'text', text: 'Hello ', fragment: true },
    // absIndex = 1: second text fragment
    { kind: 'step', stepKey: '1', stepKind: 'text', text: 'world!', fragment: true },
    // absIndex = 2: DONE tail
    { kind: 'step', stepKey: '1', stepKind: 'text', text: '', usage: { thinking_tokens: 45 } },
    { kind: 'result', conversationId: 'c11', ok: true, response: 'Hello world!', usage: {} },
  ])
  // Block types order MUST be reasoning then text
  const blockStarts = chunks.filter((c) => c.type === 'block-start').map((c) => (c as { blockType: string }).blockType)
  assert.deepEqual(blockStarts, ['reasoning', 'text'])

  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
  assert.equal(reasoning, '[agy] Analyzing problem constraints and deciding algorithm.\n')

  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
  assert.equal(text, 'Hello world!')
})

test('DB thought arriving on DONE tail is not dropped due to premature thinkingAnnounced (issue #43)', () => {
  const thoughtsMap = new Map<number, string>()
  const m = new EventMapper({
    runId: 'r-async-thoughts',
    cutOnTool: false,
    resolvedThoughts: thoughtsMap,
  })
  // Event 1: ACTIVE fragment arrives when DB thoughts have NOT resolved yet (thoughtsMap is empty)
  const c1 = [...m.map({ kind: 'step', stepKey: '1', stepKind: 'text', text: 'Hello', fragment: true, usage: { thinking_tokens: 438 }, raw: {} }, 0)]
  // Event 2: DB thoughts resolve asynchronously before DONE tail
  thoughtsMap.set(1, 'Critical analysis of constraints.')
  // Event 3: DONE tail arrives
  const c2 = [...m.map({ kind: 'step', stepKey: '1', stepKind: 'text', text: '', fragment: false, usage: { thinking_tokens: 438 }, raw: {} }, 1)]
  const allChunks = [...c1, ...c2]
  const reasoning = allChunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
  // The banner-only chip streamed first (no prose yet); when the DB prose
  // resolves it is APPENDED without a second banner, and never dropped.
  assert.equal(reasoning, '[agy · 438 tokens]\nCritical analysis of constraints.\n')
})

test('stepKind === thinking uses resolvedThoughts when available', () => {
  const thoughtsMap = new Map<number, string>([
    [0, 'In-depth multi-turn planning logic here.'],
  ])
  const m = new EventMapper({
    runId: 'r-thinking-step',
    cutOnTool: false,
    resolvedThoughts: thoughtsMap,
  })
  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '1', stepKind: 'thinking', text: 'Thinking...' },
    { kind: 'step', stepKey: '2', stepKind: 'text', text: 'Final answer.' },
    { kind: 'result', conversationId: 'c10', ok: true, response: 'Final answer.', usage: {} },
  ])
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
  assert.equal(reasoning, 'In-depth multi-turn planning logic here.')
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
  assert.equal(text, 'Final answer.')
})

test('emitFailure closes blocks and finishes with error', () => {
  const m = newSpan()
  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '1', stepKind: 'text', text: 'partial' },
  ])
  chunks.push(...[...m.emitFailure('error', 'AUTH', 'not signed in')])
  const finish = asFinish(lastChunk(chunks))
  if (finish.reason.kind === 'error') {
    assert.equal(finish.reason.failure.code, 'AUTH')
  } else {
    assert.fail('expected error finish')
  }
  const endIdx = chunks.map((c) => c.type).lastIndexOf('block-end')
  assert.ok(endIdx >= 0)
  assert.ok(chunks.slice(endIdx + 1).every((d) => d.type === 'usage' || d.type === 'finish'))
})

test('result ERROR with usable response soft-finishes and annotates the error', () => {
  const m = newSpan()
  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '5', stepKind: 'text', text: 'There are 2 files.', fragment: true },
    { kind: 'result', conversationId: 'c15', ok: false, response: 'There are 2 files.', error: 'find timed out', usage: { input_tokens: 9, output_tokens: 8 } },
  ])
  const reasoning = chunks
    .filter((c) => c.type === 'reasoning-delta')
    .map((c) => (c as { text: string }).text)
    .join('')
  assert.ok(reasoning.includes('[agy finished with error] find timed out'), reasoning)
  const finish = asFinish(lastChunk(chunks))
  assert.equal(finish.reason.kind, 'stop')
  assert.equal(m.isFinished, true)
})

test('result ERROR without response stays passive for the adapter', () => {
  const m = newSpan()
  const chunks = mapAll(m, [
    { kind: 'result', conversationId: 'c15', ok: false, response: '', error: 'explosion', usage: {} },
  ])
  assert.equal(chunks.length, 0)
  assert.equal(m.isFinished, false)
})

test('mirrorCallId round-trips through parseMirrorCallId', () => {
  const id = mirrorCallId('0f1e2d3c-4b5a-6789-9abc-def012345678', 42)
  assert.equal(id, 'agytc-0f1e2d3c-4b5a-6789-9abc-def012345678-42')
  assert.deepEqual(parseMirrorCallId(id), { runId: '0f1e2d3c-4b5a-6789-9abc-def012345678', eventIndex: 42 })
  assert.equal(parseMirrorCallId('other-1'), null)
  assert.equal(parseMirrorCallId('agytc-x'), null)
})

test('usageFromRaw maps snake_case fields', () => {
  const u = usageFromRaw({ input_tokens: 1, output_tokens: 2, thinking_tokens: 3, cache_read_tokens: 4, cache_write_tokens: 5, total_tokens: 15 })
  assert.equal(u.inputTokens, 1)
  assert.equal(u.outputTokens, 2)
  assert.equal(u.reasoningTokens, 3)
  assert.equal(u.cacheReadTokens, 4)
  assert.equal(u.cacheWriteTokens, 5)
  assert.equal(u.totalTokens, 15)
})

test('thinking-only turn without DB prose still surfaces the banner (issue #43)', () => {
  // Desktop host, no sqlite reader: high-effort thinking used to render
  // NOTHING at all. The DONE tail with usage must emit the bare banner.
  const m = newSpan('r-banner')
  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '2', stepKind: 'text', text: '', usage: { input_tokens: 100, output_tokens: 0, thinking_tokens: 320 } },
    { kind: 'result', conversationId: 'c43', ok: true, response: 'Answer.', usage: {} },
  ])
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
  assert.ok(reasoning.includes('[agy · 320 tokens]'), 'banner-only chip emitted for thinking-only turns')
})

test('banner-only chip precedes the first visible text and never repeats (issue #43)', () => {
  const m = newSpan('r-banner2')
  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '3', stepKind: 'text', text: 'Hello', fragment: true, usage: { thinking_tokens: 45 } },
    { kind: 'step', stepKey: '3', stepKind: 'text', text: ' world', fragment: true, usage: { thinking_tokens: 60 } },
  ])
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
  assert.equal(reasoning, '[agy · 45 tokens]\n', 'exactly one banner before the answer')
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
  assert.equal(text, 'Hello world')
})

test('token-only steps AFTER visible text stay suppressed (no clutter regression)', () => {
  const m = newSpan('r-banner3')
  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '1', stepKind: 'text', text: 'answer text', fragment: true, usage: { thinking_tokens: 10 } },
    { kind: 'step', stepKey: '2', stepKind: 'text', text: 'more', fragment: true, usage: { thinking_tokens: 99 } },
  ])
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
  assert.ok(reasoning.includes('[agy · 10 tokens]'), 'first banner present')
  assert.ok(!reasoning.includes('99'), 'later token-only steps are not chatty')
})

test('rewriteImageMarkdown rewrites file://, Windows, and WSL paths to mediaBaseUrl', () => {
  const baseUrl = 'http://127.0.0.1:4000/plugins/agy-link/media'

  // file:/// URL
  const input1 = 'Here: ![2D 原画](file:///D:/proj/tribal-era/docs/concept.png)'
  const out1 = rewriteImageMarkdown(input1, baseUrl)
  assert.equal(out1, `Here: ![2D 原画](${baseUrl}?path=file%3A%2F%2F%2FD%3A%2Fproj%2Ftribal-era%2Fdocs%2Fconcept.png)`)

  // Windows path
  const input2 = 'Render: ![3D](D:\\proj\\tribal-era\\mesh.png)'
  const out2 = rewriteImageMarkdown(input2, baseUrl)
  assert.equal(out2, `Render: ![3D](${baseUrl}?path=D%3A%5Cproj%5Ctribal-era%5Cmesh.png)`)

  // WSL path
  const input3 = 'Linux: ![wsl](/home/zand/preview.webp)'
  const out3 = rewriteImageMarkdown(input3, baseUrl)
  assert.equal(out3, `Linux: ![wsl](${baseUrl}?path=%2Fhome%2Fzand%2Fpreview.webp)`)

  // Pass-through when no mediaBaseUrl
  assert.equal(rewriteImageMarkdown(input1, undefined), input1)
})

test('EventMapper with mediaBaseUrl streams rewritten image markdown in text steps', () => {
  const baseUrl = 'http://127.0.0.1:5000/plugins/agy-link/media'
  const m = new EventMapper({
    runId: 'r_img',
    cutOnTool: true,
    mediaBaseUrl: baseUrl,
  })

  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '1', stepKind: 'text', text: 'Here is ![concept](file:///D:/test.png)' },
    { kind: 'result', conversationId: 'c1', ok: true, response: 'done', usage: {} },
  ])

  const textChunk = chunks.find((c) => c.type === 'text-delta') as { type: 'text-delta'; text: string } | undefined
  assert.ok(textChunk !== undefined)
  assert.ok(textChunk.text.includes(baseUrl))
  assert.ok(textChunk.text.includes('test.png'))
})

test('EventMapper emits update_goal tool-call when in goal continuation round', () => {
  const m = new EventMapper({
    runId: 'r_goal',
    cutOnTool: true,
    supportsGoalUpdate: true,
    goalContext: {
      goalId: 'goal-999',
      revision: 2,
      round: 1,
    },
  })

  const chunks = mapAll(m, [
    { kind: 'init', conversationId: 'c1' },
    { kind: 'step', stepKey: '1', stepKind: 'text', text: 'All tasks completed successfully!' },
    { kind: 'result', conversationId: 'c1', ok: true, response: 'All tasks completed successfully!', usage: {} },
  ])

  const tc = chunks.find((c) => c.type === 'block-end' && (c as { block?: { type: string; name: string } }).block?.name === 'update_goal') as any
  assert.ok(tc, 'Should emit update_goal tool-call')
  const args = JSON.parse(tc.block.arguments)
  assert.equal(args.goal_id, 'goal-999')
  assert.equal(args.revision, 2)
  assert.equal(args.action, 'complete')

  const fin = chunks.find((c) => c.type === 'finish') as any
  assert.equal(fin.reason.kind, 'tool-calls')
})

test('EventMapper emits update_goal tool-call even when result envelope ok: false has non-empty response', () => {
  const m = new EventMapper({
    runId: 'r_goal_err',
    cutOnTool: true,
    supportsGoalUpdate: true,
    goalContext: {
      goalId: 'goal-failover',
      revision: 1,
      round: 1,
    },
  })

  const chunks = mapAll(m, [
    { kind: 'init', conversationId: 'c1' },
    { kind: 'step', stepKey: '1', stepKind: 'text', text: 'Work is finished!' },
    {
      kind: 'result',
      conversationId: 'c1',
      ok: false,
      response: 'Work is finished!',
      error: 'API error: EOF',
      usage: {},
    },
  ])

  const tc = chunks.find((c) => c.type === 'block-end' && (c as { block?: { type: string; name: string } }).block?.name === 'update_goal') as any
  assert.ok(tc, 'Should emit update_goal tool-call despite ok: false')
  const args = JSON.parse(tc.block.arguments)
  assert.equal(args.goal_id, 'goal-failover')
  assert.equal(args.revision, 1)
  assert.equal(args.action, 'complete')

  const fin = chunks.find((c) => c.type === 'finish') as any
  assert.equal(fin.reason.kind, 'tool-calls')
})

test('EventMapper emits exit_plan_mode tool-call when in plan mode', () => {
  const m = new EventMapper({
    runId: 'r_plan',
    cutOnTool: true,
    supportsPlanExit: true,
  })

  const chunks = mapAll(m, [
    { kind: 'init', conversationId: 'c1' },
    { kind: 'step', stepKey: '1', stepKind: 'text', text: '# Architecture Plan\n\n1. Phase one' },
    { kind: 'result', conversationId: 'c1', ok: true, response: '# Architecture Plan\n\n1. Phase one', usage: {} },
  ])

  const tc = chunks.find((c) => c.type === 'block-end' && (c as { block?: { type: string; name: string } }).block?.name === 'exit_plan_mode') as any
  assert.ok(tc, 'Should emit exit_plan_mode tool-call')
  const args = JSON.parse(tc.block.arguments)
  assert.match(args.plan, /# Architecture Plan/)

  const fin = chunks.find((c) => c.type === 'finish') as any
  assert.equal(fin.reason.kind, 'tool-calls')
})

test('ToolCallState: rememberToolCallId disambiguates call ID collisions across different tool names', () => {
  const map = new Map<string, ToolCallState>()

  // First call for call_0 under 'run_command'
  const id1 = rememberToolCallId(map, 'call_0', 'run_command')
  assert.equal(id1, 'call_0')

  // Second call for call_0 under SAME tool name keeps the original ID
  const id2 = rememberToolCallId(map, 'call_0', 'run_command')
  assert.equal(id2, 'call_0')

  // Third call for call_0 under DIFFERENT tool name 'write_to_file' suffixes with #name
  const id3 = rememberToolCallId(map, 'call_0', 'write_to_file')
  assert.equal(id3, 'call_0#write_to_file')

  // consumeToolBinding consumes in FIFO order
  const b1 = consumeToolBinding(map, 'call_0')
  assert.equal(b1?.id, 'call_0')
  assert.equal(b1?.name, 'run_command')

  const b2 = consumeToolBinding(map, 'call_0')
  assert.equal(b2?.id, 'call_0')
  assert.equal(b2?.name, 'run_command')

  const b3 = consumeToolBinding(map, 'call_0')
  assert.equal(b3?.id, 'call_0#write_to_file')
  assert.equal(b3?.name, 'write_to_file')

  // expirePendingToolCalls clears pending list
  rememberToolCallId(map, 'call_1', 'tool_a')
  expirePendingToolCalls(map)
  const bAfterExpire = consumeToolBinding(map, 'call_1')
  // falls back to last
  assert.equal(bAfterExpire?.name, 'tool_a')
})

test('parseMirrorCallId supports both canonical and hash-disambiguated call IDs', () => {
  const parsedPlain = parseMirrorCallId('agytc-550e8400-e29b-41d4-a716-446655440000-12')
  assert.deepEqual(parsedPlain, {
    runId: '550e8400-e29b-41d4-a716-446655440000',
    eventIndex: 12,
  })

  const parsedHashed = parseMirrorCallId('agytc-550e8400-e29b-41d4-a716-446655440000-12#agy_tool')
  assert.deepEqual(parsedHashed, {
    runId: '550e8400-e29b-41d4-a716-446655440000',
    eventIndex: 12,
  })
})


