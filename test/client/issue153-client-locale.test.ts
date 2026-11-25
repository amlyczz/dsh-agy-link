// Issue #153 (remaining modules): every user-facing client string must come from
// the locale service. These modules are DOM enhancers, not React components, so
// they read the shared translator bound once in index.ts (client/i18n-bridge.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REPO_ROOT } from '../helpers/paths.ts'
const root = REPO_ROOT

/** String literals containing CJK, ignoring comments. */
function cjkLiterals(rel: string): string[] {
  const src = readFileSync(join(root, rel), 'utf8')
  const noblock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  const hits: string[] = []
  noblock.split(/\r?\n/).forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '')
    const literals = code.match(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g) ?? []
    for (const literal of literals) {
      if (/[\u4e00-\u9fff]/.test(literal)) hits.push(`${rel}:${i + 1} ${literal.slice(0, 60)}`)
    }
  })
  return hits
}

const LOCALIZED = [
  'src/client/toolview/question-card.ts',
  'src/client/toolview/checklist-card.ts',
  'src/client/toolview/extended-cards.ts',
  'src/client/toolview/image-card.ts',
  'src/client/mermaid-render.ts',
  'src/client/compaction.ts',
  'src/client/images/lightbox.ts',
  'src/client/images/scanner.ts',
  'src/client/images/audio.ts',
  'src/client/embed.ts',
  'src/client/decisions.ts',
]

test('issue #153: the localized client modules hold no hardcoded CJK copy', () => {
  for (const rel of LOCALIZED) {
    const hits = cjkLiterals(rel)
    // `代码块` is DSH's own placeholder banner text, matched to DETECT "no real
    // language label" — it must stay verbatim.
    const real = hits.filter((h) => !h.includes('代码块'))
    assert.deepEqual(real, [], `${rel} still hardcodes copy:\n  ${real.join('\n  ')}`)
  }
})

test('issue #153: the modules translate through the shared bridge', () => {
  for (const rel of LOCALIZED) {
    const src = readFileSync(join(root, rel), 'utf8')
    assert.ok(
      src.includes('i18n-bridge') || src.includes('activeTranslate'),
      `${rel} must route copy through the shared translator`,
    )
  }
})

test('issue #153: every locale defines the new module keys', () => {
  const keys = [
    'image.previewChip', 'image.playChip', 'image.zoomHint', 'image.lightboxHint',
    'audio.toggleTitle', 'audio.listenChip', 'audio.openBtn',
    'embed.collapse', 'embed.expand', 'embed.source',
    'file.openedInSidebar', 'file.openFailed', 'file.notFound',
    'lightbox.zoomIn', 'lightbox.close', 'lightbox.loading', 'lightbox.copyPath',
    'lightbox.copyImage', 'lightbox.copyImageChip', 'lightbox.imageCopied', 'lightbox.copyImageFailed',
    'mermaid.viewSource', 'mermaid.parseFailed',
    'compaction.contextCompacted',
    'question.insert', 'question.recorded',
  ]
  for (const file of ['en', 'zh', 'es', 'ptBR']) {
    const table = readFileSync(join(root, 'src/client/locales', file + '.ts'), 'utf8')
    for (const key of keys) {
      assert.ok(table.includes("'" + key + "'"), file + ' is missing ' + key)
    }
  }
})

test('issue #153: the English table stays ASCII for these keys', () => {
  const en = readFileSync(join(root, 'src/client/locales/en.ts'), 'utf8')
  for (const line of en.split('\n')) {
    if (!/'(image|audio|embed|file|lightbox|mermaid|compaction|question)\./.test(line)) continue
    assert.equal(/[\u4e00-\u9fff]/.test(line), false, 'English copy must not contain CJK: ' + line.trim())
  }
})

test('issue #153: the bridge falls back to English copy instead of a bare key', async () => {
  const { translateOr, resetTranslatorForTest, bindTranslator } = await import('../../src/client/i18n-bridge.ts')
  resetTranslatorForTest()
  assert.equal(translateOr('lightbox.zoomIn', 'Zoom in'), 'Zoom in', 'no binding → English default')
  assert.equal(translateOr('file.openFailed', 'Could not open: {error}', { error: 'x' }), 'Could not open: x')
  // A host whose locale returns the key itself must not leak the key either.
  bindTranslator({ locale: { bind: () => (key: string) => key } })
  assert.equal(translateOr('lightbox.zoomIn', 'Zoom in'), 'Zoom in')
  // A working locale wins.
  bindTranslator({ locale: { bind: () => (key: string) => (key === 'lightbox.zoomIn' ? 'Acercar' : key) } })
  assert.equal(translateOr('lightbox.zoomIn', 'Zoom in'), 'Acercar')
  resetTranslatorForTest()
})
