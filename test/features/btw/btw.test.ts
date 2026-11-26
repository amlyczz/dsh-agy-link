import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CommandRuntime, parseCommand, type CommandInvocation } from '@deepseek-ai/dsh-commands'
import { resolveConfig } from '../../../src/common/config.ts'
import { defaultConfig, type AgyEvent } from '../../../src/common/types.ts'
import { BtwService, buildBtwAgySettings } from '../../../src/features/btw/service.ts'
import { btwCommandDefinition, parseBtwArgs } from '../../../src/host/btw-command.ts'
import { registerRoutes } from '../../../src/transport/http/router.ts'
import type { HostServices } from '../../../src/host/services.ts'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('BtwService streams text and tool steps, isolates from main session, and reuses side conversationId on follow-up', async () => {
  const calls: Array<{
    prompt: string
    mode?: string
    disableSlashCommands?: boolean
    agySettings?: string
    cwd?: string
    model?: string
    effort?: string
    conversationId?: string
    signal?: AbortSignal
    onEvent?: (ev: AgyEvent) => void
    onAttemptStart?: () => void
  }> = []
  let nextResult = createDeferred<{ ok: boolean; text: string; conversationId: string | null; accountId?: string; error?: string; durationMs: number }>()

  const service = new BtwService({
    cfg: () => ({ ...defaultConfig(), defaultModel: 'gemini-3.8-flash' }),
    catalog: () => ({ get: () => ({ source: 'discovered', models: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium'] }], updatedAt: 0, lastError: null }) }),
    resolveContext: (sid) => ({
      workspaceRoot: `/ws/${sid}`,
      historyText: 'User: Check adapter\n\nAssistant: Working on it',
      liveProgress: 'Recent in-flight steps:\n- read_file(src/index.ts) [RUNNING]',
    }),
    runOnce: async (req) => {
      calls.push(req)
      req.onAttemptStart?.()
      return nextResult.promise
    },
    now: () => 1000,
  })

  const snapshots: Array<{ open: boolean; answer: string; tools: number; status: string }> = []
  const unsub = service.subscribe('sess-1', (view) => {
    const cur = view.entries[view.activeIndex]
    snapshots.push({
      open: view.open,
      answer: cur?.answer ?? '',
      tools: cur?.tools.length ?? 0,
      status: cur?.status ?? 'none',
    })
  })

  const { promise } = service.start({ sessionId: 'sess-1', question: 'What is adapter doing?' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.mode, 'default')
  assert.equal(calls[0]?.disableSlashCommands, true)
  const settingsObj = JSON.parse(calls[0]?.agySettings ?? '{}') as { permissions?: { allow?: string[]; deny?: string[] } }
  assert.ok(settingsObj.permissions?.allow?.includes('read_file(*)'))
  assert.ok(settingsObj.permissions?.deny?.includes('run_command(*)'))
  assert.ok(settingsObj.permissions?.deny?.includes('write_file(*)'))
  assert.equal(calls[0]?.cwd, '/ws/sess-1')
  assert.equal(calls[0]?.conversationId, undefined)
  assert.match(calls[0]?.prompt ?? '', /Check adapter/)
  assert.match(calls[0]?.prompt ?? '', /read_file\(src\/index\.ts\)/)
  assert.match(calls[0]?.prompt ?? '', /What is adapter doing\?/)

  const onEvent = calls[0]!.onEvent!
  onEvent({ kind: 'init', conversationId: 'btw-conv-1', raw: {} })
  onEvent({ kind: 'step', stepKind: 'tool', stepKey: 't1', text: '', tool: { name: 'read_file', args: { Path: 'src/host/adapter.ts' } }, state: 'RUNNING' })
  onEvent({ kind: 'step', stepKind: 'tool', stepKey: 't1', text: '', tool: { name: 'read_file', args: { Path: 'src/host/adapter.ts' }, output: 'ok' }, state: 'DONE' })
  onEvent({ kind: 'step', stepKind: 'text', stepKey: 's1', text: 'It is ', fragment: true })
  onEvent({ kind: 'step', stepKind: 'text', stepKey: 's1', text: 'mapping spans.', fragment: true })

  const midView = service.view('sess-1')
  assert.equal(midView.open, true)
  assert.equal(midView.entries[0]?.answer, 'It is mapping spans.')
  assert.equal(midView.entries[0]?.tools.length, 1)
  assert.equal(midView.entries[0]?.tools[0]?.name, 'read_file')
  assert.equal(midView.entries[0]?.tools[0]?.target, 'src/host/adapter.ts')
  assert.equal(midView.entries[0]?.tools[0]?.state, 'done')
  assert.equal(midView.entries[0]?.status, 'running')

  nextResult.resolve({ ok: true, text: 'It is mapping spans.', conversationId: 'btw-conv-1', accountId: 'acc-a', durationMs: 420 })
  const entry1 = await promise
  assert.equal(entry1.status, 'done')
  assert.equal(entry1.conversationId, 'btw-conv-1')
  assert.equal(entry1.accountId, 'acc-a')
  assert.ok(snapshots.some((s) => s.answer === 'It is ' && s.status === 'running'))

  // Follow-up reuses btw-conv-1
  nextResult = createDeferred()
  const follow = service.start({ sessionId: 'sess-1', question: 'And which file handles retries?', followUp: true })
  assert.equal(calls[1]?.conversationId, 'btw-conv-1')
  nextResult.resolve({ ok: true, text: 'src/provider/retry-policy.ts', conversationId: 'btw-conv-1', durationMs: 180 })
  const entry2 = await follow.promise
  assert.equal(entry2.status, 'done')
  assert.equal(service.view('sess-1').entries.length, 2)
  assert.equal(service.view('sess-1').activeIndex, 1)

  // New thread drops conversationId
  nextResult = createDeferred()
  const fresh = service.start({ sessionId: 'sess-1', question: 'Unrelated question', newThread: true })
  assert.equal(calls[2]?.conversationId, undefined)
  nextResult.resolve({ ok: true, text: 'Fresh answer', conversationId: 'btw-conv-2', durationMs: 90 })
  await fresh.promise
  assert.equal(service.view('sess-1').entries.length, 3)

  // Navigate & dismiss
  const nav = service.dismiss('sess-1', true, 0)
  assert.equal(nav.activeIndex, 0)
  const closed = service.dismiss('sess-1', false)
  assert.equal(closed.open, false)
  assert.equal(closed.entries.length, 3)

  unsub()
  service.dispose()
})

test('BtwService supports cancellation and resets partial stream on account failover retry', async () => {
  let attempt = 0
  let capturedSignal: AbortSignal | undefined
  const blocked = createDeferred<{ ok: boolean; text: string; conversationId: string | null; error?: string; durationMs: number }>()

  const service = new BtwService({
    cfg: () => defaultConfig(),
    catalog: () => undefined,
    resolveContext: () => ({ workspaceRoot: '/tmp', historyText: '', liveProgress: '' }),
    runOnce: async (req) => {
      attempt++
      if (attempt === 1) {
        req.onAttemptStart?.()
        req.onEvent?.({ kind: 'step', stepKind: 'text', stepKey: 's1', text: 'stale partial', fragment: true })
        req.onAttemptStart?.()
        req.onEvent?.({ kind: 'step', stepKind: 'text', stepKey: 's2', text: 'clean answer', fragment: true })
        return { ok: true, text: 'clean answer', conversationId: 'c2', durationMs: 50 }
      }
      capturedSignal = req.signal
      req.onAttemptStart?.()
      return blocked.promise
    },
  })

  const res1 = await service.ask({ sessionId: 's-retry', question: 'retry test' })
  assert.equal(res1.answer, 'clean answer')

  const { promise } = service.start({ sessionId: 's-cancel', question: 'long task' })
  assert.equal(capturedSignal?.aborted, false)
  assert.equal(service.cancel('s-cancel'), true)
  assert.equal(capturedSignal?.aborted, true)
  blocked.resolve({ ok: false, text: '', conversationId: null, error: 'aborted', durationMs: 10 })
  const res2 = await promise
  assert.equal(res2.status, 'aborted')
})

test('parseBtwArgs and top-level /btw command handle GUI non-blocking mode, --wait sync mode, copy, and clear', async () => {
  const parsed = parseBtwArgs('  --model gemini-4-hydrogen --effort medium --new why is it slow? ')
  assert.equal(parsed.model, 'gemini-4-hydrogen')
  assert.equal(parsed.effort, 'medium')
  assert.equal(parsed.newThread, true)
  assert.equal(parsed.question, 'why is it slow?')

  assert.equal(parseBtwArgs('copy').action, 'copy')
  assert.equal(parseBtwArgs('clear').action, 'clear')
  assert.equal(parseBtwArgs('--help').action, 'help')

  let webActive = true
  const defer = createDeferred<{ ok: boolean; text: string; conversationId: string | null; durationMs: number }>()
  const btw = new BtwService({
    cfg: () => defaultConfig(),
    catalog: () => undefined,
    resolveContext: () => ({ workspaceRoot: '/tmp', historyText: '', liveProgress: '' }),
    runOnce: async () => defer.promise,
  })

  const def = btwCommandDefinition({
    btw: () => btw,
    isWebActive: () => webActive,
  })
  assert.equal(def.name, 'atw')
  assert.match(def.description, /\/atw/)
  assert.ok(def.input?.hint && def.input.hint.trim().length > 0)

  const helpRes = await def.handler({
    commandId: 'cmd-help' as CommandInvocation['commandId'],
    rawInput: ' help',
    attachments: [],
    signal: new AbortController().signal,
    agent: { id: 'sess-cmd', session: {} },
  } as unknown as CommandInvocation)
  assert.equal(helpRes.kind, 'success')
  assert.match(helpRes.text ?? '', /\/atw/)
  assert.doesNotMatch(helpRes.text ?? '', /\/btw\b/)

  const inv = (rawInput: string): CommandInvocation => ({
    commandId: 'cmd-1' as CommandInvocation['commandId'],
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
    agent: { id: 'sess-cmd', session: {} },
  } as unknown as CommandInvocation)

  // GUI non-blocking: returns immediately while defer is still pending!
  const nonBlocking = await def.handler(inv(' what is this?'))
  assert.equal(nonBlocking.kind, 'success')
  assert.equal(btw.view('sess-cmd').open, true)
  assert.equal(btw.view('sess-cmd').entries[0]?.status, 'running')

  defer.resolve({ ok: true, text: 'Resolved asynchronously', conversationId: 'c-btw', durationMs: 30 })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(btw.view('sess-cmd').entries[0]?.answer, 'Resolved asynchronously')

  // /btw copy returns latest answer
  const copied = await def.handler(inv(' copy'))
  assert.equal(copied.kind, 'success')
  assert.match(copied.text ?? '', /Resolved asynchronously/)

  // /btw --wait blocks until settled and returns full answer
  const syncDefer = createDeferred<{ ok: boolean; text: string; conversationId: string | null; durationMs: number }>()
  const syncBtw = new BtwService({
    cfg: () => defaultConfig(),
    catalog: () => undefined,
    resolveContext: () => ({ workspaceRoot: '/tmp', historyText: '', liveProgress: '' }),
    runOnce: async () => syncDefer.promise,
  })
  const syncDef = btwCommandDefinition({ btw: () => syncBtw, isWebActive: () => webActive })
  const waitPromise = syncDef.handler(inv(' --wait explain X'))
  syncDefer.resolve({ ok: true, text: 'Sync explanation', conversationId: 'c-sync', durationMs: 20 })
  const syncRes = await waitPromise
  assert.equal(syncRes.kind, 'success')
  assert.match(syncRes.text ?? '', /Sync explanation/)

  // Headless (webActive = false) also waits automatically
  webActive = false
  const headlessRes = await syncDef.handler(inv(' headless question'))
  assert.equal(headlessRes.kind, 'success')
  assert.match(headlessRes.text ?? '', /Sync explanation/)

  // Clear
  const cleared = await def.handler(inv(' clear'))
  assert.equal(cleared.kind, 'success')
  assert.match(cleared.text ?? '', /\/atw/)
  assert.equal(btw.view('sess-cmd').entries.length, 0)

  // Empty usage in headless mode cites /atw
  const usageRes = await def.handler(inv(''))
  assert.equal(usageRes.kind, 'error')
  assert.match(usageRes.text, /\/atw/)

  // Real DSH CommandRuntime exposes /atw descriptor (description + input.hint) for slash menu
  // and coexists cleanly with a community /btw command in the same scope.
  const ctx = new Context()
  const runtime = new CommandRuntime(ctx)
  const disposeBtw = runtime.register({ name: 'btw', description: 'community btw', input: { hint: 'question' }, handler: async () => ({ kind: 'success' }) })
  const disposeAtw = runtime.register(def)
  const descriptors = runtime.list({ id: 'sess-cmd', session: {} } as unknown as CommandInvocation['agent'])
  const atwDesc = descriptors.find((d) => d.name === 'atw')
  assert.ok(atwDesc)
  assert.equal(atwDesc.description, def.description)
  assert.deepEqual(atwDesc.input, def.input)
  assert.deepEqual(parseCommand('/atw why?'), { name: 'atw', rawInput: ' why?' })
  disposeAtw()
  disposeBtw()
})

test('HTTP /plugins/agy-link/btw/* routes validate inputs, control lifecycle, and push SSE updates', async () => {
  const routes = new Map<string, (req: unknown, res: unknown) => void>()
  const btw = new BtwService({
    cfg: () => defaultConfig(),
    catalog: () => undefined,
    resolveContext: () => ({ workspaceRoot: '/tmp', historyText: '', liveProgress: '' }),
    runOnce: async (req) => {
      req.onAttemptStart?.()
      req.onEvent?.({ kind: 'step', stepKind: 'text', stepKey: 's1', text: 'Hello SSE', fragment: true })
      return { ok: true, text: 'Hello SSE', conversationId: 'c-http', durationMs: 12 }
    },
  })

  const fakeServices = {
    btw,
    getConfig: () => defaultConfig(),
    bin: () => null,
    version: () => null,
    status: { dormantReason: null, version: null },
    auth: { snapshot: () => ({}) },
    pool: { getPoolData: () => ({ accounts: [] }), getAccounts: () => [], getActiveAccountId: () => null },
    quota: { refreshingAccounts: () => [] },
    warmup: { snapshot: () => null },
    poolAuth: { snapshot: () => ({}) },
    catalog: { get: () => ({ source: 'fallback', models: [], updatedAt: 0, lastError: null }) },
    store: { count: () => 0 },
    acpPool: { status: () => ({ activeProcesses: 0, sessions: 0, keys: [] }) },
    backgroundWakeup: { status: () => ({ enabled: false }) },
    lastRun: null,
    ecosystem: { list: async () => ({}) },
    translation: { pendingFor: () => [], stats: () => ({}) },
    adapter: {},
    setOverride: () => {},
    notifyPicker: () => {},
    mediaDir: () => '/tmp',
    hostDir: '/tmp',
    sessionsSvc: () => undefined,
  } as unknown as HostServices

  registerRoutes({ register: (r) => { routes.set(r.path, r.handler); return () => {} } }, fakeServices)

  const invoke = (path: string, method: string, body?: Record<string, unknown>) => new Promise<{ status: number; json: any }>((resolve) => {
    const req = Object.assign(new EventEmitter(), { method, url: path, headers: {} })
    const res = {
      status: 200,
      writeHead(s: number) { this.status = s },
      end(raw?: string) { resolve({ status: this.status, json: raw ? JSON.parse(raw) : null }) },
    }
    routes.get(path.split('?')[0]!)!(req, res)
    if (body !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(body)))
    }
    req.emit('end')
  })

  const badState = await invoke('/plugins/agy-link/btw/state', 'GET')
  assert.equal(badState.status, 400)

  const badAsk = await invoke('/plugins/agy-link/btw/ask', 'POST', { sessionId: 's1', question: '   ' })
  assert.equal(badAsk.status, 400)

  const askRes = await invoke('/plugins/agy-link/btw/ask', 'POST', { sessionId: 's1', question: 'Hi' })
  assert.equal(askRes.status, 200)
  assert.equal(askRes.json.ok, true)
  await new Promise((r) => setTimeout(r, 10))

  const stateRes = await invoke('/plugins/agy-link/btw/state?session=s1', 'GET')
  assert.equal(stateRes.status, 200)
  assert.equal(stateRes.json.state.entries[0].answer, 'Hello SSE')

  // SSE stream pushes initial state event and cleans up on close
  const sseReq = Object.assign(new EventEmitter(), { method: 'GET', url: '/plugins/agy-link/btw/stream?session=s1', headers: {} })
  const chunks: string[] = []
  let sseStatus = 0
  const sseRes = Object.assign(new EventEmitter(), {
    writeHead(s: number) { sseStatus = s },
    write(chunk: string) { chunks.push(chunk); return true },
    end() {},
  })
  routes.get('/plugins/agy-link/btw/stream')!(sseReq, sseRes)
  assert.equal(sseStatus, 200)
  assert.match(chunks.join(''), /event: state/)
  assert.match(chunks.join(''), /Hello SSE/)
  sseReq.emit('close')

  const dismissRes = await invoke('/plugins/agy-link/btw/dismiss', 'POST', { sessionId: 's1', open: false })
  assert.equal(dismissRes.json.state.open, false)

  const clearRes = await invoke('/plugins/agy-link/btw/clear', 'POST', { sessionId: 's1' })
  assert.equal(clearRes.json.state.entries.length, 0)
})

test('BtwService honors btwModel / btwEffort config and DSH_AGY_BTW_* env vars, while --model/--effort override', async () => {
  const envCfg = resolveConfig(
    {},
    { DSH_AGY_BTW_MODEL: 'claude-sonnet-5-5', DSH_AGY_BTW_EFFORT: 'medium' },
    {},
  )
  assert.equal(envCfg.btwModel, 'claude-sonnet-5-5')
  assert.equal(envCfg.btwEffort, 'medium')

  const calls: Array<{ model?: string; effort?: string }> = []
  let activeCfg = { ...defaultConfig(), defaultModel: 'gemini-3.8-flash', btwModel: 'gemini-4-hydrogen', btwEffort: 'medium' }
  const svc = new BtwService({
    cfg: () => activeCfg,
    catalog: () => undefined,
    resolveContext: () => ({ workspaceRoot: '/tmp', historyText: '', liveProgress: '' }),
    runOnce: async (req) => {
      calls.push({ model: req.model, effort: req.effort })
      return { ok: true, text: 'ok', conversationId: 'c1', durationMs: 5 }
    },
  })

  await svc.ask({ sessionId: 's-cfg', question: 'use console config' })
  assert.deepEqual(calls[0], { model: 'gemini-4-hydrogen', effort: 'medium' })

  await svc.ask({ sessionId: 's-cfg', question: 'override', model: 'claude-sonnet-5-5', effort: 'high' })
  assert.deepEqual(calls[1], { model: 'claude-sonnet-5-5', effort: 'high' })

  activeCfg = { ...defaultConfig(), defaultModel: 'gemini-3.8-flash', btwModel: '', btwEffort: 'low' }
  await svc.ask({ sessionId: 's-cfg', question: 'fallback to defaultModel' })
  assert.deepEqual(calls[2], { model: 'gemini-3.8-flash', effort: 'low' })

  // When btwModel and defaultModel are unset, prefer Gemini 4 Hydrogen with medium effort
  const autoSvc = new BtwService({
    cfg: () => defaultConfig(),
    catalog: () => ({
      get: () => ({
        source: 'discovered',
        models: [
          { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
          { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', efforts: ['low', 'medium', 'high', 'xhigh'] },
        ],
        updatedAt: 0,
        lastError: null,
      }),
    }),
    resolveContext: () => ({ workspaceRoot: '/tmp', historyText: '', liveProgress: '' }),
    runOnce: async (req) => {
      calls.push({ model: req.model, effort: req.effort })
      return { ok: true, text: 'ok', conversationId: 'c1', durationMs: 5 }
    },
  })
  await autoSvc.ask({ sessionId: 's-auto', question: 'auto model pick' })
  assert.deepEqual(calls[3], { model: 'gemini-4-hydrogen', effort: 'medium' })
})

test('buildBtwAgySettings preserves safe keys and enforces read-only permissions even when baseSettings allows writes', () => {
  const merged = JSON.parse(buildBtwAgySettings(JSON.stringify({
    customKey: 42,
    permissions: {
      allow: ['run_command(*)', 'custom_read(*)'],
      deny: ['custom_deny(*)'],
    },
  }))) as { customKey?: number; permissions: { allow: string[]; deny: string[] } }
  assert.equal(merged.customKey, 42)
  assert.ok(merged.permissions.allow.includes('read_file(*)'))
  assert.ok(merged.permissions.allow.includes('custom_read(*)'))
  assert.ok(!merged.permissions.allow.includes('run_command(*)'))
  assert.ok(merged.permissions.deny.includes('run_command(*)'))
  assert.ok(merged.permissions.deny.includes('write_file(*)'))
  assert.ok(merged.permissions.deny.includes('custom_deny(*)'))
})
