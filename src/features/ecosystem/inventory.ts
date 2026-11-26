// Read-only inventory of Antigravity plugins, MCP servers, skills, rules, and custom agents.
// Secret values (MCP env vars, tokens) are never included in the returned snapshot.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import type {
  EcosystemAgent,
  EcosystemMcpServer,
  EcosystemPlugin,
  EcosystemRule,
  EcosystemSkill,
  EcosystemSnapshot,
  EcosystemSource,
} from '../../common/ecosystem-types.ts'

function readJsonObj(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function unquote(s: string): string {
  const t = s.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}

/** Extract `name` and `description` from Markdown YAML frontmatter. */
export function parseMarkdownFrontmatter(text: string): { name?: string; description?: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match || !match[1]) return {}
  const lines = match[1].split(/\r?\n/)
  const out: { name?: string; description?: string } = {}
  let currentKey: 'name' | 'description' | null = null
  const buf: string[] = []

  const flush = () => {
    if (currentKey !== null && buf.length > 0) {
      const joined = buf.join(' ').trim()
      if (joined !== '') out[currentKey] = joined
    }
    currentKey = null
    buf.length = 0
  }

  for (const line of lines) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (kv && !line.startsWith(' ') && !line.startsWith('\t')) {
      flush()
      const k = kv[1]
      const v = (kv[2] ?? '').trim()
      if (k === 'name' || k === 'description') {
        if (v === '>' || v === '>-' || v === '|' || v === '|-') {
          currentKey = k
        } else if (v !== '') {
          out[k] = unquote(v)
        }
      }
      continue
    }
    if (currentKey !== null && /^\s+/.test(line)) {
      const trimmed = line.trim()
      if (trimmed !== '') buf.push(trimmed)
    }
  }
  flush()
  return out
}

function redactUrlCredentials(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    if (u.username || u.password) {
      u.username = ''
      u.password = ''
      return u.toString()
    }
    return rawUrl
  } catch {
    return rawUrl
  }
}

export function isInternalBridgeKey(name: string): boolean {
  return name === 'dsh-tools' || name.startsWith('dsh-tools-')
}

function readMcpFile(
  file: string,
  source: EcosystemSource,
  out: EcosystemMcpServer[],
  pluginName?: string,
): void {
  const doc = readJsonObj(file)
  const servers = doc?.mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return
  for (const [name, rawEntry] of Object.entries(servers as Record<string, unknown>)) {
    if (isInternalBridgeKey(name)) continue
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue
    const e = rawEntry as Record<string, unknown>
    const rawUrl = typeof e.url === 'string' ? e.url : (typeof e.serverUrl === 'string' ? e.serverUrl : '')
    const transport: 'stdio' | 'http' = rawUrl !== '' ? 'http' : 'stdio'
    const cmdParts = [
      typeof e.command === 'string' ? e.command : '',
      ...(Array.isArray(e.args) ? e.args.map((a) => String(a)) : []),
    ].filter(Boolean)
    const target = transport === 'http' ? redactUrlCredentials(rawUrl) : cmdParts.join(' ')
    out.push({
      name,
      transport,
      target: target || '(unconfigured)',
      disabled: e.disabled === true,
      source,
      ...(pluginName ? { pluginName } : {}),
    })
  }
}

function scanSkillsDir(
  dir: string,
  source: EcosystemSource,
  out: EcosystemSkill[],
  pluginName?: string,
): number {
  if (!existsSync(dir)) return 0
  let count = 0
  try {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue
      const skillFile = join(dir, ent.name, 'SKILL.md')
      if (!existsSync(skillFile)) continue
      count++
      try {
        const text = readFileSync(skillFile, 'utf8')
        const meta = parseMarkdownFrontmatter(text)
        out.push({
          name: meta.name || ent.name,
          description: meta.description || '',
          source,
          ...(pluginName ? { pluginName } : {}),
          path: skillFile,
        })
      } catch {
        // skip unreadable skill
      }
    }
  } catch {
    // ignore missing/unreadable dir
  }
  return count
}

function addRuleFile(
  file: string,
  source: EcosystemSource,
  out: EcosystemRule[],
  seenPaths: Set<string>,
  pluginName?: string,
): boolean {
  try {
    if (!existsSync(file)) return false
    const resolved = resolve(file)
    if (seenPaths.has(resolved)) return false
    const st = statSync(resolved)
    if (!st.isFile()) return false
    seenPaths.add(resolved)
    out.push({
      name: basename(resolved),
      path: resolved,
      bytes: st.size,
      source,
      ...(pluginName ? { pluginName } : {}),
    })
    return true
  } catch {
    return false
  }
}

function scanRulesDir(
  dir: string,
  source: EcosystemSource,
  out: EcosystemRule[],
  seenPaths: Set<string>,
  pluginName?: string,
): number {
  if (!existsSync(dir)) return 0
  let count = 0
  try {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() && !ent.isSymbolicLink()) continue
      if (extname(ent.name).toLowerCase() !== '.md') continue
      if (addRuleFile(join(dir, ent.name), source, out, seenPaths, pluginName)) count++
    }
  } catch {
    // ignore
  }
  return count
}

function readPluginManifest(pluginDir: string): Record<string, unknown> | null {
  for (const rel of ['plugin.json', join('.antigravity-plugin', 'plugin.json'), join('.gemini-plugin', 'plugin.json')]) {
    const manifest = readJsonObj(join(pluginDir, rel))
    if (manifest) return manifest
  }
  return null
}

function scanPluginsRoot(opts: {
  pluginsDir: string
  source: 'global' | 'workspace'
  pluginsConfig: Record<string, unknown>
  plugins: EcosystemPlugin[]
  mcpServers: EcosystemMcpServer[]
  skills: EcosystemSkill[]
  rules: EcosystemRule[]
  seenRulePaths: Set<string>
}): void {
  if (!existsSync(opts.pluginsDir)) return
  try {
    for (const ent of readdirSync(opts.pluginsDir, { withFileTypes: true })) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue
      const pluginDir = join(opts.pluginsDir, ent.name)
      const manifest = readPluginManifest(pluginDir)
      if (!manifest) continue
      const cfgEntry = opts.pluginsConfig[ent.name]
      const cfgEnabled = cfgEntry && typeof cfgEntry === 'object'
        ? (cfgEntry as { enabled?: unknown }).enabled
        : undefined
      const enabled = typeof cfgEnabled === 'boolean' ? cfgEnabled : manifest.disabled !== true
      const hasMcp = existsSync(join(pluginDir, 'mcp_config.json'))
      const hasHooks = existsSync(join(pluginDir, 'hooks.json'))
      const skillList: EcosystemSkill[] = []
      const skillCount = scanSkillsDir(join(pluginDir, 'skills'), 'plugin', skillList, ent.name)
      const ruleList: EcosystemRule[] = []
      const ruleCount = scanRulesDir(join(pluginDir, 'rules'), 'plugin', ruleList, new Set(), ent.name)

      opts.plugins.push({
        id: ent.name,
        name: typeof manifest.name === 'string' && manifest.name.trim() !== '' ? manifest.name.trim() : ent.name,
        enabled,
        ...(typeof manifest.description === 'string' && manifest.description.trim() !== ''
          ? { description: manifest.description.trim() }
          : {}),
        ...(typeof manifest.version === 'string' && manifest.version.trim() !== ''
          ? { version: manifest.version.trim() }
          : {}),
        source: opts.source,
        hasMcp,
        hasHooks,
        skillCount,
        ruleCount,
        path: pluginDir,
      })

      if (enabled) {
        for (const s of skillList) opts.skills.push(s)
        for (const r of ruleList) {
          if (!opts.seenRulePaths.has(r.path)) {
            opts.seenRulePaths.add(r.path)
            opts.rules.push(r)
          }
        }
        if (hasMcp) readMcpFile(join(pluginDir, 'mcp_config.json'), 'plugin', opts.mcpServers, ent.name)
      }
    }
  } catch {
    // ignore
  }
}

function scanAgentsDir(dir: string, source: 'global' | 'workspace', out: EcosystemAgent[]): void {
  if (!existsSync(dir)) return
  try {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.isFile() && extname(ent.name).toLowerCase() === '.md') {
        const p = join(dir, ent.name)
        const meta = parseMarkdownFrontmatter(readFileSync(p, 'utf8'))
        out.push({
          name: meta.name || ent.name.replace(/\.md$/i, ''),
          description: meta.description || '',
          source,
          path: p,
        })
      } else if (ent.isDirectory()) {
        const p = join(dir, ent.name, 'agent.md')
        if (existsSync(p)) {
          const meta = parseMarkdownFrontmatter(readFileSync(p, 'utf8'))
          out.push({
            name: meta.name || ent.name,
            description: meta.description || '',
            source,
            path: p,
          })
        }
      }
    }
  } catch {
    // ignore
  }
}

export function inspectEcosystem(opts: {
  primaryHome: string
  workspaceRoot?: string
  syncedAccountCount?: number
  lastSyncAt?: number | null
}): EcosystemSnapshot {
  const configDir = join(opts.primaryHome, '.gemini', 'config')
  const configDoc = readJsonObj(join(configDir, 'config.json'))
  const pluginsConfig =
    configDoc?.plugins && typeof configDoc.plugins === 'object' && !Array.isArray(configDoc.plugins)
      ? (configDoc.plugins as Record<string, unknown>)
      : {}

  const plugins: EcosystemPlugin[] = []
  const mcpServers: EcosystemMcpServer[] = []
  const skills: EcosystemSkill[] = []
  const rules: EcosystemRule[] = []
  const agents: EcosystemAgent[] = []
  const seenRulePaths = new Set<string>()

  readMcpFile(join(configDir, 'mcp_config.json'), 'global', mcpServers)
  scanPluginsRoot({
    pluginsDir: join(configDir, 'plugins'),
    source: 'global',
    pluginsConfig,
    plugins,
    mcpServers,
    skills,
    rules,
    seenRulePaths,
  })
  scanSkillsDir(join(configDir, 'skills'), 'global', skills)
  scanRulesDir(join(configDir, 'rules'), 'global', rules, seenRulePaths)
  addRuleFile(join(configDir, 'GEMINI.md'), 'global', rules, seenRulePaths)
  addRuleFile(join(configDir, 'AGENTS.md'), 'global', rules, seenRulePaths)
  addRuleFile(join(opts.primaryHome, '.gemini', 'GEMINI.md'), 'global', rules, seenRulePaths)
  addRuleFile(join(opts.primaryHome, '.gemini', 'AGENTS.md'), 'global', rules, seenRulePaths)
  scanAgentsDir(join(configDir, 'agents'), 'global', agents)

  const wsRoot = opts.workspaceRoot?.trim()
  if (wsRoot && existsSync(wsRoot)) {
    readMcpFile(join(wsRoot, '.mcp.json'), 'workspace', mcpServers)
    addRuleFile(join(wsRoot, 'GEMINI.md'), 'workspace', rules, seenRulePaths)
    addRuleFile(join(wsRoot, 'AGENTS.md'), 'workspace', rules, seenRulePaths)
    for (const dirName of ['.agents', '.agent', '_agents', '_agent']) {
      const base = join(wsRoot, dirName)
      if (!existsSync(base)) continue
      scanPluginsRoot({
        pluginsDir: join(base, 'plugins'),
        source: 'workspace',
        pluginsConfig,
        plugins,
        mcpServers,
        skills,
        rules,
        seenRulePaths,
      })
      scanSkillsDir(join(base, 'skills'), 'workspace', skills)
      scanRulesDir(join(base, 'rules'), 'workspace', rules, seenRulePaths)
      scanAgentsDir(join(base, 'agents'), 'workspace', agents)
    }
  }

  return {
    primaryHome: opts.primaryHome,
    ...(wsRoot ? { workspaceRoot: wsRoot, workspaceRoots: [wsRoot] } : {}),
    plugins,
    mcpServers,
    skills,
    rules,
    agents,
    syncedAccountCount: opts.syncedAccountCount ?? 0,
    lastSyncAt: opts.lastSyncAt ?? null,
  }
}
