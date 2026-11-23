// Command registry: maps each /agy subcommand to its group handler. The
// dispatcher is order-independent because every subcommand appears once.
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { HELP, ok, type CommandContext, type CommandDeps, type CommandHandler } from './shared.ts'
import { handleStatus } from './status.ts'
import { handlePool } from './pool.ts'
import { handleAuth } from './auth.ts'
import { handleConfig } from './config.ts'
import { handleSession, handleGoal, handleClear } from './session.ts'
import { handleModels } from './models.ts'
import { handleDoctor } from './doctor.ts'
import { handleCacheStats } from './cache.ts'
import { handleImage } from './image.ts'
import { handleEcosystem } from './ecosystem.ts'
import { handleSlashBridge } from './slash-bridge.ts'

interface CommandEntry {
  readonly subs: readonly string[]
  readonly handle: CommandHandler
}

export const COMMAND_REGISTRY: readonly CommandEntry[] = [
  { subs: ['status'], handle: handleStatus },
  {
    subs: [
      'pool', 'accounts',
      'use', 'set-active',
      'enable-account', 'disable-account', 'add-account',
      'refresh-quota', 'clear-cooldown', 'remove-account',
    ],
    handle: handlePool,
  },
  { subs: ['auth', 'auth-status', 'auth-code', 'import', 'import-token'], handle: handleAuth },
  { subs: ['models'], handle: handleModels },
  {
    subs: [
      'mode', 'sandbox', 'agent', 'settings', 'transport', 'wakeup', 'effort',
      'dispatch', 'dispatch-retries',
      'parallel', 'max-concurrent',
      'workspace',
    ],
    handle: handleConfig,
  },
  { subs: ['goal'], handle: handleGoal },
  { subs: ['session'], handle: handleSession },
  { subs: ['clear'], handle: handleClear },
  { subs: ['image', 'img'], handle: handleImage },
  { subs: ['btw', 'fork', 'grill', 'grill-me', 'learn', 'compact'], handle: handleSlashBridge },
  { subs: ['plugins', 'mcp', 'agents', 'skills', 'sync-ecosystem', 'sync'], handle: handleEcosystem },
  { subs: ['doctor'], handle: handleDoctor },
  { subs: ['cache-stats', 'cache'], handle: handleCacheStats },
]

/** Route one parsed invocation to its group handler; `help`/unknown returns HELP. */
export async function dispatchCommand(deps: CommandDeps, ctx: CommandContext): Promise<CommandResult> {
  for (const entry of COMMAND_REGISTRY) {
    if (entry.subs.includes(ctx.sub)) return entry.handle(deps, ctx)
  }
  return ok(HELP)
}
