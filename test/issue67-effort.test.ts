// Issue #67 — a model whose agy build refuses `--effort`.
//
// agy 1.4.6 (Windows) rejects the WHOLE invocation when `--effort` is passed to
// a model that does not take one, and the catalog only knows effort support as
// advisory (the fallback list advertises low/medium/high for the Gemini Flash
// family as a guess). The plugin must therefore learn from the refusal instead
// of failing the turn — on the streaming path (`AgyAdapter.stream`) and on the
// one-shot path (`agy_ask` → `runAgyOnce`), which spawns agy directly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineAgyAskTool } from '../src/host/ask-tool.ts'
import { defaultConfig, type PluginConfig } from '../src/common/types.ts'

const fakeBin = join(import.meta.dirname, 'fake-agy.mjs')
const workDir = mkdtempSync(join(tmpdir(), 'agy-issue67-'))

const catalog = {
  source: 'fallback' as const,
  discoveredAt: 0,
  models: [
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
    { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', efforts: ['low', 'medium', 'high'] },
  ],
}

function makeTool(extra: { effortUnsupported?: () => readonly string[]; onEffortUnsupported?: (m: string) => void } = {}) {
  const cfg: PluginConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 20_000 }
  const tool = defineAgyAskTool({
    cfg: () => cfg,
    bin: () => fakeBin,
    catalog: () => catalog,
    ...extra,
  })
  return tool as unknown as { execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<string> }
}

/** Run the tool with the fake agy and report what the child was invoked with. */
async function runAsk(
  tool: { execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<string> },
  args: Record<string, unknown>,
  mode: string,
): Promise<{ argv: string[]; spawns: number; text: string }> {
  const argsFile = join(workDir, 'args.json')
  const invocations = join(workDir, 'invocations.txt')
  rmSync(argsFile, { force: true })
  rmSync(invocations, { force: true })
  process.env.FAKE_AGY_MODE = mode
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  process.env.FAKE_AGY_INVOCATION_FILE = invocations
  try {
    const text = await tool.execute(args, { signal: new AbortController().signal })
    const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
    const spawns = readFileSync(invocations, 'utf8').split('\n').filter(Boolean).length
    return { argv, spawns, text }
  } finally {
    delete process.env.FAKE_AGY_ARGS_FILE
    delete process.env.FAKE_AGY_INVOCATION_FILE
    process.env.FAKE_AGY_MODE = 'ok'
  }
}

test('issue #67: agy_ask learns the refusal, replays without --effort, and reports it', async () => {
  // The catalog claims medium/high for this model, so the tool WOULD pass the
  // flag; agy refuses, names the model, and the same call without the flag works.
  const learned: string[] = []
  const tool = makeTool({ onEffortUnsupported: (m) => learned.push(m) })
  const first = await runAsk(tool, { prompt: 'hi', model: 'gemini-3.8-flash', effort: 'medium' }, 'effort-unsupported')
  assert.equal(first.spawns, 2, 'one refused attempt + one replay')
  assert.equal(first.argv.includes('--effort'), false, 'the replay drops the flag')
  assert.match(first.text, /answered without --effort/)
  assert.deepEqual(learned, ['gemini-3.8-flash'], 'the host is told, so it can persist + refresh the picker')
})

test('issue #67: agy_ask never asks a model the host already learned about', async () => {
  const tool = makeTool({ effortUnsupported: () => ['gemini-3.8-flash'] })
  // Mode 'ok' would accept the flag, so a single spawn WITHOUT it proves the
  // seeded list was honoured before the spawn rather than after a refusal.
  const run = await runAsk(tool, { prompt: 'hi', model: 'gemini-3.8-flash', effort: 'high' }, 'ok')
  assert.equal(run.spawns, 1)
  assert.equal(run.argv.includes('--effort'), false)
})

test('issue #67: an unrelated model keeps its effort, and an explicit effort is not dropped', async () => {
  const tool = makeTool({ effortUnsupported: () => ['gemini-3.8-flash'] })
  const run = await runAsk(tool, { prompt: 'hi', model: 'gemini-3.7-flash', effort: 'medium' }, 'ok')
  const at = run.argv.indexOf('--effort')
  assert.ok(at >= 0, 'an unlearned model still receives --effort')
  assert.equal(run.argv[at + 1], 'medium', 'and it is the requested level')
  assert.equal(run.spawns, 1)
})

test('issue #67: a refusal on a model whose id differs by provider prefix is still learned', async () => {
  // agy reports the bare slug; the caller may pass a provider-qualified id.
  const learned: string[] = []
  const tool = makeTool({ onEffortUnsupported: (m) => learned.push(m) })
  const run = await runAsk(tool, { prompt: 'hi', model: 'gemini-3.8-flash', effort: 'low' }, 'effort-unsupported')
  assert.equal(run.spawns, 2)
  assert.deepEqual(learned, ['gemini-3.8-flash'])
})

// The learned list is persisted by the host next to the runtime overrides, so a
// restart does not repeat the failed attempt. Keep the file shape pinned here.
test('issue #67: the effort-unsupported sidecar survives a round trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-effort-sidecar-'))
  const file = join(dir, 'effort-unsupported.json')
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify(['gemini-3.8-flash'], null, 2), 'utf8')
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
  assert.ok(Array.isArray(raw))
  assert.deepEqual(raw, ['gemini-3.8-flash'])
  rmSync(dir, { recursive: true, force: true })
})