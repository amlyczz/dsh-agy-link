// Regression tests for issue #152 (part 1): an account label must be editable
// from the console, and the edit must survive as a user-chosen alias.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not the pathname property: on Windows the latter yields
// "/D:/..." and every join() below then resolves to D:\\D:\\...
import { REPO_ROOT } from '../helpers/paths.ts'
const root = REPO_ROOT

test('issue #152: the pool exposes an alias route with input validation', () => {
  const src = readFileSync(join(root, 'src/transport/http/routes/pool.ts'), 'utf8')
  assert.match(src, /path: '\/plugins\/agy-link\/pool\/alias'/)
  assert.match(src, /alias must not be empty/)
  assert.match(src, /alias is too long/)
  assert.match(src, /account not found/)
})

test('issue #152: a user-chosen alias clears the "built-in default" flag', () => {
  // `defaultAlias` is what makes the card render a GENERATED label; a manual
  // rename must drop it, or the typed label would never be displayed.
  const src = readFileSync(join(root, 'src/domain/accounts/admin.ts'), 'utf8')
  const body = src.slice(src.indexOf('setAccountAlias('), src.indexOf('setAccountEnabled('))
  assert.match(body, /acc\.alias = alias\.trim\(\)/)
  assert.match(body, /acc\.defaultAlias = false/)
})

test('issue #152: the panel offers an inline rename that calls the host', () => {
  const panel = readFileSync(join(root, 'src/client/sections/AccountsPanel.ts'), 'utf8')
  assert.match(panel, /renderAliasEditor/)
  assert.match(panel, /handlers\.saveAlias\(acc\.id\)/)
  // The label itself is the affordance (no standalone Rename button): clicking
  // it opens the editor, and the rename copy rides along as its tooltip.
  assert.match(panel, /agy-card-alias/)
  assert.match(panel, /onClick: \(\) => setEditingAliasId\(isEditingAlias \? null : acc\.id\)/)
  assert.match(panel, /t\('account\.renameTitle'\)/)
  assert.doesNotMatch(panel, /\}, ` \$\{t\('account\.rename'\)\}`\)/, 'no standalone Rename button may come back')
  const hooks = readFileSync(join(root, 'src/client/hooks/useAccounts.ts'), 'utf8')
  assert.match(hooks, /postPool\('alias'/)
})

test('issue #152: every locale carries the rename copy', () => {
  for (const file of ['en', 'zh', 'es', 'ptBR']) {
    const table = readFileSync(join(root, 'src/client/locales', file + '.ts'), 'utf8')
    for (const key of ['account.rename', 'account.renameTitle', 'account.renamePlaceholder', 'account.renamed', 'account.renameEmpty']) {
      assert.ok(table.includes("'" + key + "'"), file + ' is missing ' + key)
    }
  }
})
