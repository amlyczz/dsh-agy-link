// /agy doctor — write a diagnostic report and return its path.
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { ok, type CommandDeps } from './shared.ts'

export async function handleDoctor(deps: CommandDeps): Promise<CommandResult> {
  const path = await deps.runDoctor()
  return ok('Diagnostic report written to `' + path + '` — attach it when opening an issue.')
}
