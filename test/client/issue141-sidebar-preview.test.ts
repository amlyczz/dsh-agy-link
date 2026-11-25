// Regression tests for issue #141: file links must open in the right Sidebar's
// document preview when it is registered, instead of always falling back to the
// OS opener.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canPreviewFiles, normalizeLocalPath } from '../../src/client/images/scanner.ts'

const PREVIEW_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview'

function ctxWith(tabs: unknown): unknown {
  return { get: (key: string) => (key === 'sidebarRightTabs' ? tabs : undefined) }
}

test('issue #141: an entries() registry containing the preview id enables preview', () => {
  // `get()` is keyed by kind, so the old id lookup always missed.
  assert.equal(canPreviewFiles(ctxWith({ entries: () => [{ id: 'browser' }, { id: PREVIEW_ID }] })), true)
})

test('issue #141: the kind-based get() fallback confirms the id, not just the kind', () => {
  assert.equal(canPreviewFiles(ctxWith({ get: (kind: string) => (kind === 'text' ? { id: PREVIEW_ID } : undefined) })), true)
  // Another 'text' tab is NOT the document preview.
  assert.equal(canPreviewFiles(ctxWith({ get: (kind: string) => (kind === 'text' ? { id: 'my-own-text-tab' } : undefined) })), false)
})

test('issue #141: a host without the preview type keeps the OS opener', () => {
  assert.equal(canPreviewFiles(ctxWith({ entries: () => [{ id: 'browser' }] })), false)
  assert.equal(canPreviewFiles(ctxWith(undefined)), false)
  assert.equal(canPreviewFiles(undefined), false)
})

test('issue #141: an encoded href normalizes to the same path the session cwd uses', () => {
  assert.equal(normalizeLocalPath('file:///C:/a%20b/c.md'), 'C:/a b/c.md')
  assert.equal(normalizeLocalPath('W:\\Bio%20Fuel%20Cell\\x.md#L12'), 'W:/Bio Fuel Cell/x.md')
  // %5C is an encoded backslash and must become a separator.
  assert.equal(normalizeLocalPath('C:%5Cdavinci%5Cx.png'), 'C:/davinci/x.png')
  // A literal percent that is not valid percent-encoding is preserved.
  assert.equal(normalizeLocalPath('C:\\100%done\\x.md'), 'C:/100%done/x.md')
  // An encoded question mark belongs to the NAME, so it survives the split.
  assert.equal(normalizeLocalPath('C:\\a%3Fb\\x.md'), 'C:/a?b/x.md')
  // Query/hash suffixes are still dropped, and ./ prefixes trimmed.
  assert.equal(normalizeLocalPath('./docs/x.md?v=1'), 'docs/x.md')
})
