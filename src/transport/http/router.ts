// The plugin's HTTP surface: registers every /plugins/agy-link/* route with
// the host webServer and returns one disposer that tears them all down.
// Route bodies live in ./routes/*; this module only wires them up.
import type { HostServices } from '../../host/services.ts'
import { isCrossOriginBlocked, type HttpRequestLike } from '../../host/media-route.ts'
import { methodOf, sendJson, type RawRes, type RouteRegistrar, type WebServerLike } from './respond.ts'
import { register as registerStatus } from './routes/status.ts'
import { register as registerSessionView } from './routes/session-view.ts'
import { register as registerPool } from './routes/pool.ts'
import { register as registerAuth } from './routes/auth.ts'
import { register as registerConfig } from './routes/config.ts'
import { register as registerTranslate } from './routes/translate.ts'
import { register as registerMedia } from './routes/media.ts'
import { register as registerEmbed } from './routes/embed.ts'
import { register as registerEcosystem } from './routes/ecosystem.ts'
import { register as registerLease } from './routes/lease.ts'
import { register as registerBtw } from './routes/btw.ts'

export type { WebServerLike, Route, RouteHandler, RouteRegistrar } from './respond.ts'

export function registerRoutes(webServer: WebServerLike, services: HostServices): () => void {
  const disposers: Array<() => void> = []
  const reg: RouteRegistrar = (route) => {
    const exempt = route.path === '/plugins/agy-link/open' || route.path.startsWith('/plugins/agy-link/lease')
    const guarded = exempt
      ? route
      : {
          ...route,
          handler: (req: unknown, res: unknown) => {
            const m = methodOf(req)
            if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS' && isCrossOriginBlocked(req as HttpRequestLike)) {
              sendJson(res as RawRes, 403, { ok: false, error: 'cross-origin request denied' })
              return
            }
            route.handler(req, res)
          },
        }
    const d = webServer.register(guarded) as unknown as () => void | undefined
    if (typeof d === 'function') disposers.push(d)
  }
  registerStatus(reg, services)
  registerSessionView(reg, services)
  registerPool(reg, services)
  registerAuth(reg, services)
  registerConfig(reg, services)
  registerTranslate(reg, services)
  registerMedia(reg, services)
  registerEmbed(reg, services)
  registerEcosystem(reg, services)
  registerBtw(reg, services)
  const disposeLease = registerLease(reg, services, webServer.port)
  return () => {
    disposeLease()
    for (const d of disposers) {
      try {
        d()
      } catch {
        // route already gone (server teardown) — nothing to do
      }
    }
  }
}
