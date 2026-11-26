// scripts/lineup-drift.mjs: the comparator behind `npm run lineup:check`.
//
// It guards a contract that is invisible on a healthy machine — the offline
// lineup is only read when discovery cannot run — so its own logic is pinned
// here on synthetic inputs, independent of whatever agy lists today.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, diffLineup, formatReport, offeredSlugs } from '../../scripts/lineup-drift.mjs'
import { DEFAULT_FALLBACK_MODELS } from '../../src/common/model-lineup.ts'

// A small lineup exercising both entry kinds: tiered and fixed-thinking.
const LINEUP = [
  { id: 'gemini-4-neon', name: 'Gemini 4 Neon', efforts: ['low', 'high'] },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'high'] },
  { id: 'gemini-pro-orchestrator', name: 'Orchestrator' },
]
const TSV = [
  'gemini-4-neon-high\tGemini 4 Neon (High)',
  'gemini-4-neon-low\tGemini 4 Neon (Low)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'gemini-pro-orchestrator\tOrchestrator',
].join('\n')

test('an exact mirror is in sync, banners and all', () => {
  const diff = diffLineup(LINEUP, 'Fetching models...\n' + TSV)
  assert.deepEqual([diff.stale, diff.missing, diff.reordered], [[], [], false])
  assert.equal(classify(diff), 'in-sync')
  assert.equal(formatReport(diff), '')
})

test('a tier agy retires is reported as stale even though the base id survives', () => {
  const withoutHigh = TSV.replace('gemini-4-neon-high\tGemini 4 Neon (High)\n', '')
  const diff = diffLineup(LINEUP, withoutHigh)
  assert.deepEqual(diff.stale, ['gemini-4-neon-high'], 'slug level, not base-id level')
  assert.deepEqual(diff.missing, [])
  assert.equal(classify(diff), 'drifted')
  assert.match(formatReport(diff), /still offered : gemini-4-neon-high/)
})

test('a tier agy adds is reported as missing', () => {
  const diff = diffLineup(LINEUP, TSV + '\ngemini-3.8-flash-max\tGemini 3.8 Flash (Max)')
  assert.deepEqual(diff.missing, ['gemini-3.8-flash-max'])
  assert.deepEqual(diff.stale, [])
  assert.equal(classify(diff), 'drifted')
})

test('same models in another order is drift of its own kind', () => {
  const rows = TSV.split('\n')
  const diff = diffLineup(LINEUP, [...rows.slice(2, 4), ...rows.slice(0, 2), rows[4]].join('\n'))
  assert.deepEqual([diff.stale, diff.missing], [[], []])
  assert.equal(diff.reordered, true)
  assert.equal(classify(diff), 'drifted')
})

test('no readable catalog is not drift: it must not cry wolf', () => {
  for (const output of ['', 'Fetching models...\nerror: not signed in', 'failed: network']) {
    const diff = diffLineup(LINEUP, output)
    assert.equal(diff.live.size, 0, JSON.stringify(output))
    assert.equal(classify(diff), 'empty', 'an empty catalog is inconclusive, not a mismatch')
  }
})

test('offeredSlugs: one slug per tier, bare id for fixed-thinking entries', () => {
  assert.deepEqual(
    [...offeredSlugs([{ id: 'a', efforts: ['low', 'high'] }, { id: 'b', efforts: null }, { id: 'c' }])].sort(),
    ['a-high', 'a-low', 'b', 'c'],
  )
})

test('the shipped lineup round-trips through the agy table shape', () => {
  // Rendering the lineup in `agy models` shape and parsing it back must be a
  // no-op: this exercises the real entry list, not a sample.
  const rows = []
  for (const entry of DEFAULT_FALLBACK_MODELS) {
    for (const tier of entry.efforts ?? []) rows.push(`${entry.id}-${tier}\t${entry.name} (${tier})`)
    if (!entry.efforts?.length) rows.push(`${entry.id}\t${entry.name}`)
  }
  const diff = diffLineup(DEFAULT_FALLBACK_MODELS, rows.join('\n'))
  assert.deepEqual([diff.stale, diff.missing, diff.reordered], [[], [], false])
})
