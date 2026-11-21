import type { HostServices } from '../../../host/services.ts'
import { handleEmbedRequest } from '../../../host/embed-route.ts'
import type { HttpRequestLike, HttpResponseLike } from '../../../host/media-route.ts'
import type { RouteRegistrar } from '../respond.ts'
import { collectWorkspaceRoots } from './media.ts'

export function register(reg: RouteRegistrar, services: HostServices): void {
  reg({
    kind: 'exact',
    path: '/plugins/agy-link/embed',
    handler: (req, res) => {
      handleEmbedRequest(req as HttpRequestLike, res as HttpResponseLike, {
        workspaceRoots: collectWorkspaceRoots(services),
      })
    },
  })
}
