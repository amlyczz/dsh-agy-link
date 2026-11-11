// /agy command family (spec section 6). One registered command dispatches on
// its first token; every handler answers with GUI-renderable markdown. The
// handlers live in ./commands/{status,auth,pool,config,session,models,doctor}.ts
// and are wired by ./commands/registry.ts.
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { dispatchCommand } from './commands/registry.ts'
import { err, type CommandDeps } from './commands/shared.ts'

export type { CommandDeps } from './commands/shared.ts'

export function agyCommandDefinition(deps: CommandDeps): CommandDefinition {
  return {
    name: 'agy',
    description: 'Antigravity (agy CLI) bridge: status, login, models, mode, diagnostics, goal',
    // Without `input`, DSH's composer treats `/agy <sub>` as an illegal bare
    // command and silently falls back to a normal chat message (issue #27).
    input: { hint: '<status|pool|goal|session|enable-account|disable-account|models|mode|effort|dispatch|dispatch-retries|parallel|max-concurrent|workspace|clear|doctor|help>' },
    handler: (invocation) => handle(deps, invocation.rawInput, invocation),
  }
}

async function handle(deps: CommandDeps, raw: string, invocation?: CommandInvocation): Promise<CommandResult> {
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  const sub = parts[0] ?? 'help'
  const arg = parts[1] ?? ''
  try {
    return await dispatchCommand(deps, { sub, arg, parts, raw, invocation })
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }
}
