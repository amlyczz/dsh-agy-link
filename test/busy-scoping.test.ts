// Regression: a single busy action must not touch every control on the page.
//
// Measured (2026-10-23, real dist/client.js in Chrome): clicking "刷新额度"
// produced **40 attribute mutations, all of them `disabled` on `.agy-btn`**,
// while only 2 nodes were actually added. `isBusy` was derived as
// `loadingAction !== null` and applied to every account card's buttons
// (enable/disable, sync, set-active, proxy, delete) — so one account's
// refresh disabled all 40 buttons, each toggle forcing a style recalc and a
// repaint of the whole panel. On a 4-account pool that is the "click refresh
// and the dialog flashes" report.
//
// The contract these tests pin:
//   1. busy-ness is per-action: only the button that started the action (and
//      the global actions that genuinely conflict) is disabled;
//   2. the shimmer only animates the account actually being refreshed.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
// Phase 4 moved the account cards and the per-account quota wrapper into
// src/client/sections/AccountsPanel.ts.
const src = readFileSync(join(root, 'src/client/sections/AccountsPanel.ts'), 'utf8')

function section(from: string, to: string): string {
	const start = src.indexOf(from)
	assert.ok(start > 0, `anchor not found: ${from}`)
	const end = src.indexOf(to, start)
	assert.ok(end > start, `closing anchor not found: ${to}`)
	return src.slice(start, end)
}

/** The per-account action-button block inside the rendered account cards. */
function accountActionBlock(): string {
	const start = src.indexOf("title: acc.enabled ? t('account.disableTitle')")
	assert.ok(start > 0, 'account action buttons must exist')
	return src.slice(start, start + 3200)
}

test('REGRESSION: account buttons are not all disabled by a single global isBusy', () => {
	const block = accountActionBlock()
	const busyCount = (block.match(/disabled:\s*isBusy\b/g) ?? []).length
	assert.equal(
		busyCount,
		0,
		'per-account buttons must derive disabled from their OWN action, not a global isBusy ' +
			'(a single refresh otherwise rewrites 40 disabled attributes and repaints the panel)',
	)
})

test('REGRESSION: the enable/disable button is disabled only while THAT account is toggling', () => {
	const block = accountActionBlock()
	assert.match(
		block,
		/disabled:\s*accountActionBusy\(acc,\s*'enable'\)/,
		'enable button must key off its own action id',
	)
})

test('REGRESSION: the sync button is disabled only while THAT account is syncing', () => {
	const block = accountActionBlock()
	assert.match(
		block,
		/disabled:\s*accountActionBusy\(acc,\s*'refresh'\)/,
		'sync button must key off its own action id',
	)
})

test('REGRESSION: the shimmer only animates the account being refreshed', () => {
	const renderQuotaBar = section('const renderQuotaBar =', 'Authoritative active account')
	// The shimmer must consider THIS account's own refresh action, i.e. the
	// per-account `refresh:${acc.id}` id, not only the global 'refresh-quota'.
	assert.match(
		renderQuotaBar,
		/`refresh:\$\{acc\.id\}`/,
		'the refresh shimmer must be scoped to the account that is actually refreshing',
	)
})

test('an account other than the one refreshing is not shimmed', () => {
	const renderQuotaBar = section('const renderQuotaBar =', 'Authoritative active account')
	assert.equal(
		/isRefreshingQuota/.test(renderQuotaBar),
		false,
		'the global refresh flag must not reach per-account quota bars',
	)
})
