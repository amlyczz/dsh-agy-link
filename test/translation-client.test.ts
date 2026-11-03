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

function loadPlugin() {
  let loaded: { factory: (require: (id: string) => unknown) => unknown } | undefined
  vm.runInNewContext(
    source,
    {
      window: { __ModuleLoader__: { load(value: typeof loaded) { loaded = value } } },
      globalThis: {},
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
    useState<S>(initial: S): [S, (next: S | ((prev: S) => S)) => void] {
      return [initial, () => undefined]
    },
    useEffect(): void {},
    useRef<S>(initial: S): { current: S } {
      return { current: initial }
    },
    useMemo<T>(factory: () => T): T {
      return factory()
    },
  }
  return loaded.factory((id) => {
    if (id === 'react') return react
    if (id === 'react-dom') return {}
    throw new Error('unexpected browser dependency: ' + id)
  }) as { apply: (ctx: unknown) => void; inject: string[] }
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

function mount() {
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
  const plugin = loadPlugin()
  plugin.apply(ctx)
  return { definitions, slots }
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
  const text = collectText(element).join(' ')
  assert.match(text, /Gemini translation/)
  assert.match(text, /结论/)
  assert.match(text, /a\.ts/)
})

test('per-reply action is an icon-only Gemini button in the action strip', () => {
  const { slots } = mount()
  const action = slots.find((s) => s.options.name === 'conversation.chat.assistant-actions')
  assert.ok(action, 'conversation.chat.assistant-actions must be registered')
  const element = action!.component({ messageId: 'm1', sessionId: 's1', t: (key: string) => key }) as ElementLike
  assert.ok(isElement(element))
  assert.equal(element.type, 'button')
  // Icon-only: a single <svg> glyph, no text label (the label is the tooltip).
  assert.equal(element.children.length, 1)
  const glyph = element.children[0] as ElementLike
  assert.equal(glyph.type, 'svg')
  assert.equal(collectText(element).join('').trim(), '')
  assert.equal(typeof element.props?.title, 'string')
  assert.ok(String(element.props?.title).length > 0)
  // No session → no button (the slot's inject face is required).
  assert.equal(action!.component({ messageId: 'm1', t: (k: string) => k }), null)
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

test('standalone enable/disable toggles are a bordered pill in both states', () => {
  // Regression: the auto-warmup / auto-translate rows carry one state button
  // outside a segment group; the bare segBtn/segBtnActive entries left the OFF
  // state transparent and borderless ("启用" rendered as plain text). The
  // toggle is now a class-based pill with a hover state and a filled ON state.
  assert.match(source, /\.agy-toggle\s*\{/)
  assert.match(source, /border: 1px solid var\(--dsw-alias-border-l3/)
  assert.match(source, /\.agy-toggle\[data-on="true"\]/)
  assert.match(source, /\.agy-toggle:hover/)
})
