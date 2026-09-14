import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { en, es, ptBR, zh } from '../src/client/locales.ts'

const source = fs.readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')

function loadClient(): { apply: (ctx: unknown) => void; inject: string[] } {
  let loaded: { factory: (require: (id: string) => unknown) => unknown } | undefined
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(value: typeof loaded) { loaded = value } } },
    globalThis: {},
  }, { filename: 'client.js' })
  assert.ok(loaded)
  return loaded.factory((id) => {
    if (id === 'react') return { createElement() {}, useState() { return [0, () => {}] }, useEffect() {}, useRef() { return { current: false } } }
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

test('native locale lifecycle registers, switches, falls back, and cleans up', () => {
  const plugin = loadClient()
  let active = 'en'
  const catalog = new Map([['zh', { id: 'zh' }], ['en', { id: 'en' }]])
  const dictionaries = new Map<string, Record<string, string>>()
  const cleanup: (() => void)[] = []
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
    subscribe() { return () => {} },
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
  active = 'pt-BR'; assert.equal(t('account.add'), 'Adicionar conta Google')
  active = 'es'; assert.equal(t('account.add'), 'Añadir cuenta de Google')
  delete dictionaries.get('agy-link/es')!['account.add']
  assert.equal(t('account.add'), 'Add Google account')
  for (const dispose of cleanup.reverse()) dispose()
  assert.deepEqual([...catalog.keys()], ['zh', 'en'])
  assert.equal(dictionaries.size, 0)
})
