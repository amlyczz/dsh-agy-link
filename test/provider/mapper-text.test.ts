import assert from 'node:assert/strict'
import { test } from 'node:test'
import { splitPendingMarkdownLink } from '../../src/provider/mapper/text.ts'


// issue #202: a `[label](file:///...)` link split across stream chunks never
// gets rewritten by normalizeFileLinks, so DSH renders plain text instead of a
// blue file link. The unterminated tail must be held until it closes.
test('splitPendingMarkdownLink holds an unterminated link tail', () => {
  assert.deepEqual(splitPendingMarkdownLink('see [a](file:///x'), { ready: 'see ', pending: '[a](file:///x' })
  // A closed link passes straight through.
  assert.deepEqual(splitPendingMarkdownLink('see [a](file:///x) done'), { ready: 'see [a](file:///x) done', pending: '' })
  // No link at all.
  assert.deepEqual(splitPendingMarkdownLink('plain text'), { ready: 'plain text', pending: '' })
  // Labels belong to the held fragment.
  assert.deepEqual(splitPendingMarkdownLink('x [the label](/Users/a'), { ready: 'x ', pending: '[the label](/Users/a' })
  // Never buffer unboundedly: a lone '[' far from the tail is emitted.
  const huge = '[' + 'a'.repeat(5000)
  assert.equal(splitPendingMarkdownLink(huge).pending, '')
})
