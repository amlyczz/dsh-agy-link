// The header has ONE entry for orchestration + live subagents (the 编排 chip),
// and the 编排 page explains a host without its route instead of spinning.
//
// Regression for the v0.6.107 report: "编排" and the "● 2" count pill sat side by
// side and both opened the same page, and the page read "正在读取编排状态…"
// forever because the running DSH host predated the /orchestration route.
import '../helpers/client-render.ts'
import { React } from '../helpers/client-render.ts'

import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)
const { JSDOM } = nodeRequire('jsdom') as { JSDOM: new (html?: string, options?: Record<string, unknown>) => any }
const ReactDOMClient = nodeRequire('react-dom/client') as any
const testUtils = nodeRequire('react-dom/test-utils') as any

import { setServicesContext } from '../../src/client/services.ts'
import { OrchestrationButton } from '../../src/client/sections/OrchestrationButton.ts'
import { SubagentControl, type SubagentItem } from '../../src/client/sections/SubagentPanel.ts'
import { OrchestrationPanel } from '../../src/client/orchestration/Panel.ts'
import { resetOrchestrationDataForTests, UNAVAILABLE_AFTER_FAILURES } from '../../src/client/orchestration/data.ts'
import type { OrchestrationSnapshot } from '../../src/client/orchestration/types.ts'

const h = (React as { createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown }).createElement

let dom: any
let saved: Array<[string, PropertyDescriptor | undefined]> = []

function setGlobal(key: string, value: unknown): void {
  saved.push([key, Object.getOwnPropertyDescriptor(globalThis, key)])
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}

function installDom(): any {
  restore()
  dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://127.0.0.1:53305/' })
  const w = dom.window
  for (const key of ['HTMLElement', 'HTMLAnchorElement', 'HTMLImageElement', 'HTMLVideoElement', 'HTMLAudioElement', 'Node', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'URL', 'URLSearchParams']) {
    setGlobal(key, w[key])
  }
  setGlobal('window', w)
  setGlobal('document', w.document)
  setGlobal('navigator', w.navigator)
  setGlobal('requestAnimationFrame', (cb: (t: number) => void) => w.requestAnimationFrame(cb))
  setGlobal('cancelAnimationFrame', (id: number) => w.cancelAnimationFrame(id))
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  return w
}

function restore(): void {
  setServicesContext(null)
  resetOrchestrationDataForTests()
  for (const [key, desc] of saved.reverse()) {
    if (desc !== undefined) Object.defineProperty(globalThis, key, desc)
    else delete (globalThis as Record<string, unknown>)[key]
  }
  saved = []
  if (dom !== undefined) {
    try { dom.window.close() } catch { /* ignore */ }
    dom = undefined
  }
}

afterEach(async () => {
  // A failed assertion must not leave a live component (and its interval) behind:
  // that kept the test process alive after the report.
  for (const root of mountedRoots.splice(0)) {
    try { await act(() => { root.unmount() }) } catch { /* already unmounted */ }
  }
  restore()
})

// Captured before any test enables mock timers: the harness itself must keep
// real delays while the module under test sees the mocked `setTimeout`.
const realSetTimeout = globalThis.setTimeout
const wait = (ms: number): Promise<void> => new Promise((r) => { realSetTimeout(r, ms) })

async function act(fn: () => void | Promise<void>): Promise<void> {
  await testUtils.act(async () => { await fn() })
}

const mountedRoots: any[] = []

async function mount(node: unknown): Promise<{ container: HTMLElement; root: any; unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  mountedRoots.push(root)
  await act(() => { root.render(node) })
  return { container, root, unmount: async () => { await act(() => { root.unmount() }) } }
}

const running = (id: string): SubagentItem => ({
  conversationId: id, role: 'Builder', typeName: 'godot-game-builder', running: true,
  lastAction: 'building', startedAt: 1_000, lastAt: 2_000,
})

const snapshot = (over: Partial<OrchestrationSnapshot> = {}): OrchestrationSnapshot => ({
  session: 's1', conversationId: 'conv-1', live: true,
  seats: [{ role: 'planner', model: 'gemini-pro-orchestrator-neon', short: 'orchestrator neon', calls: 1, inputTokens: 26069, outputTokens: 771, lastAt: 1 }],
  steps: [], todos: [], context: { at: 1 }, subagents: [], background: [], updatedAt: 1, ...over,
})

function stubFetch(handler: (url: string) => { ok: boolean; status: number; json: () => Promise<unknown> } | Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>): string[] {
  const urls: string[] = []
  setGlobal('fetch', async (url: string) => {
    urls.push(url)
    return handler(url)
  })
  return urls
}

test('header: with a right Sidebar the 编排 chip is the one entry and carries the live count; the count pill is gone', async () => {
  installDom()
  const opened: string[] = []
  setServicesContext({ sidebarRight: { openTab: (kind: string) => { opened.push(kind) } } })
  stubFetch(() => ({ ok: false, status: 404, json: async () => ({}) }))

  const view = await mount(h('div', null,
    h(OrchestrationButton, { t: ((k: string) => k) as never, sessionId: 's1', liveRunning: 2 }),
    h(SubagentControl, { t: ((k: string) => k) as never, items: [running('a'), running('b')] }),
  ))
  const chip = view.container.querySelector('.agy-orchestration-btn') as HTMLElement | null
  assert.ok(chip, 'the 编排 chip renders')
  assert.match(chip!.textContent ?? '', /编排/)
  assert.match(chip!.textContent ?? '', /2/, 'the chip shows the live count even before any snapshot')
  assert.equal(view.container.querySelector('.agy-subagent-chain'), null, 'no second count pill next to it')
  assert.equal(view.container.querySelectorAll('button').length, 1, 'exactly one header button')

  await act(() => { chip!.click() })
  assert.deepEqual(opened, ['agy-orchestration'], 'the one button opens the 编排 page')
  await view.unmount()
})

test('header: without a right Sidebar there is no 编排 chip and the count pill keeps its popover', async () => {
  installDom()
  setServicesContext({})
  stubFetch(() => ({ ok: false, status: 404, json: async () => ({}) }))

  const view = await mount(h('div', null,
    h(OrchestrationButton, { t: ((k: string) => k) as never, sessionId: 's1', liveRunning: 2 }),
    h(SubagentControl, { t: ((k: string) => k) as never, items: [running('a'), running('b')] }),
  ))
  assert.equal(view.container.querySelector('.agy-orchestration-btn'), null, 'no page to open, no chip')
  const pill = view.container.querySelector('.agy-subagent-chain') as HTMLElement | null
  assert.ok(pill, 'the count pill remains the entry on a host without the page')
  assert.match(pill!.textContent ?? '', /2/)
  await act(() => { pill!.click() })
  assert.ok(document.querySelector('[role="dialog"]'), 'the popover opens (portalled to <body>)')
  await view.unmount()
})

test('header: once a snapshot arrives the chip names the seat and shows the larger running count', async () => {
  installDom()
  setServicesContext({ sidebarRight: { openTab: () => {} } })
  stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, orchestration: snapshot() }) }))

  const view = await mount(h(OrchestrationButton, { t: ((k: string) => k) as never, sessionId: 's1', liveRunning: 3 }))
  await act(async () => { await wait(20) })
  const chip = view.container.querySelector('.agy-orchestration-btn') as HTMLElement | null
  assert.ok(chip)
  assert.match(chip!.textContent ?? '', /规划/, 'the active seat label')
  assert.match(chip!.textContent ?? '', /orchestrator neon/)
  assert.match(chip!.textContent ?? '', /3/, 'the live tracker count wins over the snapshot (0 subagents)')
  await view.unmount()
})

test('page: a host without the route gets an explanation instead of an endless spinner, and retry recovers', async (t) => {
  installDom()
  setServicesContext({ sidebarRight: { openTab: () => {} } })
  let answering = false
  const urls = stubFetch(() => answering
    ? { ok: true, status: 200, json: async () => ({ ok: true, orchestration: snapshot() }) }
    : { ok: false, status: 404, json: async () => ({}) })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const view = await mount(h(OrchestrationPanel, { sessionId: 's1' }))
    assert.match(view.container.textContent ?? '', /正在读取编排状态/)
    for (let i = 1; i < UNAVAILABLE_AFTER_FAILURES; i++) {
      t.mock.timers.tick(5_000)
      await act(async () => { await wait(5) })
    }
    assert.equal(urls.length, UNAVAILABLE_AFTER_FAILURES, 'one request per poll')
    const text = view.container.textContent ?? ''
    assert.match(text, /读取编排状态失败/)
    assert.match(text, /重启 DSH/)
    assert.equal(text.includes('正在读取编排状态'), false, 'the spinner is gone')

    // Retry: back to loading, and a host that now answers shows the seats.
    answering = true
    const retry = view.container.querySelector('button') as HTMLButtonElement | null
    assert.ok(retry, 'a retry button')
    await act(async () => { retry!.click(); await wait(20) })
    const recovered = view.container.textContent ?? ''
    assert.equal(recovered.includes('读取编排状态失败'), false)
    assert.match(recovered, /orchestrator neon/)
    assert.match(recovered, /规划|planner/)
    await view.unmount()
  } finally {
    t.mock.timers.reset()
  }
})

test('page: a host that answers renders the snapshot at once', async () => {
  installDom()
  setServicesContext({ sidebarRight: { openTab: () => {} } })
  stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, orchestration: snapshot({ live: false }) }) }))
  const view = await mount(h(OrchestrationPanel, { sessionId: 's1' }))
  await act(async () => { await wait(20) })
  const text = view.container.textContent ?? ''
  assert.equal(text.includes('正在读取编排状态'), false)
  assert.match(text, /orchestrator neon/)
  await view.unmount()
})
