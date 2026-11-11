// /agy models — refresh and list discovered Antigravity models.
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { ok, type CommandDeps } from './shared.ts'

export async function handleModels(deps: CommandDeps): Promise<CommandResult> {
  const cat = await deps.catalog().forceRefresh()
  const lines = [
    '**Antigravity models** — source: ' + cat.source + (cat.lastError === undefined ? '' : ' — ' + cat.lastError) + ':',
  ]
  for (const m of cat.models) {
    lines.push('- `' + m.id + '` — ' + m.name + (m.efforts ? ' — efforts: ' + m.efforts.join(' / ') : ''))
  }
  return ok(lines.join('\n'))
}
