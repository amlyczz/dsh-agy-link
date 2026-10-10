// Mermaid fence classification (client-side). The scanner keys off the
// md-code-block banner infostring, which is the raw fence language.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMermaidFence, looksLikeMermaidSource, isMermaidBlock } from '../src/client/mermaid.ts'

test('isMermaidFence accepts the mermaid fence aliases', () => {
  assert.equal(isMermaidFence('mermaid'), true)
  assert.equal(isMermaidFence('Mermaid'), true)
  assert.equal(isMermaidFence('  MERMAID  '), true)
  assert.equal(isMermaidFence('mermaidjs'), true)
  assert.equal(isMermaidFence('mermaid-x'), true)
})

test('isMermaidFence rejects ordinary languages', () => {
  for (const lang of ['typescript', 'js', 'json', 'bash', 'text', '', 'python']) {
    assert.equal(isMermaidFence(lang), false, lang)
  }
})

test('looksLikeMermaidSource sniffs diagram syntax off the first line', () => {
  assert.equal(looksLikeMermaidSource('flowchart TD\n  A --> B'), true)
  assert.equal(looksLikeMermaidSource('graph LR\n  A --> B'), true)
  assert.equal(looksLikeMermaidSource('sequenceDiagram\n  A->>B: hi'), true)
  assert.equal(looksLikeMermaidSource('\n\n  erDiagram\n    USER ||--o{ POST : has'), true)
  assert.equal(looksLikeMermaidSource('const x = 1'), false)
  assert.equal(looksLikeMermaidSource(''), false)
  assert.equal(looksLikeMermaidSource('graphite plot'), false, 'graph alone is not mermaid')
})

test('isMermaidBlock recognizes mermaid fence or sniffs unrecognized code blocks', () => {
  assert.equal(isMermaidBlock('mermaid', 'flowchart TD\n  A --> B'), true)
  assert.equal(isMermaidBlock('代码块', 'flowchart TD\n  A --> B'), true)
  assert.equal(isMermaidBlock('code', 'flowchart TD\n  A --> B'), true)
  assert.equal(isMermaidBlock('', 'sequenceDiagram\n  Alice->>Bob: Hello'), true)
  assert.equal(isMermaidBlock('typescript', 'flowchart TD\n  A --> B'), false)
  assert.equal(isMermaidBlock('python', 'graph LR\n  A --> B'), false)
  assert.equal(isMermaidBlock('代码块', 'const foo = "bar"'), false)
})

test('MERMAID_CSS suppresses leaked mermaid error elements and bomb SVGs at body level', async () => {
  const { MERMAID_CSS } = await import('../src/client/mermaid.ts')
  assert.match(MERMAID_CSS, /body > \[id\^="dagy-mmd"\]/)
  assert.match(MERMAID_CSS, /body > \[id\^="iagy-mmd"\]/)
  assert.match(MERMAID_CSS, /\.error-icon/)
  assert.match(MERMAID_CSS, /\.error-text/)
  assert.match(MERMAID_CSS, /display:\s*none\s*!important/)
})

test('cleanupTempElements sweeps leaked temp containers from DOM', async () => {
  const { cleanupTempElements } = await import('../src/client/mermaid.ts')
  const removed: string[] = []
  const elements = new Map<string, { remove: () => void }>()

  const makeEl = (id: string) => {
    const el = {
      id,
      remove: () => {
        removed.push(id)
        elements.delete(id)
      },
    }
    elements.set(id, el)
    return el
  }

  makeEl('dagy-mmd-1')
  makeEl('iagy-mmd-1')
  makeEl('agy-mmd-1')
  makeEl('dagy-mmd-stray')

  const origDoc = (globalThis as unknown as { document?: unknown }).document
  try {
    ;(globalThis as unknown as { document: unknown }).document = {
      getElementById: (id: string) => elements.get(id) ?? null,
      querySelectorAll: (sel: string) => {
        if (sel.includes('body >')) {
          return Array.from(elements.values())
        }
        return []
      },
    }
    cleanupTempElements('agy-mmd-1')
    assert.ok(removed.includes('dagy-mmd-1'))
    assert.ok(removed.includes('iagy-mmd-1'))
    assert.ok(removed.includes('agy-mmd-1'))
    assert.ok(removed.includes('dagy-mmd-stray'))
  } finally {
    ;(globalThis as unknown as { document?: unknown }).document = origDoc
  }
})

