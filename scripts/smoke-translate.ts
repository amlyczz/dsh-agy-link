// Live smoke check for the /tsl translation route (not part of `pnpm test`).
//
//   node --experimental-transform-types scripts/smoke-translate.ts
//
// Drives the real AgyAdapter with `purpose:'translation'` against the real agy
// binary and the real account pool, proving the model/effort/mode wiring and
// the plain-language prompt end to end. Spends a few tokens; run manually.
import { AgyAdapter } from '../src/host/adapter.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { AccountPoolManager } from '../src/host/pool.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { RunRegistry } from '../src/host/recording.ts'
import { buildTranslationPrompt } from '../src/host/translate.ts'
import { defaultConfig } from '../src/common/types.ts'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const cfg = { ...defaultConfig(), permissionMode: 'plan' as const, timeoutMs: 120_000 }
const pool = new AccountPoolManager()
const adapter = new AgyAdapter({
  getConfig: () => cfg,
  catalog: new ModelCatalog(async () => { throw new Error('discovery disabled in smoke') }, cfg.fallbackModels, 300_000),
  store: new SessionStore(join(tmpdir(), 'agy-tsl-smoke-sessions.json')),
  pool,
  bin: () => 'agy',
  acquire: () => Promise.resolve(() => {}),
  runs: new RunRegistry(),
  log: (m: string) => console.error('[agy]', m),
})

const source = process.argv[2] ?? '构建完成，退出码 0。\n\n- dist/index.js — 1.4M\n- 工作区干净，dist/ 为 .gitignore 产物，无待提交变更。'
const prompt = buildTranslationPrompt(source, '中文（简体）', 8000)

const options = {
  provider: 'antigravity',
  model: 'gemini-3.8-flash',
  reasoningEffort: 'high',
  messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })],
  maxTokens: 4096,
  purpose: 'translation',
  signal: AbortSignal.timeout(120_000),
} as unknown as GenerateOptions

let text = ''
const startedAt = Date.now()
for await (const chunk of adapter.stream(options) as AsyncIterable<StreamChunk>) {
  if (chunk.type === 'text-delta') text += chunk.text
  if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') {
    console.error('[finish]', JSON.stringify(chunk.reason))
  }
}
const ms = Date.now() - startedAt
console.log('--- translation (' + ms + 'ms) ---')
console.log(text.trim() === '' ? '(empty)' : text.trim())
process.exit(text.trim() === '' ? 1 : 0)
