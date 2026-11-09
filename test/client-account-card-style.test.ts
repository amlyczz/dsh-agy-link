import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

// Style regressions in the account console are invisible to any behavioural
// test: 0.6.4 shrank every card and capped the email badge at 135px, so users
// saw "q98646558@gm" and a visibly smaller panel. These assertions guard the
// presentation contract directly on the source of truth.
const source = fs.readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')

test('the account email badge is never width-capped into an ellipsis', () => {
  assert.equal(/maxWidth:\s*'135px'/.test(source), false, 'a fixed 135px cap truncates real emails')
  const start = source.indexOf('acc.email ? h(')
  assert.ok(start >= 0, 'email badge still exists')
  const block = source.slice(start, start + 900)
  assert.equal(/maxWidth:\s*'\d+px'/.test(block), false, 'no fixed width cap on the email badge')
  assert.ok(block.includes('title: acc.email'), 'the full address stays available as a tooltip')
})

test('account cards keep comfortable, readable density', () => {
  // Reverting the 0.6.4 compaction: cards were 10px 14px with an 8px gap.
  assert.ok(source.includes("padding: '10px 14px'"), 'card padding is back to the roomy value')
  assert.ok(source.includes("marginBottom: '8px'"), 'card spacing is back to the roomy value')
})

test('quota rows keep aligned columns without shrinking the type', () => {
  const start = source.indexOf('const renderLine')
  assert.ok(start >= 0)
  const block = source.slice(start, start + 2600)
  assert.ok(block.includes("width: '64px'"), 'the window label column stays fixed so bars line up')
  assert.ok(block.includes("width: '150px'"), 'the reset/cooldown cluster stays fixed so bars line up')
  assert.ok(block.includes("fontSize: '11.5px'"), 'the row keeps its pre-compaction font size')
})
