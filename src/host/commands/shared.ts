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
import type { OneShotResult } from '../oneshot.ts'
import type { EcosystemService } from '../../features/ecosystem/index.ts'
import type { BackgroundWakeStatus } from '../../common/background-types.ts'

export interface GoalViewLike {
  id: string
  revision: number
  objective: string
  phase: string
  maxGoalRounds?: number
  roundsStarted?: number
  activation?: string
  blockedReason?: { code?: string; message: string }
}

export interface GoalServiceLike {
  get(agent: unknown): GoalViewLike | undefined
  create(agent: unknown, req: { objective: string; maxGoalRounds?: number }): GoalViewLike
  edit(agent: unknown, ref: { id: string; revision: number }, req: { objective: string }): GoalViewLike
  pause(agent: unknown, ref: { id: string; revision: number }): GoalViewLike
  resume(agent: unknown, ref: { id: string; revision: number }): GoalViewLike
  complete(agent: unknown, ref: { id: string; revision: number }): GoalViewLike
  clear(agent: unknown, ref: { id: string; revision: number }): unknown
}

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
  notifyPicker?: () => void
  runDoctor: () => Promise<string>
  sessions?: () => { get(id: unknown): unknown } | undefined
  goals?: () => GoalServiceLike | undefined
  agents?: () => { get(id: unknown): unknown } | undefined
  imageService?: () => import('../image.ts').ImageService
  acpStatus?: () => { activeProcesses: number; sessions: number; keys: readonly string[] }
  backgroundStatus?: () => BackgroundWakeStatus
  ecosystem?: () => EcosystemService
  runOnce?: (req: {
    prompt: string
    model?: string
    effort?: string
    mode?: string
    timeoutMs?: number
    signal?: AbortSignal
    readPaths?: readonly string[]
    schema?: unknown
    agent?: string
    sandbox?: boolean
    agySettings?: string
    conversationId?: string
  }) => Promise<OneShotResult>
  forksFile?: string
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
  '- `/agy goal [status|set <obj>|edit <obj>|pause|resume|complete|clear]` — inspect or control the current DSH goal',
  '- `/agy session [info|clear]` — view or drop the current session agy binding',
  '- `/agy add-account [alias]` — start OAuth login for a new account slot',
  '- `/agy use <id>` — switch the active account immediately',
  '- `/agy enable-account <id>` — enable an account slot',
  '- `/agy disable-account <id>` — disable an account slot (skips in rotation)',
  '- `/agy refresh-quota` — query Google backend for fresh quota %',
  '- `/agy clear-cooldown` — reset cooldown timers (and any active low-quota bench)',
  '- `/agy remove-account <id>` — delete an account slot',
  '- `/agy auth [id|alias|email]` — login to the primary or reauthenticate an existing account',
  '- `/agy auth-status` — check the current or most recent login result',
  '- `/agy auth-code <code>` — finish login by pasting the code (fallback)',
  '- `/agy import <refresh_token_or_json> [alias]` — import account via refresh token or token JSON',
  '- `/agy models` — refresh and list discovered models',
  '- `/agy image <prompt> [-a ratio] [-n name] [-i ref]` — generate or edit an image via agy (`generate_image`)',
  '- `/agy btw <question>` — ask an isolated side question in read-only mode without altering session state',
  '- `/agy fork [list|restore <id>|<prompt>]` — snapshot, branch, or restore an agy conversation fork',
  '- `/agy grill [topic]` / `/agy grill-me [topic]` — structured design interview to surface trade-offs & decisions',
  '- `/agy learn [--apply] [focus]` — distill a reusable Skill or Rule from this session (optionally save to `.agents/`)',
  '- `/agy compact [focus]` — summarize session context and reset the agy conversation binding',
  '- `/agy plugins [list|enable <id>|disable <id>]` — inspect or toggle installed Antigravity plugins',
  '- `/agy mcp` / `/agy skills` / `/agy agents [list|use <name>|off]` — inspect MCP servers, skills/rules, and custom agents',
  '- `/agy sync-ecosystem` — mirror primary plugins, skills, rules, agents, and MCP config to isolated pool accounts',
  '- `/agy mode <skip|auto|plan|accept-edits>` — permission mode (next turn)',
  '- `/agy sandbox [on|off]` — toggle OS terminal sandbox (`--sandbox`)',
  '- `/agy agent [name|off]` — select default custom Markdown agent (`--agent`)',
  '- `/agy settings [show|<json-or-path>|clear]` — set per-session `agy --settings` override',
  '- `/agy transport [cli|acp|status]` — switch between CLI `-p` and persistent `agy acp`',
  '- `/agy wakeup [on|off|status]` — toggle cross-turn background timer/task wakeup or inspect active watches',
  '- `/agy effort <low|medium|high|xhigh|max|default>` — default reasoning effort',
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
