// Several single-root inventories -> one snapshot (issue #219).
//
// `inspectEcosystem` answers for ONE workspace, which is exactly what a
// session-scoped command needs. The settings panel has no session, so it covers
// every active session directory instead; this is the composition step. Keeping
// it pure and separate leaves the single-root scan (and its callers) untouched.
import type { EcosystemSnapshot } from '../../common/ecosystem-types.ts'

function uniqueBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const key = keyOf(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * Merge later inventories into `base`.
 *
 * De-duplication follows how the panel renders each kind, so two workspaces
 * exposing the same name are ONE item (the first occurrence, i.e. the base):
 * skills and MCP servers by name within their source/plugin, agents by
 * `name:source` (that pair is the React key), plugins by id within their
 * source, rules by path. The base keeps `primaryHome`, sync state and its
 * `workspaceRoot`; `workspaceRoots` lists every root that was actually scanned.
 */
export function mergeEcosystemSnapshots(base: EcosystemSnapshot, extras: readonly EcosystemSnapshot[]): EcosystemSnapshot {
  if (extras.length === 0) return base
  const all = [base, ...extras]
  const roots: string[] = []
  for (const snap of all) {
    for (const root of [...(snap.workspaceRoots ?? []), ...(snap.workspaceRoot ? [snap.workspaceRoot] : [])]) {
      if (!roots.includes(root)) roots.push(root)
    }
  }
  return {
    primaryHome: base.primaryHome,
    ...(roots.length > 0 ? { workspaceRoot: base.workspaceRoot ?? roots[0] } : {}),
    workspaceRoots: roots,
    plugins: uniqueBy(all.flatMap((s) => s.plugins), (p) => `${p.source}\u0000${p.id}`),
    mcpServers: uniqueBy(all.flatMap((s) => s.mcpServers), (m) => `${m.source}\u0000${m.pluginName ?? ''}\u0000${m.name}`),
    skills: uniqueBy(all.flatMap((s) => s.skills), (s) => `${s.source}\u0000${s.pluginName ?? ''}\u0000${s.name}`),
    rules: uniqueBy(all.flatMap((s) => s.rules), (r) => r.path),
    agents: uniqueBy(all.flatMap((s) => s.agents), (a) => `${a.source}\u0000${a.name}`),
    syncedAccountCount: base.syncedAccountCount,
    lastSyncAt: base.lastSyncAt,
  }
}
