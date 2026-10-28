// Regression: opening the Antigravity console must ISOLATE the page behind it.
//
// Incident (2026-10-28, recurring): click the "AGY · account" capsule -> the
// full-screen AgyModalDialog opens -> scrolling STILL flashes the screen.
// This had been "fixed" several times (scroll-guard, decision-chip idempotence,
// busy scoping, first-open host claim) but kept coming back because every fix
// patched one publisher while the overlay itself was never isolated:
//
//   * `.agy-modal-backdrop` is position:fixed/inset:0 but the conversation
//     scroll element behind it was NOT locked, so wheel/inertia scrolled the
//     page underneath the overlay, reflowing and re-compositing it every frame;
//   * the backdrop carried a full-viewport `backdrop-filter: blur(6px)`, so
//     that每帧 movement re-sampled the whole page through the filter -> flash;
//   * the plugin's global DOM scanners (decisions/images/reasoning/mermaid)
//     observe document.body and inject into the conversation, so the modal's
//     own polling re-renders woke them and mutated the page behind the overlay.
//
// The contract these tests pin: a full-screen overlay must (1) not use a
// full-viewport backdrop-filter, (2) freeze the background scroll, (3) stop
// wheel chaining, and (4) suspend the plugin's own scanners while it is open.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const src = readFileSync(join(root, 'src/client/index.ts'), 'utf8').replace(/\r\n/g, '\n')

/** Extract the body of a CSS rule by its selector from the GLOBAL_CSS literal. */
function cssRule(selector: string): string {
	const start = src.indexOf(selector + ' {')
	assert.ok(start > 0, `CSS rule not found: ${selector}`)
	const end = src.indexOf('}', start)
	assert.ok(end > start, `CSS rule not closed: ${selector}`)
	return src.slice(start, end + 1)
}

test('REGRESSION: the full-viewport modal backdrop must not use backdrop-filter', () => {
	const rule = cssRule('.agy-modal-backdrop')
	assert.equal(
		/backdrop-filter\s*:/.test(rule),
		false,
		'a full-viewport fixed backdrop-filter re-samples the page every frame while anything behind moves ' +
			'(scroll/animation/streaming) and is a known flash source in Electron — use the rgba dim instead',
	)
	assert.match(rule, /background\s*:/, 'the backdrop must still dim the page with a solid/alpha background')
})

test('REGRESSION: the modal backdrop contains wheel/touch scroll chaining', () => {
	const rule = cssRule('.agy-modal-backdrop')
	assert.match(
		rule,
		/overscroll-behavior\s*:\s*contain/,
		'overscroll-behavior:contain stops momentum from the overlay leaking to the page behind it',
	)
})

test('REGRESSION: opening the console locks the conversation scroller behind it', () => {
	// A CSS rule keyed off a class toggled while the modal is open.
	const re = /html\.agy-modal-open\s+\[data-conversation-scroll\][^{]*\{[^}]*overflow\s*:\s*hidden/i
	assert.match(
		src,
		re,
		'while the console is open the conversation scroll element must be overflow:hidden ' +
			'(scrollbar-gutter:stable keeps the width from jumping), so nothing moves behind the overlay',
	)
})

test('REGRESSION: setOpen suspends overlay scanners and toggles the scroll-lock class', () => {
	const start = src.indexOf('const agyModalStore = {')
	assert.ok(start > 0, 'agyModalStore must exist')
	const end = src.indexOf('\n};', start)
	assert.ok(end > start, 'agyModalStore must be a closed object literal')
	const body = src.slice(start, end + 3)

	assert.match(
		body,
		/setOverlaySuspended\s*\(/,
		'opening/closing the console must suspend/resume the plugin DOM scanners (no mutating the page behind an open overlay)',
	)
	assert.match(
		body,
		/agy-modal-open/,
		'setOpen must toggle the `agy-modal-open` class that drives the background scroll lock',
	)
	assert.match(
		body,
		/classList\.(toggle|add|remove)\s*\(/,
		'the scroll-lock class must be applied to the documentElement',
	)
})

test('GUARDRAIL: no full-viewport backdrop-filter anywhere in the plugin CSS', () => {
	// The whole class of flicker comes from filtering the full viewport. Keep the
	// invariant global so a future overlay (or the lightbox) cannot reintroduce it.
	for (const rel of ['src/client/index.ts', 'src/client/images.ts']) {
		const text = readFileSync(join(root, rel), 'utf8')
		assert.equal(
			/backdrop-filter\s*:/.test(text),
			false,
			`${rel}: full-viewport backdrop-filter must not be reintroduced (it re-samples the page every frame behind a fixed overlay)`,
		)
	}
})
