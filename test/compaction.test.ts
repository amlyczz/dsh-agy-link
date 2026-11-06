import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatTokenCount,
  calcTokenReduction,
  formatCompactionSummary,
  renderCompactionMarker,
} from '../src/common/compaction.ts'
import { scanAndEnhanceCompactionCards } from '../src/client/compaction.ts'
import { calcPromptTokens } from '../src/host/adapter.ts'

test('formatTokenCount formats token counts into human-friendly units', () => {
  assert.equal(formatTokenCount(0), '0')
  assert.equal(formatTokenCount(-50), '0')
  assert.equal(formatTokenCount(450), '450')
  assert.equal(formatTokenCount(1000), '1k')
  assert.equal(formatTokenCount(14200), '14.2k')
  assert.equal(formatTokenCount(128500), '128.5k')
  assert.equal(formatTokenCount(1000000), '1M')
  assert.equal(formatTokenCount(1500000), '1.5M')
})

test('calcTokenReduction calculates percentage reduction correctly', () => {
  assert.equal(calcTokenReduction(100000, 10000), '-90%')
  assert.equal(calcTokenReduction(128500, 14200), '-89%')
  assert.equal(calcTokenReduction(50000, 25000), '-50%')
  assert.equal(calcTokenReduction(1000, 1000), '-0%')
  assert.equal(calcTokenReduction(0, 1000), '-0%')
})

test('formatCompactionSummary renders the transition with reduction', () => {
  assert.equal(formatCompactionSummary(128500, 14200), '128.5k → 14.2k tokens (-89%)')
  assert.equal(formatCompactionSummary(50000, 5000), '50k → 5k tokens (-90%)')
})

test('renderCompactionMarker builds structured markdown link marker', () => {
  const marker = renderCompactionMarker({
    beforeTokens: 128500,
    afterTokens: 14200,
    items: 18,
    summary: 'Retained database config and auth setup.',
  })

  assert.ok(marker.startsWith('> ['))
  assert.ok(marker.includes('#agy-compaction-card?'))
  assert.ok(marker.includes('before=128500'))
  assert.ok(marker.includes('after=14200'))
  assert.ok(marker.includes('items=18'))
  assert.ok(marker.includes('128.5k → 14.2k tokens (-89%)'))
  assert.ok(marker.includes('Retained%20database%20config%20and%20auth%20setup.'))
})

test('calcPromptTokens computes total prompt context accounting for cache read and write', () => {
  assert.equal(calcPromptTokens(undefined), undefined)
  assert.equal(calcPromptTokens(null), undefined)
  assert.equal(calcPromptTokens({}), undefined)

  // Only input tokens
  assert.equal(calcPromptTokens({ input_tokens: 4500 }), 4500)

  // Input + Cache Read + Cache Write (e.g. Gemini / AGY turn with large cache)
  const full = calcPromptTokens({
    input_tokens: 2482,
    cache_read_tokens: 241021,
    cache_write_tokens: 0,
    output_tokens: 7065,
  })
  assert.equal(full, 243503)
})

/** Minimal DOM Element implementation for testing client-side enhancement. */
type TestEl = {
  tagName: string
  className: string
  innerHTML: string
  textContent: string
  dataset: Record<string, string | undefined>
  style: Record<string, string>
  children: TestEl[]
  parentNode: TestEl | null
  parentElement: TestEl | null
  readonly nextElementSibling: TestEl | null
  listeners: Record<string, ((e: { stopPropagation(): void }) => void)[]>
  getAttribute(name: string): string | null
  setAttribute(name: string, val: string): void
  addEventListener(event: string, handler: (e: { stopPropagation(): void }) => void): void
  replaceChildren(...nodes: TestEl[]): void
  replaceWith(...nodes: TestEl[]): void
  replaceChild(newChild: TestEl, oldChild: TestEl): TestEl
  removeChild(child: TestEl): TestEl
  remove(): void
  appendChild(child: TestEl): TestEl
  querySelectorAll(sel: string): TestEl[]
  click(): void
}

function makeTestEl(tagName: string, className = ''): TestEl {
  const attributes: Record<string, string> = {}
  const el: TestEl = {
    tagName: tagName.toUpperCase(),
    className,
    innerHTML: '',
    textContent: '',
    dataset: {},
    style: {},
    children: [],
    parentNode: null,
    parentElement: null,
    get nextElementSibling(): TestEl | null {
      if (!el.parentNode) return null
      const idx = el.parentNode.children.indexOf(el)
      if (idx >= 0 && idx + 1 < el.parentNode.children.length) {
        return el.parentNode.children[idx + 1] ?? null
      }
      return null
    },
    listeners: {},
    getAttribute(name: string): string | null {
      return attributes[name] ?? null
    },
    setAttribute(name: string, val: string): void {
      attributes[name] = val
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        el.dataset[key] = val
      }
    },
    addEventListener(event: string, handler: (e: { stopPropagation(): void }) => void): void {
      el.listeners[event] = el.listeners[event] || []
      el.listeners[event].push(handler)
    },
    replaceChildren(...nodes: TestEl[]): void {
      el.children = []
      for (const n of nodes) el.appendChild(n)
    },
    replaceWith(...nodes: TestEl[]): void {
      if (!el.parentNode) return
      const p = el.parentNode
      const idx = p.children.indexOf(el)
      if (idx >= 0) {
        p.children.splice(idx, 1, ...nodes)
        for (const n of nodes) {
          n.parentNode = p
          n.parentElement = p
        }
      }
      el.parentNode = null
      el.parentElement = null
    },
    replaceChild(newChild: TestEl, oldChild: TestEl): TestEl {
      const idx = el.children.indexOf(oldChild)
      if (idx >= 0) {
        el.children[idx] = newChild
        newChild.parentNode = el
        newChild.parentElement = el
        oldChild.parentNode = null
        oldChild.parentElement = null
      }
      return oldChild
    },
    removeChild(child: TestEl): TestEl {
      const idx = el.children.indexOf(child)
      if (idx >= 0) {
        el.children.splice(idx, 1)
        child.parentNode = null
        child.parentElement = null
      }
      return child
    },
    remove(): void {
      if (el.parentNode) {
        el.parentNode.removeChild(el)
      }
    },
    appendChild(child: TestEl): TestEl {
      child.parentNode = el
      child.parentElement = el
      el.children.push(child)
      return child
    },
    querySelectorAll(sel: string): TestEl[] {
      const results: TestEl[] = []
      const match = (item: TestEl): boolean => {
        if (sel === '.agy-compaction-card:not([data-agy-compaction-rendered="true"])') {
          return item.className.includes('agy-compaction-card') && item.getAttribute('data-agy-compaction-rendered') !== 'true'
        }
        if (sel === 'a[href*="#agy-compaction"]:not([data-agy-compaction-rendered="true"])') {
          return item.tagName === 'A' && (item.getAttribute('href') || '').includes('#agy-compaction') && item.getAttribute('data-agy-compaction-rendered') !== 'true'
        }
        if (sel === 'p:not([data-agy-compaction-rendered="true"])') {
          return item.tagName === 'P' && item.getAttribute('data-agy-compaction-rendered') !== 'true'
        }
        return false
      }
      const walk = (node: TestEl) => {
        for (const c of node.children) {
          if (match(c)) results.push(c)
          walk(c)
        }
      }
      walk(el)
      return results
    },
    click(): void {
      const handlers = el.listeners['click'] || []
      for (const h of handlers) h({ stopPropagation() {} })
    },
  }
  return el
}

test('client scanAndEnhanceCompactionCards transforms modern markdown anchor into interactive native card', () => {
  const root = makeTestEl('div')
  const blockquote = makeTestEl('blockquote')
  const p = makeTestEl('p')
  const anchor = makeTestEl('a')
  anchor.setAttribute('href', '#agy-compaction?before=243500&after=200&items=18&summary=' + encodeURIComponent('Decisions retained.'))
  anchor.textContent = '✂️ 上下文已压缩 · 243.5k → 200 tokens (-100%)'
  p.appendChild(anchor)
  blockquote.appendChild(p)
  root.appendChild(blockquote)

  const origDoc = (globalThis as unknown as { document?: unknown }).document
  ;(globalThis as unknown as { document: unknown }).document = {
    createElement(tag: string) {
      return makeTestEl(tag)
    },
    documentElement: { lang: 'zh-CN' },
  }

  try {
    scanAndEnhanceCompactionCards(root as unknown as ParentNode)

    assert.equal(root.children.length, 1)
    const card = root.children[0]!
    assert.ok(card.className.includes('agy-compaction-card'))
    assert.equal(card.getAttribute('data-agy-compaction-rendered'), 'true')

    const row = card.children[0]!
    assert.ok(row.className.includes('agy-compaction-row'))
    assert.equal(row.getAttribute('data-state'), 'collapsed')

    const button = row.children.find((c) => c.className.includes('agy-compaction-button'))!
    const body = row.children.find((c) => c.className.includes('agy-compaction-body'))!
    assert.ok(button.innerHTML.includes('上下文已压缩'))
    assert.ok(button.innerHTML.includes('243.5k → 200 tokens (-100%)'))
    assert.equal(body.style.display, 'none')

    // Click to expand
    button.click()
    assert.equal(row.getAttribute('data-state'), 'expanded')
    assert.equal(body.style.display, 'block')

    // Click again to collapse
    button.click()
    assert.equal(row.getAttribute('data-state'), 'collapsed')
    assert.equal(body.style.display, 'none')
  } finally {
    ;(globalThis as unknown as { document: unknown }).document = origDoc
  }
})

test('client scanAndEnhanceCompactionCards transforms legacy HTML marker into interactive native card', () => {
  const root = makeTestEl('div')
  const card = makeTestEl('div', 'agy-compaction-card')
  card.setAttribute('data-before', '128500')
  card.setAttribute('data-after', '14200')
  card.setAttribute('data-items', '18')
  card.setAttribute('data-summary', encodeURIComponent('Decisions retained.'))
  root.appendChild(card)

  const origDoc = (globalThis as unknown as { document?: unknown }).document
  ;(globalThis as unknown as { document: unknown }).document = {
    createElement(tag: string) {
      return makeTestEl(tag)
    },
    documentElement: { lang: 'zh-CN' },
  }

  try {
    scanAndEnhanceCompactionCards(root as unknown as ParentNode)

    assert.equal(card.getAttribute('data-agy-compaction-rendered'), 'true')
    assert.equal(card.children.length, 1)

    const row = card.children[0]!
    assert.ok(row.className.includes('agy-compaction-row'))
    assert.equal(row.getAttribute('data-state'), 'collapsed')

    const button = row.children.find((c) => c.className.includes('agy-compaction-button'))!
    const body = row.children.find((c) => c.className.includes('agy-compaction-body'))!
    assert.ok(button.innerHTML.includes('上下文已压缩'))
    assert.ok(button.innerHTML.includes('128.5k → 14.2k tokens (-89%)'))
    assert.equal(body.style.display, 'none')

    button.click()
    assert.equal(row.getAttribute('data-state'), 'expanded')
    assert.equal(body.style.display, 'block')
  } finally {
    ;(globalThis as unknown as { document: unknown }).document = origDoc
  }
})

test('client scanAndEnhanceCompactionCards transforms legacy escaped <p> block into card', () => {
  const root = makeTestEl('div')
  const p1 = makeTestEl('p')
  p1.textContent = '<div class="agy-compaction-card" data-before="4641" data-after="205" data-items="2118" data-summary="%23%23%20summary">'
  const bq = makeTestEl('blockquote')
  bq.textContent = '✂️ 上下文已压缩 · 4.6k → 205 tokens (-96%)'
  const p2 = makeTestEl('p')
  p2.textContent = '</div>'

  root.appendChild(p1)
  root.appendChild(bq)
  root.appendChild(p2)

  const origDoc = (globalThis as unknown as { document?: unknown }).document
  ;(globalThis as unknown as { document: unknown }).document = {
    createElement(tag: string) {
      return makeTestEl(tag)
    },
    documentElement: { lang: 'zh-CN' },
  }

  try {
    scanAndEnhanceCompactionCards(root as unknown as ParentNode)

    assert.equal(root.children.length, 1)
    const card = root.children[0]!
    assert.ok(card.className.includes('agy-compaction-card'))
    const row = card.children[0]!
    const button = row.children.find((c) => c.className.includes('agy-compaction-button'))!
    assert.ok(button.innerHTML.includes('4.6k → 205 tokens (-96%)'))
  } finally {
    ;(globalThis as unknown as { document: unknown }).document = origDoc
  }
})

test('client compaction card tolerates a malformed data-summary without throwing', () => {
  const root = makeTestEl('div')
  const card = makeTestEl('div', 'agy-compaction-card')
  card.setAttribute('data-before', '1000')
  card.setAttribute('data-after', '400')
  card.setAttribute('data-items', '2')
  card.setAttribute('data-summary', '%E0%A4%A')
  root.appendChild(card)

  const origDoc = (globalThis as unknown as { document?: unknown }).document
  ;(globalThis as unknown as { document: unknown }).document = {
    createElement(tag: string) {
      return makeTestEl(tag)
    },
    documentElement: { lang: 'zh-CN' },
  }
  try {
    assert.doesNotThrow(() => scanAndEnhanceCompactionCards(root as unknown as ParentNode))
    assert.equal(card.getAttribute('data-agy-compaction-rendered'), 'true')
    assert.equal(card.children.length, 1, 'card still renders, just without a digest')
  } finally {
    ;(globalThis as unknown as { document: unknown }).document = origDoc
  }
})

test('EventMapper prepends compaction card chunk when compactionNotice is set', async () => {
  const { EventMapper } = await import('../src/host/mapper.ts')
  const mapper = new EventMapper({
    runId: 'r1',
    cutOnTool: true,
    compactionNotice: {
      beforeTokens: 128500,
      afterTokens: 14200,
      items: 18,
      summary: 'Retained database config and auth setup.',
    },
  })

  const chunks = [...mapper.map({
    kind: 'step',
    stepKey: '1',
    stepKind: 'text',
    text: 'Hello world',
  } as never, 0)]

  const textDeltas = chunks.filter((c) => c.type === 'text-delta') as Array<{ type: 'text-delta'; text?: string }>
  const fullText = textDeltas.map((d) => d.text ?? '').join('')
  assert.ok(fullText.includes('#agy-compaction-card?'))
  assert.ok(fullText.includes('128.5k → 14.2k tokens (-89%)'))
  assert.ok(fullText.includes('Retained%20database%20config%20and%20auth%20setup.'))
  assert.ok(fullText.includes('Hello world'))
})
