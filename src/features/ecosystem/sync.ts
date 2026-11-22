// Idempotent allowlist mirror of Antigravity customizations (plugins, skills,
// rules, agents, MCP servers, plugin enablement) from primary HOME into isolated
// pool account HOMEs. Credentials, logs, conversations, and Keychains are NEVER touched.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { writeFileAtomicSync } from '../../common/atomic-write.ts'
import type { EcosystemSyncReport } from '../../common/ecosystem-types.ts'
import type { ManagedAccount } from '../../common/pool-types.ts'
import { isInternalBridgeKey } from './inventory.ts'

const SENSITIVE_NAME_RE = /^(?:\.env(?:\.|$)|antigravity-oauth-token(?:\.bak)?$|\.primary-credential\.json$|id_rsa$|id_ed25519$)|(?:\.pem|\.key)$/i
const SYNC_SUBDIRS = ['plugins', 'skills', 'rules', 'agents'] as const
const CONFIG_ALLOWLIST_FILES = ['plugins.json', 'skills.json', 'hooks.json', 'GEMINI.md', 'AGENTS.md'] as const
const GEMINI_ROOT_ALLOWLIST_FILES = ['GEMINI.md', 'AGENTS.md'] as const

function isInsideRoot(target: string, root: string): boolean {
  const t = process.platform === 'win32' ? target.toLowerCase() : target
  const r = process.platform === 'win32' ? root.toLowerCase() : root
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep)
}

function writeIfChanged(dstFile: string, content: Buffer | string, mode = 0o644): boolean {
  const nextBuf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  if (existsSync(dstFile)) {
    try {
      const curBuf = readFileSync(dstFile)
      if (curBuf.equals(nextBuf)) return false
    } catch {
      // rewrite unreadable target
    }
  }
  mkdirSync(dirname(dstFile), { recursive: true })
  writeFileAtomicSync(dstFile, nextBuf, mode)
  return true
}

function mirrorDirectory(
  srcDir: string,
  dstDir: string,
  primaryRealRoot: string,
  counters: { copied: number; removed: number },
): void {
  mkdirSync(dstDir, { recursive: true })
  const srcEntries = readdirSync(srcDir, { withFileTypes: true })
  const expectedNames = new Set<string>()

  for (const ent of srcEntries) {
    if (SENSITIVE_NAME_RE.test(ent.name)) continue
    const srcPath = join(srcDir, ent.name)
    const dstPath = join(dstDir, ent.name)
    let isDir = ent.isDirectory()
    let isFile = ent.isFile()

    if (ent.isSymbolicLink()) {
      try {
        const real = realpathSync(srcPath)
        if (!isInsideRoot(real, primaryRealRoot)) continue
        const st = lstatSync(real)
        isDir = st.isDirectory()
        isFile = st.isFile()
      } catch {
        continue
      }
    }

    if (isDir) {
      expectedNames.add(ent.name)
      mirrorDirectory(srcPath, dstPath, primaryRealRoot, counters)
    } else if (isFile) {
      expectedNames.add(ent.name)
      const data = readFileSync(srcPath)
      if (writeIfChanged(dstPath, data)) counters.copied++
    }
  }

  // Prune stale files/directories removed from primary
  for (const existing of readdirSync(dstDir, { withFileTypes: true })) {
    if (expectedNames.has(existing.name)) continue
    const stalePath = join(dstDir, existing.name)
    rmSync(stalePath, { recursive: true, force: true })
    counters.removed++
  }
}

function readJsonObjSafe(file: string): Record<string, unknown> | null {
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

function mergeMcpConfig(primaryFile: string, targetFile: string): boolean {
  const primary = readJsonObjSafe(primaryFile)
  if (!primary) return false
  const primaryServers =
    primary.mcpServers && typeof primary.mcpServers === 'object' && !Array.isArray(primary.mcpServers)
      ? (primary.mcpServers as Record<string, unknown>)
      : {}
  const target = readJsonObjSafe(targetFile) ?? {}
  const targetServers =
    target.mcpServers && typeof target.mcpServers === 'object' && !Array.isArray(target.mcpServers)
      ? (target.mcpServers as Record<string, unknown>)
      : {}

  const nextServers: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(primaryServers)) {
    if (isInternalBridgeKey(k)) continue
    nextServers[k] = v
  }
  for (const [k, v] of Object.entries(targetServers)) {
    if (isInternalBridgeKey(k)) {
      nextServers[k] = v
    }
  }

  const nextObj = { ...target, mcpServers: nextServers }
  return writeIfChanged(targetFile, JSON.stringify(nextObj, null, 2))
}

function mergePluginsConfig(primaryFile: string, targetFile: string): boolean {
  const primary = readJsonObjSafe(primaryFile)
  if (!primary || !primary.plugins || typeof primary.plugins !== 'object' || Array.isArray(primary.plugins)) {
    return false
  }
  const target = readJsonObjSafe(targetFile) ?? {}
  const nextObj = { ...target, plugins: primary.plugins }
  return writeIfChanged(targetFile, JSON.stringify(nextObj, null, 2))
}

function syncOneAccount(primaryHome: string, primaryRealRoot: string, acc: ManagedAccount): { copied: number; removed: number } {
  const primaryConfigDir = join(primaryHome, '.gemini', 'config')
  const targetGeminiDir = join(acc.dir, '.gemini')
  const targetConfigDir = join(targetGeminiDir, 'config')
  mkdirSync(targetConfigDir, { recursive: true })
  const counters = { copied: 0, removed: 0 }

  for (const sub of SYNC_SUBDIRS) {
    const srcDir = join(primaryConfigDir, sub)
    if (!existsSync(srcDir)) continue
    try {
      if (!lstatSync(srcDir).isDirectory()) continue
    } catch {
      continue
    }
    mirrorDirectory(srcDir, join(targetConfigDir, sub), primaryRealRoot, counters)
  }

  for (const fname of CONFIG_ALLOWLIST_FILES) {
    const src = join(primaryConfigDir, fname)
    if (!existsSync(src) || SENSITIVE_NAME_RE.test(fname)) continue
    try {
      if (lstatSync(src).isFile() && writeIfChanged(join(targetConfigDir, fname), readFileSync(src))) {
        counters.copied++
      }
    } catch {
      // ignore unreadable file
    }
  }

  for (const fname of GEMINI_ROOT_ALLOWLIST_FILES) {
    const src = join(primaryHome, '.gemini', fname)
    if (!existsSync(src)) continue
    try {
      if (lstatSync(src).isFile() && writeIfChanged(join(targetGeminiDir, fname), readFileSync(src))) {
        counters.copied++
      }
    } catch {
      // ignore
    }
  }

  if (mergeMcpConfig(join(primaryConfigDir, 'mcp_config.json'), join(targetConfigDir, 'mcp_config.json'))) {
    counters.copied++
  }
  if (mergePluginsConfig(join(primaryConfigDir, 'config.json'), join(targetConfigDir, 'config.json'))) {
    counters.copied++
  }
  return counters
}

export function syncEcosystemToPool(opts: {
  primaryHome: string
  accounts: readonly ManagedAccount[]
  log?: (msg: string) => void
}): EcosystemSyncReport {
  const { primaryHome, accounts, log } = opts
  const syncedAccounts: string[] = []
  const skippedAccounts: string[] = []
  const errors: Array<{ accountId: string; error: string }> = []
  let copiedFiles = 0
  let removedFiles = 0

  const primaryResolved = resolve(primaryHome)
  let primaryRealRoot = primaryResolved
  try {
    primaryRealRoot = realpathSync(primaryResolved)
  } catch {
    // primaryHome may not exist in test mocks
  }
  const hasPrimaryConfig = existsSync(join(primaryHome, '.gemini', 'config'))

  for (const acc of accounts) {
    if (!acc.dir || acc.systemHome || resolve(acc.dir) === primaryResolved) {
      skippedAccounts.push(acc.id)
      continue
    }
    if (!hasPrimaryConfig) {
      skippedAccounts.push(acc.id)
      continue
    }
    try {
      const c = syncOneAccount(primaryHome, primaryRealRoot, acc)
      copiedFiles += c.copied
      removedFiles += c.removed
      syncedAccounts.push(acc.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ accountId: acc.id, error: message })
      log?.(`ecosystem sync failed for ${acc.id}: ${message}`)
    }
  }

  return {
    primaryHome,
    syncedAccounts,
    skippedAccounts,
    copiedFiles,
    removedFiles,
    errors,
    syncedAt: Date.now(),
  }
}
