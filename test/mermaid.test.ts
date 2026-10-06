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

