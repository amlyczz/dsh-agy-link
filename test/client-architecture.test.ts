import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Phase 4 moved the settings panel and account console out of the 3,000-line
// index.ts. These guards keep the split from silently collapsing again, and
// they follow the code (the four presentation guard tests were repointed to
// the new source-of-truth modules for the same reason).
const root = join(fileURLToPath(import.meta.url), '..', '..')
const client = join(root, 'src/client')
const indexSource = readFileSync(join(client, 'index.ts'), 'utf8')

test('client index.ts stays a wiring file', () => {
  const lines = indexSource.split('\n').length
  assert.ok(lines <= 300, `src/client/index.ts grew back to ${lines} lines`)
  assert.match(indexSource, /apply\s*\(/, 'apply still exists')
  assert.doesNotMatch(indexSource, /const AgySettingsSection\s*=\s*\(props/, 'the settings section lives in sections/')
})

test('the split modules exist', () => {
  for (const rel of [
    'api.ts', 'status.ts', 'icons.ts', 'styles.ts',
    'hooks/useConfig.ts', 'hooks/useAccounts.ts', 'hooks/useAuthFlow.ts',
    'sections/SettingsSection.ts', 'sections/AccountsPanel.ts',
    'sections/ModelsPanel.ts', 'sections/QuotaPanel.ts',
    'ui/Button.ts', 'ui/Modal.ts', 'ui/Row.ts', 'ui/Select.ts', 'ui/Toggle.ts',
  ]) {
    assert.ok(existsSync(join(client, rel)), `missing ${rel}`)
  }
})

test('no inline button styling outside ui/', () => {
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'ui') continue
        walk(p)
      } else if (p.endsWith('.ts')) {
        const src = readFileSync(p, 'utf8')
        if (/h\('button',\s*\{[^}]*style:/s.test(src)) offenders.push(p)
      }
    }
  }
  walk(client)
  assert.deepEqual(offenders, [], 'buttons must use ui/Button, not inline style objects')
})
