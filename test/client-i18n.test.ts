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
  const registeredSlots: { options: { id: string; label?: string | (() => string); locale?: string } }[] = []
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
      register(options: { id: string; label?: string | (() => string); locale?: string }) { registeredSlots.push({ options }); return () => {} },
    },
  }
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale'])
  plugin.apply(ctx)
  assert.deepEqual([...catalog.keys()], ['zh', 'en', 'pt-BR', 'es'])
  assert.equal(dictionaries.size, 4)
  assert.equal(registeredSlots.length, 2)
  assert.equal(registeredSlots[0]!.options.locale, 'agy-link')
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
  plugin.apply({ locale, effect(callback: () => void) { callback() }, slots: { inject(_name: string, callback: () => void) { callback() }, register(_opts: unknown, registered: (props?: unknown) => unknown) { component = registered; return () => {} } } })
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
