/**
 * Type contract for scripts/lineup-drift.mjs (plain JS, importable for tests).
 * Keeping it here is what lets the TDD test suite type-check under tsc.
 */
import type { FallbackModelDef } from '../src/common/model-lineup.ts'
import type { CatalogEntry } from '../src/domain/models/parse.ts'

export interface LineupDiff {
  /** One slug per tier the lineup offers; a bare id for fixed-thinking entries. */
  offered: Set<string>
  /** The raw slugs `agy models` listed. */
  live: Set<string>
  /** Offered by the lineup, no longer listed by agy. */
  stale: string[]
  /** Listed by agy, not offered by the lineup. */
  missing: string[]
  /** The same slugs in a different order (only meaningful when the sets are equal). */
  reordered: boolean
}

/** `empty` when agy listed nothing usable — inconclusive, never reported as drift. */
export type LineupVerdict = 'empty' | 'in-sync' | 'drifted'

export function offeredSlugs(entries: readonly { id: string; efforts?: readonly string[] | null }[]): Set<string>
export function diffLineup(lineup: readonly FallbackModelDef[], agyModelsOutput: string): LineupDiff
export function classify(diff: LineupDiff): LineupVerdict
export function formatReport(diff: LineupDiff): string
