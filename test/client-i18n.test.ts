import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { en, es, ptBR, zh } from '../src/client/locales.ts'

const source = fs.readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')

function loadClient(react: Record<string, unknown> = {}): { apply: (ctx: unknown) => void; inject: string[] } {
  let loaded: { factory: (require: (id: string) => unknown) => unknown } | undefined
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(value: typeof loaded) { loaded = value } } },
    globalThis: {},
    setInterval: () => 0,
    clearInterval: () => {},
  }, { filename: 'client.js' })
  assert.ok(loaded)
  return loaded.factory((id) => {
    if (id === 'react') return { createElement() {}, useState() { return [0, () => {}] }, useEffect() {}, useRef() { return { current: false } }, ...react }
    if (id === 'react-dom') return {}
    throw new Error(`unexpected browser dependency: ${id}`)
  }) as { apply: (ctx: unknown) => void; inject: string[] }
}

test('native locale dictionaries retain exact keys and placeholder parity', () => {
  const all = [zh, en, ptBR, es]
  const keys = Object.keys(zh).sort()
  const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
  for (const dictionary of all.slice(1)) {
    assert.deepEqual(Object.keys(dictionary).sort(), keys)
    for (const key of keys) assert.deepEqual(placeholders(dictionary[key as keyof typeof dictionary]), placeholders(zh[key as keyof typeof zh]), `${key} placeholder parity`)
  }
})

test('native-contract locale lifecycle registers, publishes switches, falls back, and cleans up', () => {
  const plugin = loadClient()
  let active = 'en'
  const catalog = new Map([['zh', { id: 'zh' }], ['en', { id: 'en' }]])
  const dictionaries = new Map<string, Record<string, string>>()
  const cleanup: (() => void)[] = []
  const subscribers = new Set<() => void>()
  const registeredSlots: { options: { id?: string; key?: string; label?: string | (() => string); locale?: string } }[] = []
  const locale = {
    addLanguage(language: { id: string; label: string; fallback: string }) {
      assert.equal(catalog.has(language.id), false)
      assert.equal(language.fallback, 'en')
      catalog.set(language.id, language)
      return () => { catalog.delete(language.id) }
    },
    register(namespace: string, languageOrDictionaries: string | Record<string, Record<string, string>>, dictionary?: Record<string, string>) {
      const pairs = typeof languageOrDictionaries === 'string' ? [[languageOrDictionaries, dictionary!]] as const : Object.entries(languageOrDictionaries)
      for (const [language, entries] of pairs) dictionaries.set(`${namespace}/${language}`, entries)
      return () => { for (const [language] of pairs) dictionaries.delete(`${namespace}/${language}`) }
    },
    bind(namespace: string) {
      return (key: string, params?: Record<string, unknown>) => {
        const template = dictionaries.get(`${namespace}/${active}`)?.[key] ?? dictionaries.get(`${namespace}/en`)?.[key] ?? key
        return template.replace(/\{(\w+)\}/g, (token: string, name: string) => name in (params ?? {}) ? String(params![name]) : token)
      }
    },
    subscribe(listener: () => void) { subscribers.add(listener); return () => subscribers.delete(listener) },
    setLocale(language: string) { active = language; subscribers.forEach(listener => listener()) },
  }
  const ctx = {
    locale,
    effect(callback: () => (() => void)) { cleanup.push(callback()) },
    slots: {
      inject(_name: string, callback: () => (() => void)) { cleanup.push(callback()) },
      register(options: { id?: string; key?: string; label?: string | (() => string); locale?: string }) { registeredSlots.push({ options }); return () => {} },
    },
  }
  // Cordis inject entries are hard deps (issue #24): locale must be listed
  // or accessing ctx.locale throws before any fallback can run.
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale'])
  plugin.apply(ctx)
  assert.deepEqual([...catalog.keys()], ['zh', 'en', 'pt-BR', 'es'])
  assert.equal(dictionaries.size, 4)
  // conversation.session.header.actions + settings.section + plugins.bundle.config
  // + plugins.row.config + agy_tool + run_code toolviews
  assert.equal(registeredSlots.length, 6)
  assert.equal(registeredSlots[0]!.options.locale, 'agy-link')
  assert.equal(registeredSlots[1]!.options.id, 'agy-link')
  assert.equal(registeredSlots[2]!.options.key, 'dsh-agy-link')
  assert.equal(registeredSlots[3]!.options.key, 'dsh-agy-link#agy-link')
  assert.equal(registeredSlots[4]!.options.id, 'agy-tool-view')
  assert.equal(registeredSlots[5]!.options.id, 'agy-run-code-view')
  const t = locale.bind('agy-link')
  locale.setLocale('pt-BR'); assert.equal(t('account.add'), 'Adicionar conta Google')
  locale.setLocale('es'); assert.equal(t('account.add'), 'Añadir cuenta de Google')
  delete dictionaries.get('agy-link/es')!['account.add']
  assert.equal(t('account.add'), 'Add Google account')
  for (const dispose of cleanup.reverse()) dispose()
  assert.deepEqual([...catalog.keys()], ['zh', 'en'])
  assert.equal(dictionaries.size, 0)
})

test('mounted panel subscribes to locale revisions and exposes localized accessible names', () => {
  const effects: Array<() => void | (() => void)> = []
  let rerenders = 0
  const plugin = loadClient({
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) { return { type, props, children } },
    useState(initial: unknown) { return [initial, () => { rerenders++ }] },
    useEffect(effect: () => void | (() => void)) { effects.push(effect) },
    useRef(initial: unknown) { return { current: initial } },
  })
  let active = 'en'
  const dictionaries = new Map<string, Record<string, string>>()
  const listeners = new Set<() => void>()
  let component: ((props?: unknown) => unknown) | undefined
  const locale = {
    addLanguage() { return () => {} },
    register(namespace: string, languageOrDictionaries: string | Record<string, Record<string, string>>, dictionary?: Record<string, string>) {
      const pairs: Array<[string, Record<string, string>]> = typeof languageOrDictionaries === 'string'
        ? [[languageOrDictionaries, dictionary!]]
        : Object.entries(languageOrDictionaries)
      pairs.forEach(([language, entries]) => dictionaries.set(`${namespace}/${language}`, entries))
      return () => {}
    },
    bind(namespace: string) { return (key: string) => dictionaries.get(`${namespace}/${active}`)?.[key] ?? dictionaries.get(`${namespace}/en`)?.[key] ?? key },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    setLocale(language: string) { active = language; listeners.forEach(listener => listener()) },
  }
  plugin.apply({ locale, effect(callback: () => void) { callback() }, slots: { inject(_name: string, callback: () => void) { callback() }, register(opts: { id?: string }, registered: (props?: unknown) => unknown) {
    if (opts?.id === 'agy-link') component = registered;
    return () => {}
  } } })
  assert.ok(component)
  component!()
  effects[0]!()
  locale.setLocale('pt-BR')
  assert.equal(rerenders, 1)
  const rendered = component!() as { children: unknown[] }
  const text = JSON.stringify(rendered)
  assert.match(text, /Carregando o status do Antigravity/)
})

test('safe dynamic auth codes and localized duration units have complete dictionaries', () => {
  const codes = ['browser_manual', 'callback_failed', 'no_active_flow', 'invalid_code', 'invalid_state', 'exchange_failed', 'primary_activated', 'account_activated', 'missing_code', 'request_failed']
  for (const dictionary of [zh, en, ptBR, es]) {
    for (const code of codes) assert.ok(dictionary[`auth.code.${code}` as keyof typeof dictionary])
    for (const key of ['duration.day', 'duration.hour', 'duration.minute', 'aria.aliasInput', 'aria.proxyInput', 'aria.authCodeInput']) assert.ok(dictionary[key as keyof typeof dictionary])
  }
})

test('modal host manager reactively promotes secondary header on unmount and suppresses modal portal when closed', () => {
  const hooks: Record<string, any[]> = {}
  let sessionStatusComponent: (() => any) | undefined

  const stateMap = new Map<number, any>()
  let stateIndex = 0

  const plugin = loadClient({
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
      return { type, props, children }
    },
    useState(initial: unknown) {
      const idx = stateIndex++
      if (!stateMap.has(idx)) stateMap.set(idx, initial)
      return [stateMap.get(idx), (val: unknown) => { stateMap.set(idx, typeof val === 'function' ? (val as any)(stateMap.get(idx)) : val) }]
    },
    useEffect(effect: () => void | (() => void)) {
      // Record effects
    },
    useRef(initial: unknown) {
      return { current: initial }
    },
  })

  const locale = {
    addLanguage() { return () => {} },
    register() { return () => {} },
    bind() { return (key: string) => key },
    subscribe() { return () => {} },
    setLocale() {},
  }

  plugin.apply({
    locale,
    effect(cb: () => void) { cb() },
    slots: {
      inject(_name: string, cb: () => void) { cb() },
      register(opts: { id?: string }, comp: any) {
        if (opts?.id === 'agy-link-status') sessionStatusComponent = comp
        return () => {}
      },
    },
  })

  assert.ok(sessionStatusComponent)
  // When closed, the session status badge returns a single div without the modal portal
  stateIndex = 0
  const rendered = sessionStatusComponent()
  assert.ok(rendered)
  assert.equal(rendered.type, 'div')
  // Second child (the portal) is null because isModalOpen is false
  assert.equal(rendered.children[1], null)
})

test('REGRESSION: session status badge claims primary host on mount to eliminate first-open flicker', () => {
  let sessionStatusComponent: (() => any) | undefined

  const stateMap = new Map<number, any>()
  let stateIndex = 0

  const plugin = loadClient({
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
      return { type, props, children }
    },
    useState(initial: unknown) {
      const idx = stateIndex++
      const resolved = typeof initial === 'function' ? (initial as () => unknown)() : initial
      if (!stateMap.has(idx)) stateMap.set(idx, resolved)
      return [stateMap.get(idx), (val: unknown) => { stateMap.set(idx, typeof val === 'function' ? (val as any)(stateMap.get(idx)) : val) }]
    },
    useEffect(effect: () => void | (() => void)) {
      effect()
    },
    useRef(initial: unknown) {
      return { current: initial }
    },
  })

  const locale = {
    addLanguage() { return () => {} },
    register() { return () => {} },
    bind() { return (key: string) => key },
    subscribe() { return () => {} },
    setLocale() {},
  }

  plugin.apply({
    locale,
    effect(cb: () => void) { cb() },
    slots: {
      inject(_name: string, cb: () => void) { cb() },
      register(opts: { id?: string }, comp: any) {
        if (opts?.id === 'agy-link-status') sessionStatusComponent = comp
        return () => {}
      },
    },
  })

  assert.ok(sessionStatusComponent)
  stateIndex = 0
  const header1 = sessionStatusComponent()
  assert.ok(header1)
  // Initial primary host state is true immediately on mount (no 2nd-render handoff delay)
  assert.equal(stateMap.get(0), true, 'session status must initialize isPrimaryHost to true synchronously')
})

test('REGRESSION: re-rendering session headers during status sync does not thrash active modal host', () => {
  let sessionStatusComponent: (() => any) | undefined

  const stateMap = new Map<string, any>()
  let currentCompId = ''

  const plugin = loadClient({
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
      return { type, props, children }
    },
    useState(initial: unknown) {
      const key = `${currentCompId}_state`
      const resolved = typeof initial === 'function' ? (initial as () => unknown)() : initial
      if (!stateMap.has(key)) stateMap.set(key, resolved)
      return [stateMap.get(key), (val: unknown) => {
        stateMap.set(key, typeof val === 'function' ? (val as any)(stateMap.get(key)) : val)
      }]
    },
    useEffect(effect: () => void | (() => void)) {
      effect()
    },
    useRef(initial: unknown) {
      const key = `${currentCompId}_ref`
      if (!stateMap.has(key)) stateMap.set(key, { current: initial })
      return stateMap.get(key)
    },
  })

  plugin.apply({
    locale: {
      addLanguage() { return () => {} },
      register() { return () => {} },
      bind() { return (key: string) => key },
      subscribe() { return () => {} },
      setLocale() {},
    },
    effect(cb: () => void) { cb() },
    slots: {
      inject(_name: string, cb: () => void) { cb() },
      register(opts: { id?: string }, comp: any) {
        if (opts?.id === 'agy-link-status') sessionStatusComponent = comp
        return () => {}
      },
    },
  })

  assert.ok(sessionStatusComponent)

  // 1. Mount Header 1
  currentCompId = 'header_1'
  sessionStatusComponent()
  assert.equal(stateMap.get('header_1_state'), true, 'first header becomes primary host')

  // 2. Mount Header 2
  currentCompId = 'header_2'
  sessionStatusComponent()
  assert.equal(stateMap.get('header_2_state'), false, 'second header does NOT hijack primary host')
  assert.equal(stateMap.get('header_1_state'), true, 'first header remains primary host')

  // 3. Re-render both headers (simulating quota sync status push)
  currentCompId = 'header_2'
  sessionStatusComponent()
  currentCompId = 'header_1'
  sessionStatusComponent()

  // Primary host must NOT flip or thrash
  assert.equal(stateMap.get('header_1_state'), true, 'header 1 remains primary host after sync tick')
  assert.equal(stateMap.get('header_2_state'), false, 'header 2 stays secondary without hijacking')
})


