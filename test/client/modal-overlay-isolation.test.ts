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
//
// Phase 4 moved the CSS to src/client/global-css.ts and the modal store /
// overlay shell to src/client/ui/Modal.ts; the guards follow the code.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REPO_ROOT } from '../helpers/paths.ts'
const root = REPO_ROOT
// The stylesheet is composed from two modules: the shared tokens/rules in
// global-css.ts plus the overlay block extracted into modal-css.ts.
const cssSrc = [
	readFileSync(join(root, 'src/client/modal-css.ts'), 'utf8'),
	readFileSync(join(root, 'src/client/global-css.ts'), 'utf8'),
].join('\n').replace(/\r\n/g, '\n')
const modalSrc = readFileSync(join(root, 'src/client/ui/Modal.ts'), 'utf8').replace(/\r\n/g, '\n')

/** Extract the body of a CSS rule by its selector from the GLOBAL_CSS literal. */
function cssRule(selector: string): string {
	const start = cssSrc.indexOf(selector + ' {')
	assert.ok(start > 0, `CSS rule not found: ${selector}`)
	const end = cssSrc.indexOf('}', start)
	assert.ok(end > start, `CSS rule not closed: ${selector}`)
	// Comments carry the reasoning and sometimes name the very property we ban
	// (e.g. "no contain: content here"); strip them before asserting.
	return cssSrc.slice(start, end + 1).replace(/\/\*[\s\S]*?\*\//g, '')
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
		cssSrc,
		re,
		'while the console is open the conversation scroll element must be overflow:hidden ' +
			'(scrollbar-gutter:stable keeps the width from jumping), so nothing moves behind the overlay',
	)
})

test('REGRESSION: setOpen suspends overlay scanners and toggles the scroll-lock class', () => {
	const start = modalSrc.indexOf('const agyModalStore = {')
	assert.ok(start > 0, 'agyModalStore must exist')
	const end = modalSrc.indexOf('\n};', start)
	assert.ok(end > start, 'agyModalStore must be a closed object literal')
	const body = modalSrc.slice(start, end + 3)

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
	for (const rel of ['src/client/global-css.ts', 'src/client/images.ts', 'src/client/images/styles.ts']) {
		const text = readFileSync(join(root, rel), 'utf8')
		assert.equal(
			/backdrop-filter\s*:/.test(text),
			false,
			`${rel}: full-viewport backdrop-filter must not be reintroduced (it re-samples the page every frame behind a fixed overlay)`,
		)
	}
})

test('REGRESSION: the modal panel carries no compositing/paint-containment hints', () => {
	// 2026-11-04: the console STILL flashed while its body scrolled. Both hints
	// here were added by the 0.4.72 flicker attempt and are themselves the trap:
	// `contain: content` implies PAINT containment on an ancestor of a scrolling
	// subtree (Chromium drops and rebuilds the backing layer mid-scroll), and a
	// forced translateZ(0) layer over a translucent backdrop re-composites the
	// whole panel every frame. A 640px panel needs neither.
	const rule = cssRule('.agy-modal-panel')
	assert.equal(/[^-]contain\s*:/.test(rule), false, '.agy-modal-panel must not use containment (paint containment + inner scroller = flicker)')
	assert.equal(/transform\s*:/.test(rule), false, '.agy-modal-panel must not force a compositing layer')
	assert.match(rule, /overflow\s*:\s*hidden/, 'plain overflow:hidden is what actually clips the panel')
})

test('REGRESSION: the decorative shimmer does not pin a layer', () => {
	const rule = cssRule('.agy-shimmer-track::after')
	assert.equal(/will-change\s*:/.test(rule), false, 'will-change pins a compositing layer for an infinite decorative loop')
})

test('REGRESSION: wheel/touch over the overlay cannot scroll the page behind it', () => {
	// Non-passive native capture listener: React's onWheel is passive, so
	// preventDefault() there is ignored. The console's own scroller is exempt.
	assert.match(
		modalSrc,
		/addEventListener\(['"]wheel['"][^)]*passive:\s*false[^)]*capture:\s*true/,
		'the dialog must attach its own non-passive wheel blocker',
	)
	assert.match(modalSrc, /target\.closest\(['"]\.agy-modal-backdrop['"]\)/, 'the blocker only acts inside the overlay')
	assert.match(modalSrc, /target\.closest\(['"]\.agy-modal-body['"]\)/, 'the console scroller keeps native wheel scrolling')
	assert.match(modalSrc, /addEventListener\(['"]touchmove['"][^)]*passive:\s*false/, 'touch is blocked the same way')
})

test('REGRESSION: the shell itself is locked while the console is open', () => {
	assert.match(
		cssSrc,
		/html\.agy-modal-open,\s*\n\s*html\.agy-modal-open body\s*\{[^}]*overflow\s*:\s*hidden\s*!important/,
		'locking only [data-conversation-scroll] leaves a shell-level scroller free behind the overlay',
	)
})

test('REGRESSION: scrolling menu/console has no GPU layer promotion traps on quota tracks or hover buttons', async () => {
	const shimmerTrack = cssRule('.agy-shimmer-track')
	assert.equal(/[^-]contain\s*:/.test(shimmerTrack), false, '.agy-shimmer-track must not use contain: paint inside scrolling menus')
	assert.equal(/transform\s*:/.test(shimmerTrack), false, '.agy-shimmer-track must not force translateZ(0)')
	const btnHover = cssRule('.agy-btn:hover:not(:disabled)')
	assert.equal(/transform\s*:/.test(btnHover), false, '.agy-btn:hover must not promote layers mid-scroll')
	assert.equal(/filter\s*:/.test(btnHover), false, '.agy-btn:hover must not apply filter mid-scroll')

	const quotaPanelSrc = readFileSync(join(root, 'src/client/sections/QuotaPanel.ts'), 'utf8')
	assert.match(quotaPanelSrc, /const isShimmer = isRefreshing\b/, 'static unreported bars must not shimmer infinitely')

	const { acquireOverlaySuspend, isOverlaySuspended } = await import('../../src/client/scroll-guard.ts')
	assert.equal(isOverlaySuspended(), false)
	const release1 = acquireOverlaySuspend()
	const release2 = acquireOverlaySuspend()
	assert.equal(isOverlaySuspended(), true)
	release1()
	assert.equal(isOverlaySuspended(), true, 'ref-counted until all mounted settings views unmount')
	release2()
	assert.equal(isOverlaySuspended(), false)
})

test('REGRESSION: modal pins top edge, lets bottom adapt to tab height, and refreshes injected CSS', () => {
	const backdrop = cssRule('.agy-modal-backdrop')
	assert.match(backdrop, /align-items\s*:\s*flex-start/, 'modal must pin its top edge rather than centering vertically')

	const panel = cssRule('.agy-modal-panel')
	assert.match(panel, /max-height\s*:/, 'modal panel stays bounded by viewport height')
	assert.equal(/(?:^|[;\s])height\s*:/.test(panel), false, 'modal bottom should adapt to active tab height instead of forcing fixed height')

	const body = cssRule('.agy-modal-body')
	assert.match(body, /scrollbar-gutter\s*:\s*stable/, 'scrollbar appearance across tabs must not shift header/tab layout horizontally')

	const stylesSrc = readFileSync(join(root, 'src/client/styles.ts'), 'utf8')
	assert.match(stylesSrc, /existing\.textContent\s*!==\s*GLOBAL_CSS/, 'hot-reloading the plugin must refresh the existing style node')
})

// Incident (2026-11-25, sixth report of the same symptom): scrolling the console
// still flashes. Everything that animates INSIDE a scrolling subtree keeps the
// compositor re-painting that subtree on every frame; combined with the panel's
// rounded clip + shadow that is a well-known Electron/Chromium flicker source.
// The contract: while a scroll gesture is active, decorative animation inside
// the overlay is PAUSED — nothing repaints under the moving scroller.
test('REGRESSION: decorative animation inside the console pauses while scrolling', () => {
	// The whole panel, not just its scroller: the header carries the spinner and
	// status chips, and those repaint the same layer the scroller moves in.
	const scrollingRule = cssRule('html.agy-scrolling :is(.agy-modal-panel, .agy-modal-panel *)')
	assert.match(
		scrollingRule,
		/animation-play-state\s*:\s*paused/,
		'animations inside the scrolling console body must be paused while a scroll gesture is active',
	)
	assert.match(
		scrollingRule,
		/transition\s*:\s*none/,
		'transitions inside the scrolling console body must not run mid-scroll',
	)
	// The toggle must come from the scroll guard, not from a component effect.
	const guardSrc = readFileSync(join(root, 'src/client/scroll-guard.ts'), 'utf8')
	assert.match(guardSrc, /agy-scrolling/, 'scroll-guard owns the agy-scrolling class toggle')
})

test('REGRESSION: the status poll never re-renders the UI mid-scroll', async () => {
	const statusSrc = readFileSync(join(root, 'src/client/status.ts'), 'utf8')
	assert.match(
		statusSrc,
		/isScrollActive\(\)/,
		'status.ts must defer listener notification while a scroll gesture is active',
	)
	assert.match(
		statusSrc,
		/onScrollIdle\(/,
		'the deferred snapshot must be flushed when the gesture ends — including while the console itself owns the screen',
	)
})
