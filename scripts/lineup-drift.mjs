#!/usr/bin/env node
// lineup-drift.mjs — does the offline model lineup still mirror `agy models`?
//
// `DEFAULT_FALLBACK_MODELS` (src/common/model-lineup.ts) is, by its own contract,
// a MIRROR of what `agy models` prints: it must not keep models agy has retired
// and must carry every tier agy offers, in agy's own order. It is read only when
// discovery cannot run (signed out / offline), so on a healthy machine drift is
// invisible until a signed-out user is offered a model that no longer exists, or
// denied one that does. agy 1.5.18 moved 14 slugs in a single release.
//
// The comparison is at SLUG level (family + tier) and goes through the same
// parse / fold functions the runtime uses, so its verdict is the one the test
// "the offline fallback lineup is the same set the live discovery produces"
// would reach with live output in place of its fixture. Comparing base ids
// alone is not enough: 1.5.18 retired one Hydrogen tier and added a Claude one
// without touching a single base id.
//
//   npm run lineup:check                        # live `agy models`
//   node scripts/lineup-drift.mjs --tsv out.tsv # saved `agy models` output
//
// Exit codes: 0 in sync · 1 drifted · 2 no readable catalog.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DEFAULT_FALLBACK_MODELS } from '../src/common/model-lineup.ts'
import { buildFallbackCatalog, foldEfforts, parseModelsOutput } from '../src/domain/models/parse.ts'

/** One slug per tier a catalog entry offers; a fixed-thinking entry is its bare id. */
export function offeredSlugs(entries) {
  const out = new Set()
  for (const entry of entries) {
    const tiers = entry.efforts ?? []
    if (tiers.length === 0) out.add(entry.id)
    else for (const tier of tiers) out.add(`${entry.id}-${tier}`)
  }
  return out
}

/**
 * Compare a lineup with `agy models` output.
 *
 * - `stale`:     slugs the lineup offers that agy no longer lists.
 * - `missing`:   slugs agy lists that the lineup does not offer.
 * - `reordered`: the same ids in a different order (only meaningful when the
 *                two slug sets are equal; the mirror follows agy's order).
 */
export function diffLineup(lineup, agyModelsOutput) {
  const live = new Set(parseModelsOutput(agyModelsOutput).map((m) => m.slug))
  const offered = offeredSlugs(buildFallbackCatalog(lineup))
  const sameSet = live.size === offered.size && [...live].every((slug) => offered.has(slug))
  const liveOrder = foldEfforts(parseModelsOutput(agyModelsOutput)).map((m) => m.id)
  const lineupOrder = buildFallbackCatalog(lineup).map((m) => m.id)
  return {
    offered,
    live,
    stale: [...offered].filter((slug) => !live.has(slug)),
    missing: [...live].filter((slug) => !offered.has(slug)),
    reordered: sameSet && liveOrder.some((id, i) => id !== lineupOrder[i]),
  }
}

/** `empty` when agy listed nothing usable, else `in-sync` or `drifted`. */
export function classify(diff) {
  if (diff.live.size === 0) return 'empty'
  return diff.stale.length === 0 && diff.missing.length === 0 && !diff.reordered ? 'in-sync' : 'drifted'
}

export function formatReport(diff) {
  const lines = []
  if (diff.stale.length) lines.push(`  retired by agy, still offered : ${diff.stale.join(', ')}`)
  if (diff.missing.length) lines.push(`  listed by agy, not offered    : ${diff.missing.join(', ')}`)
  if (diff.reordered) lines.push('  same models, different order    : update the lineup to agy\'s order')
  return lines.join('\n')
}

async function readLiveCatalog(argv) {
  const tsvAt = argv.indexOf('--tsv')
  if (tsvAt >= 0) {
    const file = argv[tsvAt + 1]
    if (!file) throw new Error('--tsv needs a file path')
    return readFileSync(file, 'utf8')
  }
  const run = promisify(execFile)
  const { stdout } = await run(process.env.AGY_BIN ?? 'agy', ['models'], { timeout: 30_000, maxBuffer: 4 << 20 })
  return stdout
}

async function main() {
  const diff = diffLineup(DEFAULT_FALLBACK_MODELS, await readLiveCatalog(process.argv.slice(2)))
  const verdict = classify(diff)
  console.log(`lineup offers ${diff.offered.size} slugs · agy lists ${diff.live.size}`)
  if (verdict === 'empty') {
    console.error('lineup-drift: agy listed no models (signed out, or `agy` not on PATH). Set AGY_BIN or pass --tsv.')
    return 2
  }
  if (verdict === 'drifted') console.error(`lineup-drift: DEFAULT_FALLBACK_MODELS no longer mirrors agy\n${formatReport(diff)}`)
  else console.log('in sync')
  return verdict === 'drifted' ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`lineup-drift: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(2)
    },
  )
}
