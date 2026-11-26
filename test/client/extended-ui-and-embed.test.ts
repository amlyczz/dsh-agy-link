import '../helpers/client-render.ts'
import { React, renderToStaticMarkup } from '../helpers/client-render.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultConfig } from '../../src/common/types.ts'
import { installAgentEmbedRenderer } from '../../src/client/embed.ts'
import { bindTranslator, resetTranslatorForTest } from '../../src/client/i18n-bridge.ts'
import { enhanceAudioLink } from '../../src/client/images/audio.ts'
import { EcosystemPanel } from '../../src/client/sections/EcosystemPanel.ts'
import { renderImageRow } from '../../src/client/sections/ImageSettingsRows.ts'
import { RuntimeControlsSection } from '../../src/client/sections/RuntimeControlsRows.ts'
import { WarmupStatusBar } from '../../src/client/sections/WarmupStatusBar.ts'
import { CardBody } from '../../src/client/toolview/card-bodies.ts'
import { mirrorCardModel } from '../../src/client/toolview/card-model.ts'
import type { ToolBlock } from '../../src/client/toolview/types.ts'
import { handleEmbedRequest, injectEmbedBridge } from '../../src/host/embed-route.ts'
import { mediaKindFor, normalizeMediaType, stageMedia } from '../../src/host/media.ts'
import { EventMapper } from '../../src/provider/mapper/event-mapper.ts'
import { rewriteAgentEmbeds, splitPendingEmbedFragment } from '../../src/provider/mapper/text.ts'

const nodeRequire = createRequire(import.meta.url)
const { JSDOM } = nodeRequire('jsdom') as { JSDOM: new (html?: string, opts?: Record<string, unknown>) => any }
const ReactDOMClient = nodeRequire('react-dom/client') as any
const testUtils = nodeRequire('react-dom/test-utils') as any
const createElement = (React as { createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown }).createElement

function fakeRes() {
  let code = 0
  let headers: Record<string, string> = {}
  let body = ''
  return {
    get status() { return code },
    get headers() { return headers },
    get body() { return body },
    writeHead(s: number, h: Record<string, string | number>) {
      code = s
      headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k, String(v)]))
    },
    end(chunk?: unknown) {
      body = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : ''
    },
  }
}

function settled(tool: string, input: Record<string, unknown>, content: string[] = ['ok'], server?: string): ToolBlock {
  return {
    kind: 'tool-result',
    call: { name: 'agy_tool', argsRaw: JSON.stringify({ tool, input, ...(server ? { server } : {}) }) },
    content: content.map((text) => ({ type: 'text' as const, text })),
    isError: false,
  } as unknown as ToolBlock
}

function withDom(fn: (win: any) => void | Promise<void>) {
  return async () => {
    const dom = new JSDOM('<!doctype html><html class="dark"><body></body></html>', { url: 'http://127.0.0.1:4100/' })
    const w = dom.window
    const keys = ['window', 'document', 'navigator', 'MutationObserver', 'HTMLElement', 'HTMLAnchorElement', 'getComputedStyle', 'MessageEvent', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'] as const
    const saved = keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const)
    for (const k of keys) {
      if (k === 'fetch') continue
      Object.defineProperty(globalThis, k, { value: k === 'IS_REACT_ACT_ENVIRONMENT' ? true : w[k], configurable: true, writable: true })
    }
    try {
      await fn(w)
    } finally {
      for (const [k, d] of saved.reverse()) {
        if (d !== undefined) Object.defineProperty(globalThis, k, d)
        else delete (globalThis as unknown as Record<string, unknown>)[k]
      }
      w.close()
    }
  }
}

test('stageMedia stages PDF, audio (parameterized MIME), and video, and enforces mediaMaxFileBytes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-stage-media-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const localVideo = join(dir, 'clip.mp4')
  writeFileSync(localVideo, Buffer.from('mp4-bytes'))

  assert.equal(normalizeMediaType('Audio/WebM; codecs=opus'), 'audio/webm')
  assert.equal(mediaKindFor('application/pdf'), 'pdf')
  assert.equal(mediaKindFor('audio/x-m4a'), 'audio')
  assert.equal(mediaKindFor('video/quicktime'), 'video')

  const res = await stageMedia({
    dir: join(dir, 'staged'),
    key: 'sess',
    items: [
      { attachmentId: 'pdf1', mediaType: 'application/pdf', name: 'spec.pdf', data: Buffer.from('%PDF-1.4') },
      { attachmentId: 'aud1', mediaType: 'audio/webm; codecs=opus', name: 'voice.webm', data: Buffer.from('opus-data').toString('base64') },
      { attachmentId: 'vid1', mediaType: 'video/mp4', name: 'clip.mp4', path: localVideo },
      { attachmentId: 'big1', mediaType: 'application/pdf', name: 'huge.pdf', bytes: 9999 },
      { attachmentId: 'bad1', mediaType: 'application/x-unknown', name: 'bin.dat', data: Buffer.from('x') },
    ],
    maxItems: 8,
    maxImageBytes: 1024,
    maxFileBytes: 2048,
  })

  assert.equal(res.staged.length, 3)
  assert.equal(res.skipped, 2)
  assert.match(res.promptSuffix, /\[pdf attached: "spec\.pdf".*read_file/)
  assert.match(res.promptSuffix, /\[audio attached: "voice\.webm" \(audio\/webm/)
  assert.match(res.promptSuffix, /\[video attached: "clip\.mp4"/)
  assert.match(res.promptSuffix, /exceeds mediaMaxFileBytes/)
  assert.match(res.promptSuffix, /unsupported type/)
  assert.equal(readFileSync(res.staged[2]!.path, 'utf8'), 'mp4-bytes')
})

test('text embed rewriter & EventMapper buffer chunk-split <agent-embed> across deltas and flush before tool cut', () => {
  assert.match(
    rewriteAgentEmbeds('See <agent-embed src="file:///tmp/chart.html" /> now', '/plugins/agy-link/embed'),
    /\[Widget: chart\.html\]\(\/plugins\/agy-link\/embed\?path=file%3A%2F%2F%2Ftmp%2Fchart\.html&agy_embed=1\)/,
  )
  const split = splitPendingEmbedFragment('intro <agent-embed src="file:///a.ht')
  assert.equal(split.ready, 'intro ')
  assert.equal(split.pending, '<agent-embed src="file:///a.ht')

  const mapper = new EventMapper({
    runId: 'r1',
    mediaBaseUrl: 'http://127.0.0.1:4100/plugins/agy-link/media',
    cutOnTool: true,
  })
  const events = [
    { kind: 'step', stepKey: 't1', stepKind: 'text', fragment: true, text: 'Look:\n<agent-em' },
    { kind: 'step', stepKey: 't1', stepKind: 'text', fragment: true, text: 'bed src="file:///w/ui.html"></agent-embed>' },
    { kind: 'step', stepKey: 'tc1', stepKind: 'tool', state: 'DONE', text: 'ok', tool: { name: 'run_command', args: { CommandLine: 'ls' }, output: 'ok' } },
    { kind: 'result', conversationId: 'c1', ok: true, response: '', usage: {} },
  ] as const
  const chunks = events.flatMap((ev, idx) => [...mapper.map(ev as never, idx)])
  const textOut = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
  assert.match(textOut, /\[Widget: ui\.html\]\(http:\/\/127\.0\.0\.1:4100\/plugins\/agy-link\/embed\?path=/)
})

test('embed-route serves strict-CSP HTML, injects bridge cleanly, and blocks hostile inputs', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-embed-adv-'))
  const outsideDir = mkdtempSync(join(tmpdir(), 'agy-embed-outside-'))
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  })

  const bare = join(dir, 'bare.htm')
  const bodyOnly = join(dir, 'body.html')
  const big = join(dir, 'big.html')
  const jsFile = join(dir, 'evil.js')
  const outsideHtml = join(outsideDir, 'secret.html')
  writeFileSync(bare, '<div>$1 $& widget</div>')
  writeFileSync(bodyOnly, '<div>ok</div></body>')
  writeFileSync(big, 'a'.repeat(2 * 1024 * 1024 + 10))
  writeFileSync(jsFile, 'alert(1)')
  writeFileSync(outsideHtml, '<h1>secret</h1>')

  // Dollar replacement tokens like $1 / $& must be preserved literally in injectEmbedBridge
  assert.match(injectEmbedBridge('<head></head>', 'id-1'), /id-1/)
  assert.match(injectEmbedBridge(bare.includes('bare') ? '<div>$1 $&</div>' : '', 'id-2'), /<div>\$1 \$&<\/div>/)

  // Cross-origin blocked
  const cors = fakeRes()
  handleEmbedRequest({ url: '/?path=' + encodeURIComponent(bare), headers: { origin: 'https://evil.example' } }, cors, { workspaceRoot: dir })
  assert.equal(cors.status, 403)

  // Non-html blocked
  const nonHtml = fakeRes()
  handleEmbedRequest({ url: '/?path=' + encodeURIComponent(jsFile) }, nonHtml, { workspaceRoot: dir })
  assert.equal(nonHtml.status, 403)

  // Outside workspace blocked
  const outside = fakeRes()
  handleEmbedRequest({ url: '/?path=' + encodeURIComponent(outsideHtml) }, outside, { workspaceRoot: dir })
  assert.equal(outside.status, 403)

  // Oversized (>2MB) returns 413
  const tooBig = fakeRes()
  handleEmbedRequest({ url: '/?path=' + encodeURIComponent(big) }, tooBig, { workspaceRoot: dir })
  assert.equal(tooBig.status, 413)

  // Hostile id param is sanitized back to "embed"
  const okBare = fakeRes()
  handleEmbedRequest({ url: '/?path=' + encodeURIComponent(bare) + '&id=' + encodeURIComponent('bad";alert(1)') }, okBare, { workspaceRoot: dir })
  assert.equal(okBare.status, 200)
  assert.match(okBare.body, /var EMBED_ID = "embed"/)
  assert.match(okBare.headers['Content-Security-Policy'] ?? '', /connect-src 'none'/)

  const okBody = fakeRes()
  handleEmbedRequest({ url: '/?path=' + encodeURIComponent(bodyOnly) + '&id=widget_9' }, okBody, { workspaceRoot: dir })
  assert.equal(okBody.status, 200)
  assert.match(okBody.body, /var EMBED_ID = "widget_9"/)
  assert.match(okBody.body, /<\/script>\s*<\/body>/)
})

test('client embed renderer and audio enhancer upgrade DOM in JSDOM with localized copy', withDom(async (w) => {
  bindTranslator({ locale: { bind: () => (k: string) => (k === 'embed.collapse' ? 'CollapseX' : k === 'audio.listenChip' ? 'ListenX' : k) } })
  const prevFetch = globalThis.fetch
  const prevRaf = (globalThis as Record<string, unknown>).requestAnimationFrame
  const openedUrls: string[] = []
  try {
    (globalThis as Record<string, unknown>).requestAnimationFrame = (cb: (t: number) => void) => {
      cb(0)
      return 0
    }
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      openedUrls.push(String(input))
      return { ok: false, status: 404, json: async () => ({ error: 'missing' }) } as Response
    }) as typeof fetch

    // 1. Embed link -> sandboxed iframe + collapse toggle + clamped postMessage resize + theme & source fallback
    const badLink = w.document.createElement('a')
    badLink.href = 'http://127.0.0.1:4100/plugins/agy-link/embed'
    badLink.textContent = 'bad'
    w.document.body.appendChild(badLink)

    const link = w.document.createElement('a')
    link.href = 'http://127.0.0.1:4100/plugins/agy-link/embed?path=%2Ftmp%2Fw.html&agy_embed=1'
    link.textContent = 'Widget: w.html'
    w.document.body.appendChild(link)

    w.document.documentElement.className = 'dark'
    const dispose = installAgentEmbedRenderer()
    const card = w.document.querySelector('.agy-embed-card') as HTMLElement | null
    const iframe = w.document.querySelector('iframe.agy-embed-frame') as HTMLIFrameElement | null
    assert.ok(card && iframe)
    assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts')
    iframe.dispatchEvent(new w.Event('load'))
    w.document.documentElement.className = ''
    w.document.documentElement.setAttribute('data-theme', 'light')

    const btns = card.querySelectorAll<HTMLButtonElement>('button.agy-embed-btn')
    assert.equal(btns[0]?.textContent, 'CollapseX')
    btns[0]?.click()
    assert.equal(iframe.style.display, 'none')
    assert.equal(btns[0]?.textContent, 'Expand')
    btns[0]?.click()
    assert.equal(iframe.style.display, 'block')
    assert.equal(btns[0]?.textContent, 'CollapseX')

    btns[1]?.click()

    const m = iframe.src.match(/[?&]id=([^&]+)/)
    assert.ok(m?.[1])
    w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'other', id: decodeURIComponent(m[1]), height: 200 }, source: iframe.contentWindow }))
    w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'agy-embed-resize', id: 'unknown-id', height: 200 }, source: iframe.contentWindow }))
    w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'agy-embed-resize', id: decodeURIComponent(m[1]), height: 200 }, source: w }))
    w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'agy-embed-resize', id: decodeURIComponent(m[1]), height: 1500 }, source: iframe.contentWindow }))
    assert.equal(iframe.style.height, '800px')
    w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'agy-embed-resize', id: decodeURIComponent(m[1]), height: 10 }, source: iframe.contentWindow }))
    assert.equal(iframe.style.height, '80px')

    // 2. Audio link -> toggle chip + keyboard toggle + idempotency + <audio controls> + open fallback toast
    const alink = w.document.createElement('a')
    alink.href = 'file:///tmp/demo.mp3'
    alink.textContent = 'demo.mp3'
    w.document.body.appendChild(alink)
    enhanceAudioLink(alink, 'file:///tmp/demo.mp3', 'file:///tmp/demo.mp3')
    enhanceAudioLink(alink, 'file:///tmp/demo.mp3', 'file:///tmp/demo.mp3')
    assert.equal(w.document.querySelectorAll('.agy-audio-card').length, 1)
    const chip = alink.querySelector('.agy-audio-link-icon') as HTMLElement | null
    const acard = w.document.querySelector('.agy-audio-card') as HTMLElement | null
    const audioEl = acard?.querySelector('audio.agy-audio-player') as HTMLAudioElement | null
    const openBtn = acard?.querySelector('button.agy-audio-card-open') as HTMLButtonElement | null
    assert.ok(chip && acard && audioEl && openBtn)
    assert.match(chip.textContent ?? '', /ListenX/)
    assert.equal(audioEl.controls, true)
    chip.click()
    assert.equal(acard.style.display, 'none')
    chip.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter' }))
    assert.equal(acard.style.display, 'flex')
    openBtn.click()
    await new Promise((r) => setTimeout(r, 20))
    assert.ok(openedUrls.length >= 2)
    dispose()
  } finally {
    globalThis.fetch = prevFetch
    if (prevRaf !== undefined) (globalThis as Record<string, unknown>).requestAnimationFrame = prevRaf
    else delete (globalThis as Record<string, unknown>).requestAnimationFrame
    resetTranslatorForTest()
  }
}))

test('extended toolview models & CardBody render image-generator, swarm, workflow, schedule, task, subagent, and browser cards', () => {
  const cases: Array<[string, Record<string, unknown>, string[], string, string?]> = [
    ['invoke_subagent', { Role: 'Image Generator', TypeName: 'image-generator', Prompt: 'draw fox', AspectRatio: '16:9' }, ['saved /tmp/fox.png'], 'image'],
    ['swarm', { action: 'add', name: 'worker-1', workspace: 'share', model: 'neon', n: 2, brief: 'implement feature' }, ['spawned worker'], 'swarm'],
    ['run_workflow', { ScriptPath: '/tmp/wf.py', Cwd: '/tmp', Description: 'Fan out audit', Script: 'print(1)' }, ['done'], 'workflow'],
    ['schedule', { CronExpression: '*/5 * * * *', IsDaemon: true, TimerCondition: 'any', Prompt: 'check status' }, ['scheduled'], 'schedule'],
    ['manage_task', { Action: 'kill', TaskId: 'task-9', Input: 'abort' }, ['killed'], 'task'],
    ['define_subagent', { Name: 'auditor', Description: 'Audit code', Role: 'Auditor' }, ['defined'], 'subagent'],
    ['navigate_page', { Url: 'https://example.com' }, ['screenshot saved at /tmp/shot.png'], 'browser', 'chrome-devtools'],
  ]

  for (const [tool, input, out, expectedKind, server] of cases) {
    const model = mirrorCardModel(settled(tool, input, out, server))
    assert.equal(model.kind, expectedKind, `${tool} should map to ${expectedKind}`)
    const html = renderToStaticMarkup(createElement(CardBody as never, { model, t: ((k: string) => k) as never }))
    assert.ok(html.length > 0, `${tool} CardBody HTML must not be empty`)
  }
})

test('client sections (EcosystemPanel, RuntimeControlsRows, ImageSettingsRows, WarmupStatusBar) render cleanly across states', withDom(async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = []
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(init.body) : undefined
      calls.push({ url, method, body })
      if (url.includes('/ecosystem/sync')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, report: { syncedAccounts: ['acc_2'], copiedFiles: 2, removedFiles: 0 }, snapshot: { primaryHome: '/h', plugins: [{ id: 'p1', name: 'Plugin1', enabled: true, source: 'global', hasMcp: false, hasHooks: false, skillCount: 1, ruleCount: 0, path: '/p1' }], mcpServers: [{ name: 'srv', transport: 'stdio', target: 'npx x', disabled: false, source: 'global' }], skills: [{ name: 'sk1', description: '', source: 'global', path: '/s' }], rules: [{ name: 'AGENTS.md', path: '/r', bytes: 10, source: 'global' }], agents: [{ name: 'rev', description: 'Reviewer', source: 'global', path: '/a' }], syncedAccountCount: 1, lastSyncAt: 1 } }) }
      }
      if (url.includes('/ecosystem/plugin')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, snapshot: { primaryHome: '/h', plugins: [{ id: 'p1', name: 'Plugin1', enabled: false, source: 'global', hasMcp: false, hasHooks: false, skillCount: 1, ruleCount: 0, path: '/p1' }], mcpServers: [], skills: [], rules: [], agents: [], syncedAccountCount: 1, lastSyncAt: 1 } }) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          primaryHome: '/h',
          plugins: [{ id: 'p1', name: 'Plugin1', enabled: true, source: 'global', hasMcp: false, hasHooks: false, skillCount: 1, ruleCount: 0, path: '/p1' }],
          mcpServers: [{ name: 'srv', transport: 'stdio', target: 'npx x', disabled: false, source: 'global' }],
          skills: [{ name: 'sk1', description: '', source: 'global', path: '/s' }],
          rules: [{ name: 'AGENTS.md', path: '/r', bytes: 10, source: 'global' }],
          agents: [{ name: 'rev', description: 'Reviewer', source: 'global', path: '/a' }],
          syncedAccountCount: 0,
          lastSyncAt: null,
        }),
      }
    },
  })

  {
    const t = ((k: string, p?: Record<string, unknown>) => (p ? `${k}:${JSON.stringify(p)}` : k)) as never
    const cfgWrites: Array<[string, unknown]> = []
    const setCfg = async (k: string, v: unknown) => { cfgWrites.push([k, v]) }
    const status = {
      ...defaultConfig(),
      permissionMode: 'auto',
      sandbox: true,
      transport: 'acp' as const,
      acpStatus: { activeProcesses: 1, sessions: 2, keys: [] },
      imageTool: true,
      syncAccountCustomizations: true,
      agent: 'rev',
      imageModel: 'gemini-4-hydrogen',
      imageEffort: 'medium',
    }

    const runtimeHtml = renderToStaticMarkup(createElement(RuntimeControlsSection as never, { t, status, loadingAction: null, setCfg }))
    assert.match(runtimeHtml, /config\.acpStats/)
    assert.match(runtimeHtml, /config\.permissionMode/)
    assert.match(runtimeHtml, /config\.mcpScopeAll/)
    assert.match(runtimeHtml, /config\.mcpScopeHostOnly/)

    const imageRowHtml = renderToStaticMarkup(createElement('div', null, renderImageRow(
      t,
      status,
      [{ id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', efforts: ['low', 'medium', 'high'] }],
      null,
      setCfg,
      () => {},
      { auto: 'auto', level: (x: string) => x },
    )))
    assert.match(imageRowHtml, /dsh-agy-image/)

    const runningBar = renderToStaticMarkup(createElement(WarmupStatusBar as never, {
      t,
      warmupState: { running: true, completed: 1, total: 2, currentAccountId: 'a1', lastRun: null },
      accounts: [{ id: 'a1', alias: 'Alpha', dir: '', enabled: true, createdAt: 0 }],
    }))
    assert.match(runningBar, /warmup\.progressCurrent.*Alpha/)

    const lastRunBar = renderToStaticMarkup(createElement(WarmupStatusBar as never, {
      t,
      warmupState: {
        running: false, completed: 1, total: 1, currentAccountId: null,
        lastRun: { finishedAt: Date.now(), totalAccounts: 1, succeeded: 1, skipped: 0, failed: 0, accounts: [{ accountId: 'a1', alias: 'Alpha', succeeded: 1, skipped: 0, failed: 0 }] },
      },
      accounts: [],
    }))
    assert.match(lastRunBar, /warmup\.lastRun/)

    // Mount EcosystemPanel in JSDOM to exercise fetch, expand, sync, and plugin toggle
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = ReactDOMClient.createRoot(container)
    await testUtils.act(async () => {
      root.render(createElement(EcosystemPanel as never, { t, currentAgent: 'rev', loadingAction: null, setCfg, showToast: () => {} }))
      await new Promise((r) => setTimeout(r, 20))
    })
    const buttons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]
    const expandBtn = buttons.find((b) => b.textContent === 'eco.expand')
    assert.ok(expandBtn)
    await testUtils.act(async () => { expandBtn.click() })
    assert.match(container.textContent ?? '', /Plugin1/)
    assert.match(container.textContent ?? '', /eco\.activeAgent/)

    const syncBtn = (Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]).find((b) => b.textContent === 'eco.syncNow')
    assert.ok(syncBtn)
    await testUtils.act(async () => { syncBtn.click(); await new Promise((r) => setTimeout(r, 15)) })
    assert.ok(calls.some((c) => c.url.includes('/ecosystem/sync')))

    const toggleBtn = (Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]).find((b) => b.textContent === 'config.on')
    assert.ok(toggleBtn)
    await testUtils.act(async () => { toggleBtn.click(); await new Promise((r) => setTimeout(r, 15)) })
    assert.ok(calls.some((c) => c.url.includes('/ecosystem/plugin')))

    await testUtils.act(async () => { root.unmount() })
  }
}))
