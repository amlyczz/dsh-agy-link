import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { defaultConfig } from '../../../src/common/types.ts'
import { handleConfig } from '../../../src/host/commands/config.ts'
import { handleImage, parseImageCommandInput, tokenizeImageArgs } from '../../../src/host/commands/image.ts'
import type { CommandDeps } from '../../../src/host/commands/shared.ts'
import { handleSlashBridge } from '../../../src/host/commands/slash-bridge.ts'
import { defineAgyImageTool, formatImageResultMarkdown } from '../../../src/host/image-tool.ts'
import type { ImageRequest, ImageResult, ImageService } from '../../../src/host/image.ts'
import { runAgyOnce } from '../../../src/host/oneshot.ts'
import { AccountPoolManager } from '../../../src/host/pool.ts'
import { SessionStore } from '../../../src/host/sessions.ts'

test('defineAgyImageTool and formatImageResultMarkdown invoke ImageService and format verified markdown', async () => {
  const seen: ImageRequest[] = []
  const sampleRes: ImageResult = {
    ok: true,
    path: '/tmp/out/hero.png',
    uri: 'file:///tmp/out/hero.png',
    mime: 'image/png',
    width: 1376,
    height: 768,
    aspectRatio: '16:9',
    bytes: 2 * 1024 * 1024,
    name: 'hero',
    prompt: 'sunset city',
    model: 'gemini-4-hydrogen',
    effort: 'medium',
    durationMs: 4200,
    attempts: 1,
    accountId: 'acc_1',
  }

  let failMode = false
  const fakeService = {
    async generate(req: ImageRequest): Promise<ImageResult> {
      seen.push(req)
      if (failMode) {
        return { ...sampleRes, ok: false, code: 'IMAGE_REGION_UNSUPPORTED', error: 'region blocked' }
      }
      return sampleRes
    },
  } as unknown as ImageService

  const tool = defineAgyImageTool({ imageService: () => fakeService, log: () => {} })
  assert.equal(tool.name, 'agy_image')

  const out = await tool.execute({
    prompt: 'sunset city',
    name: 'hero',
    aspectRatio: '16:9',
    imagePaths: '/tmp/ref1.png, /tmp/ref2.png\n/tmp/ref3.png',
    outPath: '/tmp/out/hero.png',
    model: 'gemini-4-hydrogen',
    effort: 'medium',
  }, { signal: undefined } as never)

  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0]?.imagePaths, ['/tmp/ref1.png', '/tmp/ref2.png', '/tmp/ref3.png'])
  assert.match(String(out), /!\[hero\]\(file:\/\//)
  assert.match(String(out), /1376×768 · 16:9 · image\/png · 2\.00 MB · 4\.2s · gemini-4-hydrogen · account: acc_1/)

  const kbMd = formatImageResultMarkdown({ ...sampleRes, bytes: 2048, accountId: undefined })
  assert.match(kbMd, /2 KB/)

  failMode = true
  await assert.rejects(
    tool.execute({ prompt: 'sunset city' }, { signal: undefined } as never),
    /IMAGE_REGION_UNSUPPORTED.*region blocked/,
  )
})

test('tokenizeImageArgs, parseImageCommandInput, and handleImage parse all flags and handle errors', async () => {
  assert.deepEqual(tokenizeImageArgs('"a \\"quoted\\" cat" -a 16:9 \'ref path.png\''), ['a "quoted" cat', '-a', '16:9', 'ref path.png'])

  const parsed = parseImageCommandInput('/agy image "cyberpunk neon \\"alley\\"" -a 16:9 -n alley -i /tmp/a.png --ref /tmp/b.png -o /tmp/out.png --model gemini-4-hydrogen --effort medium --force')
  assert.equal('error' in parsed, false)
  if (!('error' in parsed)) {
    assert.equal(parsed.prompt, 'cyberpunk neon "alley"')
    assert.equal(parsed.aspectRatio, '16:9')
    assert.equal(parsed.name, 'alley')
    assert.deepEqual(parsed.imagePaths, ['/tmp/a.png', '/tmp/b.png'])
    assert.equal(parsed.outPath, '/tmp/out.png')
    assert.equal(parsed.model, 'gemini-4-hydrogen')
    assert.equal(parsed.effort, 'medium')
    assert.equal(parsed.force, true)
  }

  assert.match((parseImageCommandInput('/agy image') as { error: string }).error, /Usage:/)
  assert.match((parseImageCommandInput('/agy image -a') as { error: string }).error, /missing value/)
  assert.match((parseImageCommandInput('/agy image -a 16:9') as { error: string }).error, /Prompt is required/)

  const baseDeps: CommandDeps = {
    cfg: () => defaultConfig(),
    bin: () => 'agy',
    version: () => '1.5.12',
    auth: () => ({} as never),
    catalog: () => ({} as never),
    store: () => ({} as never),
    pool: () => ({} as never),
    lastRun: () => null,
    runDoctor: async () => '',
    setOverride: () => {},
  }
  assert.match((await handleImage(baseDeps, { sub: 'image', arg: 'cat', parts: ['image', 'cat'], raw: '/agy image cat' })).text ?? '', /not initialized/)

  const okRes = await handleImage({
    ...baseDeps,
    imageService: () => ({
      generate: async (req: ImageRequest): Promise<ImageResult> => ({
        ok: true, path: '/tmp/cat.png', mime: 'image/png', width: 1024, height: 1024,
        aspectRatio: '1:1', bytes: 4096, name: 'cat', prompt: req.prompt, model: 'gemini-4-hydrogen',
        effort: 'medium', durationMs: 1200, attempts: 1,
      }),
    }) as unknown as ImageService,
  }, { sub: 'image', arg: 'cat', parts: ['image', 'cat'], raw: '/agy image cat' })
  assert.match(okRes.text ?? '', /1024×1024/)

  const failRes = await handleImage({
    ...baseDeps,
    imageService: () => ({
      generate: async (): Promise<ImageResult> => ({
        ok: false, path: '', mime: '', width: 0, height: 0, aspectRatio: '', bytes: 0,
        name: '', prompt: 'cat', model: 'm', effort: 'medium', durationMs: 100, attempts: 1,
        code: 'AGY_ERROR', error: 'boom',
      }),
    }) as unknown as ImageService,
  }, { sub: 'image', arg: 'cat', parts: ['image', 'cat'], raw: '/agy image cat' })
  assert.match(failRes.text ?? '', /Image generation failed.*boom/)
})

test('slash-bridge handles btw, fork/restore/list, grill-me, learn --apply with traversal rejection, and compact', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-slash-bridge-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const store = new SessionStore(join(dir, 'sessions.json'))
  store.set('sess-1', { conversationId: 'conv-orig', lastMessageCount: 3, updatedAt: Date.now(), model: 'gemini-3.8-flash' })
  const wsDir = join(dir, 'ws')
  const forksFile = join(dir, 'forks.json')
  const runs: Array<Record<string, unknown>> = []
  let nextRunResult: { ok: boolean; text: string; conversationId: string | null; error?: string; durationMs: number } = {
    ok: true, text: 'Side answer', conversationId: 'conv-branch', durationMs: 25,
  }

  const fakeSession = {
    header: { cwd: wsDir },
    snapshotEvents: () => [
      { type: 'user/message', data: { message: { content: 'Build module A' } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Implemented A' }] } } },
    ],
  }

  const deps: CommandDeps = {
    cfg: () => ({ ...defaultConfig(), workspaceRoot: wsDir }),
    bin: () => 'agy',
    version: () => '1.5.12',
    auth: () => ({} as never),
    catalog: () => ({} as never),
    store: () => store,
    pool: () => ({} as never),
    lastRun: () => null,
    runDoctor: async () => '',
    setOverride: () => {},
    forksFile,
    sessions: () => ({ get: () => fakeSession }),
    runOnce: async (req) => {
      runs.push(req)
      return nextRunResult
    },
  }

  const inv = {
    commandId: 'agy' as CommandInvocation['commandId'],
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
    agent: { id: 'sess-1', session: fakeSession },
  } as unknown as CommandInvocation

  // Empty fork list before any checkpoint
  assert.match((await handleSlashBridge(deps, { sub: 'fork', arg: 'list', parts: ['fork', 'list'], raw: '/agy fork list', invocation: inv })).text ?? '', /No fork checkpoints saved/)

  // Missing runOnce runner paths
  const noRunnerDeps: CommandDeps = { ...deps, runOnce: undefined }
  for (const sub of ['btw', 'grill', 'learn', 'compact'] as const) {
    const msg = (await handleSlashBridge(noRunnerDeps, { sub, arg: 'q', parts: [sub, 'q'], raw: `/agy ${sub} q`, invocation: inv })).text ?? ''
    assert.match(msg, /not configured/)
  }

  // runOnce failure propagation paths
  nextRunResult = { ok: false, text: '', conversationId: null, error: 'boom', durationMs: 5 }
  assert.match((await handleSlashBridge(deps, { sub: 'btw', arg: 'why?', parts: ['btw', 'why?'], raw: '/agy btw why?', invocation: inv })).text ?? '', /Side question failed/)
  assert.match((await handleSlashBridge(deps, { sub: 'fork', arg: 'go', parts: ['fork', 'go'], raw: '/agy fork go', invocation: inv })).text ?? '', /Fork execution failed/)
  assert.match((await handleSlashBridge(deps, { sub: 'grill', arg: 'x', parts: ['grill', 'x'], raw: '/agy grill x', invocation: inv })).text ?? '', /Grill interview failed/)
  assert.match((await handleSlashBridge(deps, { sub: 'learn', arg: 'x', parts: ['learn', 'x'], raw: '/agy learn x', invocation: inv })).text ?? '', /Learn preview failed/)
  assert.match((await handleSlashBridge(deps, { sub: 'learn', arg: '--apply x', parts: ['learn', '--apply', 'x'], raw: '/agy learn --apply x', invocation: inv })).text ?? '', /Learn --apply failed/)
  assert.match((await handleSlashBridge(deps, { sub: 'compact', arg: '', parts: ['compact'], raw: '/agy compact', invocation: inv })).text ?? '', /Compaction failed/)
  nextRunResult = { ok: true, text: 'Side answer', conversationId: 'conv-branch', durationMs: 25 }

  // btw
  assert.match((await handleSlashBridge(deps, { sub: 'btw', arg: '', parts: ['btw'], raw: '/agy btw' })).text ?? '', /Usage:/)
  const btw = await handleSlashBridge(deps, { sub: 'btw', arg: 'why?', parts: ['btw', 'why?'], raw: '/agy btw why?', invocation: inv })
  assert.match(btw.text ?? '', /Side Answer/)
  assert.equal(runs.at(-1)?.mode, 'default')
  assert.equal(runs.at(-1)?.disableSlashCommands, true)
  assert.equal(runs.at(-1)?.cwd, wsDir)
  assert.equal(runs.at(-1)?.model, 'gemini-4-hydrogen')
  assert.equal(runs.at(-1)?.effort, 'medium')
  assert.match(String(runs.at(-1)?.prompt), /Build module A/)

  // fork empty -> saves checkpoint + drops binding; fork with prompt -> creates branch checkpoint; list & restore
  const forkReset = await handleSlashBridge(deps, { sub: 'fork', arg: '', parts: ['fork'], raw: '/agy fork', invocation: inv })
  assert.match(forkReset.text ?? '', /Saved checkpoint/)
  assert.equal(store.get('sess-1'), undefined)

  const forkPrompt = await handleSlashBridge(deps, { sub: 'fork', arg: 'explore', parts: ['fork', 'explore', 'B'], raw: '/agy fork explore B', invocation: inv })
  assert.match(forkPrompt.text ?? '', /Forked Branch Result/)

  const forkList = await handleSlashBridge(deps, { sub: 'fork', arg: 'list', parts: ['fork', 'list'], raw: '/agy fork list', invocation: inv })
  assert.match(forkList.text ?? '', /Session Fork Checkpoints/)
  const idMatch = forkList.text?.match(/`(fork-[a-f0-9]+)`/)
  assert.ok(idMatch?.[1])

  const restored = await handleSlashBridge(deps, { sub: 'fork', arg: 'restore', parts: ['fork', 'restore', idMatch[1]], raw: `/agy fork restore ${idMatch[1]}`, invocation: inv })
  assert.match(restored.text ?? '', /Restored fork/)
  assert.ok(store.get('sess-1')?.conversationId)

  const missingFork = await handleSlashBridge(deps, { sub: 'fork', arg: 'restore', parts: ['fork', 'restore', 'fork-missing'], raw: '/agy fork restore fork-missing', invocation: inv })
  assert.match(missingFork.text ?? '', /not found/)

  // grill-me
  const grill = await handleSlashBridge(deps, { sub: 'grill-me', arg: 'auth', parts: ['grill-me', 'auth'], raw: '/agy grill-me auth', invocation: inv })
  assert.match(grill.text ?? '', /Design Alignment/)
  assert.equal(runs.at(-1)?.mode, 'default')
  assert.equal(runs.at(-1)?.disableSlashCommands, true)
  assert.equal(runs.at(-1)?.cwd, wsDir)

  // learn preview + --apply (valid & adversarial rejection)
  const learnPreview = await handleSlashBridge(deps, { sub: 'learn', arg: 'caching', parts: ['learn', 'caching'], raw: '/agy learn caching', invocation: inv })
  assert.match(learnPreview.text ?? '', /Extracted Skill \/ Rule Draft/)

  nextRunResult = {
    ok: true,
    text: '```json\n{"kind":"skill","name":"safe-cache","summary":"Cache rule","content":"---\\nname: safe-cache\\ndescription: test\\n---\\nBody"}\n```',
    conversationId: 'conv-learn',
    durationMs: 30,
  }
  const learnApply = await handleSlashBridge(deps, { sub: 'learn', arg: '--apply', parts: ['learn', '--apply'], raw: '/agy learn --apply', invocation: inv })
  assert.match(learnApply.text ?? '', /Saved \*\*skill\*\* `safe-cache`/)
  const skillPath = join(wsDir, '.agents', 'skills', 'safe-cache', 'SKILL.md')
  assert.equal(existsSync(skillPath), true)
  assert.match(readFileSync(skillPath, 'utf8'), /safe-cache/)

  // learn --apply with raw JSON rule payload
  nextRunResult = {
    ok: true,
    text: JSON.stringify({ kind: 'rule', name: 'my-rule', summary: 's', content: '# rule' }),
    conversationId: 'conv-learn-rule',
    durationMs: 20,
  }
  const learnRule = await handleSlashBridge(deps, { sub: 'learn', arg: '--apply', parts: ['learn', '--apply'], raw: '/agy learn --apply', invocation: inv })
  assert.match(learnRule.text ?? '', /Saved \*\*rule\*\* `my-rule`/)
  assert.equal(readFileSync(join(wsDir, '.agents', 'rules', 'my-rule.md'), 'utf8'), '# rule')

  // Adversarial: path traversal name rejected by regex
  nextRunResult = {
    ok: true,
    text: JSON.stringify({ kind: 'rule', name: '../../../../escape', summary: 'bad', content: 'x' }),
    conversationId: 'conv-bad',
    durationMs: 10,
  }
  const badLearn = await handleSlashBridge(deps, { sub: 'learn', arg: '--apply', parts: ['learn', '--apply'], raw: '/agy learn --apply', invocation: inv })
  assert.match(badLearn.text ?? '', /Invalid structured output/)

  // compact drops bindings
  nextRunResult = { ok: true, text: 'Key state retained.', conversationId: 'conv-c', durationMs: 20 }
  const compacted = await handleSlashBridge(deps, { sub: 'compact', arg: '', parts: ['compact'], raw: '/agy compact', invocation: inv })
  assert.match(compacted.text ?? '', /Session Compacted.*dropped 1/)
  assert.match(compacted.text ?? '', /<compacted-summary>/)
  assert.equal(store.get('sess-1'), undefined)

  const noHistCompact = await handleSlashBridge(deps, { sub: 'compact', arg: '', parts: ['compact'], raw: '/agy compact' })
  assert.match(noHistCompact.text ?? '', /No conversation history/)
})

test('/agy config handles mode auto, sandbox, agent, settings JSON, and transport', () => {
  const cfg = defaultConfig()
  const writes: Array<[string, unknown]> = []
  const deps: CommandDeps = {
    cfg: () => cfg,
    bin: () => 'agy',
    version: () => '1.5.12',
    auth: () => ({} as never),
    catalog: () => ({} as never),
    store: () => ({} as never),
    pool: () => ({} as never),
    lastRun: () => null,
    runDoctor: async () => '',
    acpStatus: () => ({ activeProcesses: 1, sessions: 2, keys: ['primary|auto|0|'] }),
    setOverride: (k, v) => {
      writes.push([k, v])
      ;(cfg as unknown as Record<string, unknown>)[k] = v
    },
  }

  assert.match(handleConfig(deps, { sub: 'mode', arg: 'auto', parts: ['mode', 'auto'], raw: '/agy mode auto' }).text ?? '', /auto/)
  assert.match(handleConfig(deps, { sub: 'sandbox', arg: 'on', parts: ['sandbox', 'on'], raw: '/agy sandbox on' }).text ?? '', /on/)
  assert.match(handleConfig(deps, { sub: 'sandbox', arg: 'bad', parts: ['sandbox', 'bad'], raw: '/agy sandbox bad' }).text ?? '', /usage:/)
  assert.match(handleConfig(deps, { sub: 'agent', arg: 'my-agent', parts: ['agent', 'my-agent'], raw: '/agy agent my-agent' }).text ?? '', /my-agent/)
  assert.match(handleConfig(deps, { sub: 'agent', arg: 'off', parts: ['agent', 'off'], raw: '/agy agent off' }).text ?? '', /cleared/)
  assert.match(handleConfig(deps, { sub: 'settings', arg: '{"k":1}', parts: ['settings', '{"k":1}'], raw: '/agy settings {"k":1}' }).text ?? '', /updated/)
  assert.match(handleConfig(deps, { sub: 'settings', arg: '{bad', parts: ['settings', '{bad'], raw: '/agy settings {bad' }).text ?? '', /invalid inline JSON/)
  assert.match(handleConfig(deps, { sub: 'settings', arg: 'clear', parts: ['settings', 'clear'], raw: '/agy settings clear' }).text ?? '', /Cleared/)
  assert.match(handleConfig(deps, { sub: 'transport', arg: 'acp', parts: ['transport', 'acp'], raw: '/agy transport acp' }).text ?? '', /acp/)
  assert.match(handleConfig(deps, { sub: 'transport', arg: 'status', parts: ['transport', 'status'], raw: '/agy transport status' }).text ?? '', /ACP active processes: 1/)
  assert.match(handleConfig(deps, { sub: 'transport', arg: 'bad', parts: ['transport', 'bad'], raw: '/agy transport bad' }).text ?? '', /usage:/)

  assert.deepEqual(writes, [
    ['permissionMode', 'auto'],
    ['sandbox', true],
    ['agent', 'my-agent'],
    ['agent', ''],
    ['agySettings', '{"k":1}'],
    ['agySettings', ''],
    ['transport', 'acp'],
  ])
})

test('handleImage forwards signal and resolves relative -i/-o against session cwd', async () => {
  const wsDir = resolve(tmpdir(), 'agy-img-ws')
  let seenReq: ImageRequest | undefined
  let seenSignal: AbortSignal | undefined
  const ac = new AbortController()

  const deps: CommandDeps = {
    cfg: () => defaultConfig(),
    bin: () => 'agy',
    version: () => '1.5.12',
    auth: () => ({} as never),
    catalog: () => ({} as never),
    store: () => ({} as never),
    pool: () => ({} as never),
    lastRun: () => null,
    runDoctor: async () => '',
    setOverride: () => {},
    imageService: () => ({
      generate: async (req: ImageRequest, signal?: AbortSignal): Promise<ImageResult> => {
        seenReq = req
        seenSignal = signal
        return {
          ok: true, path: req.outPath ?? '/tmp/out.png', mime: 'image/png', width: 1024, height: 1024,
          aspectRatio: '1:1', bytes: 2048, name: 'cat', prompt: req.prompt, model: 'gemini-4-hydrogen',
          effort: 'medium', durationMs: 500, attempts: 1,
        }
      },
    }) as unknown as ImageService,
  }

  const inv = {
    commandId: 'agy' as CommandInvocation['commandId'],
    rawInput: 'image "a cat" -i refs/in.png -o out/cat.png',
    attachments: [],
    signal: ac.signal,
    agent: { id: 'sess-img', session: { header: { cwd: wsDir } } },
  } as unknown as CommandInvocation

  const res = await handleImage(deps, {
    sub: 'image',
    arg: '"a',
    parts: ['image', '"a', 'cat"', '-i', 'refs/in.png', '-o', 'out/cat.png'],
    raw: '/agy image "a cat" -i refs/in.png -o out/cat.png',
    invocation: inv,
  })
  assert.equal(res.kind, 'success')
  assert.deepEqual(seenReq?.imagePaths, [resolve(wsDir, 'refs/in.png')])
  assert.equal(seenReq?.outPath, resolve(wsDir, 'out/cat.png'))
  assert.equal(seenSignal, ac.signal)
})

test('btw extracts agy_tool calls and live activeRun progress, and fork preserves lastMessageCount/sentImageIds', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-ctx-fork-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const store = new SessionStore(join(dir, 'sessions.json'))
  store.set('sess-fork', {
    conversationId: 'conv-orig',
    lastMessageCount: 7,
    sentImageIds: ['img-1', 'img-2'],
    updatedAt: 100,
  })
  const forksFile = join(dir, 'forks.json')
  const runs: Array<Record<string, unknown>> = []

  const liveEvents = [
    { kind: 'step', stepKind: 'tool', state: 'RUNNING', text: '', tool: { name: 'view_file', args: { Path: '/b.ts' } } },
    { kind: 'step', stepKind: 'subagent', text: 'researching docs' },
    { kind: 'step', stepKind: 'text', text: 'partial answer' },
  ] as const

  const fakeSession = {
    header: { cwd: dir },
    snapshotEvents: () => [
      { type: 'user/message', data: { message: { content: 'Inspect repo' } } },
      { type: 'tool/call', data: { name: 'agy_tool', args: { tool: 'read_file', input: { Path: '/a.ts' } } } },
      { type: 'tool/call', data: { call: { toolName: 'agy_tool', arguments: JSON.stringify({ toolName: 'grep_search', args: { Query: 'foo' } }) } } },
    ],
  }

  const deps: CommandDeps = {
    cfg: () => defaultConfig(),
    bin: () => 'agy',
    version: () => '1.5.12',
    auth: () => ({} as never),
    catalog: () => ({} as never),
    store: () => store,
    pool: () => ({} as never),
    lastRun: () => null,
    runDoctor: async () => '',
    setOverride: () => {},
    forksFile,
    sessions: () => ({ get: () => fakeSession }),
    activeRun: () => ({
      isSettled: false,
      conversationId: 'conv-live',
      length: liveEvents.length,
      eventAt: (i: number) => liveEvents[i],
    }) as never,
    runOnce: async (req) => {
      runs.push(req)
      return { ok: true, text: 'Ok answer', conversationId: 'conv-side', durationMs: 12 }
    },
  }

  const inv = {
    commandId: 'agy' as CommandInvocation['commandId'],
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
    agent: { id: 'sess-fork', session: fakeSession },
  } as unknown as CommandInvocation

  const btw = await handleSlashBridge(deps, { sub: 'btw', arg: 'status?', parts: ['btw', 'status?'], raw: '/agy btw status?', invocation: inv })
  assert.equal(btw.kind, 'success')
  const prompt = String(runs.at(-1)?.prompt ?? '')
  assert.match(prompt, /Tool: read_file\(\/a\.ts\)/)
  assert.match(prompt, /Tool: grep_search\(foo\)/)
  assert.match(prompt, /view_file\(\/b\.ts\) \[RUNNING\]/)
  assert.match(prompt, /\[subagent\] researching docs/)
  assert.match(prompt, /partial answer/)
  assert.doesNotMatch(prompt, /Tool: agy_tool/)

  await handleSlashBridge(deps, { sub: 'fork', arg: '', parts: ['fork'], raw: '/agy fork', invocation: inv })
  assert.equal(store.get('sess-fork'), undefined)
  const listed = await handleSlashBridge(deps, { sub: 'fork', arg: 'list', parts: ['fork', 'list'], raw: '/agy fork list', invocation: inv })
  const idMatch = listed.text?.match(/`(fork-[a-f0-9]+)`/)
  assert.ok(idMatch?.[1])
  await handleSlashBridge(deps, { sub: 'fork', arg: 'restore', parts: ['fork', 'restore', idMatch[1]], raw: `/agy fork restore ${idMatch[1]}`, invocation: inv })
  const restored = store.get('sess-fork')
  assert.ok(restored)
  assert.equal(restored.conversationId, 'conv-orig')
  assert.equal(restored.lastMessageCount, 7)
  assert.deepEqual(restored.sentImageIds, ['img-1', 'img-2'])
  assert.equal(restored.model, undefined)
  assert.equal('model' in restored, false)
})

test('runAgyOnce handles headless deny on empty exit-0, structured_output, effort-refused retry, and model-not-recognized failover', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-oneshot-edge-'))
  const fakeBin = join(dir, 'fake-oneshot-agy.mjs')
  const logFile = join(dir, 'invocations.jsonl')
  writeFileSync(
    fakeBin,
    [
      'import { appendFileSync, readFileSync } from "node:fs"',
      'const mode = process.env.FAKE_ONESHOT_MODE || ""',
      'const logFile = process.env.FAKE_ONESHOT_LOG || ""',
      'const args = process.argv.slice(2)',
      'if (logFile) appendFileSync(logFile, JSON.stringify({ args, mode }) + "\\n")',
      'if (mode === "headless-deny") {',
      '  process.stderr.write("jetski: no output produced — a tool required the \\"command\\" permission that headless mode cannot prompt for, so it was auto-denied.\\n")',
      '  process.exit(0)',
      '}',
      'if (mode === "structured-output") {',
      '  console.log(JSON.stringify({ event: "result", result: { conversation_id: "c-struct", status: "SUCCESS", response: "", structured_output: { kind: "rule", name: "r1" } } }))',
      '  process.exit(0)',
      '}',
      'if (mode === "effort-refused") {',
      '  if (args.includes("--effort")) {',
      '    process.stderr.write("invalid model selection (--model \\"gemini-3.8-flash\\" --effort \\"high\\"): --effort \\"high\\" is not supported for model \\"gemini-3.8-flash\\"\\n")',
      '    process.exit(1)',
      '  }',
      '  console.log(JSON.stringify({ event: "result", result: { conversation_id: "c-eff", status: "OK", response: "recovered without effort" } }))',
      '  process.exit(0)',
      '}',
      'if (mode === "model-not-recognized") {',
      '  const calls = logFile ? readFileSync(logFile, "utf8").trim().split("\\n").filter(Boolean).length : 1',
      '  if (calls === 1) {',
      '    process.stderr.write("invalid model selection (--model \\"gemini-4-hydrogen\\" --effort \\"\\"): model gemini-4-hydrogen is not recognized as a known model or custom model in settings\\n")',
      '    process.exit(1)',
      '  }',
      '  console.log(JSON.stringify({ event: "result", result: { conversation_id: "c-m2", status: "OK", response: "served by account 2" } }))',
      '  process.exit(0)',
      '}',
    ].join('\n'),
  )

  const prevMode = process.env.FAKE_ONESHOT_MODE
  const prevLog = process.env.FAKE_ONESHOT_LOG
  t.after(() => {
    if (prevMode === undefined) delete process.env.FAKE_ONESHOT_MODE
    else process.env.FAKE_ONESHOT_MODE = prevMode
    if (prevLog === undefined) delete process.env.FAKE_ONESHOT_LOG
    else process.env.FAKE_ONESHOT_LOG = prevLog
    rmSync(dir, { recursive: true, force: true })
  })

  process.env.FAKE_ONESHOT_LOG = logFile
  const baseOneShotDeps = {
    cfg: () => ({ ...defaultConfig(), agyBin: fakeBin, workspaceRoot: dir, timeoutMs: 10_000, mcpBridge: false }),
    bin: () => fakeBin,
  }

  // Case 1: headless-deny on exit 0 empty output
  process.env.FAKE_ONESHOT_MODE = 'headless-deny'
  const denyRes = await runAgyOnce(baseOneShotDeps, { prompt: 'hello' })
  assert.equal(denyRes.ok, false)
  assert.match(denyRes.error ?? '', /headless mode cannot prompt/)

  // Case 2: structured_output extraction
  process.env.FAKE_ONESHOT_MODE = 'structured-output'
  const structRes = await runAgyOnce(baseOneShotDeps, {
    prompt: 'learn',
    schema: { type: 'object', properties: { kind: { type: 'string' }, name: { type: 'string' } } },
  })
  assert.equal(structRes.ok, true, structRes.error)
  assert.deepEqual(JSON.parse(structRes.text), { kind: 'rule', name: 'r1' })

  // Case 3: effort-refused retry
  writeFileSync(logFile, '')
  process.env.FAKE_ONESHOT_MODE = 'effort-refused'
  const refusedModels: string[] = []
  const effRes = await runAgyOnce(
    { ...baseOneShotDeps, onEffortUnsupported: (m) => refusedModels.push(m) },
    { prompt: 'hi', model: 'gemini-3.8-flash', effort: 'high' },
  )
  assert.equal(effRes.ok, true, effRes.error)
  assert.equal(effRes.text, 'recovered without effort')
  assert.deepEqual(refusedModels, ['gemini-3.8-flash'])
  const effLogs = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[] })
  assert.equal(effLogs.length, 2)
  assert.equal(effLogs[0]!.args.includes('--effort'), true)
  assert.equal(effLogs[1]!.args.includes('--effort'), false)

  // Case 4: model-not-recognized failover across pool accounts
  writeFileSync(logFile, '')
  process.env.FAKE_ONESHOT_MODE = 'model-not-recognized'
  const pool = new AccountPoolManager(join(dir, 'pool-mnr'))
  pool.createAccountSlot('Second')
  const firstAcc = pool.getAccounts()[0]!
  const mnrRes = await runAgyOnce(
    { ...baseOneShotDeps, pool: () => pool },
    { prompt: 'hi', model: 'gemini-4-hydrogen' },
  )
  assert.equal(mnrRes.ok, true, mnrRes.error)
  assert.equal(mnrRes.text, 'served by account 2')
  const mnrLogs = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(mnrLogs.length, 2)
  assert.equal(pool.isModelSupported(firstAcc, 'gemini-4-hydrogen'), false)
})
