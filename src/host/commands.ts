// /agy command family (spec section 6). One registered command dispatches on
// its first token; every handler answers with GUI-renderable markdown. The
// handlers live in ./commands/{status,auth,pool,config,session,models,doctor}.ts
// and are wired by ./commands/registry.ts.
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { PluginConfig } from '../common/types.ts'
import type { HostServices } from './services.ts'
import { dispatchCommand } from './commands/registry.ts'
import { err, type CommandDeps, type GoalServiceLike } from './commands/shared.ts'
import { writeDoctorReport } from './diagnostics.ts'
import { runAgyOnce } from './oneshot.ts'

export type { CommandDeps } from './commands/shared.ts'

export function buildAgyCommandDeps(opts: {
  services: HostServices
  goals: () => GoalServiceLike | undefined
  agents: () => { get(id: unknown): unknown } | undefined
}): CommandDeps {
  const { services, goals, agents } = opts
  const { getConfig, log, bin, version, store, pool, quota, catalog, auth, poolAuth, adapter, acpPool, ecosystem, imageService, setOverride, notifyPicker, readEffortUnsupported, rememberEffortUnsupported, sessionsSvc, backgroundWakeup } = services
  return {
    cfg: getConfig,
    bin,
    version,
    auth: () => auth,
    catalog: () => catalog,
    store: () => store,
    pool: () => pool,
    poolAuth: () => poolAuth,
    quota: () => quota,
    lastRun: () => services.lastRun,
    imageService: () => imageService,
    acpStatus: () => acpPool.status(),
    backgroundStatus: () => backgroundWakeup.status(),
    ecosystem: () => ecosystem,
    activeRun: (sessionId) => adapter.activeRun(sessionId),
    runOnce: (req) => runAgyOnce({
      cfg: getConfig,
      bin,
      pool: () => pool,
      acquire: (sig) => services.semaphore.acquire(sig),
      log,
      effortUnsupported: () => readEffortUnsupported(),
      onEffortUnsupported: (model) => rememberEffortUnsupported(model),
    }, req),
    setOverride,
    notifyPicker,
    sessions: () => sessionsSvc(),
    goals,
    agents,
    runDoctor: async () => writeDoctorReport({
      cfg: getConfig,
      bin,
      version,
      catalog: () => catalog,
      store: () => store,
      recentLines: () => services.lastParser.recentLines,
      effortUnsupported: () => adapter.effortUnsupportedModels(),
      accounts: () => services.pool.getAccounts(),
    }),
  }
}

export function agyCommandDefinition(deps: CommandDeps): CommandDefinition {
  return {
    name: 'agy',
    description: 'Antigravity (agy CLI) bridge: status, login, models, mode, diagnostics, goal',
    // Without `input`, DSH's composer treats `/agy <sub>` as an illegal bare
    // command and silently falls back to a normal chat message (issue #27).
    input: { hint: '<status|pool|use|add-account|enable-account|disable-account|remove-account|refresh-quota|clear-cooldown|auth|auth-status|auth-code|import|image|goal|session|btw|fork|grill|learn|compact|mcp|plugins|agents|skills|sync-ecosystem|models|mode|sandbox|agent|settings|transport|wakeup|effort|dispatch|dispatch-retries|parallel|max-concurrent|workspace|clear|doctor|help>' },
    handler: (invocation) => handle(deps, invocation.rawInput, invocation),
  }
}

async function handle(deps: CommandDeps, raw: string, invocation?: CommandInvocation): Promise<CommandResult> {
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  const sub = (parts[0] ?? 'help').toLowerCase()
  const arg = parts[1] ?? ''
  try {
    return await dispatchCommand(deps, { sub, arg, parts, raw, invocation })
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }
}
