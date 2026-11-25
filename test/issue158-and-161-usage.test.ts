import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { EventMapper } from '../src/host/mapper.ts'
import { RunRecording } from '../src/host/recording.ts'
import {
  acpPromptResultToAgyEvent,
  acpUpdateToAgyEvents,
  createAcpStreamState,
  isAcpTerminalStatus,
} from '../src/features/acp/protocol.ts'
import { AcpTranscriptUsageTailer } from '../src/features/acp/transcript-usage.ts'
import { isSyntheticHarnessMessage, latestUserTaskText } from '../src/provider/prompt-text.ts'

type UsageChunk = Extract<StreamChunk, { type: 'usage' }>

function collectSpan(rec: RunRecording, from: number, cutOnTool = true): { chunks: StreamChunk[]; next: number } {
  const mapper = new EventMapper({ runId: rec.runId, cutOnTool, usage: rec, initialSawText: rec.sawTextBefore(from) })
  const chunks: StreamChunk[] = []
  let i = from
  while (i < rec.length) {
    const ev = rec.eventAt(i)!
    chunks.push(...mapper.map(ev, i))
    i++
    if (mapper.isFinished) break
  }
  return { chunks, next: i }
}

test('issue #158: ACP usage_update { used, size } never clobbers PromptResponse.usage', () => {
  const state = createAcpStreamState()
  acpUpdateToAgyEvents('s1', { sessionUpdate: 'usage_update', used: 14157, size: 1048576 }, state)
  assert.equal(state.lastContextUsed, 14157)
  assert.deepEqual(state.lastUsage, {})

  const textEvs = acpUpdateToAgyEvents('s1', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Hello world' },
  }, state)
  assert.equal(textEvs.length, 1)
  assert.equal(textEvs[0]!.kind, 'step')
  if (textEvs[0]!.kind === 'step') {
    assert.equal(textEvs[0]!.usage, undefined)
  }

  const resEv = acpPromptResultToAgyEvent('s1', {
    stopReason: 'end_turn',
    usage: {
      inputTokens: 2072,
      cachedReadTokens: 12000,
      outputTokens: 85,
      thoughtTokens: 84,
      totalTokens: 14157,
    },
  }, state.accumulatedText, state.lastContextUsed)
  assert.equal(resEv.kind, 'result')
  if (resEv.kind === 'result') {
    assert.equal(resEv.usage.input_tokens, 2072)
    assert.equal(resEv.usage.cache_read_tokens, 12000)
    assert.equal(resEv.usage.output_tokens, 85)
    assert.equal(resEv.usage.thinking_tokens, 84)
  }

  // Feed through RunRecording + EventMapper: final usage must match PromptResponse exactly
  const rec = new RunRecording('r-acp-158')
  for (const ev of textEvs) rec.append(ev)
  rec.append(resEv)
  const { chunks } = collectSpan(rec, 0)
  const usages = chunks.filter((c): c is UsageChunk => c.type === 'usage')
  assert.equal(usages.length, 1)
  assert.equal(usages[0]!.usage.inputTokens, 2072)
  assert.equal(usages[0]!.usage.cacheReadTokens, 12000)
  assert.equal(usages[0]!.usage.outputTokens, 85)
  assert.equal(usages[0]!.usage.reasoningTokens, 84)
})

test('issue #158: AcpTranscriptUsageTailer reads incremental PLANNER_RESPONSE usage without replaying pre-turn lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-transcript-158-'))
  try {
    const file = join(dir, 'transcript.jsonl')
    appendFileSync(file, JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      usage: { input_tokens: 999, output_tokens: 11, cache_read_tokens: 0 },
    }) + '\n', 'utf8')

    // Start tailing AFTER step 1
    const tailer = new AcpTranscriptUsageTailer('conv-1', undefined, file)
    assert.deepEqual(tailer.poll(), [])

    // Append multi-byte UTF-8 split across writes
    const line2 = JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: '中文测试内容',
      usage: { input_tokens: 1200, output_tokens: 150, cache_read_tokens: 80000, thinking_tokens: 90 },
    }) + '\n'
    const buf = Buffer.from(line2, 'utf8')
    appendFileSync(file, buf.subarray(0, 40))
    assert.deepEqual(tailer.poll(), [])
    appendFileSync(file, buf.subarray(40))
    const samples = tailer.poll()
    assert.equal(samples.length, 1)
    assert.equal(samples[0]!.stepKey, 'transcript-2')
    assert.equal(samples[0]!.usage.input_tokens, 1200)
    assert.equal(samples[0]!.usage.cache_read_tokens, 80000)
    assert.equal(samples[0]!.usage.output_tokens, 150)
    assert.equal(samples[0]!.usage.thinking_tokens, 90)
    // Duplicate poll yields nothing
    assert.deepEqual(tailer.poll(), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('issue #158: latestUserTaskText skips dsh-mnemon without breaking isSyntheticHarnessMessage', () => {
  const userMsg = { role: 'user', content: [{ type: 'text', text: 'Real user task' }], source: { kind: 'user' } } as unknown as Message
  const mnemonMsg = { role: 'user', content: [{ type: 'text', text: 'Recalled memory snapshot' }], source: { kind: 'dsh-mnemon' } } as unknown as Message
  assert.equal(isSyntheticHarnessMessage(mnemonMsg), false)
  assert.equal(latestUserTaskText([userMsg, mnemonMsg]), 'Real user task')
})

test('issue #161: parallel 3 tool calls emit usage ONLY once (1x, never 3x) and omit 0/0 fallback', () => {
  const rec = new RunRecording('r-161-parallel')
  rec.append({ kind: 'init', conversationId: 'c1', raw: {} })
  rec.append({
    kind: 'step',
    stepKey: '1',
    stepKind: 'text',
    text: '',
    state: 'DONE',
    usage: { input_tokens: 14655, output_tokens: 231, thinking_tokens: 147, cache_read_tokens: 0 },
  })
  rec.append({ kind: 'step', stepKey: '2', stepKind: 'tool', state: 'DONE', text: '', tool: { name: 'read_file', args: { Path: 'a.txt' }, output: '1' } })
  rec.append({ kind: 'step', stepKey: '3', stepKind: 'tool', state: 'DONE', text: '', tool: { name: 'read_file', args: { Path: 'b.txt' }, output: '2' } })
  rec.append({ kind: 'step', stepKey: '4', stepKind: 'tool', state: 'DONE', text: '', tool: { name: 'read_file', args: { Path: 'c.txt' }, output: '3' } })
  rec.append({
    kind: 'step',
    stepKey: '5',
    stepKind: 'text',
    text: 'All done',
    state: 'DONE',
    usage: { input_tokens: 2468, output_tokens: 172, thinking_tokens: 156, cache_read_tokens: 12601 },
  })
  rec.append({
    kind: 'result',
    conversationId: 'c1',
    ok: true,
    response: 'All done',
    usage: { input_tokens: 17123, output_tokens: 403, thinking_tokens: 303, cache_read_tokens: 12601 },
    raw: {},
  })

  const s1 = collectSpan(rec, 0)
  const s2 = collectSpan(rec, s1.next)
  const s3 = collectSpan(rec, s2.next)
  const s4 = collectSpan(rec, s3.next)

  const u1 = s1.chunks.filter((c): c is UsageChunk => c.type === 'usage')
  const u2 = s2.chunks.filter((c): c is UsageChunk => c.type === 'usage')
  const u3 = s3.chunks.filter((c): c is UsageChunk => c.type === 'usage')
  const u4 = s4.chunks.filter((c): c is UsageChunk => c.type === 'usage')

  // Tool 1 consumes the step-1 LLM call usage
  assert.equal(u1.length, 1)
  assert.equal(u1[0]!.usage.inputTokens, 14655)
  assert.equal(u1[0]!.usage.outputTokens, 231)

  // Tools 2 & 3 emit zero-delta bucket-preserving usage chunks (#210: no 3x duplication, keeps DSH footer consistent)
  assert.equal(u2.length, 1)
  assert.deepEqual(u2[0]!.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 })
  assert.equal(u3.length, 1)
  assert.deepEqual(u3[0]!.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 })

  // Final result consumes step-5 usage once
  assert.equal(u4.length, 1)
  assert.equal(u4[0]!.usage.inputTokens, 2468)
  assert.equal(u4[0]!.usage.cacheReadTokens, 12601)
  assert.equal(u4[0]!.usage.outputTokens, 172)

  // Summed turn totals stay strictly 1x
  const allUsages = [...u1, ...u2, ...u3, ...u4]
  assert.equal(allUsages.reduce((s, x) => s + x.usage.inputTokens, 0), 14655 + 2468)
  assert.equal(allUsages.reduce((s, x) => s + x.usage.outputTokens, 0), 231 + 172)
  assert.equal(allUsages.reduce((s, x) => s + (x.usage.cacheReadTokens ?? 0), 0), 12601)
})

test('issue #161: single span with 2 LLM calls takes last prompt tokens and sums output/thinking tokens', () => {
  const rec = new RunRecording('r-161-merge')
  rec.append({
    kind: 'step',
    stepKey: '38',
    stepKind: 'text',
    text: 'Checking...',
    state: 'DONE',
    usage: { input_tokens: 5000, cache_read_tokens: 90000, output_tokens: 200, thinking_tokens: 50 },
  })
  rec.append({
    kind: 'step',
    stepKey: '40',
    stepKind: 'text',
    text: 'Found it.',
    state: 'DONE',
    usage: { input_tokens: 6000, cache_read_tokens: 95000, output_tokens: 300, thinking_tokens: 80 },
  })
  rec.append({
    kind: 'step',
    stepKey: '41',
    stepKind: 'tool',
    state: 'DONE',
    text: '',
    tool: { name: 'read_file', args: { Path: 'x.ts' }, output: 'ok' },
  })

  const { chunks } = collectSpan(rec, 0)
  const usages = chunks.filter((c): c is UsageChunk => c.type === 'usage')
  assert.equal(usages.length, 1)
  assert.equal(usages[0]!.usage.inputTokens, 6000)
  assert.equal(usages[0]!.usage.cacheReadTokens, 95000)
  assert.equal(usages[0]!.usage.outputTokens, 500)
  assert.equal(usages[0]!.usage.reasoningTokens, 130)
})

test('issue #161: emitFailure with no usage sample omits usage chunk instead of flashing 0/0', () => {
  const rec = new RunRecording('r-161-fail')
  const mapper = new EventMapper({ runId: rec.runId, cutOnTool: true, usage: rec })
  const chunks = [...mapper.emitFailure('error', 'NETWORK', 'connection reset')]
  assert.equal(chunks.some((c) => c.type === 'usage'), false)
  assert.equal(chunks[chunks.length - 1]?.type, 'finish')
})

test('ACP status truth helper distinguishes live vs terminal tool statuses', () => {
  assert.equal(isAcpTerminalStatus(undefined), false)
  assert.equal(isAcpTerminalStatus('pending'), false)
  assert.equal(isAcpTerminalStatus('in_progress'), false)
  assert.equal(isAcpTerminalStatus('completed'), true)
  assert.equal(isAcpTerminalStatus('failed'), true)
  assert.equal(isAcpTerminalStatus('cancelled'), true)
})

test('issue #210: concurrent tool cuts match prior cacheRead/cacheWrite buckets and never emit before first sample', () => {
  // Case A: Prior usage carried both cacheRead and cacheWrite -> zero-delta carries both as 0.
  const recBoth = new RunRecording('r-210-both')
  recBoth.append({ kind: 'step', stepKey: '1', stepKind: 'text', text: '', state: 'DONE', usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 50, cache_write_tokens: 10 } })
  recBoth.append({ kind: 'step', stepKey: '2', stepKind: 'tool', state: 'DONE', text: '', tool: { name: 'read_file', args: { Path: '1.ts' }, output: 'a' } })
  recBoth.append({ kind: 'step', stepKey: '3', stepKind: 'tool', state: 'DONE', text: '', tool: { name: 'read_file', args: { Path: '2.ts' }, output: 'b' } })
  const b1 = collectSpan(recBoth, 0)
  const b2 = collectSpan(recBoth, b1.next)
  assert.deepEqual(b2.chunks.filter((c): c is UsageChunk => c.type === 'usage').map((c) => c.usage), [
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ])

  // Case B: Prior usage had neither cacheRead nor cacheWrite -> zero-delta omits both optional keys.
  const recNeither = new RunRecording('r-210-none')
  recNeither.append({ kind: 'step', stepKey: '1', stepKind: 'text', text: '', state: 'DONE', usage: { input_tokens: 100, output_tokens: 20 } })
  recNeither.append({ kind: 'step', stepKey: '2', stepKind: 'tool', state: 'DONE', text: '', tool: { name: 'read_file', args: { Path: '1.ts' }, output: 'a' } })
  recNeither.append({ kind: 'step', stepKey: '3', stepKind: 'tool', state: 'DONE', text: '', tool: { name: 'read_file', args: { Path: '2.ts' }, output: 'b' } })
  const n1 = collectSpan(recNeither, 0)
  const n2 = collectSpan(recNeither, n1.next)
  assert.deepEqual(n2.chunks.filter((c): c is UsageChunk => c.type === 'usage').map((c) => c.usage), [
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  ])

  // Case C: No real usage has ever been emitted -> tool cuts must NOT fabricate 0/0 usage chunks.
  const recEmpty = new RunRecording('r-210-empty')
  recEmpty.append({ kind: 'step', stepKey: '1', stepKind: 'tool', state: 'DONE', text: '', tool: { name: 'read_file', args: { Path: '1.ts' }, output: 'a' } })
  recEmpty.append({ kind: 'step', stepKey: '2', stepKind: 'tool', state: 'DONE', text: '', tool: { name: 'read_file', args: { Path: '2.ts' }, output: 'b' } })
  const e1 = collectSpan(recEmpty, 0)
  const e2 = collectSpan(recEmpty, e1.next)
  assert.equal(e1.chunks.some((c) => c.type === 'usage'), false)
  assert.equal(e2.chunks.some((c) => c.type === 'usage'), false)
})
