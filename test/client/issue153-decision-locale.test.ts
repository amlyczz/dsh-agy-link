// Regression tests for issue #153: the decision-chip copy must come from the
// locale service, and the text written into the composer must follow the host
// language — an English host used to receive `我选择 …` as its own prompt.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REPO_ROOT } from '../helpers/paths.ts'
const root = REPO_ROOT
const src = readFileSync(join(root, 'src/client/decisions.ts'), 'utf8')

test('issue #153: decisions.ts no longer hardcodes the chip copy', () => {
  for (const literal of ['点击选项快速填入', '我选择', '点击填入:']) {
    assert.equal(src.includes(literal), false, `hardcoded copy still present: ${literal}`)
  }
  // ...and it goes through the shared translator bridge instead.
  assert.match(src, /i18n-bridge/)
  assert.match(src, /translateOr\('decision\.quickFill'/)
  assert.match(src, /translateOr\('decision\.insertPayload'/)
})

test('issue #153: every locale defines the decision keys', () => {
  const keys = ['decision.quickFill', 'decision.insertTooltip', 'decision.insertPayload']
  for (const file of ['en', 'zh', 'es', 'ptBR']) {
    const table = readFileSync(join(root, 'src/client/locales', file + '.ts'), 'utf8')
    for (const key of keys) {
      assert.ok(table.includes("'" + key + "'"), file + ' is missing ' + key)
    }
  }
})

test('issue #153: the English payload never injects Chinese into the prompt', () => {
  const en = readFileSync(join(root, 'src/client/locales/en.ts'), 'utf8')
  const line = en.split('\n').find((l) => l.includes("'decision.insertPayload'")) ?? ''
  assert.match(line, /I choose \{choice\}/)
  assert.equal(/[\u4e00-\u9fff]/.test(line), false, 'the English payload must be pure ASCII copy')
})
