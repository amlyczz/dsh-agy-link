// Issue #131: the settings panel must be able to list the models an account can
// actually run even when the agy CLI is absent. The quota snapshot carries that
// list, so these tests pin the folding/merging rules the panel and the provider
// both rely on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	accountsOfferingModel,
	mergeCatalogWithQuotaModels,
	quotaCatalogForAccount,
	quotaModelsForAccount,
} from '../../../src/domain/models/quota-catalog.ts'
import type { CatalogEntry } from '../../../src/domain/models/parse.ts'
import type { ManagedAccount } from '../../../src/common/pool-types.ts'

function account(id: string, quotas: Record<string, unknown>, enabled = true): ManagedAccount {
	return { id, alias: id, dir: `/tmp/${id}`, enabled, createdAt: 0, cooldowns: {}, quotas } as unknown as ManagedAccount
}

const NEON_QUOTAS = {
	google: {
		models: [
			{ modelId: 'gemini-4-neon-low', displayName: 'Gemini 4 Neon (Low)' },
			{ modelId: 'gemini-4-neon-high', displayName: 'Gemini 4 Neon (High)' },
			{ modelId: 'gemini-3-flash', displayName: 'Gemini 3 Flash' },
		],
	},
	anthropic: {
		models: [{ modelId: 'claude-opus-5-5-high' }, { modelId: 'claude-opus-5-5-low' }],
	},
}

test('quotaModelsForAccount reads every family and prefers the display name', () => {
	const rows = quotaModelsForAccount(account('acc_a', NEON_QUOTAS))
	assert.deepEqual(
		rows.map((r) => r.slug),
		['gemini-4-neon-low', 'gemini-4-neon-high', 'gemini-3-flash', 'claude-opus-5-5-high', 'claude-opus-5-5-low'],
	)
	assert.equal(rows[0]?.label, 'Gemini 4 Neon (Low)')
	assert.equal(rows[3]?.label, 'claude-opus-5-5-high', 'no displayName falls back to the slug')
})

test('quotaModelsForAccount tolerates missing quotas, blank ids, and duplicates', () => {
	assert.deepEqual(quotaModelsForAccount(undefined), [])
	assert.deepEqual(quotaModelsForAccount(null), [])
	assert.deepEqual(quotaModelsForAccount(account('acc_a', {})), [])
	const noisy = account('acc_a', {
		google: {
			models: [
				{ modelId: '  gemini-3-flash  ', displayName: '' },
				{ modelId: '   ' },
				{ modelId: 'gemini-3-flash' },
				{ modelId: 42 },
				null,
			],
		},
	})
	assert.deepEqual(quotaModelsForAccount(noisy), [{ slug: 'gemini-3-flash', label: 'gemini-3-flash' }])
})

test('quotaCatalogForAccount folds effort variants like the CLI catalog does', () => {
	const entries = quotaCatalogForAccount(account('acc_a', NEON_QUOTAS))
	const neon = entries.find((e) => e.id === 'gemini-4-neon')
	assert.ok(neon, 'effort variants fold into one base entry')
	assert.deepEqual(neon.efforts, ['low', 'high'])
	assert.ok(entries.some((e) => e.id === 'gemini-3-flash'), 'a bare model stays its own entry')
})

test('mergeCatalogWithQuotaModels keeps discovered order and adds quota-only models', () => {
	const discovered: CatalogEntry[] = [
		{ id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', efforts: ['low', 'high'] },
		{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: null },
	]
	const quota = quotaCatalogForAccount(account('acc_a', NEON_QUOTAS))
	const merged = mergeCatalogWithQuotaModels(discovered, quota)
	assert.deepEqual(
		merged.map((m) => m.id),
		['gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-4-neon', 'gemini-3-flash', 'claude-opus-5-5'],
	)
})

test('mergeCatalogWithQuotaModels unions efforts and lets a quota row fill a placeholder name', () => {
	const discovered: CatalogEntry[] = [{ id: 'gemini-4-neon', name: 'gemini-4-neon', efforts: ['medium'] }]
	const merged = mergeCatalogWithQuotaModels(discovered, [
		{ id: 'gemini-4-neon', name: 'Gemini 4 Neon (Low)', efforts: ['low'] },
	])
	assert.equal(merged.length, 1)
	assert.deepEqual(merged[0]?.efforts, ['medium', 'low'])
	assert.equal(merged[0]?.name, 'Gemini 4 Neon (Low)', 'placeholder name is upgraded, not duplicated')
})

test('mergeCatalogWithQuotaModels disambiguates display names the upstream snapshot duplicates', () => {
	// Live evidence: four unrelated legacy slugs all report "Gemini 3.5 Flash Lite".
	// None of them is a stem of the others, so every one falls back to its slug.
	const merged = mergeCatalogWithQuotaModels([], [
		{ id: 'gemini-2.5-flash', name: 'Gemini 3.5 Flash Lite', efforts: null },
		{ id: 'gemini-2.5-flash-lite', name: 'Gemini 3.5 Flash Lite', efforts: null },
		{ id: 'gemini-2.5-flash-thinking', name: 'Gemini 3.5 Flash Lite', efforts: null },
		{ id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', efforts: null },
	])
	assert.deepEqual(merged.map((m) => m.name), [
		'gemini-2.5-flash',
		'gemini-2.5-flash-lite',
		'gemini-2.5-flash-thinking',
		'gemini-3.5-flash-lite',
	])
	assert.deepEqual(merged.map((m) => m.id), [
		'gemini-2.5-flash',
		'gemini-2.5-flash-lite',
		'gemini-2.5-flash-thinking',
		'gemini-3.5-flash-lite',
	], 'the id stays stable — it is what the picker sends back')
})

test('mergeCatalogWithQuotaModels keeps the label on the stem of an id-derived collision', () => {
	// Live evidence: the folded `-tiered` row inherits "Gemini 4 Hydrogen" from
	// the effort siblings, so the base model must keep the readable name and the
	// variant falls back to its slug.
	const merged = mergeCatalogWithQuotaModels([], [
		{ id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', efforts: ['low', 'high'] },
		{ id: 'gemini-4-hydrogen-tiered', name: 'Gemini 4 Hydrogen', efforts: ['high'] },
		{ id: 'gemini-4-hydrogen-sonar', name: 'Gemini 4 Hydrogen', efforts: null },
	])
	assert.equal(merged[0]?.name, 'Gemini 4 Hydrogen')
	assert.equal(merged[1]?.name, 'gemini-4-hydrogen-tiered')
	assert.equal(merged[2]?.name, 'gemini-4-hydrogen-sonar')
})

test('mergeCatalogWithQuotaModels keeps a unique display name untouched', () => {
	const merged = mergeCatalogWithQuotaModels([], [
		{ id: 'gemini-4-neon', name: 'Gemini 4 Neon', efforts: null },
		{ id: 'gemini-3-flash', name: 'Gemini 3 Flash', efforts: null },
	])
	assert.deepEqual(merged.map((m) => m.name), ['Gemini 4 Neon', 'Gemini 3 Flash'])
})

test('mergeCatalogWithQuotaModels never overwrites a real discovered name', () => {
	const merged = mergeCatalogWithQuotaModels(
		[{ id: 'gemini-3-flash', name: 'Gemini 3 Flash', efforts: null }],
		[{ id: 'gemini-3-flash', name: 'Gemini 3 Flash (quota)', efforts: null }],
	)
	assert.equal(merged[0]?.name, 'Gemini 3 Flash')
})

test('mergeCatalogWithQuotaModels is a no-op passthrough without quota rows', () => {
	const discovered: CatalogEntry[] = [{ id: 'gemini-3-flash', name: 'Gemini 3 Flash', efforts: null }]
	assert.deepEqual(mergeCatalogWithQuotaModels(discovered, []), discovered)
})

test('accountsOfferingModel maps a base id onto effort variants and skips disabled accounts', () => {
	const a = account('acc_a', NEON_QUOTAS)
	const b = account('acc_b', { google: { models: [{ modelId: 'gemini-4-neon-low' }] } })
	const off = account('acc_off', { google: { models: [{ modelId: 'gemini-4-neon-low' }] } }, false)
	assert.deepEqual(accountsOfferingModel([a, b, off], 'gemini-4-neon'), ['acc_a', 'acc_b'])
	assert.deepEqual(accountsOfferingModel([a, b], 'gemini-3-flash'), ['acc_a'])
	assert.deepEqual(accountsOfferingModel([a, b], 'gemini-2.5-pro'), [])
	assert.deepEqual(accountsOfferingModel([a, b], '  '), [])
})
