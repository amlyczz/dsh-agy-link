import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultConfig } from '../../../src/common/types.ts'
import type { ManagedAccount } from '../../../src/common/pool-types.ts'
import { EcosystemService } from '../../../src/features/ecosystem/index.ts'
import { inspectEcosystem, parseMarkdownFrontmatter } from '../../../src/features/ecosystem/inventory.ts'
import { syncEcosystemToPool } from '../../../src/features/ecosystem/sync.ts'
import { handleEcosystem } from '../../../src/host/commands/ecosystem.ts'
import type { CommandDeps } from '../../../src/host/commands/shared.ts'

function makeAccount(dir: string, id: string, extra: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id,
    alias: id,
    dir,
    enabled: true,
    createdAt: 0,
    cooldowns: {},
    quotas: {},
    ...extra,
  }
}

test('parseMarkdownFrontmatter and inspectEcosystem discover plugins, MCP, skills, rules, and agents', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-eco-inspect-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const primary = join(root, 'primary')
  const ws = join(root, 'workspace')
  const cfgDir = join(primary, '.gemini', 'config')
  mkdirSync(join(cfgDir, 'plugins', 'p-enabled', 'skills', 'sk-plugin'), { recursive: true })
  mkdirSync(join(cfgDir, 'plugins', 'p-enabled', 'rules'), { recursive: true })
  mkdirSync(join(cfgDir, 'plugins', 'p-disabled', '.antigravity-plugin'), { recursive: true })
  mkdirSync(join(cfgDir, 'plugins', 'p-disabled', 'skills', 'sk-hidden'), { recursive: true })
  mkdirSync(join(cfgDir, 'skills', 'sk-global'), { recursive: true })
  mkdirSync(join(cfgDir, 'rules'), { recursive: true })
  mkdirSync(join(cfgDir, 'agents', 'folder-agent'), { recursive: true })
  mkdirSync(join(ws, '.agents', 'agents'), { recursive: true })
  mkdirSync(join(ws, '.agents', 'skills', 'sk-ws'), { recursive: true })

  // Frontmatter folding + quotes
  const fm = parseMarkdownFrontmatter([
    '---',
    'name: "quoted-name"',
    'description: >-',
    '  line one',
    '  line two',
    '---',
    'body',
  ].join('\n'))
  assert.deepEqual(fm, { name: 'quoted-name', description: 'line one line two' })
  assert.deepEqual(parseMarkdownFrontmatter('no frontmatter'), {})

  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({
    plugins: {
      'p-enabled': { enabled: true },
      'p-disabled': { enabled: false },
    },
  }))
  writeFileSync(join(cfgDir, 'mcp_config.json'), JSON.stringify({
    mcpServers: {
      'dsh-tools': { command: 'node', args: ['bridge.mjs'] },
      'remote-api': { url: 'https://user:secret-pass@mcp.example.com/sse', env: { SECRET: 'hidden' } },
      'local-cli': { command: 'npx', args: ['-y', 'demo-mcp'] },
    },
  }))

  writeFileSync(join(cfgDir, 'plugins', 'p-enabled', 'plugin.json'), JSON.stringify({ name: 'Enabled Plugin', version: '1.2.0', description: 'Helpful' }))
  writeFileSync(join(cfgDir, 'plugins', 'p-enabled', 'mcp_config.json'), JSON.stringify({ mcpServers: { 'plugin-srv': { command: 'python', args: ['srv.py'] } } }))
  writeFileSync(join(cfgDir, 'plugins', 'p-enabled', 'hooks.json'), '{}')
  writeFileSync(join(cfgDir, 'plugins', 'p-enabled', 'skills', 'sk-plugin', 'SKILL.md'), '---\nname: plugin-skill\ndescription: From plugin\n---\n')
  writeFileSync(join(cfgDir, 'plugins', 'p-enabled', 'rules', 'p-rule.md'), '# plugin rule')

  writeFileSync(join(cfgDir, 'plugins', 'p-disabled', '.antigravity-plugin', 'plugin.json'), JSON.stringify({ name: 'Disabled Plugin' }))
  writeFileSync(join(cfgDir, 'plugins', 'p-disabled', 'skills', 'sk-hidden', 'SKILL.md'), '---\nname: hidden-skill\n---\n')

  writeFileSync(join(cfgDir, 'skills', 'sk-global', 'SKILL.md'), '---\nname: global-skill\ndescription: Global\n---\n')
  writeFileSync(join(cfgDir, 'rules', 'r1.md'), '# rule 1')
  writeFileSync(join(primary, '.gemini', 'AGENTS.md'), '# root agents')
  writeFileSync(join(cfgDir, 'agents', 'solo.md'), '---\nname: solo-agent\ndescription: Solo\n---\n')
  writeFileSync(join(cfgDir, 'agents', 'folder-agent', 'agent.md'), '---\ndescription: Folder agent\n---\n')

  writeFileSync(join(ws, 'AGENTS.md'), '# ws agents')
  writeFileSync(join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { 'ws-srv': { url: 'http://127.0.0.1:9000/mcp' } } }))
  writeFileSync(join(ws, '.agents', 'agents', 'ws-reviewer.md'), '---\nname: ws-reviewer\n---\n')
  writeFileSync(join(ws, '.agents', 'skills', 'sk-ws', 'SKILL.md'), '---\nname: ws-skill\n---\n')

  const snap = inspectEcosystem({ primaryHome: primary, workspaceRoot: ws, syncedAccountCount: 2, lastSyncAt: 1234 })
  assert.equal(snap.plugins.length, 2)
  assert.equal(snap.plugins.find((p) => p.id === 'p-enabled')?.hasHooks, true)
  assert.equal(snap.plugins.find((p) => p.id === 'p-disabled')?.enabled, false)

  // dsh-tools excluded; URL credentials redacted
  assert.equal(snap.mcpServers.some((m) => m.name === 'dsh-tools'), false)
  const remote = snap.mcpServers.find((m) => m.name === 'remote-api')
  assert.ok(remote)
  assert.equal(remote.target.includes('secret-pass'), false)
  assert.equal(remote.target, 'https://mcp.example.com/sse')
  assert.ok(snap.mcpServers.some((m) => m.name === 'plugin-srv' && m.pluginName === 'p-enabled'))
  assert.ok(snap.mcpServers.some((m) => m.name === 'ws-srv' && m.source === 'workspace'))

  // Disabled plugin's skills are excluded
  assert.equal(snap.skills.some((s) => s.name === 'hidden-skill'), false)
  assert.ok(snap.skills.some((s) => s.name === 'plugin-skill'))
  assert.ok(snap.skills.some((s) => s.name === 'global-skill'))
  assert.ok(snap.skills.some((s) => s.name === 'ws-skill'))
  assert.ok(snap.rules.some((r) => r.name === 'p-rule.md'))
  assert.ok(snap.rules.some((r) => r.name === 'AGENTS.md' && r.source === 'workspace'))
  assert.deepEqual(snap.agents.map((a) => a.name).sort(), ['folder-agent', 'solo-agent', 'ws-reviewer'])
  assert.equal(snap.syncedAccountCount, 2)
  assert.equal(snap.lastSyncAt, 1234)
})

test('syncEcosystemToPool mirrors allowlist, preserves target dsh-tools, prunes stale files, and blocks secrets/symlinks', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-eco-sync-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const primary = join(root, 'primary')
  const accDir = join(root, 'acc2')
  const outsideSecret = join(root, 'outside-secret.txt')
  writeFileSync(outsideSecret, 'TOP-SECRET')

  const pCfg = join(primary, '.gemini', 'config')
  const tCfg = join(accDir, '.gemini', 'config')
  mkdirSync(join(pCfg, 'skills', 's1'), { recursive: true })
  mkdirSync(join(pCfg, 'rules'), { recursive: true })
  mkdirSync(join(tCfg, 'skills', 'stale-skill'), { recursive: true })

  writeFileSync(join(pCfg, 'skills', 's1', 'SKILL.md'), '# skill 1')
  writeFileSync(join(pCfg, 'rules', 'safe.md'), '# safe rule')
  // Adversarial sensitive files must NEVER be mirrored
  writeFileSync(join(pCfg, 'rules', '.env'), 'API_KEY=bad')
  writeFileSync(join(pCfg, 'rules', '.env.prod'), 'API_KEY=bad')
  writeFileSync(join(pCfg, 'rules', 'antigravity-oauth-token'), 'refresh=bad')
  writeFileSync(join(pCfg, 'rules', 'id_ed25519'), 'PRIVATE')
  writeFileSync(join(pCfg, 'rules', 'cert.pem'), 'PEM')
  writeFileSync(join(pCfg, 'rules', 'priv.key'), 'KEY')
  writeFileSync(join(primary, '.gemini', 'AGENTS.md'), '# global agents')
  writeFileSync(join(pCfg, 'config.json'), JSON.stringify({ plugins: { p1: { enabled: true } } }))
  writeFileSync(join(pCfg, 'mcp_config.json'), JSON.stringify({
    mcpServers: {
      'dsh-tools': { url: 'http://primary-bridge/mcp' },
      'user-mcp': { command: 'echo', args: ['ok'] },
    },
  }))
  // Pre-existing target state with its own dsh-tools & stale skill
  writeFileSync(join(tCfg, 'skills', 'stale-skill', 'SKILL.md'), 'old')
  writeFileSync(join(tCfg, 'mcp_config.json'), JSON.stringify({
    mcpServers: { 'dsh-tools': { url: 'http://acc2-bridge/mcp' }, 'removed-mcp': { command: 'x' } },
    keepMe: 123,
  }))
  writeFileSync(join(tCfg, 'config.json'), JSON.stringify({ accountSpecific: true }))

  // Symlink escaping primaryHome must be ignored (best-effort on Windows if symlink perm absent)
  try {
    symlinkSync(outsideSecret, join(pCfg, 'rules', 'escaped.md'))
  } catch {
    // ignore on restricted Windows without Developer Mode
  }

  const accounts: ManagedAccount[] = [
    makeAccount(primary, 'acc_primary', { systemHome: true }),
    makeAccount(accDir, 'acc_2'),
  ]
  const report1 = syncEcosystemToPool({ primaryHome: primary, accounts })
  assert.deepEqual(report1.syncedAccounts, ['acc_2'])
  assert.deepEqual(report1.skippedAccounts, ['acc_primary'])
  assert.equal(report1.errors.length, 0)
  assert.ok(report1.copiedFiles >= 4)
  assert.ok(report1.removedFiles >= 1)

  assert.equal(readFileSync(join(tCfg, 'skills', 's1', 'SKILL.md'), 'utf8'), '# skill 1')
  assert.equal(existsSync(join(tCfg, 'skills', 'stale-skill')), false)
  assert.equal(existsSync(join(tCfg, 'rules', '.env')), false)
  assert.equal(existsSync(join(tCfg, 'rules', '.env.prod')), false)
  assert.equal(existsSync(join(tCfg, 'rules', 'antigravity-oauth-token')), false)
  assert.equal(existsSync(join(tCfg, 'rules', 'id_ed25519')), false)
  assert.equal(existsSync(join(tCfg, 'rules', 'cert.pem')), false)
  assert.equal(existsSync(join(tCfg, 'rules', 'priv.key')), false)
  assert.equal(existsSync(join(tCfg, 'rules', 'escaped.md')), false)
  assert.equal(readFileSync(join(accDir, '.gemini', 'AGENTS.md'), 'utf8'), '# global agents')

  const mergedMcp = JSON.parse(readFileSync(join(tCfg, 'mcp_config.json'), 'utf8'))
  assert.equal(mergedMcp.keepMe, 123)
  assert.equal(mergedMcp.mcpServers['dsh-tools'].url, 'http://acc2-bridge/mcp', 'target dsh-tools must be preserved')
  assert.deepEqual(mergedMcp.mcpServers['user-mcp'], { command: 'echo', args: ['ok'] })
  assert.equal(mergedMcp.mcpServers['removed-mcp'], undefined)

  const mergedCfg = JSON.parse(readFileSync(join(tCfg, 'config.json'), 'utf8'))
  assert.equal(mergedCfg.accountSpecific, true)
  assert.deepEqual(mergedCfg.plugins, { p1: { enabled: true } })

  // Second run is strictly idempotent (no writes, no removals)
  const report2 = syncEcosystemToPool({ primaryHome: primary, accounts })
  assert.equal(report2.copiedFiles, 0)
  assert.equal(report2.removedFiles, 0)
})

test('EcosystemService & /agy ecosystem commands handle sync, plugin toggling, agents, and validation', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-eco-svc-'))
  try {
    const primary = join(root, 'primary')
    const accDir = join(root, 'acc2')
    const cfgDir = join(primary, '.gemini', 'config')
    mkdirSync(join(cfgDir, 'plugins', 'demo-plugin', 'skills', 's'), { recursive: true })
    mkdirSync(join(cfgDir, 'agents'), { recursive: true })
    writeFileSync(join(cfgDir, 'plugins', 'demo-plugin', 'plugin.json'), JSON.stringify({ name: 'Demo', description: 'Demo desc' }))
    writeFileSync(join(cfgDir, 'plugins', 'demo-plugin', 'skills', 's', 'SKILL.md'), '---\nname: demo-skill\n---\n')
    writeFileSync(join(cfgDir, 'agents', 'auditor.md'), '---\nname: auditor\ndescription: Security reviewer\n---\n')

    const cfg = defaultConfig()
    cfg.syncAccountCustomizations = false
    const eco = new EcosystemService({
      primaryHome: primary,
      pool: { getAccounts: () => [makeAccount(accDir, 'acc_2')] },
      getConfig: () => cfg,
    })

    // syncAll respects syncAccountCustomizations=false unless forced
    const skipped = eco.syncAll()
    assert.deepEqual(skipped.skippedAccounts, ['acc_2'])
    assert.deepEqual(skipped.syncedAccounts, [])

    const forced = eco.syncAll({ force: true })
    assert.deepEqual(forced.syncedAccounts, ['acc_2'])
    assert.equal(eco.syncAccount(makeAccount(accDir, 'acc_2')).syncedAccounts[0], 'acc_2')

    // Reject path traversal plugin ids
    assert.throws(() => eco.setPluginEnabled('../../../evil', true), /Invalid plugin id/)
    assert.throws(() => eco.setPluginEnabled('..', false), /Invalid plugin id/)
    assert.throws(() => eco.setPluginEnabled('a/b', false), /Invalid plugin id/)

    cfg.syncAccountCustomizations = true
    const afterDisable = eco.setPluginEnabled('demo-plugin', false)
    assert.equal(afterDisable.plugins.find((p) => p.id === 'demo-plugin')?.enabled, false)

    // Command handler integration
    const overrides: Array<[string, unknown]> = []
    const deps: CommandDeps = {
      cfg: () => cfg,
      bin: () => 'agy',
      version: () => '1.5.12',
      auth: () => ({} as never),
      catalog: () => ({} as never),
      store: () => ({} as never),
      pool: () => ({} as never),
      lastRun: () => null,
      runDoctor: async () => '',
      ecosystem: () => eco,
      setOverride: (k, v) => {
        overrides.push([k, v])
        if (k === 'agent') cfg.agent = String(v)
      },
    }

    assert.match(handleEcosystem({ ...deps, ecosystem: undefined }, { sub: 'plugins', arg: '', parts: ['plugins'], raw: 'plugins' }).text ?? '', /not initialized/)
    assert.match(handleEcosystem(deps, { sub: 'plugins', arg: '', parts: ['plugins'], raw: 'plugins' }).text ?? '', /Demo/)
    assert.match(handleEcosystem(deps, { sub: 'plugins', arg: 'enable', parts: ['plugins', 'enable', 'demo-plugin'], raw: 'plugins enable demo-plugin' }).text ?? '', /enabled/)
    assert.match(handleEcosystem(deps, { sub: 'skills', arg: '', parts: ['skills'], raw: 'skills' }).text ?? '', /demo-skill/)
    assert.match(handleEcosystem(deps, { sub: 'plugins', arg: 'disable', parts: ['plugins', 'disable', 'demo-plugin'], raw: 'plugins disable demo-plugin' }).text ?? '', /disabled/)
    assert.match(handleEcosystem(deps, { sub: 'plugins', arg: 'enable', parts: ['plugins', 'enable'], raw: 'plugins enable' }).text ?? '', /Usage:/)
    assert.match(handleEcosystem(deps, { sub: 'mcp', arg: '', parts: ['mcp'], raw: 'mcp' }).text ?? '', /No external/)
    writeFileSync(join(cfgDir, 'mcp_config.json'), JSON.stringify({ mcpServers: { 'ext-srv': { command: 'node', args: ['s.js'] } } }))
    assert.match(handleEcosystem(deps, { sub: 'mcp', arg: '', parts: ['mcp'], raw: 'mcp' }).text ?? '', /ext-srv/)
    assert.match(handleEcosystem(deps, { sub: 'agents', arg: '', parts: ['agents'], raw: 'agents' }).text ?? '', /auditor/)
    assert.match(handleEcosystem(deps, { sub: 'agents', arg: 'use', parts: ['agents', 'use'], raw: '/agy agents use' }).text ?? '', /Usage:/)
    assert.match(handleEcosystem(deps, { sub: 'agents', arg: 'use', parts: ['agents', 'use', 'auditor'], raw: '/agy agents use auditor' }).text ?? '', /auditor/)
    assert.match(handleEcosystem(deps, { sub: 'agents', arg: 'off', parts: ['agents', 'off'], raw: '/agy agents off' }).text ?? '', /cleared/)
    assert.match(handleEcosystem(deps, { sub: 'sync-ecosystem', arg: '', parts: ['sync-ecosystem'], raw: 'sync-ecosystem' }).text ?? '', /Synced pool accounts: 1/)
    assert.match(handleEcosystem(deps, { sub: 'unknown', arg: '', parts: ['unknown'], raw: 'unknown' }).text ?? '', /Unknown ecosystem command/)
    assert.deepEqual(overrides, [['agent', 'auditor'], ['agent', '']])

    // Empty primary home coverage for plugins/skills/agents empty states
    const emptyPrimary = join(root, 'empty-primary')
    const emptyEco = new EcosystemService({ primaryHome: emptyPrimary, pool: { getAccounts: () => [] }, getConfig: () => cfg })
    const emptyDeps = { ...deps, ecosystem: () => emptyEco }
    assert.match(handleEcosystem(emptyDeps, { sub: 'plugins', arg: '', parts: ['plugins'], raw: 'plugins' }).text ?? '', /No Antigravity plugins/)
    assert.match(handleEcosystem(emptyDeps, { sub: 'skills', arg: '', parts: ['skills'], raw: 'skills' }).text ?? '', /none discovered/)
    assert.match(handleEcosystem(emptyDeps, { sub: 'agents', arg: '', parts: ['agents'], raw: 'agents' }).text ?? '', /No custom Markdown agents/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ecosystem ignores dsh-tools-* bridges during inspect/sync, preserves target bridge, resolves session cwd, and rejects invalid sub-actions', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-eco-bridge-'))
  try {
    const primary = join(root, 'primary')
    const accDir = join(root, 'acc2')
    const sessionWs = join(root, 'session-ws')
    mkdirSync(join(primary, '.gemini', 'config'), { recursive: true })
    mkdirSync(join(accDir, '.gemini', 'config'), { recursive: true })
    mkdirSync(join(sessionWs, '.agents', 'skills', 'ws-skill'), { recursive: true })

    writeFileSync(
      join(primary, '.gemini', 'config', 'mcp_config.json'),
      JSON.stringify({
        mcpServers: {
          'dsh-tools': { url: 'http://127.0.0.1:1111/mcp' },
          'dsh-tools-54321': { url: 'http://127.0.0.1:54321/mcp' },
          'ext-mcp': { command: 'node', args: ['ext.js'] },
        },
      }),
    )
    writeFileSync(
      join(accDir, '.gemini', 'config', 'mcp_config.json'),
      JSON.stringify({
        mcpServers: {
          'dsh-tools-61234': { url: 'http://127.0.0.1:61234/mcp' },
          stale: { command: 'node', args: ['stale.js'] },
        },
      }),
    )
    writeFileSync(
      join(sessionWs, '.agents', 'skills', 'ws-skill', 'SKILL.md'),
      '---\nname: ws-skill\ndescription: session ws skill\n---\n',
    )

    const inspected = inspectEcosystem({ primaryHome: primary })
    assert.deepEqual(inspected.mcpServers.map((m) => m.name), ['ext-mcp'])

    syncEcosystemToPool({ primaryHome: primary, accounts: [makeAccount(accDir, 'acc_2')] })
    const syncedMcp = JSON.parse(readFileSync(join(accDir, '.gemini', 'config', 'mcp_config.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>
    }
    assert.ok('ext-mcp' in syncedMcp.mcpServers)
    assert.ok('dsh-tools-61234' in syncedMcp.mcpServers)
    assert.equal('dsh-tools-54321' in syncedMcp.mcpServers, false)
    assert.equal('dsh-tools' in syncedMcp.mcpServers, false)

    const cfg = defaultConfig()
    const eco = new EcosystemService({ primaryHome: primary, pool: { getAccounts: () => [] }, getConfig: () => cfg })
    const deps: CommandDeps = {
      cfg: () => cfg,
      bin: () => 'agy',
      version: () => '1.5.12',
      auth: () => ({} as never),
      catalog: () => ({} as never),
      store: () => ({} as never),
      pool: () => ({} as never),
      lastRun: () => null,
      runDoctor: async () => '',
      setOverride: () => {},
      ecosystem: () => eco,
    }
    const inv = { agent: { id: 's-eco', session: { header: { cwd: sessionWs } } } } as never

    const skillsRes = handleEcosystem(deps, { sub: 'skills', arg: '', parts: ['skills'], raw: '/agy skills', invocation: inv })
    assert.match(skillsRes.text ?? '', /ws-skill/)

    const badPlugin = handleEcosystem(deps, { sub: 'plugins', arg: 'foo', parts: ['plugins', 'foo'], raw: '/agy plugins foo', invocation: inv })
    assert.equal(badPlugin.kind, 'error')
    assert.match(badPlugin.text ?? '', /Usage:/)

    const badAgent = handleEcosystem(deps, { sub: 'agents', arg: 'foo', parts: ['agents', 'foo'], raw: '/agy agents foo', invocation: inv })
    assert.equal(badAgent.kind, 'error')
    assert.match(badAgent.text ?? '', /Usage:/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
