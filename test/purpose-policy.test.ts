import { test } from 'node:test'
import assert from 'node:assert/strict'
import { purposePolicy } from '../src/provider/purpose-policy.ts'

const p = (purpose: 'chat' | 'compaction' | 'session-title' | 'translation' | 'image', isReview = false) =>
  purposePolicy({ purpose, isReview })

test('chat mirrors tools and persists its binding', () => {
  assert.equal(p('chat').aux, false)
  assert.equal(p('chat').mirrorTools, true)
  assert.equal(p('chat').pinLowEffort, false)
  assert.equal(p('chat').persistBinding(false), true)
})

test('background helpers are aux, low effort, no tools, no binding', () => {
  for (const purpose of ['compaction', 'session-title'] as const) {
    assert.equal(p(purpose).aux, true)
    assert.equal(p(purpose).pinLowEffort, true)
    assert.equal(p(purpose).mirrorTools, false)
    assert.equal(p(purpose).persistBinding(false), false)
  }
})

test('review behaves like a background helper regardless of purpose', () => {
  const review = p('chat', true)
  assert.equal(review.aux, true)
  assert.equal(review.pinLowEffort, true)
  assert.equal(review.mirrorTools, false)
  assert.equal(review.persistBinding(false), false)
})

test('translation keeps the caller effort and persists only its own session', () => {
  const t = p('translation')
  assert.equal(t.pinLowEffort, false)
  assert.equal(t.mirrorTools, false)
  assert.equal(t.persistBinding(false), false)
  assert.equal(t.persistBinding(true), true)
})

test('image never persists a binding and keeps the caller effort', () => {
  const i = p('image')
  assert.equal(i.pinLowEffort, false)
  assert.equal(i.mirrorTools, false)
  assert.equal(i.persistBinding(true), false)
})
