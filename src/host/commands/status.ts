// /agy status — binary, version, auth, mode, catalog and binding overview.
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { classifyToolError } from '../recording.ts'
import { ok, type CommandDeps } from './shared.ts'

export async function renderStatus(deps: CommandDeps): Promise<string> {
  const cfg = deps.cfg()
  const bin = deps.bin()
  const authHelper = deps.auth()
  // Bound the auth probe so /agy status never hangs the command UI (issue #29).
  // Keep the timer handle so a fast answer doesn't leave a pending timeout.
  let probeTimer: NodeJS.Timeout | null = null
  const auth = authHelper
    ? await Promise.race([
        authHelper.resolvedStatus(),
        new Promise<undefined>((r) => {
          probeTimer = setTimeout(() => r(undefined), 8_000)
        }),
      ]).finally(() => {
        if (probeTimer !== null) clearTimeout(probeTimer)
      })
    : undefined
  const cat = deps.catalog().get()
  const bindings = Object.keys(deps.store().all()).length
  const last = deps.lastRun()
  const errorKinds = last?.toolErrors.map(classifyToolError) ?? []
  const hasHeadlessPermissionDenial = errorKinds.includes('approval')
  const lines = [
    '**dsh-agy-link status**',
    '- agy binary: ' + (bin ?? 'not found — install via https://antigravity.google/docs/cli/install'),
    '- version: ' + (deps.version() ?? 'unknown'),
    '- auth: ' + (auth ? auth.phase + (auth.message ? ' — ' + auth.message : '') : 'unknown'),
    '- permission mode: ' + cfg.permissionMode + (cfg.permissionMode === 'skip' ? ' — WARNING: agy runs tools without approval' : ''),
    '- workspace: ' + (cfg.workspaceRoot !== '' ? cfg.workspaceRoot : '(session cwd / process cwd)'),
    '- default model: ' + (cfg.defaultModel === '' ? '(agy default)' : cfg.defaultModel),
    '- default effort: ' + (cfg.defaultEffort === '' ? '(model default)' : cfg.defaultEffort),
    '- catalog: ' + cat.models.length + ' models — ' + cat.source + (cat.lastError === undefined ? '' : ' — last error: ' + cat.lastError),
    '- conversation bindings: ' + bindings,
    '- last run process: ' + (last ? (last.processOk ? 'ok' : last.processCode) + ' — ' + last.model + ' in ' + Math.round(last.durationMs / 100) / 10 + 's' : 'none yet'),
    ...(last?.tokenSpeed !== undefined && (last.tokenSpeed.measuredSteps > 0 || last.tokenSpeed.outputTokens > 0)
      ? [
          '- last run tokens: ' + last.tokenSpeed.outputTokens + ' output tokens' +
            (last.tokenSpeed.avgTps !== null ? ' — avg ' + last.tokenSpeed.avgTps.toFixed(1) + ' tok/s' : '') +
            (last.tokenSpeed.lastTps !== null ? ' (last generation step: ' + last.tokenSpeed.lastTps.toFixed(1) + ' tok/s)' : ''),
        ]
      : []),
    ...(last && last.toolErrors.length > 0
      ? [
          '- last run tool errors (' + last.toolErrors.length + '): ' + last.toolErrors.join(' | '),
          ...(errorKinds.includes('missing_file')
            ? ['- Guidance: `missing_file` — verify the expected workspace/artifact path for this conversation; do not invent paths or bypass protections.']
            : []),
          ...(errorKinds.includes('system_protection')
            ? ['- Guidance: `system_protection` — AGY hardcoded system protection remains enforced; do not attempt a bypass.']
            : []),
          ...(hasHeadlessPermissionDenial && (cfg.permissionMode === 'plan' || cfg.permissionMode === 'accept-edits')
            ? ['- Note: in headless operation, agy can automatically deny a tool under this mode; the raw denial above is not evidence of a human approval or denial.']
            : []),
        ]
      : []),
  ]
  return lines.join('\n')
}

export async function handleStatus(deps: CommandDeps): Promise<CommandResult> {
  return ok(await renderStatus(deps))
}
