// HTTP routes for Antigravity customization ecosystem inspection, plugin toggle, and multi-account sync.
import type { HostServices } from '../../../host/services.ts'
import { methodOf, readBody, runRoute, sendJson, type RawRes, type RouteRegistrar } from '../respond.ts'

/**
 * Workspace roots the panel should scan: every active session's directory.
 *
 * `/agy skills` resolves one root for its session (configured workspaceRoot,
 * else that session's cwd). The panel has no session, so it covers all of them
 * and lets the service pin the configured root when there is one (issue #219).
 */
function panelWorkspaceRoots(services: HostServices): string[] {
  if (typeof services.activeCwds !== 'function') return []
  return services.activeCwds().filter((cwd): cwd is string => typeof cwd === 'string' && cwd.trim() !== '')
}

function handleGetEcosystem(services: HostServices, req: unknown, res: unknown): void {
  if (methodOf(req) !== 'GET') {
    sendJson(res as RawRes, 405, { error: 'GET only' })
    return
  }
  runRoute(res, async () => {
    const eco = services.ecosystem
    if (!eco) {
      sendJson(res as RawRes, 503, { ok: false, error: 'ecosystem service unavailable' })
      return
    }
    sendJson(res as RawRes, 200, { ok: true, ...eco.inspect(undefined, panelWorkspaceRoots(services)) })
  })
}

function handleSyncEcosystem(services: HostServices, req: unknown, res: unknown): void {
  if (methodOf(req) !== 'POST') {
    sendJson(res as RawRes, 405, { error: 'POST only' })
    return
  }
  runRoute(res, async () => {
    const eco = services.ecosystem
    if (!eco) {
      sendJson(res as RawRes, 503, { ok: false, error: 'ecosystem service unavailable' })
      return
    }
    await readBody(req)
    const report = eco.syncAll({ force: true })
    const snapshot = eco.inspect(undefined, panelWorkspaceRoots(services))
    sendJson(res as RawRes, 200, { ok: true, report, snapshot })
  })
}

function handleTogglePlugin(services: HostServices, req: unknown, res: unknown): void {
  if (methodOf(req) !== 'POST') {
    sendJson(res as RawRes, 405, { error: 'POST only' })
    return
  }
  runRoute(res, async () => {
    const eco = services.ecosystem
    if (!eco) {
      sendJson(res as RawRes, 503, { ok: false, error: 'ecosystem service unavailable' })
      return
    }
    const body = await readBody(req, true)
    if (body.__invalidJson === true) {
      sendJson(res as RawRes, 400, { error: 'invalid JSON body' })
      return
    }
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const enabled = body.enabled
    if (!id || typeof enabled !== 'boolean') {
      sendJson(res as RawRes, 400, { error: 'id (string) and enabled (boolean) are required' })
      return
    }
    try {
      const snapshot = eco.setPluginEnabled(id, enabled)
      sendJson(res as RawRes, 200, { ok: true, snapshot })
    } catch (e) {
      sendJson(res as RawRes, 400, { error: e instanceof Error ? e.message : String(e) })
    }
  })
}

export function register(reg: RouteRegistrar, services: HostServices): void {
  reg({ kind: 'exact', path: '/plugins/agy-link/ecosystem', handler: (req, res) => handleGetEcosystem(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/ecosystem/sync', handler: (req, res) => handleSyncEcosystem(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/ecosystem/plugin', handler: (req, res) => handleTogglePlugin(services, req, res) })
}
