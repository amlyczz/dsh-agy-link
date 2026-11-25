// Regression tests for false-positive `Error: unknown tool "agy_tool"` errors:
// 1. Mid-span mirror unregistration / plugin reload must not emit doomed agy_tool calls.
// 2. Host availability check respects disposal, missing tools service, and agent-scope restrictions.
// 3. History digest sanitizes historical `Error: unknown tool "agy_tool"` results while keeping real errors intact.
// 4. Client AgyMirrorToolView & server presentMirrorResult treat transient mirror UNKNOWN_TOOL as non-error.
import '../helpers/client-render.ts'
import { React, renderToStaticMarkup } from '../helpers/client-render.ts'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { isMirrorToolNotFoundText, MIRROR_TOOL_RELOAD_NOTICE } from '../../src/common/mirror-error.ts'
import { RunRegistry } from '../../src/host/recording.ts'
import { driveSpan } from '../../src/provider/span.ts'
import { buildDigest } from '../../src/provider/prompt-text.ts'
import { presentMirrorResult } from '../../src/provider/mirror/present.ts'
import { AgyMirrorToolView } from '../../src/client/toolview/index.ts'
import { isTransientMirrorToolNotFound } from '../../src/client/toolview/args.ts'
import { apply } from '../../src/index.ts'
import { sandboxEnv } from '../helpers/sandbox-env.ts'

async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const c of iter) out.push(c)
  return out
}

test('isMirrorToolNotFoundText matches bare and mode-collapsed agy_tool errors, rejects real tool errors', () => {
  assert.equal(isMirrorToolNotFoundText('Error: unknown tool "agy_tool"'), true)
  assert.equal(isMirrorToolNotFoundText('unknown tool "agy_tool"'), true)
  assert.equal(
    isMirrorToolNotFoundText('Error: unknown tool "agy_tool": only `run_code` is callable directly'),
    true,
  )
  assert.equal(isMirrorToolNotFoundText('Error: unknown tool "bash"'), false)
  assert.equal(isMirrorToolNotFoundText('agy tool edit_file failed: target not found'), false)
  assert.equal(isMirrorToolNotFoundText(''), false)
})

test('driveSpan skips agy_tool cut when mirror becomes unavailable mid-span and finishes cleanly with text', async () => {
  const runs = new RunRegistry()
  const rec = runs.create()

  let mirrorLive = true
  const spanPromise = collect(
    driveSpan(
      { runs, isMirrorToolAvailable: () => mirrorLive },
      rec,
      0,
      true,
      false,
      null,
      false,
      false,
      undefined,
      undefined,
      true,
      'sess-1',
    ),
  )

  rec.append({
    kind: 'step',
    stepKey: '1',
    stepKind: 'tool',
    state: 'ACTIVE',
    text: '',
    tool: { name: 'edit_file', args: { Path: '/tmp/a.ts' } },
  })
  // Simulate plugin reload / tools teardown unregistering agy_tool BEFORE the step completes.
  mirrorLive = false
  rec.append({
    kind: 'step',
    stepKey: '1',
    stepKind: 'tool',
    state: 'DONE',
    text: '',
    tool: { name: 'edit_file', args: { Path: '/tmp/a.ts' }, output: 'ok' },
  })
  rec.append({
    kind: 'result',
    conversationId: 'conv-1',
    ok: true,
    response: 'All edits applied.',
    usage: { input_tokens: 10, output_tokens: 5 },
    raw: {},
  })
  rec.settle(null)

  const chunks = await spanPromise
  const toolCalls = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.equal(toolCalls.length, 0, 'must not emit a doomed agy_tool tool-call once mirror is unavailable')
  const finish = chunks.find((c) => c.type === 'finish')
  assert.ok(finish && finish.type === 'finish')
  assert.equal(finish.reason.kind, 'stop')
  const text = chunks
    .filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
    .map((c) => c.text)
    .join('')
  assert.match(text, /All edits applied/)
})

test('driveSpan emits retryable error instead of agy_tool cut when plugin disposes mid-tool without result', async () => {
  const runs = new RunRegistry()
  const rec = runs.create()

  let mirrorLive = true
  const spanPromise = collect(
    driveSpan(
      { runs, isMirrorToolAvailable: () => mirrorLive },
      rec,
      0,
      true,
      false,
      null,
      false,
      false,
      undefined,
      undefined,
      true,
      'sess-dispose',
    ),
  )

  mirrorLive = false
  rec.append({
    kind: 'step',
    stepKey: '2',
    stepKind: 'tool',
    state: 'DONE',
    text: '',
    tool: { name: 'run_command', args: { CommandLine: 'npm test' }, output: 'pass' },
  })
  rec.settle(null)

  const chunks = await spanPromise
  const toolCalls = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.equal(toolCalls.length, 0, 'must not emit agy_tool after mirror went unavailable')
  const finish = chunks.find((c) => c.type === 'finish')
  assert.ok(finish && finish.type === 'finish')
  assert.equal(finish.reason.kind, 'error')
})

test('buildDigest rewrites historical Error: unknown tool "agy_tool" into benign reload note, keeps real errors', () => {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'Fix the tests' }] } as unknown as Message,
    {
      role: 'tool',
      toolCallId: 'agytc-run1-70',
      isError: true,
      content: [{ type: 'text', text: 'Error: unknown tool "agy_tool"' }],
    } as unknown as Message,
    {
      role: 'tool',
      toolCallId: 'agytc-run1-71',
      isError: true,
      content: [{ type: 'text', text: 'Error: unknown tool "real_missing_tool"' }],
    } as unknown as Message,
  ]
  const digest = buildDigest(messages, 0, 8000)
  assert.ok(!digest.includes('unknown tool "agy_tool"'), 'raw agy_tool unknown-tool noise must be scrubbed')
  assert.ok(digest.includes(MIRROR_TOOL_RELOAD_NOTICE), 'benign reload notice should replace false-positive error')
  assert.ok(digest.includes('unknown tool "real_missing_tool"'), 'genuine tool errors must remain intact')
})

test('AgyMirrorToolView renders transient agy_tool UNKNOWN_TOOL as non-error with calm notice', () => {
  const falsePositiveBlock = {
    kind: 'tool-result',
    call: {
      name: 'agy_tool',
      argsRaw: JSON.stringify({
        run: '17cd3196-0aba-420e-b4f2-1ecd6c47f431',
        step: 70,
        tool: 'edit_file',
        input: { Path: '/repo/test/mcp-schema.test.ts', Target: 'a', Replacement: 'b' },
      }),
    },
    content: [{ type: 'text', text: 'Error: unknown tool "agy_tool"' }],
    isError: true,
    error: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' },
  }
  assert.equal(isTransientMirrorToolNotFound(falsePositiveBlock as never), true)

  const createEl = React.createElement as (component: unknown, props: Record<string, unknown>) => unknown
  const html = renderToStaticMarkup(
    createEl(AgyMirrorToolView, {
      callId: 'agytc-17cd3196-70',
      toolName: 'agy_tool',
      block: falsePositiveBlock,
      t: (k: string) => (k === 'tv.mirrorReloadSkipped' ? '已在 agy 中执行完成（插件重载期间跳过回放，非工具报错）' : k),
    }),
  )
  assert.match(html, /data-state="ok"/, 'false-positive agy_tool reload miss must not render red error state')
  assert.ok(!html.includes('agy-tv-summary-err'), 'must not apply error styling to summary')
  assert.ok(!html.includes('unknown tool'), 'raw unknown tool text must not surface on card')

  const realErrorBlock = {
    kind: 'tool-result',
    call: {
      name: 'agy_tool',
      argsRaw: JSON.stringify({
        run: '17cd3196-0aba-420e-b4f2-1ecd6c47f431',
        step: 71,
        tool: 'run_command',
        input: { CommandLine: 'npm test' },
      }),
    },
    content: [{ type: 'text', text: 'agy tool run_command failed: exit code 1' }],
    isError: true,
  }
  assert.equal(isTransientMirrorToolNotFound(realErrorBlock as never), false)
  const errHtml = renderToStaticMarkup(
    createEl(AgyMirrorToolView, {
      callId: 'agytc-17cd3196-71',
      toolName: 'agy_tool',
      block: realErrorBlock,
    }),
  )
  assert.match(errHtml, /data-state="err"/, 'genuine tool failures must remain in error state')
})

test('presentMirrorResult suppresses exitCode=1 and scrubs Error: unknown tool "agy_tool"', () => {
  const term = presentMirrorResult(
    { tool: 'run_command', input: { CommandLine: 'echo hi' } },
    { content: [{ type: 'text', text: 'Error: unknown tool "agy_tool"' }], isError: true },
  )
  assert.ok(term && term.card === 'terminal')
  assert.equal(term.exitCode, undefined, 'false-positive agy_tool miss must not report exitCode=1')
  assert.equal(term.output, MIRROR_TOOL_RELOAD_NOTICE)

  const gen = presentMirrorResult(
    { tool: 'read_file', input: { Path: '/tmp/a.ts' } },
    { content: [{ type: 'text', text: 'Error: unknown tool "agy_tool"' }], isError: true },
  )
  assert.ok(gen && gen.card === 'generic')
  const first = gen.content?.[0] as { text?: string } | undefined
  assert.equal(first?.text, MIRROR_TOOL_RELOAD_NOTICE)
})

test('host plugin checks tools.get(agy_tool, agent) so restricted agent scopes and disposed plugins disable mirroring', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'agy-mirror-live-'))
  const restoreEnv = sandboxEnv(workDir)
  const prevBin = process.env.DSH_AGY_BIN
  const stubBin = join(workDir, 'agy')
  writeFileSync(stubBin, '#!/bin/sh\necho "agy version 1.1.15"\n')
  chmodSync(stubBin, 0o755)
  process.env.DSH_AGY_BIN = stubBin

  type FakeCtx = Context & {
    provide: (key: string, value: unknown) => void
    fiber: { dispose: () => Promise<void> }
  }
  type CapturedAdapter = { deps?: { isMirrorToolAvailable?: (sid?: string) => boolean } }

  const holder: { adapter: CapturedAdapter | null } = { adapter: null }
  const ctx = new Context() as FakeCtx
  const restrictedAgent = { id: 'sess-restricted' }
  const allowedAgent = { id: 'sess-allowed' }
  const registeredTools = new Map<string, unknown>()

  ctx.plugin({
    name: 'fake-host-mirror-live',
    apply(c: Context) {
      const fc = c as FakeCtx
      fc.provide('llm', {
        registerAdapter(_providers: string[], adapter: unknown) {
          holder.adapter = adapter as CapturedAdapter
          return () => undefined
        },
      })
      fc.provide('commands', { register() { return () => undefined } })
      fc.provide('agents', {
        get(id: string) {
          if (id === 'sess-restricted') return restrictedAgent
          if (id === 'sess-allowed') return allowedAgent
          return undefined
        },
      })
    },
  })
  await new Promise((r) => setTimeout(r, 20))

  apply(ctx, {})
  const check = holder.adapter?.deps?.isMirrorToolAvailable
  assert.ok(check, 'adapter must receive isMirrorToolAvailable callback')
  assert.equal(check('sess-allowed'), false, 'false before tools service mounts')

  ctx.plugin({
    name: 'fake-tools-mirror-live',
    apply(c: Context) {
      ;(c as FakeCtx).provide('tools', {
        register(def: { name: string }) {
          registeredTools.set(def.name, def)
          return () => { registeredTools.delete(def.name) }
        },
        get(name: string, scope?: unknown) {
          if (scope === restrictedAgent && name === 'agy_tool') return undefined
          return registeredTools.get(name)
        },
      })
    },
  })
  await new Promise((r) => setTimeout(r, 50))

  assert.equal(check('sess-allowed'), true, 'true when registered and visible')
  assert.equal(check('sess-restricted'), false, 'false when agent scope restricts agy_tool')
  assert.equal(check(undefined), true, 'true globally when registered')

  await ctx.fiber.dispose()
  assert.equal(check('sess-allowed'), false, 'false immediately after disposal')

  restoreEnv()
  if (prevBin === undefined) delete process.env.DSH_AGY_BIN
  else process.env.DSH_AGY_BIN = prevBin
  rmSync(workDir, { recursive: true, force: true })
})
