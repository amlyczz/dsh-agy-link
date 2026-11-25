// Shared fixtures for the adapter behaviour suites (stream / continuation /
// prompt / digest / args / models / rate-limit). One scratch workDir per test
// file process; helpers are exported so no suite duplicates the wiring.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AgyAdapter, type AgyAdapterDeps } from '../../src/host/adapter.ts'
import { ModelCatalog } from '../../src/host/models.ts'
import { SessionStore } from '../../src/host/sessions.ts'
import { RunRegistry } from '../../src/host/recording.ts'
import { defineAgyMirrorTool, parseMirrorInvocation } from '../../src/host/mirror-tool.ts'
import { defaultConfig, type PluginConfig } from '../../src/common/types.ts'

import { FAKE_AGY } from './paths.ts'

/** Scratch dir for every session store, argv capture and pool file. */
export const workDir = mkdtempSync(join(tmpdir(), 'agy-adapter-'))
process.env.DSH_AGY_CONVERSATIONS_DIR = join(workDir, 'convs')

const fakeBin = FAKE_AGY

test.after(() => {
  rmSync(workDir, { recursive: true, force: true })
})

export function msg(role: 'user' | 'assistant' | 'system', text: string): Message {
  return { role, content: [{ type: 'text', text }] } as unknown as Message
}

export function makeAdapter(cfgOverrides: Partial<PluginConfig> = {}, deps: Partial<AgyAdapterDeps> = {}) {
  const cfg: PluginConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 20_000, ...cfgOverrides }
  const store = new SessionStore(join(workDir, 'sessions.json'))
  const catalog = new ModelCatalog(
    async () => { throw new Error('no discovery in tests') },
    cfg.fallbackModels,
    300_000,
  )
  const argsFile = join(workDir, 'args.json')
  const runs = new RunRegistry()
  const adapter = new AgyAdapter({
    getConfig: () => cfg,
    catalog,
    store,
    bin: () => fakeBin,
    acquire: () => Promise.resolve(() => {}),
    runs,
    ...deps,
  })
  return { adapter, store, argsFile, runs }
}

export function opts(messages: Message[], extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'antigravity',
    model: 'gemini-3.8-flash',
    messages,
    ...extra,
  } as GenerateOptions
}

export async function collect(gen: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const ch of gen) out.push(ch)
  return out
}

export async function waitFor<T>(f: () => T | undefined, ms = 3_000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = f()
    if (v !== undefined) return v
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

export type MirrorArgs = { run: string; step: number; tool: string; input?: unknown }

/**
 * Drive one full agy turn the way DSH's agent loop would: collect a span,
 * and whenever it finishes with tool-calls, append the assistant tool-call
 * message plus the mirrored tool-result message and call stream() again.
 *
 * `toolResultSchema` selects how DSH stores the tool result:
 *  - `'user'` (default, dsh-llm 0.1.x): `role: 'user'` + `source.callId`
 *  - `'tool'` (dsh-llm 0.1.7+): `role: 'tool'` + `message.toolCallId`
 */
export async function runTurn(
  adapter: AgyAdapter,
  base: Message[],
  extra: Partial<GenerateOptions> = {},
  maxHops = 12,
  trailingPluginSnapshots = false,
  replayRuns?: RunRegistry,
  toolResultSchema: 'user' | 'tool' = 'user',
): Promise<{ chunks: StreamChunk[]; toolCalls: Array<{ id: string; args: MirrorArgs }>; messages: Message[] }> {
  const messages = [...base]
  const all: StreamChunk[] = []
  const toolCalls: Array<{ id: string; args: MirrorArgs }> = []
  for (let hop = 0; hop < maxHops; hop++) {
    // Pass a copy: the adapter's outcome handler captures the array it was
    // given, and the watermark it records must reflect this hop's view.
    const chunks = await collect(adapter.stream(opts([...messages], extra)))
    all.push(...chunks)
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } } | undefined
    if (finish === undefined || finish.type !== 'finish') throw new Error('span ended without a finish chunk')
    if (finish.reason.kind !== 'tool-calls') return { chunks: all, toolCalls, messages }
    const end = chunks.find(
      (c) => c.type === 'block-end' && (c as { block: { type: string } }).block.type === 'tool-call',
    ) as unknown as { block: { id: string; name: string; arguments: string } } | undefined
    if (end === undefined) throw new Error('tool-calls finish without a tool-call block')
    let args: MirrorArgs
    if (end.block.name === 'run_code') {
      const wrapper = JSON.parse(end.block.arguments) as { code: string; description: string }
      const inv = parseMirrorInvocation(wrapper.code)
      if (inv === null) throw new Error('run_code wrapper lacks the agy_tool invocation')
      args = { run: inv.run, step: inv.step, tool: '' } as unknown as MirrorArgs
    } else if (end.block.name === 'agy_tool') {
      const parsed = JSON.parse(end.block.arguments) as { run: string; step: number; tool?: string }
      args = { run: parsed.run, step: parsed.step, tool: parsed.tool ?? '' } as unknown as MirrorArgs
    } else {
      throw new Error('tool-call block must address run_code or agy_tool, got ' + end.block.name)
    }
    toolCalls.push({ id: end.block.id, args })
    messages.push({ role: 'assistant', content: [end.block] } as unknown as Message)
    let output = 'replayed'
    let isError = false
    if (replayRuns) {
      try {
        output = String(await defineAgyMirrorTool({ runs: replayRuns }).execute(args as never, { signal: new AbortController().signal } as never))
      } catch (error) {
        isError = true
        output = String(error)
      }
    }
    if (toolResultSchema === 'tool') {
      messages.push({
        role: 'tool',
        toolCallId: end.block.id,
        content: [{ type: 'text', text: output }],
        source: { kind: 'tool', callId: end.block.id },
      } as unknown as Message)
    } else {
      messages.push({
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: end.block.id, content: [{ type: 'text', text: output }], isError }],
        source: { kind: 'tool', callId: end.block.id },
      } as unknown as Message)
    }
    if (trailingPluginSnapshots) {
      messages.push({ role: 'user', content: [], source: { kind: 'plugin', plugin: 'runtime-context', form: 'snapshot', sections: [] } } as unknown as Message)
    }
  }
  throw new Error('runTurn exceeded the hop budget')
}

export function imgMsg(id: string, text = 'shot'): Message {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image', attachmentId: id, mediaType: 'image/png', bytes: 10, width: 1, height: 1 },
    ],
  } as unknown as Message
}

export function toolResultMsg(opts: {
  role?: string
  callId?: string
  toolCallIdOnMessage?: string
  nestedText?: string
  sourceKind?: string
}): Message {
  const m: Record<string, unknown> = {
    role: opts.role ?? 'user',
    content: opts.nestedText !== undefined
      ? [{ type: 'tool-result', toolCallId: opts.callId ?? 'agytc-run-1-7', content: [{ type: 'text', text: opts.nestedText }] }]
      : [{ type: 'tool-result', toolCallId: opts.callId ?? 'agytc-run-1-7', content: [] }],
  }
  if (opts.toolCallIdOnMessage !== undefined) m.toolCallId = opts.toolCallIdOnMessage
  if (opts.callId !== undefined || opts.sourceKind !== undefined) {
    m.source = { kind: opts.sourceKind ?? 'tool', callId: opts.callId ?? 'agytc-run-1-7' }
  }
  return m as unknown as Message
}

export function msgSrc(role: 'user' | 'assistant', text: string, provider?: string, replayState?: unknown): Message {
  const m: Record<string, unknown> = { role, content: [{ type: 'text', text }] }
  if (provider !== undefined) m.source = { provider, ...(replayState !== undefined ? { replayState } : {}) }
  return m as unknown as Message
}
