// Issue #94 — agy_ask (`runAgyOnce`) spawned agy without `env`, so a GUI host
// with no shell proxy variables gave the child no proxy at all while chat and
// /tsl worked. The child must receive the configured (or detected) proxy.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineAgyAskTool } from '../src/host/ask-tool.ts'
import { defaultConfig, type PluginConfig } from '../src/common/types.ts'

const fakeBin = join(import.meta.dirname, 'fake-agy.mjs')

function makeTool(cfg: Partial<PluginConfig>) {
  const full: PluginConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 20_000, ...cfg }
  const tool = defineAgyAskTool({
    cfg: () => full,
    bin: () => fakeBin,
    catalog: () => ({
      source: 'fallback' as const,
      discoveredAt: 0,
      models: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] }],
    }),
  })
  return tool as unknown as { execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<string> }
}

test('agy_ask forwards the configured proxy into the child environment (issue #94)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-oneshot-proxy-'))
  const envFile = join(dir, 'env.json')
  process.env.FAKE_AGY_MODE = 'ok'
  process.env.FAKE_AGY_ENV_FILE = envFile
  try {
    const tool = makeTool({ proxyUrl: 'http://127.0.0.1:19999' })
    await tool.execute({ prompt: 'Reply with OK' }, { signal: new AbortController().signal })
    const env = JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string | undefined>
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:19999', 'the configured proxy reaches agy')
    assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:19999')
    assert.equal(env.ALL_PROXY, 'http://127.0.0.1:19999')
    assert.equal(env.https_proxy, 'http://127.0.0.1:19999', 'lowercase variants too (Go binaries check both)')
  } finally {
    delete process.env.FAKE_AGY_ENV_FILE
    process.env.FAKE_AGY_MODE = 'ok'
    rmSync(dir, { recursive: true, force: true })
  }
})
