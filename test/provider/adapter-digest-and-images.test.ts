// History digest, elision, image staging and NUL hardening: what the
// bounded context carries (prose over payload, byte ceilings, code-point
// safety) and how attachments are staged / watermarked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Message } from '@deepseek-ai/dsh-llm'
import { buildDigest, collectUnsentImageRefs, elideMiddle, mergeSentImageIds, utf8Bytes } from '../../src/host/adapter.ts'
import { stripNulBytes } from '../../src/host/runner.ts'
import { imgMsg, makeAdapter, msg, runTurn, toolResultMsg, waitFor, workDir } from '../helpers/adapter-fixtures.ts'

test('buildDigest bounds output and keeps newest turns', () => {
  const msgs = [msg('user', 'turn-one'), msg('assistant', 'turn-two'), msg('user', 'turn-three')]
  const d = buildDigest(msgs, 0, 25)
  assert.ok(d.includes('[conversation so far]'))
  assert.ok(d.includes('turn-three'))
  assert.ok(!d.includes('turn-one'))
  const full = buildDigest(msgs, 0, 10_000)
  assert.ok(full.includes('turn-one'))
  assert.ok(full.includes('turn-three'))
  assert.ok(full.indexOf('turn-one') < full.indexOf('turn-two'))
  assert.ok(full.indexOf('turn-two') < full.indexOf('turn-three'), 'historical turns must precede the latest task')
})

test('buildDigest keeps the head and tail of tool results, not the payload (80/20)', () => {
  // A history budget is eaten by tool payloads, not by asks and answers. Tool
  // result lines are now middle-elided, so the same budget carries more prose:
  // the verdict at the end of a command stays reachable, the dump does not.
  const dump = 'BEGIN-' + 'x'.repeat(30_000) + '-EXIT CODE 0'
  const msgs = [
    msg('user', 'run the build'),
    {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: dump }] }],
      source: { kind: 'tool', callId: 'c1' },
    } as unknown as Message,
    msg('assistant', 'The build passed and I moved on.'),
  ]
  const core = buildDigest(msgs, 0, 40_000, { maxLineBytes: 40_000 })
  assert.match(core, /Tool result: BEGIN-/, 'the tool line is still present, head first')
  assert.match(core, /EXIT CODE 0/, 'the tail verdict survives')
  assert.match(core, /\[elided \d+B\]/, 'the middle is elided with a marker')
  const start = core.indexOf('Tool result: ')
  const end = core.lastIndexOf('EXIT CODE 0') + 'EXIT CODE 0'.length
  const toolSegment = core.slice(start, end)
  assert.ok(utf8Bytes(toolSegment) <= 900, 'one tool line is capped near 800 B, got ' + utf8Bytes(toolSegment))
  assert.ok(core.includes('The build passed and I moved on.'), 'prose is never elided')

  // Same budget with the old giant tool cap keeps far less prose.
  const legacy = buildDigest(msgs, 0, 40_000, { maxLineBytes: 40_000, toolLineBytes: 40_000 })
  assert.ok(utf8Bytes(legacy) > utf8Bytes(core), 'the elided digest is the smaller one')
})

test('elideMiddle bounds the result and keeps both ends', () => {
  const text = 'AAAA' + 'm'.repeat(5_000) + 'ZZZZ'
  const out = elideMiddle(text, 400)
  assert.ok(utf8Bytes(out) <= 400, 'must respect the ceiling')
  assert.ok(out.startsWith('AAAA'))
  assert.ok(out.endsWith('ZZZZ'))
  assert.match(out, /\[elided \d+B\]/)
  assert.equal(elideMiddle('short', 400), 'short')
  assert.equal(elideMiddle('anything', 0), '')
  // CJK must not be cut mid-code point.
  const cjk = '中'.repeat(2_000)
  const cut = elideMiddle(cjk, 300)
  assert.ok(!cut.includes('\uFFFD'))
  assert.ok(utf8Bytes(cut) <= 300)
})

test('buildDigest never lets tool-result bulk eat the live task (issue #35)', () => {
  const huge = 'x'.repeat(4_000)
  const msgs = [
    msg('user', 'please read block LOg2xNRy3'),
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'agy_tool', arguments: '{}' }] } as unknown as Message,
    {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: huge }] }],
      source: { kind: 'tool', callId: 'c1' },
    } as unknown as Message,
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'agy_tool', arguments: '{}' }] } as unknown as Message,
    {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: huge }] }],
      source: { kind: 'tool', callId: 'c2' },
    } as unknown as Message,
  ]
  const d = buildDigest(msgs, 0, 8_000)
  assert.ok(d.includes('please read block LOg2xNRy3'), 'task line must survive a digest saturated by tool results')
  assert.ok(d.includes('Tool result:'), 'tool results are labeled distinctly')
})

// --- agy single-message ceiling (192,000 UTF-8 bytes, tail-truncated) -------
// Measured on agy 1.4.9: a 300 KB ASCII prompt kept exactly 192,000 B and a
// 490 KB CJK prompt kept 191,998 B; the model then answered the OLD task because
// the live request (appended after the digest) had been cut off. This suite pins
// the digest byte budget; live-request-first assembly is pinned next door in
// adapter-prompt.test.ts.
test('buildDigest enforces a UTF-8 byte ceiling without splitting code points', () => {
  const big = '这是用于测试字节预算的中文内容。'.repeat(2_000)
  const msgs = [msg('user', 'first question'), msg('assistant', big), msg('user', 'latest')]
  const d = buildDigest(msgs, 0, 1_000_000, { maxBytes: 20_000, maxLineBytes: 5_000 })
  const bytes = Buffer.byteLength(d, 'utf8')
  assert.ok(bytes <= 20_100, 'digest must respect the byte ceiling, got ' + bytes + ' B')
  assert.ok(d.includes('[conversation so far]'))
  assert.ok(!d.includes('\uFFFD'), 'a split code point must not leak a replacement char')
})

test('oversized context transfer travels as a file reference, not inlined', async () => {
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = workDir
  try {
    const { adapter } = makeAdapter({ contextTransferFileAboveBytes: 5_000 })
    process.env.FAKE_AGY_MODE = 'ok'
    const argsFile = join(workDir, 'args-ctx-file.json')
    process.env.FAKE_AGY_ARGS_FILE = argsFile
    const history: Message[] = []
    for (let i = 0; i < 30; i++) {
      history.push(msg('user', 'p' + i))
      history.push(msg('assistant', 'answer ' + i + ' ' + 'y'.repeat(800)))
    }
    history.push(msg('user', 'LIVE-QUESTION-FILE-MODE'))
    await runTurn(adapter, history)
    const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
    const prompt = argv[argv.indexOf('-p') + 1] ?? ''
    assert.ok(prompt.includes('BACKGROUND CONTEXT'), 'must reference the background file')
    assert.ok(prompt.includes('read_file'))
    assert.ok(!prompt.includes('[conversation so far]'), 'the digest must NOT be inlined')
    const m = prompt.match(/([A-Za-z]:\\[^\n]*?\.md)/) ?? prompt.match(/(\/[^\n]*?\.md)/)
    assert.ok(m !== null, 'prompt must name the context file path')
    const ctxPath = m![1]!
    assert.ok(existsSync(ctxPath), 'context file must exist: ' + ctxPath)
    assert.ok(readFileSync(ctxPath, 'utf8').includes('[conversation so far]'))
    const dirs: string[] = []
    for (let i = 0; i < argv.length; i++) if (argv[i] === '--add-dir') dirs.push(argv[i + 1] ?? '')
    assert.ok(dirs.some((d) => ctxPath.startsWith(d)), 'the context dir must be passed via --add-dir')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  }
})

test('collectUnsentImageRefs skips already-sent ids and dedupes', () => {
  const history = [imgMsg('a1'), imgMsg('a2')]
  const trailing = [imgMsg('a2', 'again'), imgMsg('a3', 'new')]
  const got = collectUnsentImageRefs(history, trailing, 0, ['a1'])
  assert.deepEqual(got.map((r) => r.attachmentId), ['a2', 'a3'], 'trailing first, a1 already sent')
})

test('collectUnsentImageRefs on a tool hop only takes unseen ids since the watermark', () => {
  // history: user image a1 (already inside the watermark), then a tool hop
  // with no new attachments. The old fallback re-sent a1 on every hop.
  const history = [
    imgMsg('a1'),
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'agy_tool', arguments: '{}' }] } as unknown as Message,
    {
      role: 'tool',
      toolCallId: 'c1',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }],
    } as unknown as Message,
  ]
  const trailing = [history[2]!]
  const got = collectUnsentImageRefs(history, trailing, 3, [])
  assert.deepEqual(got.map((r) => r.attachmentId), [], 'no unseen images after a tool hop')
  // …but a first-contact / account-switch call (fromIdx 0, nothing sent) still carries it
  const fresh = collectUnsentImageRefs(history, trailing, 0, [])
  assert.deepEqual(fresh.map((r) => r.attachmentId), ['a1'])
})

test('mergeSentImageIds dedupes and keeps the newest under the cap', () => {
  assert.deepEqual(mergeSentImageIds(['a', 'b'], ['b', 'c']), ['a', 'b', 'c'])
  const many = mergeSentImageIds(['x0'], Array.from({ length: 70 }, (_, i) => 'i' + i), 64)
  assert.equal(many.length, 64)
  assert.equal(many[many.length - 1], 'i69', 'newest kept')
  assert.ok(!many.includes('x0'), 'oldest evicted')
})

test('first contact seeds a new conversation with contextTransferMaxChars, not digestMaxChars', async () => {
  const { adapter } = makeAdapter({
    digestMaxChars: 40,
    contextTransferMaxChars: 4_000,
    mediaMaxImages: 0,
  })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-transfer.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  const old = 'OLD-CONTEXT-' + 'x'.repeat(200)
  await runTurn(adapter, [msg('assistant', old), msg('user', 'carry on')])
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.ok(prompt.includes('OLD-CONTEXT'), 'transfer digest keeps the old turn')
  assert.ok(prompt.includes('carry on'))
})

test('returning hop does not re-attach historical screenshots (image watermark)', async () => {
  const reads: string[] = []
  const { adapter, store } = makeAdapter(
    { mediaMaxImages: 8, mediaDir: join(workDir, 'media-wm') },
    {
      readImage: async (ref) => {
        reads.push(ref.attachmentId)
        return new Uint8Array([1, 2, 3])
      },
    },
  )
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-wm.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile

  // Hop 1: user attaches a1. It must be staged and recorded.
  const first = [imgMsg('a1', 'look at this UI')]
  await runTurn(adapter, first, { sessionId: 'sess-wm' as never })
  await waitFor(() => store.get('sess-wm'))
  assert.deepEqual(reads, ['a1'])
  assert.deepEqual(store.get('sess-wm')?.sentImageIds, ['a1'])

  // Hop 2: tool-hop continuation with no new attachment — a1 must NOT be re-read.
  reads.length = 0
  const second = [
    ...first,
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'agy_tool', arguments: '{}' }] } as unknown as Message,
    {
      role: 'tool',
      toolCallId: 'c1',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }],
    } as unknown as Message,
  ]
  await runTurn(adapter, second, { sessionId: 'sess-wm' as never })
  assert.deepEqual(reads, [], 'historical image must not be re-staged on a tool hop')

  // Hop 3: a NEW attachment is still forwarded.
  reads.length = 0
  const third = [...second, imgMsg('a2', 'another look')]
  await runTurn(adapter, third, { sessionId: 'sess-wm' as never })
  assert.deepEqual(reads, ['a2'], 'only the unseen attachment is staged')
  assert.deepEqual(store.get('sess-wm')?.sentImageIds, ['a1', 'a2'])
})

test('multimodal: stages attached images and forwards path with view_file instructions', async () => {
  const pngData = Buffer.from('89504e470d0a1a0a', 'hex')
  const { adapter } = makeAdapter({}, {
    readImage: async () => pngData,
  })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-multimodal.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile

  // 1. Text + image
  const imgMsg: Message = {
    role: 'user',
    content: [
      { type: 'text', text: 'what is this image?' },
      {
        type: 'image',
        attachment: {
          attachmentId: 'img_test_1' as never,
          mediaType: 'image/png',
          bytes: pngData.length,
          width: 100,
          height: 100,
          name: 'diagram.png',
        },
      },
    ],
  } as unknown as Message

  await runTurn(adapter, [imgMsg], { sessionId: 'sess-img' as never })
  const argv1 = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt1 = argv1[argv1.indexOf('-p') + 1] ?? ''
  assert.ok(prompt1.includes('what is this image?'))
  assert.ok(prompt1.includes('[image attached: "diagram.png"'))
  assert.ok(prompt1.includes('Inspect it using the view_file tool'))
  assert.ok(argv1.includes('--add-dir'))

  // 2. Image only (no text)
  const imgOnlyMsg: Message = {
    role: 'user',
    content: [
      {
        type: 'image',
        attachment: {
          attachmentId: 'img_test_2' as never,
          mediaType: 'image/png',
          bytes: pngData.length,
          width: 50,
          height: 50,
        },
      },
    ],
  } as unknown as Message

  await runTurn(adapter, [imgOnlyMsg], { sessionId: 'sess-img-only' as never })
  const argv2 = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt2 = argv2[argv2.indexOf('-p') + 1] ?? ''
  assert.ok(prompt2.includes('[image attached: "img_test_2"'))
  assert.ok(prompt2.includes('[Please inspect the attached image(s) using view_file and assist the user.]'))
})

// --- NUL-byte hardening -----------------------------------------------------
// Live failure (2026-10-16): a tool result that quoted binary output (the agent
// had listed/read a `.git` directory) carried U+0000 into the assembled prompt,
// and `spawn(agy, args)` threw
//   ERR_INVALID_ARG_VALUE: The argument 'args[16]' must be a string without null bytes
// which failed the whole turn ("failed to spawn agy") before agy ever started.
test('stripNulBytes removes NUL bytes and keeps other whitespace intact', () => {
  assert.equal(stripNulBytes('a\u0000b'), 'ab')
  assert.equal(stripNulBytes('\u0000\u0000'), '')
  assert.equal(stripNulBytes('tab\tlf\ncr\r'), 'tab\tlf\ncr\r')
  assert.equal(stripNulBytes('plain text'), 'plain text')
})

test('buildDigest strips NUL bytes that arrive with binary tool output', () => {
  const messages = [
    msg('user', 'look at .git'),
    toolResultMsg({ nestedText: 'total 1996\n\u0000drwxr-xr-x 3 zand zand 4096 Oct 1 .\u0000' }),
    msg('assistant', 'ok'),
    msg('user', '这啥情况？'),
  ]
  const digest = buildDigest(messages, 0, 10_000)
  assert.ok(digest.includes('[conversation so far]'))
  assert.ok(!digest.includes('\u0000'), 'digest must be NUL-free')
  assert.ok(digest.includes('drwxr-xr-x 3 zand zand 4096 Oct 1'), 'text around the NUL survives')
})

test('a NUL byte in history cannot fail the turn with a spawn TypeError', async () => {
  const argsFile = join(workDir, `args-nul-${Date.now()}.json`)
  const prevArgs = process.env.FAKE_AGY_ARGS_FILE
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  try {
    const { adapter } = makeAdapter()
    const history = [
      msg('user', 'look at .git'),
      toolResultMsg({ nestedText: 'total 1996\n\u0000drwxr-xr-x 3 zand zand 4096 Oct 1 .' }),
      msg('assistant', 'ok'),
      msg('user', '这啥情况？'),
    ]
    const res = await runTurn(adapter, history, { sessionId: 'sess-nul' as never })
    const finish = res.chunks[res.chunks.length - 1] as { type: string; reason: { kind: string; failure?: { message?: string } } }
    assert.equal(finish.type, 'finish')
    assert.notEqual(finish.reason.kind, 'error', 'the turn must survive NUL-bearing tool output')
    const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
    assert.ok(Array.isArray(argv) && argv.length > 0, 'fake agy must have been spawned')
    assert.ok(argv.every((a) => typeof a === 'string' && !a.includes('\u0000')), 'no argv element may contain a NUL')
  } finally {
    if (prevArgs === undefined) delete process.env.FAKE_AGY_ARGS_FILE
    else process.env.FAKE_AGY_ARGS_FILE = prevArgs
  }
})
