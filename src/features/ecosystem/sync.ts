// Idempotent allowlist mirror of Antigravity customizations (plugins, skills,
// rules, agents, MCP servers, plugin enablement) from primary HOME into isolated
// pool account HOMEs. Credentials, logs, conversations, and Keychains are NEVER touched.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, utimes } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { writeFileAtomic, writeFileAtomicSync } from '../../common/atomic-write.ts'
import type { EcosystemSyncReport } from '../../common/ecosystem-types.ts'
import type { ManagedAccount } from '../../common/pool-types.ts'
import { isInternalBridgeKey } from './inventory.ts'

const SENSITIVE_NAME_RE = /^(?:\.env(?:\.|$)|antigravity-oauth-token(?:\.bak)?$|\.primary-credential\.json$|id_rsa$|id_ed25519$)|(?:\.pem|\.key)$/i
const SYNC_SUBDIRS = ['plugins', 'skills', 'rules', 'agents'] as const
const CONFIG_ALLOWLIST_FILES = ['plugins.json', 'skills.json', 'hooks.json', 'GEMINI.md', 'AGENTS.md'] as const
const GEMINI_ROOT_ALLOWLIST_FILES = ['GEMINI.md', 'AGENTS.md'] as const
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache'])
const SKIP_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db'])
const RACY_MTIME_WINDOW_MS = 2_000

interface StatLike {
  size: number
  mtimeMs: number
  atime: Date
  mtime: Date
  isFile(): boolean
}

function isInsideRoot(target: string, root: string): boolean {
  const t = process.platform === 'win32' ? target.toLowerCase() : target
  const r = process.platform === 'win32' ? root.toLowerCase() : root
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep)
}

function canSkipByStat(srcStat: StatLike, dstStat: StatLike | null, now = Date.now()): boolean {
  return (
    dstStat !== null &&
    dstStat.isFile() &&
    dstStat.size === srcStat.size &&
    Math.abs(dstStat.mtimeMs - srcStat.mtimeMs) < 1 &&
    now - srcStat.mtimeMs > RACY_MTIME_WINDOW_MS
  )
}

function parseJsonObj(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function buildMergedMcpJson(primaryObj: Record<string, unknown> | null, targetObj: Record<string, unknown> | null): string | null {
  if (!primaryObj) return null
  const primaryServers =
    primaryObj.mcpServers && typeof primaryObj.mcpServers === 'object' && !Array.isArray(primaryObj.mcpServers)
      ? (primaryObj.mcpServers as Record<string, unknown>)
      : {}
  const target = targetObj ?? {}
  const targetServers =
    target.mcpServers && typeof target.mcpServers === 'object' && !Array.isArray(target.mcpServers)
      ? (target.mcpServers as Record<string, unknown>)
      : {}

  const nextServers: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(primaryServers)) {
    if (!isInternalBridgeKey(k)) nextServers[k] = v
  }
  for (const [k, v] of Object.entries(targetServers)) {
    if (isInternalBridgeKey(k)) nextServers[k] = v
  }
  return JSON.stringify({ ...target, mcpServers: nextServers }, null, 2)
}

function buildMergedPluginsJson(primaryObj: Record<string, unknown> | null, targetObj: Record<string, unknown> | null): string | null {
  if (!primaryObj || !primaryObj.plugins || typeof primaryObj.plugins !== 'object' || Array.isArray(primaryObj.plugins)) {
    return null
  }
  return JSON.stringify({ ...(targetObj ?? {}), plugins: primaryObj.plugins }, null, 2)
}

function writeIfChanged(dstFile: string, content: Buffer | string, srcStat?: StatLike, mode = 0o644): boolean {
  if (srcStat) {
    try {
      const dstStat = statSync(dstFile)
      if (canSkipByStat(srcStat, dstStat)) return false
    } catch {
      // missing or unreadable target stat
    }
  }
  const nextBuf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  if (existsSync(dstFile)) {
    try {
      if (readFileSync(dstFile).equals(nextBuf)) {
        if (srcStat) {
          try { utimesSync(dstFile, srcStat.atime, srcStat.mtime) } catch { /* best effort */ }
        }
        return false
      }
    } catch {
      // rewrite unreadable target
    }
  }
  mkdirSync(dirname(dstFile), { recursive: true })
  writeFileAtomicSync(dstFile, nextBuf, mode)
  if (srcStat) {
    try { utimesSync(dstFile, srcStat.atime, srcStat.mtime) } catch { /* best effort */ }
  }
  return true
}

async function writeIfChangedAsync(dstFile: string, readContent: () => Promise<Buffer | string>, srcStat?: StatLike, mode = 0o644): Promise<boolean> {
  if (srcStat) {
    try {
      const dstStat = await stat(dstFile)
      if (canSkipByStat(srcStat, dstStat)) return false
    } catch {
      // missing or unreadable target stat
    }
  }
  const raw = await readContent()
  const nextBuf = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw
  try {
    if ((await readFile(dstFile)).equals(nextBuf)) {
      if (srcStat) {
        try { await utimes(dstFile, srcStat.atime, srcStat.mtime) } catch { /* best effort */ }
      }
      return false
    }
  } catch {
    // rewrite missing or unreadable target
  }
  await mkdir(dirname(dstFile), { recursive: true })
  await writeFileAtomic(dstFile, nextBuf, mode)
  if (srcStat) {
    try { await utimes(dstFile, srcStat.atime, srcStat.mtime) } catch { /* best effort */ }
  }
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
      if (SKIP_DIR_NAMES.has(ent.name)) continue
      expectedNames.add(ent.name)
      mirrorDirectory(srcPath, dstPath, primaryRealRoot, counters)
    } else if (isFile) {
      if (SKIP_FILE_NAMES.has(ent.name)) continue
      expectedNames.add(ent.name)
      let srcStat: StatLike | undefined
      try { srcStat = statSync(srcPath) } catch { continue }
      try {
        const dstStat = statSync(dstPath)
        if (canSkipByStat(srcStat, dstStat)) continue
      } catch {
        // target does not exist yet
      }
      if (writeIfChanged(dstPath, readFileSync(srcPath), srcStat)) counters.copied++
    }
  }

  for (const existing of readdirSync(dstDir, { withFileTypes: true })) {
    if (expectedNames.has(existing.name)) continue
    rmSync(join(dstDir, existing.name), { recursive: true, force: true })
    counters.removed++
  }
}

async function mirrorDirectoryAsync(
  srcDir: string,
  dstDir: string,
  primaryRealRoot: string,
  counters: { copied: number; removed: number },
): Promise<void> {
  await mkdir(dstDir, { recursive: true })
  const srcEntries = await readdir(srcDir, { withFileTypes: true })
  const expectedNames = new Set<string>()

  for (const ent of srcEntries) {
    if (SENSITIVE_NAME_RE.test(ent.name)) continue
    const srcPath = join(srcDir, ent.name)
    const dstPath = join(dstDir, ent.name)
    let isDir = ent.isDirectory()
    let isFile = ent.isFile()

    if (ent.isSymbolicLink()) {
      try {
        const real = await realpath(srcPath)
        if (!isInsideRoot(real, primaryRealRoot)) continue
        const st = await lstat(real)
        isDir = st.isDirectory()
        isFile = st.isFile()
      } catch {
        continue
      }
    }

    if (isDir) {
      if (SKIP_DIR_NAMES.has(ent.name)) continue
      expectedNames.add(ent.name)
      await mirrorDirectoryAsync(srcPath, dstPath, primaryRealRoot, counters)
    } else if (isFile) {
      if (SKIP_FILE_NAMES.has(ent.name)) continue
      expectedNames.add(ent.name)
      let srcStat: StatLike | undefined
      try { srcStat = await stat(srcPath) } catch { continue }
      if (await writeIfChangedAsync(dstPath, () => readFile(srcPath), srcStat)) counters.copied++
    }
  }

  for (const existing of await readdir(dstDir, { withFileTypes: true })) {
    if (expectedNames.has(existing.name)) continue
    await rm(join(dstDir, existing.name), { recursive: true, force: true })
    counters.removed++
  }
}

function readJsonObjSafe(file: string): Record<string, unknown> | null {
  try {
    return existsSync(file) ? parseJsonObj(readFileSync(file, 'utf8')) : null
  } catch {
    return null
  }
}

async function readJsonObjSafeAsync(file: string): Promise<Record<string, unknown> | null> {
  try {
    return parseJsonObj(await readFile(file, 'utf8'))
  } catch {
    return null
  }
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

  for (const [srcBase, dstBase, list] of [
    [primaryConfigDir, targetConfigDir, CONFIG_ALLOWLIST_FILES],
    [join(primaryHome, '.gemini'), targetGeminiDir, GEMINI_ROOT_ALLOWLIST_FILES],
  ] as const) {
    for (const fname of list) {
      const src = join(srcBase, fname)
      if (!existsSync(src) || SENSITIVE_NAME_RE.test(fname)) continue
      try {
        const st = lstatSync(src)
        if (st.isFile() && writeIfChanged(join(dstBase, fname), readFileSync(src), st)) counters.copied++
      } catch {
        // ignore unreadable file
      }
    }
  }

  const mcpOut = buildMergedMcpJson(readJsonObjSafe(join(primaryConfigDir, 'mcp_config.json')), readJsonObjSafe(join(targetConfigDir, 'mcp_config.json')))
  if (mcpOut !== null && writeIfChanged(join(targetConfigDir, 'mcp_config.json'), mcpOut)) counters.copied++
  const cfgOut = buildMergedPluginsJson(readJsonObjSafe(join(primaryConfigDir, 'config.json')), readJsonObjSafe(join(targetConfigDir, 'config.json')))
  if (cfgOut !== null && writeIfChanged(join(targetConfigDir, 'config.json'), cfgOut)) counters.copied++
  return counters
}

async function syncOneAccountAsync(primaryHome: string, primaryRealRoot: string, acc: ManagedAccount): Promise<{ copied: number; removed: number }> {
  const primaryConfigDir = join(primaryHome, '.gemini', 'config')
  const targetGeminiDir = join(acc.dir, '.gemini')
  const targetConfigDir = join(targetGeminiDir, 'config')
  await mkdir(targetConfigDir, { recursive: true })
  const counters = { copied: 0, removed: 0 }

  for (const sub of SYNC_SUBDIRS) {
    const srcDir = join(primaryConfigDir, sub)
    try {
      if (!(await lstat(srcDir)).isDirectory()) continue
    } catch {
      continue
    }
    await mirrorDirectoryAsync(srcDir, join(targetConfigDir, sub), primaryRealRoot, counters)
  }

  for (const [srcBase, dstBase, list] of [
    [primaryConfigDir, targetConfigDir, CONFIG_ALLOWLIST_FILES],
    [join(primaryHome, '.gemini'), targetGeminiDir, GEMINI_ROOT_ALLOWLIST_FILES],
  ] as const) {
    for (const fname of list) {
      if (SENSITIVE_NAME_RE.test(fname)) continue
      const src = join(srcBase, fname)
      try {
        const st = await lstat(src)
        if (st.isFile() && await writeIfChangedAsync(join(dstBase, fname), () => readFile(src), st)) counters.copied++
      } catch {
        // ignore missing or unreadable file
      }
    }
  }

  const mcpOut = buildMergedMcpJson(
    await readJsonObjSafeAsync(join(primaryConfigDir, 'mcp_config.json')),
    await readJsonObjSafeAsync(join(targetConfigDir, 'mcp_config.json')),
  )
  if (mcpOut !== null && await writeIfChangedAsync(join(targetConfigDir, 'mcp_config.json'), async () => mcpOut)) counters.copied++
  const cfgOut = buildMergedPluginsJson(
    await readJsonObjSafeAsync(join(primaryConfigDir, 'config.json')),
    await readJsonObjSafeAsync(join(targetConfigDir, 'config.json')),
  )
  if (cfgOut !== null && await writeIfChangedAsync(join(targetConfigDir, 'config.json'), async () => cfgOut)) counters.copied++
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
    if (!acc.dir || acc.systemHome || resolve(acc.dir) === primaryResolved || !hasPrimaryConfig) {
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

  return { primaryHome, syncedAccounts, skippedAccounts, copiedFiles, removedFiles, errors, syncedAt: Date.now() }
}

/** Asynchronous variant of {@link syncEcosystemToPool} for non-blocking background maintenance. */
export async function syncEcosystemToPoolAsync(opts: {
  primaryHome: string
  accounts: readonly ManagedAccount[]
  log?: (msg: string) => void
}): Promise<EcosystemSyncReport> {
  const { primaryHome, accounts, log } = opts
  const syncedAccounts: string[] = []
  const skippedAccounts: string[] = []
  const errors: Array<{ accountId: string; error: string }> = []
  let copiedFiles = 0
  let removedFiles = 0

  const primaryResolved = resolve(primaryHome)
  let primaryRealRoot = primaryResolved
  try {
    primaryRealRoot = await realpath(primaryResolved)
  } catch {
    // primaryHome may not exist in test mocks
  }
  let hasPrimaryConfig = false
  try {
    await lstat(join(primaryHome, '.gemini', 'config'))
    hasPrimaryConfig = true
  } catch {
    hasPrimaryConfig = false
  }

  for (const acc of accounts) {
    if (!acc.dir || acc.systemHome || resolve(acc.dir) === primaryResolved || !hasPrimaryConfig) {
      skippedAccounts.push(acc.id)
      continue
    }
    try {
      const c = await syncOneAccountAsync(primaryHome, primaryRealRoot, acc)
      copiedFiles += c.copied
      removedFiles += c.removed
      syncedAccounts.push(acc.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ accountId: acc.id, error: message })
      log?.(`ecosystem sync failed for ${acc.id}: ${message}`)
    }
  }

  return { primaryHome, syncedAccounts, skippedAccounts, copiedFiles, removedFiles, errors, syncedAt: Date.now() }
}
