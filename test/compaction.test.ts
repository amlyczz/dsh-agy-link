import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatTokenCount,
  calcTokenReduction,
  formatCompactionSummary,
  renderCompactionMarker,
} from '../src/common/compaction.ts'
import { scanAndEnhanceCompactionCards } from '../src/client/compaction.ts'

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

test('renderCompactionMarker builds structured card with data attributes and fallback markdown', () => {
  const marker = renderCompactionMarker({
    beforeTokens: 128500,
    afterTokens: 14200,
    items: 18,
    summary: 'Retained database config and auth setup.',
  })

  assert.ok(marker.includes('class="agy-compaction-card"'))
  assert.ok(marker.includes('data-before="128500"'))
  assert.ok(marker.includes('data-after="14200"'))
  assert.ok(marker.includes('data-items="18"'))
  assert.ok(marker.includes('128.5k → 14.2k tokens (-89%)'))
  assert.ok(marker.includes('Retained%20database%20config%20and%20auth%20setup.'))
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
  listeners: Record<string, ((e: { stopPropagation(): void }) => void)[]>
  getAttribute(name: string): string | null
  setAttribute(name: string, val: string): void
  addEventListener(event: string, handler: (e: { stopPropagation(): void }) => void): void
  replaceChildren(...nodes: TestEl[]): void
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
    appendChild(child: TestEl): TestEl {
      child.parentNode = el
      el.children.push(child)
      return child
    },
    querySelectorAll(sel: string): TestEl[] {
      const results: TestEl[] = []
      const match = (item: TestEl): boolean => {
        if (sel === '.agy-compaction-card:not([data-agy-compaction-rendered="true"])') {
          return item.className.includes('agy-compaction-card') && item.getAttribute('data-agy-compaction-rendered') !== 'true'
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

test('client scanAndEnhanceCompactionCards transforms marker into interactive native card', () => {
  // Set up mock document
  const root = makeTestEl('div')
  const card = makeTestEl('div', 'agy-compaction-card')
  card.setAttribute('data-before', '128500')
  card.setAttribute('data-after', '14200')
  card.setAttribute('data-items', '18')
  card.setAttribute('data-summary', encodeURIComponent('Decisions retained.'))
  root.appendChild(card)

  // Mock global document
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

    const row = card.children[0]
    assert.ok(row, 'Compaction row must exist')
    assert.ok(row.className.includes('agy-compaction-row'))
    assert.equal(row.getAttribute('data-state'), 'collapsed')

    // Find button and body
    const button = row.children.find((c) => c.className.includes('agy-compaction-button'))
    const body = row.children.find((c) => c.className.includes('agy-compaction-body'))
    assert.ok(button, 'Compaction button must be generated')
    assert.ok(body, 'Compaction body must be generated')

    // Button header checks
    assert.ok(button.innerHTML.includes('上下文已压缩'))
    assert.ok(button.innerHTML.includes('128.5k → 14.2k tokens (-89%)'))
    assert.equal(body.style.display, 'none')

    // Click to expand
    button.click()
    assert.equal(row.getAttribute('data-state'), 'expanded')
    assert.equal(body.style.display, 'block')

    // Click again to collapse
    button.click()
    assert.equal(row.getAttribute('data-state'), 'collapsed')
    assert.equal(body.style.display, 'none')

    // Idempotency: second scan does not re-wrap or duplicate
    scanAndEnhanceCompactionCards(root as unknown as ParentNode)
    assert.equal(card.children.length, 1)
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
  assert.ok(fullText.includes('class="agy-compaction-card"'))
  assert.ok(fullText.includes('128.5k → 14.2k tokens (-89%)'))
  assert.ok(fullText.includes('Retained%20database%20config%20and%20auth%20setup.'))
  assert.ok(fullText.includes('Hello world'))
})
