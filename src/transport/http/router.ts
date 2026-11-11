// The plugin's HTTP surface: registers all 29 /plugins/agy-link/* routes with
// the host webServer and returns one disposer that tears every route down.
// Route bodies live in ./routes/*; this module only wires them up.
import type { HostServices } from '../../host/services.ts'
import type { RouteRegistrar, WebServerLike } from './respond.ts'
import { register as registerStatus } from './routes/status.ts'
import { register as registerPool } from './routes/pool.ts'
import { register as registerAuth } from './routes/auth.ts'
import { register as registerConfig } from './routes/config.ts'
import { register as registerTranslate } from './routes/translate.ts'
import { register as registerMedia } from './routes/media.ts'

export type { WebServerLike, Route, RouteHandler, RouteRegistrar } from './respond.ts'

export function registerRoutes(webServer: WebServerLike, services: HostServices): () => void {
  const disposers: Array<() => void> = []
  const reg: RouteRegistrar = (route) => {
    const d = webServer.register(route) as unknown as () => void | undefined
    if (typeof d === 'function') disposers.push(d)
  }
  registerStatus(reg, services)
  registerPool(reg, services)
  registerAuth(reg, services)
  registerConfig(reg, services)
  registerTranslate(reg, services)
  registerMedia(reg, services)
  return () => {
    for (const d of disposers) {
      try {
        d()
      } catch {
        // route already gone (server teardown) — nothing to do
      }
    }
  }
}
