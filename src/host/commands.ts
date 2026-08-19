// /agy command family (spec section 6). One registered command dispatches
// on its first token; every handler answers with GUI-renderable markdown.
import { isAbsolute } from 'node:path'
import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import type { PluginConfig } from '../common/types.ts'
import type { AuthHelper } from './auth.ts'
import type { ModelCatalog } from './models.ts'
import type { SessionStore } from './sessions.ts'

export interface CommandDeps {
  cfg: () => PluginConfig
  bin: () => string | null
  version: () => string | null
  auth: () => AuthHelper | null
  catalog: () => ModelCatalog
  store: () => SessionStore
  lastRun: () => { ok: boolean; code: string; durationMs: number; model: string } | null
  setOverride: (key: string, value: unknown) => void
  runDoctor: () => Promise<string>
}

const HELP = [
  '**/agy** — Antigravity (agy CLI) bridge',
  '- `/agy status` — binary, version, auth, mode, catalog, bindings',
  '- `/agy auth` — start Google login (returns the consent URL)',
  '- `/agy auth-code <code>` — paste the authorization code',
  '- `/agy models` — refresh and list discovered models',
  '- `/agy mode <skip|plan|accept-edits>` — permission mode (next turn)',
  '- `/agy effort <low|medium|high|default>` — default reasoning effort',
  '- `/agy workspace [path]` — set the agy working directory (absolute path; omit to show)',
  '- `/agy clear` — drop the most recent conversation binding',
  '- `/agy doctor` — write a diagnostic report and return its path',
  '- `/agy help` — this text',
].join('\n')

export function agyCommandDefinition(deps: CommandDeps): CommandDefinition {
  return {
    name: 'agy',
    description: 'Antigravity (agy CLI) bridge: status, login, models, mode, diagnostics',
    handler: (invocation) => handle(deps, invocation.rawInput),
  }
}

async function handle(deps: CommandDeps, raw: string): Promise<CommandResult> {
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  const sub = parts[0] ?? 'help'
  const arg = parts[1] ?? ''
  try {
    if (sub === 'status') return ok(await renderStatus(deps))
    if (sub === 'auth') {
      const auth = deps.auth()
      if (!auth) return err('agy binary not found — install the CLI first')
      const st = await auth.begin()
      if (st.phase === 'pending' && st.url) {
        return ok([
          '**Google login required** — open the URL, approve access, then bring the authorization code back:',
          '',
          st.url,
          '',
          'Then run: `/agy auth-code <authorization code>`',
          'The GUI panel offers the same flow with a QR code and a paste box.',
        ].join('\n'))
      }
      return ok('Auth probe: ' + (st.message ?? st.phase))
    }
    if (sub === 'auth-code') {
      if (arg === '') return err('usage: /agy auth-code <code>')
      const auth = deps.auth()
      if (!auth) return err('agy binary not found')
      const st = await auth.submitCode(arg)
      return st.phase === 'ok' ? ok('Logged in to Antigravity.') : err(st.message ?? 'login failed')
    }
    if (sub === 'models') {
      const cat = await deps.catalog().forceRefresh()
      const lines = [
        '**Antigravity models** — source: ' + cat.source + (cat.lastError === undefined ? '' : ' — ' + cat.lastError) + ':',
      ]
      for (const m of cat.models) {
        lines.push('- `' + m.id + '` — ' + m.name + (m.efforts ? ' — efforts: ' + m.efforts.join(' / ') : ''))
      }
      return ok(lines.join('\n'))
    }
    if (sub === 'mode') {
      if (!['skip', 'plan', 'accept-edits'].includes(arg)) {
        return err('usage: /agy mode <skip|plan|accept-edits>')
      }
      deps.setOverride('permissionMode', arg)
      return ok('Permission mode set to **' + arg + '** — effective next turn.')
    }
    if (sub === 'effort') {
      if (!['low', 'medium', 'high', 'default'].includes(arg)) {
        return err('usage: /agy effort <low|medium|high|default>')
      }
      deps.setOverride('defaultEffort', arg === 'default' ? '' : arg)
      return ok('Default effort set to **' + (arg === 'default' ? 'model default' : arg) + '**.')
    }
    if (sub === 'workspace') {
      if (arg === '') return ok('Current workspace: ' + (deps.cfg().workspaceRoot !== '' ? deps.cfg().workspaceRoot : '(session cwd / process cwd)'))
      if (arg === 'default' || arg === 'clear') {
        deps.setOverride('workspaceRoot', '')
        return ok('Workspace reset to session cwd / process cwd.')
      }
      if (!isAbsolute(arg)) return err('workspace must be an absolute path (or `default` to clear)')
      deps.setOverride('workspaceRoot', arg)
      return ok('Workspace set to **' + arg + '** — effective next turn.')
    }
    if (sub === 'clear') {
      const all = deps.store().all()
      const keys = Object.keys(all)
      if (keys.length === 0) return ok('No conversation bindings yet.')
      const key = keys.reduce((a, b) => ((all[a]?.updatedAt ?? 0) >= (all[b]?.updatedAt ?? 0) ? a : b))
      const dropped = all[key]
      if (dropped === undefined) return ok('No conversation bindings yet.')
      deps.store().delete(key)
      return ok('Dropped binding for session `' + key + '` — agy conversation ' + dropped.conversationId + '. The next turn starts a fresh agy conversation.')
    }
    if (sub === 'doctor') {
      const path = await deps.runDoctor()
      return ok('Diagnostic report written to `' + path + '` — attach it when opening an issue.')
    }
    return ok(HELP)
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }
}

async function renderStatus(deps: CommandDeps): Promise<string> {
  const cfg = deps.cfg()
  const bin = deps.bin()
  const authHelper = deps.auth()
  const auth = authHelper ? await authHelper.resolvedStatus() : undefined
  const cat = deps.catalog().get()
  const bindings = Object.keys(deps.store().all()).length
  const last = deps.lastRun()
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
    '- last run: ' + (last ? (last.ok ? 'ok' : last.code) + ' — ' + last.model + ' in ' + Math.round(last.durationMs / 100) / 10 + 's' : 'none yet'),
  ]
  return lines.join('\n')
}

function ok(text: string): CommandResult {
  return { kind: 'success', text }
}

function err(text: string): CommandResult {
  return { kind: 'error', text }
}
