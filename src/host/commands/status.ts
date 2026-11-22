// /agy status — binary, version, auth, mode, catalog and binding overview.
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { classifyToolError } from '../recording.ts'
import { ok, type AcpStatusView, type CommandDeps } from './shared.ts'

/** One-line ACP pool summary, including drains and credential-slot recoveries. */
function describeAcp(s: AcpStatusView): string {
  const parts = [`${s.activeProcesses} proc`, `${s.sessions} session(s)`]
  if ((s.drainingProcesses ?? 0) > 0) parts.push(`${s.drainingProcesses} draining`)
  if ((s.slotOverwriteDetectedCount ?? 0) > 0) parts.push(`slot overwrites: ${s.slotOverwriteDetectedCount}`)
  if (s.lastSlotRecoveryAt != null) parts.push(`slot recovered ${new Date(s.lastSlotRecoveryAt).toISOString()}`)
  return ` (${parts.join(', ')})`
}

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
    '- sandbox: ' + (cfg.sandbox ? 'on' : 'off'),
    '- transport: ' + cfg.transport + (cfg.transport === 'acp' && deps.acpStatus ? describeAcp(deps.acpStatus()) : ''),
    '- background wakeup: ' + (cfg.backgroundWakeup ? 'on' : 'off') + (deps.backgroundStatus ? (() => { const w = deps.backgroundStatus(); return ` (watches: ${w.activeWatches}, timers: ${w.pendingTimers}, tasks: ${w.pendingTasks})`; })() : ''),
    ...(cfg.agent.trim() !== '' ? ['- agent: ' + cfg.agent.trim()] : []),
    ...(cfg.agySettings.trim() !== '' ? ['- settings override: ' + cfg.agySettings.trim()] : ''),
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
          ...(hasHeadlessPermissionDenial && cfg.permissionMode !== 'skip'
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
