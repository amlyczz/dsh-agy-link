import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { join } from 'node:path'
import { REPO_ROOT } from '../helpers/paths.ts'

const source = fs.readFileSync(new URL('../../dist/client.js', import.meta.url), 'utf8')

interface ElementLike {
  type: unknown
  props: Record<string, unknown> | null
  children: unknown[]
}

function isElement(value: unknown): value is ElementLike {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value
}

function collectText(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') {
    out.push(node)
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (isElement(node)) {
    collectText(node.children, out)
  }
  return out
}

function findElements(node: unknown, pred: (el: ElementLike) => boolean, out: ElementLike[] = []): ElementLike[] {
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, pred, out)
    return out
  }
  if (isElement(node)) {
    if (pred(node)) out.push(node)
    findElements(node.children, pred, out)
  }
  return out
}

function loadClientForBtw(fetchImpl?: (url: string, init?: unknown) => Promise<unknown>) {
  let loaded: { factory: (require: (id: string) => unknown) => unknown } | undefined
  const bodyChildren: Array<{ id?: string; textContent?: string; remove(): void }> = []
  const keyListeners = new Map<string, Set<(ev: unknown) => void>>()

  const fakeDocument = {
    body: { appendChild: (n: { id?: string; textContent?: string; remove(): void }) => { bodyChildren.push(n) } },
    head: { appendChild: (n: { id?: string; textContent?: string; remove(): void }) => { bodyChildren.push(n) } },
    documentElement: {
      appendChild: (n: { id?: string; textContent?: string; remove(): void }) => { bodyChildren.push(n) },
      classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    },
    createElement: () => {
      const node = {
        id: '',
        textContent: '',
        style: {},
        dataset: {} as Record<string, string>,
        attrs: {} as Record<string, string>,
        classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
        setAttribute(k: string, v: string) { this.attrs[k] = v; if (k === 'id') this.id = v },
        addEventListener: () => {},
        removeEventListener: () => {},
        appendChild: () => {},
        remove() { const i = bodyChildren.indexOf(node); if (i >= 0) bodyChildren.splice(i, 1) },
      }
      return node
    },
    getElementById: (id: string) => bodyChildren.find((n) => n.id === id) ?? null,
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: (t: string, fn: (ev: unknown) => void) => {
      let set = keyListeners.get(t)
      if (!set) { set = new Set(); keyListeners.set(t, set) }
      set.add(fn)
    },
    removeEventListener: (t: string, fn: (ev: unknown) => void) => {
      keyListeners.get(t)?.delete(fn)
    },
  }

  vm.runInNewContext(
    source,
    {
      window: {
        __ModuleLoader__: { load(value: typeof loaded) { loaded = value } },
        document: fakeDocument,
        addEventListener: () => {},
        removeEventListener: () => {},
        ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
      },
      document: fakeDocument,
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
      MutationObserver: class { observe(): void {} disconnect(): void {} takeRecords(): unknown[] { return [] } },
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
    { filename: 'client.js' },
  )
  assert.ok(loaded)

  const stateSlots = new Map<string, unknown>()
  let activeHookKey = ''
  let hookIdx = 0
  const effects: Array<() => void | (() => void)> = []

  const react = {
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): ElementLike {
      return { type, props, children }
    },
    useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void] {
      const key = `${activeHookKey}:${hookIdx++}`
      if (!stateSlots.has(key)) {
        stateSlots.set(key, typeof initial === 'function' ? (initial as () => S)() : initial)
      }
      const setter = (next: S | ((prev: S) => S)) => {
        const cur = stateSlots.get(key) as S
        stateSlots.set(key, typeof next === 'function' ? (next as (p: S) => S)(cur) : next)
      }
      return [stateSlots.get(key) as S, setter]
    },
    useEffect(cb: () => void | (() => void)) {
      effects.push(cb)
    },
    useRef<S>(initial: S) {
      return { current: initial }
    },
  }

  const plugin = loaded.factory((id) => {
    if (id === 'react') return react
    if (id === 'react-dom') return {}
    throw new Error(`unexpected require: ${id}`)
  }) as { apply(ctx: unknown): void }

  function renderTree(node: unknown, keyPrefix = 'root'): unknown {
    if (Array.isArray(node)) return node.map((c, i) => renderTree(c, `${keyPrefix}.${i}`))
    if (!isElement(node)) return node
    if (typeof node.type === 'function') {
      activeHookKey = keyPrefix
      hookIdx = 0
      const out = (node.type as (p: Record<string, unknown> | null) => unknown)(node.props)
      return renderTree(out, `${keyPrefix}>fn`)
    }
    return {
      ...node,
      children: node.children.map((c, i) => renderTree(c, `${keyPrefix}.${i}`)),
    }
  }

  return { plugin, fakeDocument, bodyChildren, keyListeners, effects, renderTree }
}

test('BtwDock renders streaming tools/markdown, suppresses chat command noise, handles Esc, and cleans up styles', async () => {
  const posted: Array<{ url: string; body: unknown }> = []
  let currentView = {
    sessionId: 'sess-ui',
    open: true,
    activeIndex: 0,
    revision: 2,
    entries: [
      {
        id: 'btw-1',
        question: 'How does retry work?',
        answer: 'Retries happen in `retry-policy.ts`.',
        thinking: '',
        tools: [{ stepKey: 't1', name: 'read_file', target: 'src/provider/retry-policy.ts', state: 'done' as const }],
        status: 'done' as const,
        model: 'gemini-3.8-flash',
        effort: 'low',
        conversationId: 'c-btw-1',
        startedAt: 1000,
        finishedAt: 2400,
        durationMs: 1400,
      },
    ],
  }

  const { plugin, bodyChildren, keyListeners, effects, renderTree } = loadClientForBtw(async (url, init) => {
    const reqInit = (init ?? {}) as { method?: string; body?: string }
    if (reqInit.method === 'POST') {
      const body = JSON.parse(reqInit.body ?? '{}')
      posted.push({ url, body })
      if (url.endsWith('/dismiss')) currentView = { ...currentView, open: Boolean(body.open), revision: currentView.revision + 1 }
      return { ok: true, status: 200, async json() { return { ok: true, state: currentView } } }
    }
    return { ok: true, status: 200, async json() { return { ok: true, state: currentView } } }
  })

  const slots: Array<{ opts: Record<string, unknown>; comp: (p?: unknown) => unknown }> = []
  const disposers: Array<() => void> = []
  const listeners = new Map<string, (sid: unknown, name: unknown) => void>()

  plugin.apply({
    locale: {
      addLanguage: () => () => {},
      register: () => () => {},
      bind: () => (k: string) => k,
      subscribe: () => () => {},
    },
    effect: (cb: () => void | (() => void)) => {
      const off = cb()
      if (typeof off === 'function') disposers.push(off)
    },
    on: (ev: string, fn: (sid: unknown, name: unknown) => void) => {
      listeners.set(ev, fn)
      return () => { listeners.delete(ev) }
    },
    slots: {
      inject: (_name: string, cb: () => () => void) => {
        const off = cb()
        if (typeof off === 'function') disposers.push(off)
      },
      register: (opts: Record<string, unknown>, comp: (p?: unknown) => unknown) => {
        slots.push({ opts, comp })
        return () => {}
      },
    },
  })

  const dockSlot = slots.find((s) => s.opts.name === 'conversation.input.dock' && s.opts.id === 'agy-btw')
  const cmdSlot = slots.find((s) => s.opts.name === 'conversation.chat.commandview' && s.opts.key === 'atw')
  assert.ok(dockSlot)
  assert.ok(cmdSlot)
  assert.equal(dockSlot.opts.order, 15)

  // Command row suppresses normal /atw output in chat flow, but surfaces errors
  assert.equal(cmdSlot.comp({ node: { outcome: { kind: 'success', text: 'q' } } }), null)
  const errEl = cmdSlot.comp({ node: { outcome: { kind: 'error', text: 'boom' } } }) as ElementLike
  assert.equal(collectText(errEl).join(''), 'boom')

  const planCmdSlot = slots.find((s) => s.opts.name === 'conversation.chat.commandview' && s.opts.key === 'aplan')
  assert.ok(planCmdSlot)
  assert.equal(planCmdSlot.comp({ node: { outcome: { kind: 'success' } } }), null)
  const textRow = planCmdSlot.comp({ node: { outcome: { kind: 'success', text: 'Goal status' } } }) as ElementLike
  assert.equal(collectText(textRow).join(''), 'Goal status')
  const errRow = planCmdSlot.comp({ node: { outcome: { kind: 'error', text: 'Switch model' } } }) as ElementLike
  assert.equal(collectText(errRow).join(''), 'Switch model')

  // Style sheet injected
  assert.ok(bodyChildren.some((n) => n.id === 'dsh-agy-link-btw-css-v1'))

  // Trigger command/executed wake + fetch
  listeners.get('command/executed')?.('sess-ui', 'atw')
  await new Promise((r) => setTimeout(r, 15))

  const tree = renderTree({ type: dockSlot.comp, props: { sessionId: 'sess-ui' }, children: [] })
  const text = collectText(tree).join(' ')
  assert.match(text, /How does retry work\?/)
  assert.match(text, /Called 1 tool/)
  assert.match(text, /Retries happen in/)
  assert.match(text, /retry-policy\.ts/)

  // Follow-up input submission: type into input and submit while card is open
  const inputs = findElements(tree, (el) => el.type === 'input')
  assert.equal(inputs.length, 1)
  const sendButtons = findElements(tree, (el) => el.type === 'button' && el.props?.className === 'agy-btw-send')
  assert.equal(sendButtons.length, 1)
  ;(inputs[0]!.props?.onChange as (e: unknown) => void)?.({ target: { value: 'Follow up question' } })
  const tree2 = renderTree({ type: dockSlot.comp, props: { sessionId: 'sess-ui' }, children: [] })
  const sendButtons2 = findElements(tree2, (el) => el.type === 'button' && el.props?.className === 'agy-btw-send')
  assert.equal(sendButtons2.length, 1)
  ;(sendButtons2[0]!.props?.onClick as () => void)?.()
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(posted.some((p) => p.url.endsWith('/plugins/agy-link/btw/ask') && (p.body as { question?: string }).question === 'Follow up question'))

  // Run mounted effects (Escape listener) -> dismisses open card
  for (const eff of effects) eff()
  const keyFns = [...(keyListeners.get('keydown') ?? [])]
  assert.ok(keyFns.length >= 1)
  keyFns.forEach((fn) => fn({ key: 'Escape', defaultPrevented: false, preventDefault: () => {} }))
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(posted.some((p) => p.url.endsWith('/plugins/agy-link/btw/dismiss')))

  // Teardown cleans style sheet
  for (const d of disposers) d()
  assert.equal(bodyChildren.some((n) => n.id === 'dsh-agy-link-btw-css-v1'), false)
})

test('btw client modules contain zero hardcoded CJK literals and English locale stays ASCII', () => {
  for (const rel of ['src/client/btw.ts', 'src/client/btw-card.ts', 'src/client/slash-commands.ts']) {
const src = fs.readFileSync(join(REPO_ROOT, rel), 'utf8')
    const noblock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    for (const line of noblock.split(/\r?\n/)) {
      const code = line.replace(/\/\/.*$/, '')
      const literals = code.match(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g) ?? []
      for (const lit of literals) {
        assert.equal(/[\u4e00-\u9fff]/.test(lit), false, `${rel} contains hardcoded CJK literal: ${lit}`)
      }
    }
  }
  const enSrc = fs.readFileSync(new URL('../../src/client/locales/en.ts', import.meta.url), 'utf8')
  for (const line of enSrc.split('\n')) {
    if (!/'btw\./.test(line)) continue
    assert.equal(/[\u4e00-\u9fff]/.test(line), false, `en.ts btw key must be ASCII: ${line}`)
  }
})

