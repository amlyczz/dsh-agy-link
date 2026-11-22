// /agy ecosystem commands: plugins, mcp, agents, skills, and sync-ecosystem.
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { err, ok, type CommandContext, type CommandDeps } from './shared.ts'
import { resolveSessionWorkspace } from './slash-context.ts'

function formatSourceTag(source: string, pluginName?: string): string {
  return pluginName ? `${source}:${pluginName}` : source
}

export function handleEcosystem(deps: CommandDeps, ctx: CommandContext): CommandResult {
  const eco = deps.ecosystem?.()
  if (!eco) {
    return err('Ecosystem service is not initialized in this host.')
  }
  const { sub, parts, raw } = ctx
  const action = (parts[1] ?? '').toLowerCase()
  const workspaceRoot = resolveSessionWorkspace(deps, ctx)

  if (sub === 'sync-ecosystem' || sub === 'sync') {
    const report = eco.syncAll({ force: true })
    const lines = [
      '**Antigravity Ecosystem Sync**',
      `- Primary home: \`${report.primaryHome}\``,
      `- Synced pool accounts: ${report.syncedAccounts.length}${report.syncedAccounts.length > 0 ? ` (${report.syncedAccounts.join(', ')})` : ''}`,
      `- Skipped accounts: ${report.skippedAccounts.length}`,
      `- Files copied/updated: ${report.copiedFiles}, removed: ${report.removedFiles}`,
    ]
    if (report.errors.length > 0) {
      lines.push(`- Errors (${report.errors.length}): ${report.errors.map((e) => `${e.accountId}: ${e.error}`).join('; ')}`)
    }
    return ok(lines.join('\n'))
  }

  const snap = eco.inspect(workspaceRoot)

  if (sub === 'plugins') {
    if (action === 'enable' || action === 'disable') {
      const id = (parts[2] ?? '').trim()
      if (!id) return err(`Usage: /agy plugins ${action} <plugin-id>`)
      const updated = eco.setPluginEnabled(id, action === 'enable', workspaceRoot)
      const target = updated.plugins.find((p) => p.id === id)
      return ok(`Plugin **${target?.name ?? id}** (\`${id}\`) ${action === 'enable' ? 'enabled' : 'disabled'}.`)
    }
    if (action !== '' && action !== 'list') {
      return err('Usage: /agy plugins [list|enable <id>|disable <id>]')
    }
    if (snap.plugins.length === 0) {
      return ok('No Antigravity plugins installed (checked `~/.gemini/config/plugins` and `.agents/plugins`).')
    }
    const lines = snap.plugins.map((p) =>
      `- ${p.enabled ? '🟢' : '⚪'} **${p.name}** (\`${p.id}\`, ${p.source}${p.version ? `, v${p.version}` : ''})`
      + ` — skills: ${p.skillCount}, rules: ${p.ruleCount}${p.hasMcp ? ', MCP' : ''}${p.hasHooks ? ', hooks' : ''}`
      + (p.description ? ` — ${p.description}` : ''),
    )
    return ok(['**Antigravity Plugins** (' + snap.plugins.length + ')', ...lines].join('\n'))
  }

  if (sub === 'mcp') {
    if (snap.mcpServers.length === 0) {
      return ok('No external Antigravity MCP servers configured (excluding internal `dsh-tools`).')
    }
    const lines = snap.mcpServers.map((s) =>
      `- ${s.disabled ? '⚪ disabled' : '🟢 active'} **${s.name}** (${s.transport}, ${formatSourceTag(s.source, s.pluginName)}) → \`${s.target}\``,
    )
    return ok(['**Antigravity MCP Servers** (' + snap.mcpServers.length + ')', ...lines].join('\n'))
  }

  if (sub === 'skills') {
    const lines: string[] = [
      `**Antigravity Skills (${snap.skills.length}) & Rules (${snap.rules.length})**`,
      ...snap.skills.map((s) => `- Skill **${s.name}** (${formatSourceTag(s.source, s.pluginName)})${s.description ? `: ${s.description}` : ''}`),
      ...snap.rules.map((r) => `- Rule **${r.name}** (${formatSourceTag(r.source, r.pluginName)}, ${r.bytes} B) — \`${r.path}\``),
    ]
    if (snap.skills.length === 0 && snap.rules.length === 0) {
      lines.push('- *(none discovered)*')
    }
    return ok(lines.join('\n'))
  }

  if (sub === 'agents') {
    if (action === 'use') {
      const target = (raw ?? '').trim().replace(/^(?:\/agy\s+)?agents\s+use\s*/i, '').trim() || (parts[2] ?? '').trim()
      if (!target) return err('Usage: /agy agents use <name>')
      deps.setOverride('agent', target)
      return ok(`Custom agent set to **${target}** — effective next turn.`)
    }
    if (action === 'off' || action === 'clear' || action === 'default') {
      deps.setOverride('agent', '')
      return ok('Custom agent cleared (back to default agy agent) — effective next turn.')
    }
    if (action !== '' && action !== 'list') {
      return err('Usage: /agy agents [list|use <name>|off]')
    }
    const current = deps.cfg().agent.trim()
    if (snap.agents.length === 0) {
      return ok(
        `No custom Markdown agents discovered. Active override: **${current || '(default)'}**.\n`
        + 'Use `/agy agents use <name>` or `/agy agents off` to manage `--agent`.',
      )
    }
    const lines = snap.agents.map((a) =>
      `- ${current === a.name ? '⭐ ' : ''}**${a.name}** (${a.source})${a.description ? `: ${a.description}` : ''}`,
    )
    return ok([
      `**Antigravity Custom Agents** (${snap.agents.length}, active: **${current || '(default)'}**)`,
      ...lines,
      'Use `/agy agents use <name>` to activate or `/agy agents off` to clear.',
    ].join('\n'))
  }

  return err(`Unknown ecosystem command \`${sub}\`.`)
}
