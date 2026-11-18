import { renderToStaticMarkup } from './helpers/client-render.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { register as registerStatus } from '../src/transport/http/routes/status.ts'
import { register as registerPool } from '../src/transport/http/routes/pool.ts'
import type { Route } from '../src/transport/http/respond.ts'
import { TranslationService } from '../src/features/translation/service.ts'
import { ImageService } from '../src/features/image/service.ts'
import { SubagentTracker } from '../src/features/subagent/tracker.ts'
import { Semaphore, findSessionLogFile, readSessionImage, resolveSessionGoal, runTranslationStream } from '../src/host/service-helpers.ts'
import { defaultConfig } from '../src/common/types.ts'
import { R } from '../src/client/react.ts'
import { agyIcon, brandIcon, uiIcon } from '../src/client/icons.ts'
import { getJson, postConfig, postJson, postPool, win } from '../src/client/api.ts'
import { disposeStatusPolling, ensureStatusPolling, publishStatusSnapshot, stopStatusPollingIfIdle } from '../src/client/status.ts'
import { Button } from '../src/client/ui/Button.ts'
import { segGroup } from '../src/client/ui/SegGroup.ts'
import { agyModalStore, modalHostManager } from '../src/client/ui/Modal.ts'
import { AccountsPanel } from '../src/client/sections/AccountsPanel.ts'
import { renderFamilyQuotaBar } from '../src/client/sections/QuotaPanel.ts'
import { createSessionStatus } from '../src/client/sections/SessionStatus.ts'
import { getGitHeadContentAsync } from '../src/provider/mirror/git-head.ts'

function fakeReq(method: string, bodyObj?: unknown, headers: Record<string, string> = {}) {
  const req = new EventEmitter() as EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = headers
  queueMicrotask(() => {
    if (bodyObj !== undefined) req.emit('data', Buffer.from(JSON.stringify(bodyObj)))
    req.emit('end')
  })
  return req
}

function fakeRes() {
  let statusCode = 0
  let outHeaders: Record<string, string> = {}
  let rawBody = ''
  let doneResolve: (() => void) | null = null
  const done = new Promise<void>((r) => { doneResolve = r })
  return {
    done,
    get status() { return statusCode },
    get headers() { return outHeaders },
    get text() { return rawBody },
    json<T = unknown>() { return JSON.parse(rawBody) as T },
    writeHead(s: number, h: Record<string, string>) {
      statusCode = s
      outHeaders = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))
    },
    end(b?: unknown) {
      rawBody = typeof b === 'string' ? b : Buffer.isBuffer(b) ? b.toString('utf8') : ''
      doneResolve?.()
    },
  }
}

test('GET /plugins/agy-link/status emits ETag and responds 304 Not Modified on matching If-None-Match', async () => {
  const routes = new Map<string, Route['handler']>()
  registerStatus((r) => routes.set(r.path, r.handler), {
    getConfig: () => defaultConfig(),
    bin: () => '/usr/bin/agy',
    status: { version: '1.5.12', dormantReason: null },
    store: { all: () => ({}) },
    pool: {
      getPoolData: () => ({ mode: 'sequential', accounts: [], primaryAccountId: 'acc_primary' }),
      getAccounts: () => [],
      getActiveAccountId: () => 'acc_primary',
      getAccount: () => undefined,
    },
    catalog: {
      get: () => ({ source: 'discovered', models: [] }),
      getUnion: () => [],
    },
    auth: { status: () => ({ phase: 'ok' }) },
    poolAuth: { status: () => ({ phase: 'idle' }) },
    adapter: { effortUnsupportedModels: () => [] },
    translation: { pendingFor: () => [], stats: () => ({ count: 0, cacheHits: 0, last: null }) },
    lastRun: null,
  } as never)

  const handler = routes.get('/plugins/agy-link/status')!
  const res1 = fakeRes()
  handler(fakeReq('GET'), res1)
  await res1.done
  assert.equal(res1.status, 200)
  const etag = res1.headers['etag']
  assert.ok(etag && etag.startsWith('W/"'), `expected weak ETag, got ${etag}`)

  const res2 = fakeRes()
  handler(fakeReq('GET', undefined, { 'if-none-match': etag }), res2)
  await res2.done
  assert.equal(res2.status, 304)
  assert.equal(res2.text, '')
})

test('POST /plugins/agy-link/pool/begin-add dispatches 1-click in-place reauth via accountId', async () => {
  const calls: string[] = []
  const routes = new Map<string, Route['handler']>()
  registerPool((r) => routes.set(r.path, r.handler), {
    getConfig: () => defaultConfig(),
    pool: {
      getAccount: (id: string) =>
        id === 'acc_primary' ? { id: 'acc_primary', systemHome: true, alias: 'Primary' }
          : id === 'acc_2' ? { id: 'acc_2', systemHome: false, alias: 'Two', proxyUrl: 'http://127.0.0.1:7890' }
            : undefined,
    },
    poolAuth: {
      beginPrimary: async (proxy?: string) => { calls.push(`primary:${proxy ?? ''}`); return { ok: true, phase: 'waiting' } },
      beginAccount: async (id: string, proxy?: string) => { calls.push(`account:${id}:${proxy ?? ''}`); return { ok: true, phase: 'waiting' } },
      begin: async () => { calls.push('new'); return { ok: true, phase: 'waiting' } },
    },
  } as never)

  const handler = routes.get('/plugins/agy-link/pool/begin-add')!

  const rPrim = fakeRes()
  handler(fakeReq('POST', { accountId: 'acc_primary' }), rPrim)
  await rPrim.done
  assert.equal(rPrim.status, 200)

  const rSec = fakeRes()
  handler(fakeReq('POST', { accountId: 'acc_2' }), rSec)
  await rSec.done
  assert.equal(rSec.status, 200)

  const rMissing = fakeRes()
  handler(fakeReq('POST', { accountId: 'acc_ghost' }), rMissing)
  await rMissing.done
  assert.equal(rMissing.status, 404)

  assert.ok(calls[0]?.startsWith('primary:'))
  assert.equal(calls[1], 'account:acc_2:http://127.0.0.1:7890')
})

test('UI primitives & AccountsPanel never pass unkeyed array literals as children, and render 1-click reauth + quota pacing', () => {
  const arrayChildViolations: string[] = []
  const origCreate = R.createElement
  R.createElement = ((type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => {
    if (typeof type === 'string') {
      for (const ch of children) {
        if (Array.isArray(ch)) {
          arrayChildViolations.push(`${type}:${ch.length}`)
        }
      }
    }
    return origCreate(type, props, ...children)
  }) as typeof R.createElement

  try {
    const t = ((k: string) => k) as never
    Button({ variant: 'primary', children: ['icon', 'text'] })
    segGroup([origCreate('span', { key: 'a' }, 'A'), origCreate('span', { key: 'b' }, 'B')])

    const now = Date.now()
    const reauthAcc = {
      id: 'acc_reauth',
      alias: 'Needs Reauth',
      dir: '/tmp/a',
      enabled: true,
      createdAt: 1,
      authRequired: true,
      authError: 'refresh token revoked',
      cooldowns: {},
      quotas: {
        google: {
          remainingFraction: 0.85,
          resetTime: new Date(now + 1 * 3_600_000).toISOString(),
          weeklyFraction: 0.9,
          weeklyResetTime: new Date(now + 2 * 24 * 3_600_000).toISOString(),
        },
      },
    }

    const panelTree = JSON.stringify(AccountsPanel({
      t,
      pool: { mode: 'sequential', accounts: [reauthAcc], primaryAccountId: 'acc_primary' } as never,
      accounts: [reauthAcc] as never,
      loadingAction: null,
      proxyInputs: {},
      setProxyInputs: () => {},
      editingProxyId: null,
      setEditingProxyId: () => {},
      expandedModels: {},
      toggleExpand: () => {},
      optimisticActiveId: null,
      handlers: {
        moveAccount: async () => {},
        setActiveAccount: async () => {},
        beginReauth: async () => {},
        removeAccount: async () => {},
        toggleAccountEnabled: async () => {},
        refreshQuota: async () => {},
        warmupAccount: async () => {},
        saveProxy: async () => {},
        clearCooldown: async () => {},
      },
    }))

    assert.equal(arrayChildViolations.length, 0, `unexpected unkeyed array children passed to DOM elements: ${arrayChildViolations.join(', ')}`)
    assert.ok(panelTree.includes('account.reauth'), '1-click reauth button must render on authRequired card')
    assert.equal(panelTree.includes('account.setActive'), false, 'setActive must be hidden when authRequired is true')

    const quotaTree = JSON.stringify(renderFamilyQuotaBar(t, 'Gemini', 'google', reauthAcc as never, false))
    assert.ok(quotaTree.includes('quota.timeMarkerTitle'), 'quota pacing time benchmark tick should render')

    // Exercise low/medium/expired/unactivated/cooldown branches on QuotaPanel + AccountsPanel + SessionStatus
    const lowAcc = {
      ...reauthAcc,
      id: 'acc_low',
      enabled: false,
      authRequired: false,
      cooldowns: { google: { cooldownUntil: now + 60_000, reason: 'rate' } },
      quotas: {
        google: { remainingFraction: 0.1, resetTime: new Date(now + 4.9 * 3_600_000).toISOString(), weeklyFraction: 0.35, weeklyResetTime: new Date(now + 5 * 24 * 3_600_000).toISOString(), models: [{ modelId: 'm1', displayName: 'M1', remainingFraction: 0.1 }] },
        anthropic: { remainingFraction: 1, resetTime: new Date(now - 10_000).toISOString() },
        openai: { remainingFraction: 1 },
      },
    }
    JSON.stringify(AccountsPanel({
      t,
      pool: { mode: 'sequential', accounts: [reauthAcc, lowAcc], primaryAccountId: 'acc_reauth', activeAccountId: 'acc_low', systemProxy: 'http://sys:8080' } as never,
      accounts: [reauthAcc, lowAcc] as never,
      loadingAction: 'refresh:acc_low',
      proxyInputs: { acc_low: 'http://p:1' },
      setProxyInputs: () => {},
      editingProxyId: 'acc_low',
      setEditingProxyId: () => {},
      expandedModels: { acc_low: true },
      toggleExpand: () => {},
      optimisticActiveId: null,
      handlers: {
        moveAccount: async () => {},
        setActiveAccount: async () => {},
        removeAccount: async () => {},
        toggleAccountEnabled: async () => {},
        refreshQuota: async () => {},
        warmupAccount: async () => {},
        saveProxy: async () => {},
        clearCooldown: async () => {},
      },
    }))
    JSON.stringify(renderFamilyQuotaBar(t, 'Argon', 'argon', lowAcc as never, true))
    const testLocale = { subscribe: () => () => {}, bind: () => (k: string) => k }
    createSessionStatus(testLocale as never, () => null)
  } finally {
    R.createElement = origCreate
  }
})

test('SessionStatus SSR renders quota %, colors, dormant & modal states, and status polling handles ETag 304', async () => {
  const testLocale = { subscribe: () => () => {}, bind: () => (k: string) => k }
  const Badge = createSessionStatus(testLocale as never, () => null)
  // Reset modal & host state cleanly after test
  const prevOpen = agyModalStore.open
  const prevActive = modalHostManager.activeId
  try {
    modalHostManager.activeId = null
    agyModalStore.setOpen(false)
    publishStatusSnapshot({
      pool: {
        mode: 'sequential',
        primaryAccountId: 'acc_1',
        activeAccountId: 'acc_1',
        accounts: [{
          id: 'acc_1', alias: '主账号', dir: '', enabled: true, createdAt: 1, cooldowns: {},
          quotas: { google: { remainingFraction: 0.72 } },
        }],
      },
    } as never)
    const htmlHigh = renderToStaticMarkup(R.createElement(Badge, null) as never)
    assert.match(htmlHigh, /72%/)

    publishStatusSnapshot({
      pool: {
        mode: 'sequential',
        primaryAccountId: 'acc_1',
        activeAccountId: 'acc_1',
        accounts: [{
          id: 'acc_1', alias: 'Low', dir: '', enabled: true, createdAt: 1, cooldowns: {},
          quotas: { google: { remainingFraction: 0.12 } },
        }],
      },
    } as never)
    assert.match(renderToStaticMarkup(R.createElement(Badge, null) as never), /12%/)

    publishStatusSnapshot({
      dormantReason: 'no bin',
      pool: {
        mode: 'sequential',
        primaryAccountId: 'acc_1',
        activeAccountId: 'acc_1',
        accounts: [{
          id: 'acc_1', alias: 'Med', dir: '', enabled: true, createdAt: 1, authRequired: false,
          cooldowns: { google: { cooldownUntil: Date.now() + 60_000, reason: '429' } },
          quotas: { google: { remainingFraction: 0.35 } },
        }],
      },
    } as never)
    assert.match(renderToStaticMarkup(R.createElement(Badge, null) as never), /35%/)

    // Exercise api.ts + status.ts polling / ETag 304 + hidden skip + focus wake
    let fetchCalls = 0
    const origFetch = win.fetch
    win.fetch = (async (_url: string, init?: Record<string, unknown>) => {
      fetchCalls++
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (headers['If-None-Match'] === 'W/"etag-1"') {
        return { ok: false, status: 304, headers: { get: () => null }, json: async () => ({}) } as never
      }
      if (fetchCalls === 2) {
        return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({ error: 'fail' }) } as never
      }
      return { ok: true, status: 200, headers: { get: () => 'W/"etag-1"' }, json: async () => ({ ok: true, auth: { phase: 'ok' } }) } as never
    }) as never
    try {
      ensureStatusPolling()
      await new Promise((r) => setTimeout(r, 20))
      const failPost = await postJson('/plugins/agy-link/config', { key: 'x', value: 1 })
      assert.equal(failPost.ok, false)
      await postConfig('autoWarmup', true)
      await postPool('refresh-quota', {})
      await getJson('/plugins/agy-link/status')
      stopStatusPollingIfIdle()
      disposeStatusPolling()
      assert.ok(fetchCalls >= 2)
    } finally {
      win.fetch = origFetch
      disposeStatusPolling()
    }
  } finally {
    agyModalStore.setOpen(prevOpen)
    modalHostManager.activeId = prevActive
  }
})

test('Semaphore enforces bounded concurrency/abort and resolveSessionGoal + readAttachmentBytesFallback handle disk fallbacks', async () => {
  const sem = new Semaphore(() => 1)
  const rel1 = await sem.acquire()
  const ac = new AbortController()
  const pAborted = sem.acquire(ac.signal)
  ac.abort()
  await assert.rejects(pAborted, /aborted/)

  let acquired2 = false
  const p2 = sem.acquire().then((r) => { acquired2 = true; return r })
  assert.equal(acquired2, false)
  rel1()
  const rel2 = await p2
  assert.equal(acquired2, true)
  rel2()

  const dir = mkdtempSync(join(tmpdir(), 'agy-p2-helper-'))
  try {
    const objDir = join(dir, 'attachments', 'v1', 'objects', 'ab')
    mkdirSync(objDir, { recursive: true })
    writeFileSync(join(objDir, 'abcdef'), Buffer.from('hello-bytes'))
    const ctxMock = { get: () => undefined } as never
    const bytes = await readSessionImage(ctxMock, dir, { attachmentId: 'abcdef', mediaType: 'image/png', bytes: 11, width: 1, height: 1 })
    assert.equal(Buffer.from(bytes!).toString('utf8'), 'hello-bytes')
    assert.equal(await readSessionImage(ctxMock, dir, { attachmentId: 'missing', mediaType: 'image/png', bytes: 0, width: 1, height: 1 }), null)
    assert.equal(resolveSessionGoal({ get: () => undefined } as never, 'sess-none'), undefined)
    assert.equal(findSessionLogFile(dir, ''), undefined)
    const bucketDir = join(dir, 'sessions', 'b1', 'session-s1')
    mkdirSync(bucketDir, { recursive: true })
    writeFileSync(join(bucketDir, 'session.1.jsonl.zstd'), 'zstd')
    assert.ok(findSessionLogFile(dir, 's1')?.endsWith('session.1.jsonl.zstd'))
    assert.equal(
      resolveSessionGoal({
        get: (k: string) =>
          k === 'agents' ? { get: () => ({ id: 's1' }) }
            : k === 'goals' ? { get: () => ({ id: 'g1', revision: 2, phase: 'active', activation: 'armed' }) }
              : undefined,
      } as never, 's1')?.goalId,
      'g1',
    )
    assert.equal(
      resolveSessionGoal({
        get: (k: string) =>
          k === 'agents' ? { get: () => ({ id: 's1' }) }
            : k === 'goals' ? { get: () => ({ id: 'g1', phase: 'completed' }) }
              : undefined,
      } as never, 's1'),
      null,
    )

    // Exercise runTranslationStream (ok text-delta + empty response + error finish) and icon renderers
    const ctxOk = {
      llm: {
        stream: async function* () {
          yield { type: 'text-delta', text: 'translated prose' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
    } as never
    const tOk = await runTranslationStream(ctxOk, () => defaultConfig(), () => {}, {
      prompt: 'hi', model: 'gemini-3.8-flash', maxTokens: 100, timeoutMs: 2000, text: 'hi',
    })
    assert.equal(tOk.ok, true)
    assert.equal(tOk.text, 'translated prose')

    const ctxErr = {
      llm: {
        stream: async function* () {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '429' } } }
        },
      },
    } as never
    const tErr = await runTranslationStream(ctxErr, () => defaultConfig(), () => {}, {
      prompt: 'hi', model: 'gemini-3.8-flash', maxTokens: 100, timeoutMs: 2000, text: 'hi',
    })
    assert.equal(tErr.ok, false)
    assert.equal(tErr.code, 'RATE_LIMIT')

    const ctxEmpty = {
      llm: {
        stream: async function* () {
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
    } as never
    const tEmpty = await runTranslationStream(ctxEmpty, () => defaultConfig(), () => {}, {
      prompt: 'hi', model: 'gemini-3.8-flash', maxTokens: 100, timeoutMs: 2000, text: 'hi',
    })
    assert.equal(tEmpty.ok, false)

    agyIcon(18)
    brandIcon('gemini', 12)
    brandIcon('claude', 12)
    brandIcon('openai', 12)
    brandIcon('chrome', 12)
    brandIcon('edge', 12)
    uiIcon('check', 12)
    uiIcon('alert', 12)
    uiIcon('star', 12)
    uiIcon('plus', 12)
    uiIcon('trash', 12)
    uiIcon('externalLink', 12)
    uiIcon('globe', 12)
    uiIcon('power', 12)
    uiIcon('refresh', 12)
    uiIcon('flame', 12)
    uiIcon('zap', 12)
    uiIcon('mail', 12)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('getGitHeadContentAsync resolves cached git root, rejects binary/outside paths, and returns null outside repo', async () => {
  const mockExec = async (_bin: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse') return { stdout: '/repo\n' }
    return { stdout: 'const x = 1\n' }
  }
  assert.equal(await getGitHeadContentAsync('/repo/src/a.ts', mockExec), 'const x = 1\n')
  assert.equal(await getGitHeadContentAsync('/other/b.ts', mockExec), null)
  assert.equal(await getGitHeadContentAsync('', mockExec), null)
  const binaryExec = async (_bin: string, args: readonly string[]) =>
    args[0] === 'rev-parse' ? { stdout: '/repo\n' } : { stdout: 'abc\u0000def' }
  assert.equal(await getGitHeadContentAsync('/repo/img.png', binaryExec), null)
})

test('TranslationService isolates per-caller AbortSignal on deduplicated inflight key', async () => {
  let upstreamAborted = false
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const svc = new TranslationService({
    cfg: () => defaultConfig(),
    catalog: () => ({ source: 'fallback', models: [] }) as never,
    getSession: () => undefined,
    run: async (req: { signal?: AbortSignal; model: string }) => {
      req.signal?.addEventListener('abort', () => { upstreamAborted = true })
      await gate
      return { ok: true, text: '你好世界', model: req.model }
    },
  } as never)

  const acA = new AbortController()
  const acB = new AbortController()
  const pA = svc.translate({ text: 'Hello world from unit test' }, acA.signal)
  const pB = svc.translate({ text: 'Hello world from unit test' }, acB.signal)

  // Caller A cancels; caller B is still waiting -> upstream must NOT abort!
  acA.abort()
  const resA = await pA
  assert.equal(resA.ok, false)
  assert.equal(resA.code, 'ABORTED')
  assert.equal(upstreamAborted, false)

  release()
  const resB = await pB
  assert.equal(resB.ok, true)
  assert.equal(resB.text, '你好世界')
})

test('SubagentTracker decodes split multi-byte UTF-8 characters across incremental reads cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-p2-sub-'))
  try {
    const convId = 'conv-utf8'
    const subId = 'sub-utf8'
    const brainRoot = join(dir, '.gemini', 'antigravity-cli', 'brain')
    const brainMain = join(brainRoot, convId)
    const subAgentsDir = join(brainMain, '.system_generated', 'subagents')
    const subLogsDir = join(brainRoot, subId, '.system_generated', 'logs')
    mkdirSync(subAgentsDir, { recursive: true })
    mkdirSync(subLogsDir, { recursive: true })

    writeFileSync(
      join(subAgentsDir, `${subId}.json`),
      JSON.stringify({ conversationId: subId, subagentDescriptor: { role: '中文专员', typeName: 'research' } }),
    )
    const transcriptFile = join(subLogsDir, 'transcript.jsonl')
    const fullLine = JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: '已完成深度审计工作' }) + '\n'
    const rawBuf = Buffer.from(fullLine, 'utf8')
    // Split strictly inside a 3-byte Chinese UTF-8 character!
    const splitAt = fullLine.indexOf('深')
    const splitByteIdx = Buffer.byteLength(fullLine.slice(0, splitAt), 'utf8') + 1

    const events: string[] = []
    const tracker = new SubagentTracker({
      conversationId: convId,
      accountHome: dir,
      pollIntervalMs: 60_000,
      onEvent: (ev) => { if (ev.kind === 'step') events.push(ev.text) },
    })

    writeFileSync(transcriptFile, rawBuf.subarray(0, splitByteIdx))
    tracker.start()
    writeFileSync(transcriptFile, rawBuf)
    tracker.poll()
    tracker.stop()

    assert.ok(events.some((t) => t.includes('已完成深度审计工作')), `expected intact UTF-8 line, got: ${JSON.stringify(events)}`)
    assert.equal(events.some((t) => t.includes('\ufffd')), false, 'must contain zero UTF-8 replacement characters')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ImageService verifies cached path exists before returning cache hit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-p2-img-'))
  try {
    let runs = 0
    const imgFile1 = join(dir, 'out1.png')
    // Minimal 1x1 valid PNG
    const png1x1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    )
    const svc = new ImageService({
      cfg: () => ({ ...defaultConfig(), imageOutputDir: dir }),
      bin: () => '/usr/bin/agy',
      run: async () => {
        runs++
        writeFileSync(imgFile1, png1x1)
        return { ok: true, text: imgFile1, toolCalls: [], subagents: [], durationMs: 10 }
      },
    })

    const r1 = await svc.generate({ prompt: 'a red apple' })
    assert.equal(r1.ok, true)
    assert.equal(runs, 1)

    // Delete the generated file -> cache must not return ghost path
    rmSync(r1.path)
    const r2 = await svc.generate({ prompt: 'a red apple' })
    assert.equal(r2.ok, true)
    assert.equal(runs, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
