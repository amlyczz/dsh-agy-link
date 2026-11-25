// Persist the Orchestrator role selection where a resident `agy acp` process
// actually reads it (issue #204).
//
// The CLI path passes `--settings` per invocation. ACP has no such flag: the
// server reads `<gemini-home>/antigravity-cli/settings.json` at STARTUP, so a
// long-lived process only honours planner/executor changes that were on disk
// before it spawned.
//
// Rules:
//   * never touch a file we cannot parse — a corrupt setting must not turn into
//     "the plugin deleted my AGY configuration";
//   * merge, never replace: unrelated keys (and unknown nested orchestrator
//     keys) stay byte-for-byte intact;
//   * report whether the file actually changed so the caller only recycles ACP
//     processes when there is something new to pick up.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tryWriteFileAtomic } from '../../common/atomic-write.ts'
import type { OrchestratorSettingsPayload } from '../../common/orchestrator.ts'
import { mergeOrchestratorIntoAgySettings } from '../../common/orchestrator.ts'

export type SettingsSyncResult = 'written' | 'unchanged' | 'skipped'

/** `settings.json` path for an agy HOME (isolated account dir or the real user home). */
export function agySettingsFilePath(home: string): string {
  return join(home, '.gemini', 'antigravity-cli', 'settings.json')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The orchestrator object an on-disk settings document already carries. */
function readOrchestrator(raw: string): Record<string, unknown> | null | 'invalid' {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (!isPlainObject(parsed)) return 'invalid'
    return isPlainObject(parsed.orchestrator) ? parsed.orchestrator : null
  } catch {
    return 'invalid'
  }
}

/**
 * Merge `payload` into the settings document at `file`.
 *
 * Returns `'unchanged'` when the two role fields already match, `'written'`
 * after a successful atomic write, and `'skipped'` when there is nothing to
 * write or the existing document cannot be parsed safely.
 */
export function syncOrchestratorSettingsFileAt(
  file: string,
  payload: OrchestratorSettingsPayload | undefined,
): SettingsSyncResult {
  if (!payload || (payload.planner === undefined && payload.executor === undefined)) return 'skipped'
  let base: string | undefined
  if (existsSync(file)) {
    try {
      base = readFileSync(file, 'utf8')
    } catch {
      return 'skipped'
    }
  }
  const existing = base === undefined ? null : readOrchestrator(base)
  if (existing === 'invalid') return 'skipped'
  const alreadyThere =
    existing !== null
    && (payload.planner === undefined || existing.planner === payload.planner)
    && (payload.executor === undefined || existing.executor === payload.executor)
  if (alreadyThere) return 'unchanged'
  const merged = mergeOrchestratorIntoAgySettings(base, payload)
  if (merged === undefined || merged.trim() === '') return 'skipped'
  return tryWriteFileAtomic(file, merged.endsWith('\n') ? merged : merged + '\n') ? 'written' : 'skipped'
}