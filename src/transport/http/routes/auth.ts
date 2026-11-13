import type { HostServices } from '../../../host/services.ts'
import { runRoute, sendJson, readBody, methodOf, type RawRes, type RouteRegistrar } from '../respond.ts'
import { detectSystemProxy } from '../../../host/wincred.ts'

function handleAuthBegin(services: HostServices, req: unknown, res: unknown): void {
  const { getConfig, auth } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const homeDir = typeof body.homeDir === 'string' ? body.homeDir : undefined
        const accountId = typeof body.accountId === 'string' ? body.accountId : undefined
        const proxyUrl = typeof body.proxyUrl === 'string' && body.proxyUrl.trim() !== ''
          ? body.proxyUrl.trim()
          : (getConfig().proxyUrl.trim() || detectSystemProxy() || undefined)
        const st = await auth.begin(homeDir, accountId, proxyUrl)
        sendJson(res as RawRes, 200, st)
      })
}

function handleAuthCode(services: HostServices, req: unknown, res: unknown): void {
  const { store, pool, quota, catalog, auth } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const code = typeof body.code === 'string' ? body.code : ''
        if (code === '') {
          sendJson(res as RawRes, 400, { error: 'missing code' })
          return
        }
        const st = await auth.submitCode(code)
        if (st.phase === 'ok') {
          if (st.accountId) {
            const acc = pool.getAccount(st.accountId)
            if (acc) void quota.refreshAccountQuota(acc).catch(() => undefined)
          } else {
            void quota.refreshAllQuotas().catch(() => undefined)
          }
          store.clear()
          void catalog.forceRefresh().catch(() => undefined)
        }
        sendJson(res as RawRes, 200, st)
      })
}

function handleAuthCancel(services: HostServices, req: unknown, res: unknown): void {
  const { auth } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        await readBody(req)
        const st = auth.cancelAuth()
        sendJson(res as RawRes, 200, st)
      })
}

function handleAuthQr(services: HostServices, req: unknown, res: unknown): void {
  const { auth } = services
      runRoute(res, async () => {
        const st = auth.status()
        const url = st.phase === 'pending' ? st.url : undefined
        if (!url) {
          const r404 = res as RawRes
          r404.writeHead(404, { 'Content-Type': 'text/plain' })
          r404.end('no pending auth')
          return
        }
        try {
          const mod = (await import('qrcode')) as unknown as { toBuffer: (t: string, o?: { type?: string; width?: number; margin?: number }) => Promise<Buffer> }
          const png = await mod.toBuffer(url, { type: 'png', width: 220, margin: 1 })
          const r2 = res as RawRes
          r2.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
          r2.end(png)
        } catch {
          sendJson(res as RawRes, 500, { error: 'qr generation failed' })
        }
      })
}

export function register(reg: RouteRegistrar, services: HostServices): void {
  reg({ kind: 'exact', path: '/plugins/agy-link/auth', handler: (req, res) => handleAuthBegin(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/auth-code', handler: (req, res) => handleAuthCode(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/auth-cancel', handler: (req, res) => handleAuthCancel(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/qr', handler: (req, res) => handleAuthQr(services, req, res) })
}
