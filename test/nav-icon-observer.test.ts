// Regression: the settings-nav icon observer must not wake itself.
//
// Incident (2026-10-23, same scroll-flicker report): installSettingsNavIcon()
// observed `document.body` with `{ childList, subtree, characterData }` but NO
// attributeFilter, while its own sync() writes `data-dsh-agy-nav-icon` onto
// every matching nav row. Each write is an attribute mutation inside the
// observed subtree, so one external DOM change made the observer re-run its
// own pass (measured: 5 self-induced attribute mutations per poke). On the
// host's chat page — which mutates constantly while streaming and scrolling —
// that meant a full `querySelectorAll` sweep of every nav row on a loop.
//
// The fix: observe only the marker attribute (plus childList for re-rendered
// rows) and never observe characterData, which we never act on.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
// Normalize CRLF -> LF: Windows checkouts under core.autocrlf=true hand us
// `\r\n`, while every marker this test slices on is written as `\n`. Without
// normalization the `'\n}\n'` function-closing search silently misses.
// Phase 4 moved the settings-nav icon installer into src/client/icons.ts.
const src = readFileSync(join(root, 'src/client/icons.ts'), 'utf8').replace(/\r\n/g, '\n')

function installerBody(): string {
	const start = src.indexOf('function installSettingsNavIcon')
	assert.ok(start > 0, 'installSettingsNavIcon must exist')
	const end = src.indexOf('\n}\n', start)
	assert.ok(end > start, 'installSettingsNavIcon must be a closed function')
	return src.slice(start, end)
}

test('REGRESSION: nav icon observer filters to the marker attribute instead of watching everything', () => {
	const body = installerBody()
	const observeCall = body.slice(body.indexOf('observer.observe('), body.indexOf('observer.observe(') + 400)
	assert.ok(observeCall.length > 0, 'must call observer.observe()')
	assert.match(
		observeCall,
		/attributeFilter\s*:\s*\[\s*NAV_ICON_MARKER\s*\]/,
		'observer must filter to NAV_ICON_MARKER; without it the sync() attribute writes re-trigger the observer',
	)
	assert.equal(
		/characterData\s*:\s*true/.test(observeCall),
		false,
		'characterData must not be observed: it costs a full nav sweep and the sync never reads text mutations',
	)
})

test('nav icon sync is guarded so it cannot loop on its own writes', () => {
	const body = installerBody()
	assert.match(body, /scheduled/, 'sync must stay coalesced through a scheduled flag')
	// The sync must compare against current state before writing, or write only
	// when the attribute is actually absent.
	assert.match(
		body,
		/hasAttribute|getAttribute|toggleAttribute/,
		'sync must read the current marker state before writing it',
	)
})
