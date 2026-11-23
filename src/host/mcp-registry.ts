// Registry-side wiring for the schema doctor (`mcp-sanitize.ts` + the built
// `dist/mcp-sanitize.mjs` proxy).
//
// `agy` declares the MCP servers it opens itself to Google verbatim, so a single
// tool whose schema says `"type":"array"` without `items` fails the WHOLE turn
// (`400 INVALID_ARGUMENT … properties[vertices].items: missing field`). Wrapping
// those entries, unwrapping them again, and dropping agy's cached descriptors
// are all registry-file concerns — kept here so `mcp-bridge.ts` stays the
// transport/bridge file it was.
import { chmodSync, existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { writeFileAtomicSync } from '../common/atomic-write.ts'
import { SANITIZE_SHIM_NAME, unwrapForeignServers, wrapForeignServers } from './mcp-sanitize.ts'

/** Registry key stem shared with the bridge (`dsh-tools-<port>`). */
export const BRIDGE_SERVER_KEY = 'dsh-tools'

/** True for the bridge's own entries, which must never be wrapped. */
export function isBridgeKey(key: string): boolean {
  return key === BRIDGE_SERVER_KEY || key.startsWith(BRIDGE_SERVER_KEY + '-')
}

/** Absolute path of the schema-doctor shim that ships next to the bridge. */
export function sanitizeShimPath(bridgeScript: string): string {
  return join(dirname(bridgeScript), SANITIZE_SHIM_NAME)
}

export interface SchemaDoctorOptions {
  /** `dist/mcp-sanitize.mjs` */
  shimScript: string
  /** Host binary (Electron on desktop, plus ELECTRON_RUN_AS_NODE). */
  nodeBin: string
  isElectron: boolean
  log?: (message: string) => void
}

/**
 * Wrap every foreign stdio entry in `servers` through the shim. Returns the
 * wrapped names (empty when the shim is not built, which must never break the
 * registry: the servers keep working, just unsanitized).
 */
export function applySchemaDoctor(
  servers: Record<string, unknown>,
  opts: SchemaDoctorOptions,
): string[] {
  if (!existsSync(opts.shimScript)) {
    opts.log?.('[mcp] schema doctor shim missing at ' + opts.shimScript + ' — foreign MCP schemas stay unsanitized')
    return []
  }
  try {
    const { wrapped, skipped } = wrapForeignServers(servers, {
      shimScript: opts.shimScript,
      nodeBin: opts.nodeBin,
      isElectron: opts.isElectron,
      skipKey: isBridgeKey,
    })
    if (wrapped.length > 0) {
      opts.log?.('[mcp] schema doctor wraps ' + wrapped.length + ' server(s): ' + wrapped.join(','))
    }
    if (skipped.length > 0) {
      opts.log?.('[mcp] schema doctor left ' + skipped.length + ' server(s) untouched: ' + skipped.join(','))
    }
    return wrapped
  } catch (err) {
    opts.log?.('[mcp] schema doctor skipped: ' + (err instanceof Error ? err.message : String(err)))
    return []
  }
}

/**
 * Drop `agy`'s cached per-tool descriptors for servers we just re-pointed.
 *
 * `agy` writes `<home>/.gemini/antigravity-cli/mcp/<server>/<tool>.json` when it
 * builds a toolbox, and those files carry the BROKEN schema (verified:
 * `game_procedural_mesh.json` still declares `"vertices":{"type":"array"}` with
 * no `items`). Left in place, the 400 survives the fix until agy refreshes them
 * on its own schedule.
 */
export function invalidateToolStateCaches(configFile: string, servers: readonly string[]): string[] {
  if (servers.length === 0) return []
  const mcpRoot = resolve(dirname(configFile), '..', 'antigravity-cli', 'mcp')
  const cleared: string[] = []
  for (const name of servers) {
    if (name === '' || name.includes('..') || /[\\/]/.test(name)) continue
    const dir = join(mcpRoot, name)
    if (!existsSync(dir)) continue
    try {
      rmSync(dir, { recursive: true, force: true })
      cleared.push(name)
    } catch {
      /* a live agy may hold the files open on Windows; it refreshes them itself */
    }
  }
  return cleared
}

/**
 * Undo schema-doctor wrappers once the LAST bridge entry leaves the registry: no
 * live host needs the proxy any more, and a wrapper left behind points `agy` at
 * a shim that a plugin upgrade or removal can delete.
 */
export function unwrapIfOrphaned(servers: Record<string, unknown>): string[] {
  for (const key of Object.keys(servers)) {
    if (isBridgeKey(key)) return []
  }
  return unwrapForeignServers(servers)
}
/** Atomic 0600 write: the registry embeds `DSH_MCP_TOKEN`. */
export function writePrivateMcpFile(file: string, content: string): void {
  writeFileAtomicSync(file, content, 0o600)
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows: mode bits unsupported
  }
}

export interface RegistryRestoreInput {
  file: string
  /** The registry key this host owns (`dsh-tools-<port>`). */
  key: string
  /** Content before our write (null when we created the file). */
  previous: string | null
  /** Exactly what we published, to detect a foreign rewrite. */
  writtenBytes: string
}

/**
 * Build the undo for one registry write.
 *
 * Restore only what WE wrote: after a crash + manual edit (or another host
 * rewriting the shared file), blindly restoring `previous` clobbers foreign
 * changes. When the current content no longer carries our entry, leave the file
 * alone; when it does, drop our key (and the schema-doctor wrappers, once no
 * bridge entry remains) instead of rolling the whole file back.
 */
export function makeRegistryRestore(input: RegistryRestoreInput): () => void {
  const { file, key, previous, writtenBytes } = input
  return () => {
    try {
      let current: string | null = null
      try {
        if (existsSync(file)) current = readFileSync(file, 'utf8')
      } catch {
        current = null
      }
      if (current === null) return // file vanished: nothing of ours remains
      if (current !== writtenBytes) {
        let live: Record<string, unknown> = {}
        try {
          const v = JSON.parse(current)
          if (v && typeof v === 'object') live = v as Record<string, unknown>
        } catch {
          return // unparseable: don't touch the file
        }
        const liveServers = (live.mcpServers && typeof live.mcpServers === 'object' ? live.mcpServers : {}) as Record<string, unknown>
        if (!(key in liveServers)) return
        delete liveServers[key]
        unwrapIfOrphaned(liveServers)
        const emptyRegistry = Object.keys(liveServers).length === 0
        const nothingElse = Object.keys(live).every((k) => k === 'mcpServers')
        if (emptyRegistry && nothingElse) {
          // Nothing but empty bookkeeping is left: don't keep a file behind.
          try {
            unlinkSync(file)
          } catch {
            /* best effort */
          }
          return
        }
        writePrivateMcpFile(file, JSON.stringify({ ...live, mcpServers: liveServers }, null, 2) + '\n')
        return
      }
      let parsed: Record<string, unknown> = {}
      try {
        const v = JSON.parse(current)
        if (v && typeof v === 'object') parsed = v as Record<string, unknown>
      } catch {
        return // unparseable: assume our entry is gone, don't touch the file
      }
      const curServers = (parsed.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {}) as Record<string, unknown>
      if (!(key in curServers)) return
      if (previous === null) {
        delete curServers[key]
        unwrapIfOrphaned(curServers)
        if (Object.keys(curServers).length === 0) {
          // We created the file and no other servers remain: remove it.
          unlinkSync(file)
        } else {
          writePrivateMcpFile(file, JSON.stringify({ ...parsed, mcpServers: curServers }, null, 2) + '\n')
        }
      } else {
        writePrivateMcpFile(file, previous)
      }
    } catch {
      /* best effort */
    }
  }
}
