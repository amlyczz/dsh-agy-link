// Quota source: `agy -p /usage`.
//
// The Cloud Code REST quota APIs return TWO groups (Gemini, 3P). The CLI's own
// /usage command returns THREE for a Pro account — the extra one is
// "Gemini 4 Argon" with its own weekly bucket (verified live 2026-10-23).
// The CLI resolves that group internally, so asking the CLI is the only
// supported way to surface Argon quota without reimplementing a private call,
// and eliminates Node.js-level direct REST calls to Google's internal APIs.
//
// Everything here degrades to null/undefined: a missing binary, a hung spawn or
// an unknown agy version must never break the system.
import { tmpdir } from 'node:os'
import type { FamilyQuotaInfo, ModelFamily } from '../common/pool-types.ts'
import { startAgyProcess } from './runner.ts'

/** One window bucket as reported by `agy /usage`. */
export interface AgyUsageBucket {
  id: string
  name?: string
  /** "weekly" | "5h" (upstream vocabulary). */
  window: string
  remainingFraction?: number
  resetTime?: string
}

/** One quota group as reported by `agy /usage`. */
export interface AgyUsageGroup {
  name: string
  description?: string
  buckets: AgyUsageBucket[]
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

function normalizeBucket(raw: Record<string, unknown>): AgyUsageBucket | null {
  const id = str(raw.id)
  if (id === undefined) return null
  return {
    id,
    name: str(raw.name),
    window: (str(raw.window) ?? '').toLowerCase(),
    remainingFraction: num(raw.remaining_fraction ?? raw.remainingFraction),
    resetTime: str(raw.reset_time ?? raw.resetTime),
  }
}

/** Pull groups out of one `command_result` envelope. */
function groupsFromCommandResult(parsed: Record<string, unknown>): AgyUsageGroup[] | null {
  const command = parsed.command as Record<string, unknown> | undefined
  if (command === undefined || command.name !== 'usage') return null
  const data = command.data as Record<string, unknown> | undefined
  const rawGroups = data?.groups
  if (!Array.isArray(rawGroups) || rawGroups.length === 0) return null
  const groups: AgyUsageGroup[] = []
  for (const g of rawGroups) {
    if (g === null || typeof g !== 'object') continue
    const group = g as Record<string, unknown>
    const name = str(group.name)
    if (name === undefined) continue
    const buckets: AgyUsageBucket[] = []
    if (Array.isArray(group.buckets)) {
      for (const b of group.buckets) {
        if (b === null || typeof b !== 'object') continue
        const bucket = normalizeBucket(b as Record<string, unknown>)
        if (bucket !== null) buckets.push(bucket)
      }
    }
    groups.push({ name, description: str(group.description), buckets })
  }
  return groups.length > 0 ? groups : null
}

/**
 * Parse `agy -p /usage --output-format stream-json` stdout.
 *
 * Primary shape: one NDJSON line carrying a `command_result` event with
 * `command.name === "usage"`. Fallback: the plain-text table mode
 * (`<group>\t<window label>\t<pct>%\t<reset ISO>`), which the CLI prints when
 * run without `--output-format stream-json`.
 *
 * Returns null when nothing usable was found — callers keep their fallback data.
 */
export function parseAgyUsageOutput(stdout: string): AgyUsageGroup[] | null {
  const lines = stdout.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    const obj = parsed as Record<string, unknown>
    if (obj.event !== 'command_result') continue
    const groups = groupsFromCommandResult(obj)
    if (groups !== null) return groups
  }
  return parseUsageTextTable(stdout)
}

/** `<group>\t<label>\t<pct>%\t<reset>` rows; weekly labels carry "week". */
export function parseUsageTextTable(text: string): AgyUsageGroup[] | null {
  const byName = new Map<string, AgyUsageGroup>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    const cells = line.split('\t')
    if (cells.length < 3) continue
    const [groupName, label, pctCell] = cells as [string, string, string]
    const pct = Number.parseFloat(pctCell.replace('%', '').trim())
    if (!Number.isFinite(pct)) continue
    const window = /week/i.test(label) ? 'weekly' : '5h'
    let group = byName.get(groupName)
    if (group === undefined) {
      group = { name: groupName, buckets: [] }
      byName.set(groupName, group)
    }
    group.buckets.push({
      id: `${groupName.toLowerCase().replace(/\s+/g, '-')}-${window}`,
      name: label,
      window,
      remainingFraction: Math.min(1, Math.max(0, pct / 100)),
      resetTime: cells[3]?.trim() || undefined,
    })
  }
  return byName.size > 0 ? [...byName.values()] : null
}

/** Browser/client family keys this module can produce. */
type QuotaFamily = Exclude<ModelFamily, 'unknown'>

/**
 * Map CLI groups onto pool families.
 *
 * Order matters: the Argon group's description mentions "Gemini quota bucket",
 * so the Argon gate must run before the generic Gemini one or the two groups
 * collapse into `google` and overwrite each other.
 */
export function usageGroupsToFamilies(
  groups: readonly AgyUsageGroup[] | null,
  now = Date.now(),
): Partial<Record<ModelFamily, FamilyQuotaInfo>> {
  const out: Partial<Record<ModelFamily, FamilyQuotaInfo>> = {}
  if (groups === null) return out

  for (const group of groups) {
    const name = group.name.toLowerCase()
    const desc = (group.description ?? '').toLowerCase()
    const hasArgonBucket = group.buckets.some((b) => b.id.toLowerCase().includes('argon'))
    // A dedicated Argon POOL is proven only by the group NAME or a bucket id —
    // a shared "Gemini Models" group's description merely ENUMERATES its members
    // ("… Gemini 4 Argon …"), which is evidence of family membership, not of a
    // separate pool. Using it here misfiled the whole Gemini pool as argon on the
    // CLI path, freezing `google` at an old snapshot and cooling the wrong family
    // (issue #169 — the CLI twin of #130/#131).
    const isArgon = name.includes('argon') || hasArgonBucket
    const isGoogle = !isArgon && (name.includes('gemini') || desc.includes('gemini'))
    const is3P = name.includes('claude') || name.includes('gpt') || desc.includes('claude') || desc.includes('gpt')

    const families: QuotaFamily[] = isArgon
      ? ['argon']
      : isGoogle
        ? ['google']
        : is3P
          ? ['anthropic', 'openai']
          : []
    if (families.length === 0) continue

    let fiveHourFrac: number | undefined
    let fiveHourReset: string | undefined
    let weeklyFrac: number | undefined
    let weeklyReset: string | undefined
    for (const bucket of group.buckets) {
      const w = (bucket.window || bucket.id).toLowerCase()
      if (w.includes('week')) {
        weeklyFrac = bucket.remainingFraction
        weeklyReset = bucket.resetTime
      } else if (w.includes('5h') || w.includes('five')) {
        // Free accounts emit a protobuf zero-timestamp sentinel (`1970-01-01T00:00:00Z`)
        // on `3p-5h` to signal "no 5-hour bucket". Ignore that sentinel so weekly-only
        // cards reflect the real quota structure instead of a fake 100% 5h bar.
        const resetMs = bucket.resetTime ? Date.parse(bucket.resetTime) : Number.NaN
        const isEpochZero = Number.isFinite(resetMs) && resetMs <= 86_400_000
        if (!isEpochZero) {
          fiveHourFrac = bucket.remainingFraction
          fiveHourReset = bucket.resetTime
        }
      }
    }

    for (const family of families) {
      out[family] = {
        remainingFraction: fiveHourFrac,
        resetTime: fiveHourReset,
        weeklyFraction: weeklyFrac,
        weeklyResetTime: weeklyReset,
        description: group.description,
        updatedAt: now,
      }
    }
  }
  return out
}

/**
 * Overlay CLI families onto the base ones.
 *
 * The CLI is authoritative for the bucket numbers (it is what the Antigravity
 * UI itself renders) and adds families REST never reports (Argon).
 */
export function mergeUsageFamilies(
  base: Partial<Record<ModelFamily, FamilyQuotaInfo>>,
  cli: Partial<Record<ModelFamily, FamilyQuotaInfo>> | null,
): Partial<Record<ModelFamily, FamilyQuotaInfo>> {
  if (cli === null || cli === undefined) return base
  const keys = Object.keys(cli) as ModelFamily[]
  if (keys.length === 0) return base
  const merged: Partial<Record<ModelFamily, FamilyQuotaInfo>> = { ...base }
  for (const family of keys) {
    const incoming = cli[family]
    if (incoming === undefined) continue
    const existing = merged[family]
    merged[family] = {
      ...existing,
      ...incoming,
      ...(existing?.models !== undefined ? { models: existing.models } : {}),
      ...(incoming.description === undefined && existing?.description !== undefined
        ? { description: existing.description }
        : {}),
    }
  }
  return merged
}

/** Spawn one `agy -p /usage` and parse its groups. Never throws, never rejects. */
export async function readAgyUsage(opts: {
  bin: string
  env: NodeJS.ProcessEnv
  timeoutMs?: number
  signal?: AbortSignal
  preemptAutoUpdate?: boolean
}): Promise<AgyUsageGroup[] | null> {
  try {
    const proc = startAgyProcess({
      bin: opts.bin,
      args: ['-p', '/usage', '--output-format', 'stream-json'],
      cwd: tmpdir(),
      timeoutMs: opts.timeoutMs ?? 20_000,
      signal: opts.signal,
      env: opts.env,
      preemptAutoUpdate: opts.preemptAutoUpdate,
    })
    const outcome = await proc.outcome
    return parseAgyUsageOutput(outcome.stdout)
  } catch {
    return null
  }
}
