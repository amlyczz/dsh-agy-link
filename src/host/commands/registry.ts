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

interface CommandEntry {
  readonly subs: readonly string[]
  readonly handle: CommandHandler
}

export const COMMAND_REGISTRY: readonly CommandEntry[] = [
  { subs: ['status'], handle: handleStatus },
  {
    subs: [
      'pool', 'accounts',
      'enable-account', 'disable-account', 'add-account',
      'refresh-quota', 'clear-cooldown', 'remove-account',
    ],
    handle: handlePool,
  },
  { subs: ['auth', 'auth-status', 'auth-code'], handle: handleAuth },
  { subs: ['models'], handle: handleModels },
  {
    subs: [
      'mode', 'effort',
      'dispatch', 'dispatch-retries',
      'parallel', 'max-concurrent',
      'workspace',
    ],
    handle: handleConfig,
  },
  { subs: ['goal'], handle: handleGoal },
  { subs: ['session'], handle: handleSession },
  { subs: ['clear'], handle: handleClear },
  { subs: ['doctor'], handle: handleDoctor },
]

/** Route one parsed invocation to its group handler; `help`/unknown returns HELP. */
export async function dispatchCommand(deps: CommandDeps, ctx: CommandContext): Promise<CommandResult> {
  for (const entry of COMMAND_REGISTRY) {
    if (entry.subs.includes(ctx.sub)) return entry.handle(deps, ctx)
  }
  return ok(HELP)
}
