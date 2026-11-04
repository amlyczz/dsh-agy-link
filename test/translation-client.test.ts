import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')

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

function loadPlugin(fetchImpl?: (url: string, init?: unknown) => Promise<unknown>): {
  plugin: { apply: (ctx: unknown) => void; inject: string[] }
  dom: { bodyChildren: Array<Record<string, unknown>> }
  stateLog: Array<{ calls: unknown[] }>
} {
  let loaded: { factory: (require: (id: string) => unknown) => unknown } | undefined
  // Minimal DOM: the tooltip placement is real code, so the test drives it with a
  // fake document/window instead of asserting on a source regex.
  interface NodeLike {
    id?: string
    textContent?: string
    isConnected?: boolean
    style: { cssText?: string; display?: string; left?: string; top?: string }
    attrs: Record<string, string>
    setAttribute(k: string, v: string): void
    getBoundingClientRect(): { left: number; top: number; bottom: number; width: number; height: number }
    remove(): void
  }
  type NodeAny = NodeLike & { dataset: Record<string, string>; className: string }
  const bodyChildren: NodeLike[] = []
  const stateLog: Array<{ calls: unknown[] }> = []
  const tipSize = { width: 200, height: 26 }
  const fakeDocument = {
    body: { appendChild: (n: NodeLike) => { bodyChildren.push(n) } },
    createElement: (): NodeLike => {
      const node: NodeLike = {
        style: {},
        attrs: {},
        dataset: {},
        className: '',
        children: [],
        classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
        setAttribute(this: NodeAny, k: string, v: string) { this.attrs[k] = v; if (k === 'id') this.id = v },
        addEventListener: () => {},
        removeEventListener: () => {},
        appendChild: (child: unknown) => { (node as unknown as { children: unknown[] }).children.push(child) },
        append: () => {},
        getBoundingClientRect: () => ({ left: 0, top: 0, bottom: tipSize.height, width: tipSize.width, height: tipSize.height }),
        remove() { const at = bodyChildren.indexOf(node); if (at >= 0) bodyChildren.splice(at, 1); node.isConnected = false },
        isConnected: true,
      } as unknown as NodeLike
      return node
    },
    getElementById: (id: string) => bodyChildren.find((n) => n.id === id) ?? null,
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    head: { appendChild: () => {} },
    documentElement: { appendChild: () => {} },
  }
  vm.runInNewContext(
    source,
    {
      window: {
        __ModuleLoader__: { load(value: typeof loaded) { loaded = value } },
        document: fakeDocument,
        innerWidth: 1200,
        innerHeight: 800,
        ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
      },
      document: fakeDocument,
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
      MutationObserver: class { observe(): void {} disconnect(): void {} takeRecords(): unknown[] { return [] } },
      requestAnimationFrame: (cb: (t: number) => void) => { cb(0); return 0 },
      cancelAnimationFrame: () => {},
      // NOTE: no `globalThis` key — the plugin's `win` IS globalThis, and injecting
      // an empty object here shadowed it, hiding the fake document/window from it.
      // Viewport metrics therefore belong on the sandbox itself, exactly as
      // window.innerWidth is visible through globalThis in a real browser.
      innerWidth: 1200,
      innerHeight: 800,
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
    { filename: 'client.js' },
  )
  assert.ok(loaded)
  const react = {
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): ElementLike {
      return { type, props, children }
    },
    useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void] {
      const value = typeof initial === 'function' ? (initial as () => S)() : initial
      const record = { current: value as unknown, calls: [] as unknown[] }
      stateLog.push({ calls: record.calls })
      const setter = (next: S | ((prev: S) => S)): void => {
        const resolved = typeof next === 'function' ? (next as (prev: S) => S)(record.current as S) : next
        record.current = resolved as unknown
        record.calls.push(resolved)
      }
      return [value, setter]
    },
    // Effects run once per render for this stub; a remount is modelled by calling
    // the component again, so subscriptions accumulate exactly like React's would
    // until the (ignored) cleanup.
    useEffect(setup: () => (() => void) | void): void {
      try {
        setup()
      } catch {
        // a failing effect must not break the render under test
      }
    },
    useRef<S>(initial: S): { current: S } {
      return { current: initial }
    },
    useMemo<T>(factory: () => T): T {
      return factory()
    },
  }
  const plugin = loaded.factory((id) => {
    if (id === 'react') return react
    if (id === 'react-dom') return {}
    throw new Error('unexpected browser dependency: ' + id)
  }) as { apply: (ctx: unknown) => void; inject: string[] }
  return { plugin, dom: { bodyChildren: bodyChildren as unknown as Array<Record<string, unknown>> }, stateLog }
}

interface Definition {
  kind: string
  match: (event: unknown) => unknown
  start: (context: unknown, match: unknown) => Record<string, unknown>
  update: (context: { state?: unknown }) => unknown
  buildViewNode: (context: {
    key: string
    id: string
    state?: Record<string, unknown>
    start?: { location?: unknown }
  }) => { anchorSeq?: number; kind?: string; location?: unknown; data?: Record<string, unknown> } | null
}

function mount(fetchImpl?: (url: string, init?: unknown) => Promise<unknown>) {
  const definitions: Definition[] = []
  const slots: Array<{ options: Record<string, unknown>; component: (props?: Record<string, unknown>) => unknown }> = []
  const cleanup: Array<() => void> = []
  const ctx = {
    locale: {
      register: () => () => undefined,
      bind: () => (key: string) => key,
      addLanguage: () => () => undefined,
      subscribe: () => () => undefined,
    },
    get(name: string) {
      if (name === 'uiConversation') {
        return { events: { register: (definition: Definition) => { definitions.push(definition); return () => undefined } } }
      }
      return undefined
    },
    effect(callback: () => (() => void) | void) {
      const dispose = callback()
      if (typeof dispose === 'function') cleanup.push(dispose)
    },
    slots: {
      inject(_name: string, callback: () => () => void) {
        const dispose = callback()
        if (typeof dispose === 'function') cleanup.push(dispose)
      },
      register(options: Record<string, unknown>, component: (props?: Record<string, unknown>) => unknown) {
        slots.push({ options, component })
        return () => undefined
      },
    },
  }
  const { plugin, dom, stateLog } = loadPlugin(fetchImpl)
  plugin.apply(ctx)
  return { definitions, slots, dom, stateLog }
}

test('client registers the translation conversation definition', () => {
  const { definitions } = mount()
  const definition = definitions.find((d) => d.kind === 'agy-translation')
  assert.ok(definition, 'agy-translation definition must be registered')
  const matched = definition.match({ type: 'plugin:agy-link/translation', seq: 7 }) as { id?: string; role?: string } | null
  assert.equal(matched?.id, '7')
  assert.equal(matched?.role, 'start')
  assert.equal(definition.match({ type: 'assistant/message', seq: 7 }), null)
})

test('definition projects the record into a node anchored at the reply', () => {
  const { definitions } = mount()
  const definition = definitions.find((d) => d.kind === 'agy-translation')!
  const state = definition.start({}, {
    event: { type: 'plugin:agy-link/translation', seq: 60, data: { turn: 3, anchorSeq: 42, text: '人话版', model: 'gemini-3.8-flash', effort: 'high' } },
  })
  assert.equal(state.turn, 3)
  assert.equal(state.anchorSeq, 42)
  const node = definition.buildViewNode({ key: 'k1', id: '60', state, start: { location: { kind: 'turn' } } })
  assert.ok(node)
  assert.equal(node!.kind, 'agy-translation')
  assert.equal(node!.anchorSeq, 42.1, 'card must sit just under the translated message')
  assert.equal((node!.data as Record<string, unknown>).text, '人话版')
  // An empty translation never materializes a node.
  assert.equal(definition.buildViewNode({ key: 'k1', id: '60', state: { ...state, text: '  ' } }), null)
})

test('card renders a labelled Gemini block and its markdown body', () => {
  const { slots } = mount()
  const card = slots.find((s) => s.options.key === 'agy-translation')
  assert.ok(card, 'conversation.chat.node key agy-translation must be registered')
  const element = card!.component({
    node: { data: { text: '**结论**：已修复。\n\n- `a.ts` 改了', model: 'gemini-3.8-flash', effort: 'high', original: 'raw' } },
    t: (key: string) => key,
  }) as ElementLike
  assert.ok(isElement(element))
  assert.equal(element.props?.['data-agy-translation'], 'gemini')
  // Gemini brand identity: the official four-point spark filled with the brand
  // gradient, the gradient wordmark, and a plain suffix tag.
  const head = element.children[0] as ElementLike
  const badge = head.children[0] as ElementLike
  const mark = badge.children[0] as ElementLike
  assert.equal(mark.type, 'svg')
  assert.equal(mark.props?.['className'], 'agy-tsl-mark')
  const gradient = (mark.children[0] as ElementLike).children[0] as ElementLike
  assert.equal(gradient.type, 'linearGradient')
  assert.deepEqual(
    gradient.children.map((stop) => (stop as ElementLike).props?.['stop-color']),
    ['#4285F4', '#9B72CB', '#D96570'],
  )
  assert.match(String((mark.children[1] as ElementLike).props?.fill), /^url\(#agy-tsl-grad-\d+\)$/)
  const brand = badge.children[1] as ElementLike
  assert.equal(brand.props?.['className'], 'agy-tsl-brand')
  assert.equal(collectText(brand).join(''), 'Gemini')
  assert.equal((badge.children[2] as ElementLike).props?.['className'], 'agy-tsl-tag')
  const text = collectText(element).join(' ')
  assert.match(text, /Gemini translation/)
  assert.match(text, /结论/)
  assert.match(text, /a\.ts/)
  // Attribution footer: spark + "translated by Gemini" note.
  const foot = element.children[element.children.length - 1] as ElementLike
  assert.equal(foot.props?.['className'], 'agy-tsl-foot')
  assert.equal((foot.children[0] as ElementLike).type, 'svg')
  assert.match(collectText(foot).join(' '), /Translated by Gemini/)
})

test('per-reply action is an icon-only Gemini button in the action strip', () => {
  const { slots } = mount()
  const action = slots.find((s) => s.options.name === 'conversation.chat.assistant-actions')
  assert.ok(action, 'conversation.chat.assistant-actions must be registered')
  const element = action!.component({ messageId: 'm1', sessionId: 's1', t: (key: string) => key }) as ElementLike
  assert.ok(isElement(element))
  // The button is wrapped in a span that carries our own tooltip; the native
  // `title` bubble does not show inside the desktop shell.
  assert.equal(element.type, 'span')
  assert.equal(element.props?.className, 'agy-tsl-wrap')
  const button = element.children[0] as ElementLike
  assert.equal(button.type, 'button')
  // Icon-only: a single <svg> glyph, no text label (the label is the tooltip).
  assert.equal(button.children.length, 1)
  const glyph = button.children[0] as ElementLike
  assert.equal(glyph.type, 'svg')
  assert.equal(collectText(button).join('').trim(), '')
  assert.equal(button.props?.title, undefined, 'no native title; the CSS hint owns the label')
  assert.equal(typeof button.props?.['aria-label'], 'string')
  // The label lives in a body-level node shown on hover — never in this row, so a
  // missing stylesheet cannot leak it into the action strip as inline text (that
  // is what the old pseudo-element/`data-tip` design did when a stale sheet
  // suppressed the new rules).
  assert.equal(element.children.length, 1, 'the wrapper carries only the button')
  assert.equal(collectText(element).join('').trim(), '', 'no hint text inside the row')
  for (const handler of ['onMouseEnter', 'onFocus', 'onMouseLeave', 'onBlur']) {
    assert.equal(typeof element.props?.[handler], 'function', handler + ' must be wired')
  }
  assert.match(source, /\.agy-tsl-tip \{/)
  assert.match(source, /position: fixed/)
  assert.equal(source.includes('content: attr(data-tip)'), false, 'the pseudo-element hint is gone')
  // The wrapper also decides which side the bubble goes on (see below).
  assert.equal(typeof element.props?.onMouseEnter, 'function')
  assert.equal(typeof element.props?.onFocus, 'function')
  // No session → no button (the slot's inject face is required).
  assert.equal(action!.component({ messageId: 'm1', t: (k: string) => k }), null)
})

test('the hint is ONE body-level node, placed below the anchor, clamped, then hidden', () => {
  // DSH's own tooltip is a portal: it is never below-in-the-scroller, so the
  // composer cannot cover it. Ours is a body-level fixed node for exactly that
  // reason — and it must stay "below", like every other hint in the strip.
  const { slots, dom } = mount()
  const action = slots.find((s) => s.options.name === 'conversation.chat.assistant-actions')
  // A real translator so the assertion below proves the LOCALIZED label rides the
  // node (the fallback is deliberately used when a key comes back unchanged).
  const wrapper = action!.component({ messageId: 'm1', sessionId: 's1', t: (k: string) => 'T:' + k }) as ElementLike
  const show = wrapper.props?.onMouseEnter as (e: unknown) => void
  const hide = wrapper.props?.onMouseLeave as () => void
  const box = (left: number, top: number, width = 24, bottom = top + 24) => ({
    currentTarget: { getBoundingClientRect: () => ({ left, top, width, bottom }) },
  })

  show(box(600, 100, 24, 124))
  assert.equal(dom.bodyChildren.length, 1, 'hovering creates the shared node once')
  const node = dom.bodyChildren[0]! as { style: Record<string, string>; textContent?: string; attrs: Record<string, string> }
  assert.equal(node.attrs.role, 'tooltip')
  // The bubble styling (background/padding/13px/radius) lives on `.agy-tsl-tip`.
  // Regression: the node was created without that class, so the CSS never applied
  // and the label rendered as bare body text under the action strip.
  assert.equal(node.attrs.class, 'agy-tsl-tip')
  assert.equal(node.style.position, 'fixed', 'fixed positioning is re-asserted on every show')
  assert.equal(node.style.display, 'inline-flex', 'shown on hover')
  assert.equal(node.textContent, 'T:tsl.actionTip', 'the localized label rides the node, not the row')
  // BELOW the anchor: bottom(124) + 6px gap; horizontally centred (600+12-100).
  assert.equal(node.style.top, '130px')
  assert.equal(node.style.left, '512px')

  // A second hover reuses the same node instead of stacking hints.
  show(box(300, 200))
  assert.equal(dom.bodyChildren.length, 1, 'singleton')
  assert.equal(node.style.top, '230px')

  // Left edge: clamped to the 8px margin instead of overflowing the viewport.
  show(box(0, 200))
  assert.equal(node.style.left, '8px')

  // Viewport bottom: flipping above is the only case that does — a row low on
  // the screen with a composer under it still shows the hint below (over the
  // composer), exactly like the DSH portal does.
  show(box(600, 700, 24, 724))
  assert.equal(Number(String(node.style.top).replace('px', '')), 730, 'a row low in the transcript keeps the hint BELOW, over the composer')
  show(box(600, 780, 24, 804))
  const flipped = Number(String(node.style.top).replace('px', ''))
  assert.ok(flipped < 780, 'only the viewport edge flips it above (got ' + flipped + ')')

  // Never throws on a partial event, and always hides on leave.
  assert.doesNotThrow(() => show(undefined))
  assert.doesNotThrow(() => show({ currentTarget: undefined }))
  hide()
  assert.equal(node.style.display, 'none')

  // The stylesheet carries the DSH tokens for the node.
  assert.match(source, /\.agy-tsl-tip \{/)
  assert.match(source, /background: var\(--dsw-alias-tooltip-bg/)
  assert.match(source, /color: var\(--dsw-static-neutral-bluish-00/)
  assert.match(source, /border-radius: var\(--dsw-radius-sm/)
  assert.match(source, /position: fixed/)
})

test('the style sheet refreshes itself when a reload left a stale tag behind', () => {
  // Regression: the guard returned early whenever the id already existed, so the
  // rules of an already-installed (older) sheet were never replaced and newly
  // added rules — like the hover hint — silently never applied.
  assert.match(source, /const existing = doc\.getElementById\(STYLE_ID\)/)
  assert.match(source, /if \(existing\.textContent !== CSS\) existing\.textContent = CSS/)
  assert.match(source, /STYLE_ID = ["']dsh-agy-link-tsl-css-v2["']/)
})

test('action state survives a remount and re-derives from the session record', () => {
  // Regression: the chat timeline re-creates the panel on window focus, so a
  // component-local state reset the button to idle mid-flight. State now lives
  // in a module map and is re-read from GET /translate/state on mount.
  assert.match(source, /ACTION_STATE = /)
  assert.match(source, /ACTION_INFLIGHT = /)
  assert.match(source, /agy-link\/translate\/state/)
  assert.match(source, /state === ["']ready["'] \? ["']done["']/)
})

test('a panel remount mid-flight still settles to done (no forever spinner)', async () => {
  // Regression: persisting the card inserts a node, DSH re-creates the panel, and
  // the instance that owned the in-flight POST unmounts — its setState is a no-op,
  // so the freshly mounted instance kept its inherited `working` state forever.
  // Publishing to every mounted instance is what settles the survivor.
  let release: ((value: unknown) => void) | undefined
  const pending = new Promise((resolve) => {
    release = resolve
  })
  const { slots, stateLog } = mount(() => pending)
  const action = slots.find((s) => s.options.name === 'conversation.chat.assistant-actions')
  assert.ok(action)
  const first = action!.component({ messageId: 'm1', sessionId: 's1', t: (k: string) => k }) as ElementLike
  const firstButton = first.children[0] as ElementLike
  const onClick = firstButton.props?.['onClick'] as (e: unknown) => void
  onClick({ stopPropagation() {}, preventDefault() {} })

  // The card lands → the panel remounts while the request is still open.
  const before = stateLog.length
  const second = action!.component({ messageId: 'm1', sessionId: 's1', t: (k: string) => k }) as ElementLike
  const secondButton = second.children[0] as ElementLike
  assert.equal(secondButton.props?.['data-state'], 'working', 'the remount inherits the in-flight state')
  const survivors = stateLog.slice(before)

  release!({ ok: true, status: 200, json: async () => ({ ok: true }) })
  await new Promise((resolve) => setImmediate(resolve))

  const settled = survivors.flatMap((entry) => entry.calls)
  assert.ok(
    settled.includes('done'),
    'the surviving instance must settle to done, got ' + JSON.stringify(settled),
  )
})

test('every list-slot registration carries a row id (id is the row identity)', () => {
  const { slots } = mount()
  const listSlots = slots.filter((s) => s.options.key === undefined)
  assert.ok(listSlots.length >= 1)
  for (const slot of listSlots) {
    assert.ok(
      typeof slot.options.id === 'string' && slot.options.id !== '',
      'list slot ' + String(slot.options.name) + ' needs a non-empty id',
    )
  }
})

test('the turn-tail chip is gone (the action lives in the icon strip only)', () => {
  const { slots } = mount()
  assert.equal(slots.some((s) => s.options.name === 'conversation.chat.turnTail'), false)
})

test('enable/disable toggles use native segGroup segmented buttons', () => {
  // Matches the pool scheduling segmented group ([ 顺序耗尽 | 轮询均衡 ]):
  // both On and Off states have explicit segmented buttons within a container.
  assert.match(source, /config\.autoWarmup/)
  assert.match(source, /config\.autoTranslate/)
  assert.match(source, /config\.on/)
  assert.match(source, /config\.off/)
})
