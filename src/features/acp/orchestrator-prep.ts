// Persist Orchestrator role settings before an ACP turn (issue #204).
//
// Kept out of run-attempt.ts so the dispatch file stays within its module
// budget, and because this is a POLICY decision worth testing on its own:
// which settings get persisted, when the process key must change, and when the
// caller must fall back to the CLI path (where `--settings` is passed inline).
import type { PluginConfig } from '../../common/types.ts'
import { buildOrchestratorSettingsObject, isOrchestratorModel } from '../../common/orchestrator.ts'
import { resolveModelSlug } from '../../host/models.ts'
import { agySettingsFilePath, syncOrchestratorSettingsFileAt } from '../../runtime/agy/settings-sync.ts'
import { accountHome, type AccountEnvRef } from '../../runtime/net/account-env.ts'

export type OrchestratorPrep =
  | { ok: true; settingsTag?: string }
  | { ok: false; reason: 'merge-failed' }

/**
 * Write the configured planner/executor seats to the account's `settings.json`
 * when (and only when) this turn targets an Orchestrator role model, and return
 * the tag that must be part of the ACP process key.
 *
 * The resident `agy acp` server reads settings at startup, so a process spawned
 * with different seats must never be reused; the key tag makes the pool spawn a
 * fresh one while the old process finishes (and is reaped by the idle sweep).
 */
export function prepareOrchestratorSettingsForAcp(input: {
  cfg: PluginConfig
  activeModel: string
  account: AccountEnvRef | undefined
  log?: (msg: string) => void
}): OrchestratorPrep {
  const effectiveModel = resolveModelSlug(
    input.activeModel === '' ? input.cfg.defaultModel : input.activeModel,
  )
  if (!isOrchestratorModel(effectiveModel)) return { ok: true }
  const payload = buildOrchestratorSettingsObject(input.cfg)

  const file = agySettingsFilePath(accountHome(input.account))
  const sync = syncOrchestratorSettingsFileAt(file, payload, { clearRemovedSeats: true })
  if (sync === 'skipped') {
    input.log?.(`[agy-link] orchestrator settings could not be merged into ${file} — using the CLI path so --settings still applies`)
    return { ok: false, reason: 'merge-failed' }
  }
  if (sync === 'written') {
    input.log?.(`[agy-link] orchestrator settings updated in ${file} — the next ACP process will read them`)
  }
  return payload === undefined ? { ok: true } : { ok: true, settingsTag: JSON.stringify(payload) }
}