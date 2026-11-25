// Regression: decision-chip injection must be IDEMPOTENT per content node.
//
// Incident (2026-10-23): scrolling the Antigravity settings page back and forth
// made the whole page flash violently. Root cause was here, not in polling:
//
//   * the host renders markdown with `div[class*="_markdown_"], [data-markdown-variant]`
//     inside a TanStack-Virtual dynamic-measurement list (`measureElement` +
//     `anchorTo:"start"`), so any height change inside an item triggers
//     `resizeItem()` -> `applyScrollAdjustment()` -> the host rewrites scrollTop;
//   * this scanner appended a `.agy-decision-container` (+80px) into that item;
//   * the only real guard lived on the HEADING element
//     (`data-agy-decision-attached`), and React rebuilds those nodes when the
//     virtualizer remounts an item — so the guard vanished and the chip was
//     injected AGAIN on the next scan;
//   * the container-level guard `data-agy-decisions-scanned` was read but never
//     written, so it could never stop the loop.
//
// Net effect: a measured item grows on every remount -> scrollTop is rewritten
// -> the item re-measures -> it grows again. That is the "scroll back and forth
// = insane flashing" flywheel.
//
// These tests pin the contract that fixes it.

import test from 'node:test'
import assert from 'node:assert/strict'

/** Minimal DOM that supports exactly the selectors the scanner uses. */
type El = {
	tagName: string
	className: string
	innerHTML: string
	textContent: string
	dataset: Record<string, string | undefined>
	style: Record<string, string>
	children: El[]
	parentNode: El | null
	readonly nextElementSibling: El | null
	appendChild(n: El): El
	insertBefore(n: El, ref: El | null): El
	querySelectorAll(sel: string): El[]
	querySelector(sel: string): El | null
}

const KNOWN_SELECTORS = [
	'div[class*="_markdown_"]:not([data-agy-decisions-scanned="true"]), [data-markdown-variant]:not([data-agy-decisions-scanned="true"])',
	'h2, h3, h4, p > strong',
	'li',
	'.agy-decision-container',
]

function makeEl(tagName: string, className = ''): El {
	const el: El = {
		tagName,
		className,
		innerHTML: '',
		textContent: '',
		dataset: {},
		style: {},
		children: [],
		parentNode: null,
		get nextElementSibling(): El | null {
			const p = el.parentNode
			if (!p) return null
			const i = p.children.indexOf(el)
			return i >= 0 ? (p.children[i + 1] ?? null) : null
		},
		appendChild(n: El): El {
			if (n.parentNode) {
				const pi = n.parentNode.children.indexOf(n)
				if (pi >= 0) n.parentNode.children.splice(pi, 1)
			}
			n.parentNode = el
			el.children.push(n)
			return n
		},
		insertBefore(n: El, ref: El | null): El {
			const i = ref ? el.children.indexOf(ref) : -1
			if (n.parentNode) {
				const pi = n.parentNode.children.indexOf(n)
				if (pi >= 0) n.parentNode.children.splice(pi, 1)
			}
			if (i >= 0) el.children.splice(i, 0, n)
			else el.children.push(n)
			n.parentNode = el
			return n
		},
		querySelectorAll(sel: string): El[] {
			assert.ok(KNOWN_SELECTORS.includes(sel), `stub needs selector: ${sel}`)
			const out: El[] = []
			const walk = (e: El): void => {
				for (const c of e.children) {
					if (selects(c, sel)) out.push(c)
					walk(c)
				}
			}
			walk(el)
			return out
		},
		querySelector(sel: string): El | null {
			return el.querySelectorAll(sel)[0] ?? null
		},
	}
	return el
}

function selects(el: El, sel: string): boolean {
	switch (sel) {
		case 'div[class*="_markdown_"]:not([data-agy-decisions-scanned="true"]), [data-markdown-variant]:not([data-agy-decisions-scanned="true"])':
			return el.dataset.agyDecisionsScanned !== 'true' && (el.className.includes('_markdown_') || el.dataset.markdownVariant !== undefined)
		case 'h2, h3, h4, p > strong':
			return ['H2', 'H3', 'H4', 'STRONG'].includes(el.tagName)
		case 'li':
			return el.tagName === 'LI'
		case '.agy-decision-container':
			return el.className.includes('agy-decision-container')
		default:
			return false
	}
}

const walkAll = (el: El, fn: (e: El) => void): void => {
	fn(el)
	for (const c of el.children) walkAll(c, fn)
}

/** Install a fake `document` holding one virtualized message item. */
function installFakeDom(): {
	root: El
	/** React-style rebuild: brand-new markdown/heading/list nodes (guards gone). */
	remount: (withCard: boolean) => El
} {
	const root = makeEl('#root')
	const doc = {
		createElement: (tag: string): El => makeEl(tag.toUpperCase()),
		querySelectorAll: (sel: string): El[] => root.querySelectorAll(sel),
		body: root,
		head: makeEl('HEAD'),
	}
	;(globalThis as unknown as { document: unknown }).document = doc

	const buildCard = (): El => {
		const card = makeEl('DIV', 'agy-decision-container')
		const header = makeEl('DIV', 'agy-decision-header')
		header.innerHTML = '<span>x</span>'
		const chips = makeEl('DIV', 'agy-decision-chips')
		for (const label of ['1 先修复闪屏问题', '2 先做新功能']) {
			const chip = makeEl('BUTTON', 'agy-decision-chip')
			chip.textContent = label
			chips.appendChild(chip)
		}
		card.appendChild(header)
		card.appendChild(chips)
		return card
	}

	const remount = (withCard: boolean): El => {
		root.children.splice(0, root.children.length)
		const item = makeEl('DIV')
		item.dataset.index = '3'
		const md = makeEl('DIV', '_markdown_1ypvv_5')
		md.dataset.markdownVariant = 'body'
		const h3 = makeEl('H3')
		h3.textContent = '请您选择方案'
		const ol = makeEl('OL')
		const li1 = makeEl('LI')
		li1.textContent = '先修复闪屏问题'
		const li2 = makeEl('LI')
		li2.textContent = '先做新功能'
		ol.appendChild(li1)
		ol.appendChild(li2)
		md.appendChild(h3)
		md.appendChild(ol)
		// A rebuilt node carries whatever the host's snapshot already had.
		if (withCard) md.appendChild(buildCard())
		item.appendChild(md)
		root.appendChild(item)
		return md
	}

	return { root, remount }
}

const countCards = (root: El): number => {
	let n = 0
	walkAll(root, (e) => {
		if (e.className.includes('agy-decision-container')) n++
	})
	return n
}

test('scanAndEnhanceDecisions injects the chip toolbar exactly once', async () => {
	// Fresh module state per test file run; the scanner has no install dependency.
	const { scanAndEnhanceDecisions } = await import('../src/client/decisions.ts')
	const { root, remount } = installFakeDom()

	remount(false)
	scanAndEnhanceDecisions()
	assert.equal(countCards(root), 1, 'first scan should inject one toolbar')
})

test('scanAndEnhanceDecisions is idempotent: repeated scans never add a second toolbar', async () => {
	const { scanAndEnhanceDecisions } = await import('../src/client/decisions.ts')
	const { root, remount } = installFakeDom()

	remount(false)
	scanAndEnhanceDecisions()
	for (let i = 0; i < 5; i++) scanAndEnhanceDecisions()
	assert.equal(countCards(root), 1, 'the same container must never receive a second toolbar')
})

test('REGRESSION: container guard data-agy-decisions-scanned is actually WRITTEN', async () => {
	// The flywheel's root cause: the guard was read but never assigned anywhere,
	// so it was permanently undefined and could never stop a re-scan.
	const { scanAndEnhanceDecisions } = await import('../src/client/decisions.ts')
	const { remount } = installFakeDom()

	const md = remount(false)
	scanAndEnhanceDecisions()
	assert.equal(
		md.dataset.agyDecisionsScanned,
		'true',
		'container guard must be persisted after a successful scan pass',
	)
})

test('REGRESSION: a virtualizer remount must not stack another toolbar', async () => {
	// Scrolling remounts items: fresh nodes, heading guard gone. The rebuilt
	// snapshot still contains the previously injected card, so a correct
	// scanner sees "already enhanced" and does nothing.
	const { scanAndEnhanceDecisions } = await import('../src/client/decisions.ts')
	const { root, remount } = installFakeDom()

	remount(false)
	scanAndEnhanceDecisions()
	assert.equal(countCards(root), 1)

	for (let i = 0; i < 6; i++) {
		remount(true)
		scanAndEnhanceDecisions()
		assert.equal(
			countCards(root),
			1,
			`remount #${i + 1} stacked a duplicate toolbar (height grows on every scroll)`,
		)
	}
})

test('an already-enhanced item is not re-scanned at all (guard short-circuits)', async () => {
	const { scanAndEnhanceDecisions } = await import('../src/client/decisions.ts')
	const { root, remount } = installFakeDom()

	const md = remount(false)
	md.dataset.agyDecisionsScanned = 'true' // pre-marked, as if a previous pass ran
	scanAndEnhanceDecisions()
	assert.equal(countCards(root), 0, 'a marked container must be skipped entirely')
})
