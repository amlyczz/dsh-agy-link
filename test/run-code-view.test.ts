import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { runCodeModel, type ToolBlock } from '../src/client/toolview.ts'

const source = fs.readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')

type VNode = { type: unknown; props: Record<string, unknown> | null; children: unknown[] }

/**
 * Load the bundled client with a stubbed React and capture the component a keyed
 * `tool.call.toolview` registration owns, so a render can be walked without a DOM.
 * `open` drives the disclosure state the component reads from `useState`.
 */
function loadClient(options: { open?: boolean } = {}): {
  view: (props: unknown) => unknown
  registrations: { key?: string; id?: string; locale?: string }[]
} {
  const open = options.open ?? false
  let loaded: { factory: (require: (id: string) => unknown) => unknown } | undefined
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(value: typeof loaded) { loaded = value } } },
    globalThis: {},
    setInterval: () => 0,
    clearInterval: () => {},
  }, { filename: 'client.js' })
  assert.ok(loaded)
  const registrations: { key?: string; id?: string; locale?: string }[] = []
  const components = new Map<string, (props: unknown) => unknown>()
  const plugin = loaded.factory((id) => {
    if (id === 'react') {
      return {
        createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): VNode {
          return { type, props, children }
        },
        useState(initial: unknown) { return [open, () => {}] },
        useEffect() {},
        useRef(initial: unknown) { return { current: initial } },
      }
    }
    if (id === 'react-dom') return {}
    throw new Error(`unexpected browser dependency: ${id}`)
  }) as { apply: (ctx: unknown) => void }
  plugin.apply({
    locale: {
      addLanguage() { return () => {} },
      register() { return () => {} },
      bind: () => (key: string) => key,
      subscribe() { return () => {} },
    },
    effect(callback: () => () => void) { callback() },
    slots: {
      inject(_name: string, callback: () => void) { callback() },
      register(opts: { key?: string; id?: string; locale?: string }, component: (props: unknown) => unknown) {
        registrations.push({ key: opts.key, id: opts.id, locale: opts.locale })
        if (opts.key !== undefined) components.set(opts.key, component)
        return () => {}
      },
    },
  })
  const view = components.get('run_code')
  assert.ok(view, 'run_code toolview registered')
  return { view, registrations }
}

/** Flatten a rendered tree into the class names, tags, text and marker it produced. */
function render(view: (props: unknown) => unknown, block: ToolBlock | undefined, t?: (key: string) => string) {
  const classes: string[] = []
  const tags: string[] = []
  let text = ''
  let kind: unknown
  const walk = (node: unknown): void => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node === 'string' || typeof node === 'number') { text += String(node); return }
    const vnode = node as VNode
    if (typeof vnode.type === 'function') { walk((vnode.type as (p: unknown) => unknown)({ ...vnode.props })); return }
    const className = vnode.props?.className
    if (typeof className === 'string' && className !== '') classes.push(className)
    if (vnode.props && 'data-kind' in vnode.props) kind = vnode.props['data-kind']
    tags.push(String(vnode.type))
    walk(vnode.children)
  }
  walk(view({ block, t: t ?? ((key: string) => key) }))
  return { classes, tags, text, kind, has: (name: string) => classes.some((c) => c.split(/\s+/).includes(name)) }
}

function settledRunCode(args: Record<string, unknown>): ToolBlock {
  return {
    kind: 'tool-result',
    call: { name: 'run_code', argsRaw: JSON.stringify(args) },
    content: [],
    isError: false,
  } as unknown as ToolBlock
}

const LONG_CODE = 'const a = 1;\n' + Array.from({ length: 60 }, (_, i) => `const line${i} = ${i};`).join('\n')
const MIRROR_CODE = "// dsh-agy-link mirror: replay recorded agy tool step 4 (view_file)\nreturn await tools['agy_tool']({\"run\":\"abc\",\"step\":4})"

test('runCodeModel: description becomes the row summary', () => {
  const model = runCodeModel(settledRunCode({ code: 'const x = 1;', description: 'Read toolview contract' }))
  assert.equal(model.title, 'Read toolview contract')
  assert.equal(model.code, 'const x = 1;')
})

test('runCodeModel: without a description the first non-empty line is the summary', () => {
  const model = runCodeModel(settledRunCode({ code: '\n\n  const x = 1;\nconst y = 2;' }))
  assert.equal(model.title, 'const x = 1;')
})

test('runCodeModel: keeps the full program, never the 400-char preview slice', () => {
  const model = runCodeModel(settledRunCode({ code: LONG_CODE }))
  assert.ok(model.code.includes('const line59 = 59;'), 'full program retained')
  assert.ok(model.code.length > 400, 'longer than the old truncation budget')
})

test('runCodeModel: non-JSON args fall back to the raw program text', () => {
  const block = { kind: 'tool-result', call: { name: 'run_code', argsRaw: 'not json' }, content: [], isError: false } as unknown as ToolBlock
  assert.equal(runCodeModel(block).code, 'not json')
})

test('run_code toolview renders safely without props', () => {
  const { view } = loadClient()
  // The slot can invoke the view before a block settles; it must not throw.
  const out = render(view, undefined as unknown as ToolBlock)
  assert.ok(out.has('agy-tv-row'), 'row still renders')
  assert.equal(out.kind, 'code')
})

test('run_code toolview declares the locale namespace for its card labels', () => {
  const { registrations } = loadClient()
  const runCode = registrations.find((r) => r.key === 'run_code')
  assert.ok(runCode, 'run_code registration present')
  assert.equal(runCode.locale, 'agy-link', 'locale namespace declared so the t seat resolves code.* labels')
})

test('non-mirror run_code renders the styled code row, not the unstyled legacy wrapper', () => {
  const { view } = loadClient()
  const out = render(view, settledRunCode({ code: LONG_CODE, description: 'Read toolview contract' }), (key) => (key === 'code.title' ? '代码' : key))
  // The legacy minimal wrapper used classes that carry no CSS rule at all.
  assert.equal(out.has('agy-tv-header'), false)
  assert.equal(out.has('agy-tv-badge'), false)
  assert.equal(out.has('agy-tv-pre'), false)
  assert.ok(out.has('agy-tv-row'), 'styled disclosure row')
  assert.ok(out.has('agy-tv-title'), 'styled title')
  assert.ok(out.has('agy-tv-summary'), 'summary slot')
  assert.ok(out.tags.includes('svg'), 'leading icon rendered')
  assert.ok(out.text.includes('代码'), 'localized title from the t seat')
  assert.ok(out.text.includes('Read toolview contract'), 'description shown as summary')
  assert.equal(out.kind, 'code')
})

test('non-mirror run_code hides its body while collapsed and shows the full program when expanded', () => {
  const collapsed = render(loadClient({ open: false }).view, settledRunCode({ code: LONG_CODE }))
  assert.equal(collapsed.has('agy-tv-card-content'), false, 'body absent while collapsed')

  const expanded = render(loadClient({ open: true }).view, settledRunCode({ code: LONG_CODE }))
  assert.ok(expanded.has('agy-tv-card'), 'card body rendered')
  assert.ok(expanded.has('agy-tv-card-content'), 'scrollable program body')
  assert.ok(expanded.has('agy-tv-copy-btn'), 'copy affordance')
  assert.ok(expanded.text.includes('const line59 = 59;'), 'full program, not truncated at 400 chars')
})

test('mirror run_code still renders the native Antigravity card', () => {
  const { view } = loadClient()
  const out = render(view, settledRunCode({ code: MIRROR_CODE, description: 'replay agy tool step 4 · view_file' }))
  // A mirror wrapper must keep its Antigravity classification (view_file -> read)
  // instead of falling into the ordinary run_code code card.
  assert.notEqual(out.kind, 'code', 'mirror programs must not take the ordinary code branch')
  assert.equal(out.kind, 'read', 'mirrored view_file classifies as a read card')
  assert.ok(out.has('agy-tv-row'), 'Antigravity card row')
  assert.ok(out.has('agy-tv-title'), 'Antigravity card title')
  assert.equal(out.has('agy-tv-card-content'), false, 'collapsed Antigravity row hides its body')
})
