// EcosystemService: inspect primary customizations and sync them into isolated pool accounts.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomicSync } from '../../common/atomic-write.ts'
import type { EcosystemSnapshot, EcosystemSyncReport } from '../../common/ecosystem-types.ts'
import type { ManagedAccount } from '../../common/pool-types.ts'
import type { PluginConfig } from '../../common/types.ts'
import type { AccountPoolManager } from '../../host/pool.ts'
import { inspectEcosystem } from './inventory.ts'
import { mergeEcosystemSnapshots } from './merge.ts'
import { syncEcosystemToPool } from './sync.ts'

export interface EcosystemServiceOpts {
  pool: Pick<AccountPoolManager, 'getAccounts'>
  getConfig: () => PluginConfig
  primaryHome?: string
  log?: (msg: string) => void
}

export class EcosystemService {
  private readonly primaryHome: string
  private lastSyncAt: number | null = null
  private syncedAccountCount = 0

  constructor(private readonly opts: EcosystemServiceOpts) {
    this.primaryHome = opts.primaryHome || homedir()
  }

  /**
   * Inventory for one workspace, or — when nothing pins one — for several.
   *
   * A pinned root (explicit `workspaceRoot`, else the configured one) is what
   * `/agy skills` scans for its session, so `additionalRoots` are ignored in
   * that case: the panel and the command must not disagree. The settings panel
   * pins nothing and passes every active session directory; without them it
   * saw the global roots only and workspace-installed skills looked missing
   * there while the command listed them (issue #219).
   */
  inspect(workspaceRoot?: string, additionalRoots: readonly string[] = []): EcosystemSnapshot {
    const cfgRoot = this.opts.getConfig().workspaceRoot.trim()
    const resolvedRoot = workspaceRoot?.trim() || (cfgRoot !== '' ? cfgRoot : undefined)
    const base = this.snapshotAt(resolvedRoot)
    if (resolvedRoot !== undefined) return base
    const roots: string[] = []
    for (const raw of additionalRoots) {
      const root = raw.trim()
      if (root !== '' && !roots.includes(root)) roots.push(root)
    }
    return mergeEcosystemSnapshots(base, roots.map((root) => this.snapshotAt(root)))
  }

  private snapshotAt(workspaceRoot?: string): EcosystemSnapshot {
    return inspectEcosystem({
      primaryHome: this.primaryHome,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      syncedAccountCount: this.syncedAccountCount,
      lastSyncAt: this.lastSyncAt,
    })
  }

  syncAll(req: { force?: boolean; accountIds?: readonly string[] } = {}): EcosystemSyncReport {
    const cfg = this.opts.getConfig()
    if (!req.force && !cfg.syncAccountCustomizations) {
      return {
        primaryHome: this.primaryHome,
        syncedAccounts: [],
        skippedAccounts: this.opts.pool.getAccounts().map((a) => a.id),
        copiedFiles: 0,
        removedFiles: 0,
        errors: [],
        syncedAt: Date.now(),
      }
    }
    const all = this.opts.pool.getAccounts()
    const targetAccounts = req.accountIds && req.accountIds.length > 0
      ? all.filter((a) => req.accountIds!.includes(a.id))
      : all
    const report = syncEcosystemToPool({
      primaryHome: this.primaryHome,
      accounts: targetAccounts,
      log: this.opts.log,
    })
    this.lastSyncAt = report.syncedAt
    if (!req.accountIds || req.accountIds.length === 0) {
      this.syncedAccountCount = report.syncedAccounts.length
    }
    if (report.copiedFiles > 0 || report.removedFiles > 0 || report.errors.length > 0) {
      this.opts.log?.(
        `ecosystem sync: ${report.syncedAccounts.length} account(s), +${report.copiedFiles}/-${report.removedFiles} file(s)`
          + (report.errors.length > 0 ? `, ${report.errors.length} error(s)` : ''),
      )
    }
    return report
  }

  syncAccount(account: ManagedAccount): EcosystemSyncReport {
    const report = syncEcosystemToPool({
      primaryHome: this.primaryHome,
      accounts: [account],
      log: this.opts.log,
    })
    if (report.syncedAccounts.length > 0) {
      this.lastSyncAt = report.syncedAt
    }
    return report
  }

  setPluginEnabled(pluginId: string, enabled: boolean, workspaceRoot?: string): EcosystemSnapshot {
    const cleanId = pluginId.trim()
    if (!/^[A-Za-z0-9._-]+$/.test(cleanId) || cleanId === '.' || cleanId === '..') {
      throw new Error(`Invalid plugin id: ${pluginId}`)
    }
    const configDir = join(this.primaryHome, '.gemini', 'config')
    const configFile = join(configDir, 'config.json')
    mkdirSync(configDir, { recursive: true })
    let doc: Record<string, unknown> = {}
    if (existsSync(configFile)) {
      try {
        const parsed = JSON.parse(readFileSync(configFile, 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          doc = parsed as Record<string, unknown>
        }
      } catch {
        doc = {}
      }
    }
    const pluginsMap =
      doc.plugins && typeof doc.plugins === 'object' && !Array.isArray(doc.plugins)
        ? { ...(doc.plugins as Record<string, unknown>) }
        : {}
    const prevEntry =
      pluginsMap[cleanId] && typeof pluginsMap[cleanId] === 'object' && !Array.isArray(pluginsMap[cleanId])
        ? (pluginsMap[cleanId] as Record<string, unknown>)
        : {}
    pluginsMap[cleanId] = { ...prevEntry, enabled }
    doc.plugins = pluginsMap
    writeFileAtomicSync(configFile, JSON.stringify(doc, null, 2))
    if (this.opts.getConfig().syncAccountCustomizations) {
      this.syncAll({ force: true })
    }
    return this.inspect(workspaceRoot)
  }
}
