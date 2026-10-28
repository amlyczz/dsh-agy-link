// Regression: the plugin's DOM overlay scanners must be GATED not just by
// active scrolling, but also while a full-screen overlay (the Antigravity
// console) owns the screen. During that time the conversation behind the modal
// must not be mutated: every injected node changes layout and, with the overlay
// compositing on top, turns into visible flashing.
//
// This pins the contract that decisions/images/reasoning/mermaid all funnel
// their "may I mutate?" check through `isInteractionLocked()` (scroll OR
// overlay-suspended) instead of their own ad-hoc `isScrollActive()` checks.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const SCANNERS = [
	'src/client/decisions.ts',
	'src/client/images.ts',
	'src/client/reasoning.ts',
	'src/client/mermaid.ts',
]

for (const rel of SCANNERS) {
	const src = readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')
	const name = rel.split('/').pop()

	test(`${name}: imports isInteractionLocked from the scroll guard`, () => {
		assert.match(
			src,
			/import\s*\{[^}]*isInteractionLocked[^}]*\}\s*from\s*['"]\.\/scroll-guard\.ts['"]/,
			'each scanner must gate on the shared isInteractionLocked() (scroll OR overlay suspended)',
		)
	})

	test(`${name}: uses isInteractionLocked() in its guards`, () => {
		const count = (src.match(/isInteractionLocked\s*\(/g) ?? []).length
		assert.ok(
			count >= 1,
			'each scanner must actually call isInteractionLocked() before scanning/injecting',
		)
	})
}
