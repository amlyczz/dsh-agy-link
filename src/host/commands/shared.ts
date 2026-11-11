// Shared shapes and helpers for the /agy command family. Command groups live in
// sibling modules and are wired together by registry.ts.
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { PluginConfig } from '../../common/types.ts'
import type { AuthHelper } from '../auth.ts'
import type { ModelCatalog } from '../models.ts'
import type { SessionStore } from '../sessions.ts'
import type { AccountPoolManager } from '../pool.ts'
import type { PoolAuthFlow } from '../pool-auth.ts'
import type { QuotaService } from '../quota.ts'

export interface CommandDeps {
  cfg: () => PluginConfig
  bin: () => string | null
  version: () => string | null
  auth: () => AuthHelper | null
  catalog: () => ModelCatalog
  store: () => SessionStore
  pool?: () => AccountPoolManager
  poolAuth?: () => PoolAuthFlow
  quota?: () => QuotaService
  lastRun: () => {
    processOk: boolean
    processCode: string
    toolErrors: readonly string[]
    durationMs: number
    model: string
    tokenSpeed?: { lastTps: number | null; avgTps: number | null; outputTokens: number; measuredSteps: number; generatingMs: number }
  } | null
  setOverride: (key: string, value: unknown) => void
  runDoctor: () => Promise<string>
  sessions?: () => { get(id: unknown): unknown } | undefined
}

/** Parsed invocation handed to every command group. */
export interface CommandContext {
  sub: string
  arg: string
  parts: readonly string[]
  raw: string
  invocation?: CommandInvocation
}

export type CommandHandler = (deps: CommandDeps, ctx: CommandContext) => Promise<CommandResult> | CommandResult

export const HELP = [
  '**/agy** — Antigravity (agy CLI) bridge',
  '- `/agy status` — binary, version, auth, mode, catalog, bindings',
  '- `/agy pool` / `/agy accounts` — account pool, live quota %, cooldowns',
  '- `/agy goal [status|complete|clear|pause]` — inspect or control the current DSH goal',
  '- `/agy session [info|clear]` — view or drop the current session agy binding',
  '- `/agy add-account [alias]` — start OAuth login for a new account slot',
  '- `/agy enable-account <id>` — enable an account slot',
  '- `/agy disable-account <id>` — disable an account slot (skips in rotation)',
  '- `/agy refresh-quota` — query Google backend for fresh quota %',
  '- `/agy clear-cooldown` — reset cooldown timers (and any active low-quota bench)',
  '- `/agy remove-account <id>` — delete an account slot',
  '- `/agy auth [id|alias|email]` — login to the primary or reauthenticate an existing account',
  '- `/agy auth-status` — check the current or most recent login result',
  '- `/agy auth-code <code>` — finish login by pasting the code (fallback)',
  '- `/agy models` — refresh and list discovered models',
  '- `/agy mode <skip|plan|accept-edits>` — permission mode (next turn)',
  '- `/agy effort <low|medium|high|default>` — default reasoning effort',
  '- `/agy dispatch [minutes|off]` — credential-slot wait cap per attempt (omit to inspect; `off` = unlimited)',
  '- `/agy dispatch-retries <n>` — extra dispatch attempts after the cap',
  '- `/agy parallel <on|off>` — same-account parallel agy runs (Windows slot fast path)',
  '- `/agy max-concurrent <n|off>` — cap on concurrent agy request streams (off = unlimited, native)',
  '- `/agy workspace [path]` — set the agy working directory (absolute path; omit to show)',
  '- `/agy clear` — drop the most recent conversation binding',
  '- `/agy doctor` — write a diagnostic report and return its path',
  '- `/agy help` — this text',
].join('\n')

export function ok(text: string): CommandResult {
  return { kind: 'success', text }
}

export function err(text: string): CommandResult {
  return { kind: 'error', text }
}
