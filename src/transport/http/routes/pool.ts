import type { HostServices } from '../../../host/services.ts'
import { runRoute, sendJson, readBody, methodOf, ROUTE_TIMEOUT_MS, type RawRes, type RouteRegistrar } from '../respond.ts'
import type { WarmupResult } from '../../../host/warmup.ts'
import { detectSystemProxy } from '../../../host/wincred.ts'
import { openAccountTerminal } from '../../../host/runner.ts'
import { isolatedHomeEnv } from '../../../host/runner.ts'
import { writeMcpConfig } from '../../../host/mcp-bridge.ts'
import { agyMcpConfigPath } from '../../../host/mcp-bridge.ts'

function handlePoolList(services: HostServices, req: unknown, res: unknown): void {
  const { getConfig, pool } = services
      sendJson(res as RawRes, 200, pool.getPoolData(getConfig().proxyUrl.trim() || undefined))
}

function handlePoolBeginAdd(services: HostServices, req: unknown, res: unknown): void {
  const { getConfig, poolAuth } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const alias = typeof body.alias === 'string' ? body.alias : undefined
        const proxyUrl = typeof body.proxyUrl === 'string' && body.proxyUrl.trim() !== ''
          ? body.proxyUrl.trim()
          : (getConfig().proxyUrl.trim() || detectSystemProxy() || undefined)
        const st = await poolAuth.begin(alias, proxyUrl)
        sendJson(res as RawRes, st.ok ? 200 : 500, st)
      })
}

function handlePoolCompleteAdd(services: HostServices, req: unknown, res: unknown): void {
  const { pool, poolAuth } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const code = typeof body.code === 'string' ? body.code : ''
        if (!code) {
          sendJson(res as RawRes, 400, { ok: false, phase: 'waiting', code: 'missing_code' })
          return
        }
        const st = await poolAuth.submitCode(code)
        sendJson(res as RawRes, st.ok ? 200 : 400, {
          ok: st.ok,
          phase: st.phase,
          code: st.code,
          pool: pool.getPoolData(),
        })
      })
}

function handlePoolCancelAdd(services: HostServices, req: unknown, res: unknown): void {
  const { pool, poolAuth } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        await readBody(req)
        await poolAuth.cancel()
        sendJson(res as RawRes, 200, { ok: true, pool: pool.getPoolData() })
      })
}

function handlePoolAdd(services: HostServices, req: unknown, res: unknown): void {
  const { getConfig, pool, bridgeState } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const alias = typeof body.alias === 'string' ? body.alias : undefined
        const acc = pool.createAccountSlot(alias)
        if (bridgeState.bridge !== null) {
          const cfg = getConfig()
          if (cfg.mcpConfigScope === 'global' || cfg.mcpConfigScope === 'both') {
            const accTarget = agyMcpConfigPath('', isolatedHomeEnv(acc.dir))
            bridgeState.restores.push(writeMcpConfig(accTarget, bridgeState.bridge))
          }
        }
        // Quarantine until the terminal login completes (same contract as
        // /agy add-account): the scheduler must not route real runs to a
        // slot nobody has signed into yet.
        pool.markAuthRequired(acc.id, 'not signed in yet — complete the terminal login')
        const autoOpen = body.autoOpenTerminal !== false
        if (autoOpen && acc.dir) {
          openAccountTerminal(acc.dir)
        }
        sendJson(res as RawRes, 200, { ok: true, account: acc, pool: pool.getPoolData() })
      })
}

function handlePoolOpenTerminal(services: HostServices, req: unknown, res: unknown): void {
  const { pool } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id : ''
        const acc = pool.getAccount(id)
        if (!acc || !acc.dir) {
          sendJson(res as RawRes, 400, { error: 'account has no isolated directory' })
          return
        }
        openAccountTerminal(acc.dir)
        sendJson(res as RawRes, 200, { ok: true, dir: acc.dir })
      })
}

function handlePoolRemove(services: HostServices, req: unknown, res: unknown): void {
  const { pool, notifyPicker } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id : ''
        pool.deleteAccount(id)
        // Deleting the active/primary account changes the effective account.
        notifyPicker()
        sendJson(res as RawRes, 200, { ok: true, pool: pool.getPoolData() })
      })
}

function handlePoolEnable(services: HostServices, req: unknown, res: unknown): void {
  const { pool, notifyPicker } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id : ''
        const enabled = typeof body.enabled === 'boolean' ? body.enabled : true
        const ok = pool.setAccountEnabled(id, enabled)
        // Enabling/disabling the active account changes which models are live.
        if (ok) notifyPicker()
        sendJson(res as RawRes, ok ? 200 : 400, { ok, pool: pool.getPoolData() })
      })
}

function handlePoolProxy(services: HostServices, req: unknown, res: unknown): void {
  const { pool } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id : ''
        const proxyUrl = typeof body.proxyUrl === 'string' ? body.proxyUrl : undefined
        pool.setAccountProxy(id, proxyUrl)
        sendJson(res as RawRes, 200, { ok: true, pool: pool.getPoolData() })
      })
}

function handlePoolPrimary(services: HostServices, req: unknown, res: unknown): void {
  const { pool, catalog, notifyPicker } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id : ''
        if (pool.setPrimaryAccount(id)) {
          // Same contract as /pool/set-active: switching the primary changes
          // the effective account and its model catalog / Argon visibility.
          notifyPicker()
          void catalog.forceRefreshAndNotify(id).catch(() => undefined)
        }
        sendJson(res as RawRes, 200, { ok: true, pool: pool.getPoolData() })
      })
}

function handlePoolMode(services: HostServices, req: unknown, res: unknown): void {
  const { pool } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const mode = body.mode === 'round-robin' ? 'round-robin' : 'sequential'
        pool.setMode(mode)
        sendJson(res as RawRes, 200, { ok: true, pool: pool.getPoolData() })
      })
}

/**
 * In-flight quota refreshes, keyed by account id ('' = all). A manual refresh
 * runs `agy /usage` (20s cap) plus several REST calls; waiting for all of that
 * before answering is what made the console's "同步中" spin. Rapid clicks must
 * not stack duplicate pipelines either.
 */
const quotaRefreshInFlight = new Map<string, Promise<void>>();

function handlePoolRefreshQuota(services: HostServices, req: unknown, res: unknown): void {
  const { pool, quota, catalog } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id : ''
        const key = id || '__all__'
        if (!quotaRefreshInFlight.has(key)) {
          // The dedupe entry must ALWAYS be released, even if a dependency
          // never settles — otherwise every future sync on that account would
          // be silently skipped. Bound the background work independently of
          // the (already-answered) HTTP response.
          let releaseTimer: ReturnType<typeof setTimeout> | undefined
          const bounded = new Promise<void>((resolve) => {
            releaseTimer = setTimeout(resolve, ROUTE_TIMEOUT_MS)
            releaseTimer.unref?.()
          })
          const work = (async () => {
            if (id) {
              const acc = pool.getAccount(id)
              if (acc) await quota.refreshAccountQuota(acc, true)
            } else {
              await quota.refreshAllQuotas(true)
            }
            // Manual refresh also re-reads the model catalog: after an
            // external re-login the subscription tier (and thus model list)
            // may differ. One `agy models` spawn per explicit click only —
            // the background poller never touches the catalog.
            // ModelCatalog emits notifyPicker internally ONLY when entries change.
            await catalog.forceRefresh().catch(() => undefined)
          })()
            .catch(() => undefined)
            .finally(() => {
              if (releaseTimer !== undefined) clearTimeout(releaseTimer)
            })
          // Whichever finishes first — real work or the deadline — owns the
          // dedupe entry and releases it. A hung pipeline therefore cannot
          // permanently block future syncs on this account.
          quotaRefreshInFlight.set(
            key,
            Promise.race([work, bounded]).finally(() => quotaRefreshInFlight.delete(key)),
          )
        }
        // Answer IMMEDIATELY. The console polls /status every 3s, so the new
        // quota numbers appear on their own — no HTTP request needs to stay
        // open for the whole network cascade.
        sendJson(res as RawRes, 200, { ok: true, pending: true, pool: pool.getPoolData() })
      })
}

function handlePoolWarmup(services: HostServices, req: unknown, res: unknown): void {
  const { pool, quota, warmup } = services
      runRoute(res, async () => {
        try {
          if (methodOf(req) !== 'POST') {
            sendJson(res as RawRes, 405, { error: 'POST only' })
            return
          }
          const body = await readBody(req, true)
          if (body.__invalidJson === true) {
            sendJson(res as RawRes, 400, { error: 'invalid JSON body' })
            return
          }
          const id = typeof body.id === 'string' ? body.id : ''
          const force = body.force === true
          const rawModel = body.model
          if (rawModel !== undefined && (typeof rawModel !== 'string' || !/^[A-Za-z0-9._/-]{1,80}$/.test(rawModel))) {
            sendJson(res as RawRes, 400, { error: 'invalid model' })
            return
          }
          const model = typeof rawModel === 'string' ? rawModel : undefined
          // Never let an empty/malformed body fan out to every account: the
          // caller must say either `{ id }` or `{ all: true }` explicitly.
          if (id === '' && body.all !== true) {
            sendJson(res as RawRes, 400, { error: 'id or { all: true } required' })
            return
          }
          let results: WarmupResult[] = []
          if (id) {
            const acc = pool.getAccount(id)
            if (!acc) {
              sendJson(res as RawRes, 404, { error: 'Account not found' })
              return
            }
            results = await warmup.warmupAccount(acc, { force, model })
            await quota.refreshAccountQuota(acc, true).catch(() => undefined)
          } else {
            results = await warmup.warmupAllAccounts({ force })
            // Non-forced refresh respects account cooldowns and the 10s cache,
            // avoiding a second network burst right after a warmup pass.
            await quota.refreshAllQuotas(false).catch(() => undefined)
          }
          sendJson(res as RawRes, 200, { ok: true, results, pool: pool.getPoolData() })
        } catch (e) {
          sendJson(res as RawRes, 500, { error: String(e) })
        }
      })
}

function handlePoolClearCooldown(services: HostServices, req: unknown, res: unknown): void {
  const { pool } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id : undefined
        const family = typeof body.family === 'string' ? body.family : undefined
        pool.clearCooldown(id, family as never, true)
        sendJson(res as RawRes, 200, { ok: true, pool: pool.getPoolData() })
      })
}

function handlePoolSetActive(services: HostServices, req: unknown, res: unknown): void {
  const { pool, catalog, notifyPicker } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id : ''
        const ok = id !== '' && pool.setActiveAccount(id)
        if (ok) {
          notifyPicker()
          if (typeof catalog.forceRefreshAndNotify === 'function') {
            void catalog.forceRefreshAndNotify(id).catch(() => undefined)
          } else if (typeof catalog.forceRefresh === 'function') {
            void catalog.forceRefresh(id).catch(() => undefined)
          }
        }
        sendJson(res as RawRes, ok ? 200 : 400, { ok, pool: pool.getPoolData() })
      })
}

function handlePoolReorder(services: HostServices, req: unknown, res: unknown): void {
  const { pool, catalog, notifyPicker } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).filter((x): x is string => typeof x === 'string') : []
        if (pool.reorderAccounts(ids)) {
          // Reordering clears the sticky active pointers, so the effective
          // account may change; refresh it and re-announce the model list.
          const activeId = pool.getActiveAccountId('google')
          notifyPicker()
          if (activeId && typeof catalog.forceRefreshAndNotify === 'function') {
            void catalog.forceRefreshAndNotify(activeId).catch(() => undefined)
          } else if (activeId && typeof catalog.forceRefresh === 'function') {
            void catalog.forceRefresh(activeId).catch(() => undefined)
          }
        }
        sendJson(res as RawRes, 200, { ok: true, pool: pool.getPoolData() })
      })
}

function handlePoolImport(services: HostServices, req: unknown, res: unknown): void {
  const { poolAuth, pool, notifyPicker } = services
  runRoute(res, async () => {
    if (methodOf(req) !== 'POST') {
      sendJson(res as RawRes, 405, { error: 'POST only' })
      return
    }
    const body = await readBody(req)
    const token = typeof body.token === 'string' ? body.token.trim() : ''
    const alias = typeof body.alias === 'string' ? body.alias.trim() : undefined
    const proxyUrl = typeof body.proxyUrl === 'string' ? body.proxyUrl.trim() : undefined
    if (!token) {
      sendJson(res as RawRes, 400, { ok: false, error: 'Token is required' })
      return
    }
    const result = await poolAuth.importRefreshToken(token, alias, proxyUrl)
    if (result.ok) {
      notifyPicker()
      sendJson(res as RawRes, 200, {
        ok: true,
        account: result.account,
        isNew: result.isNew,
        email: result.email,
        pool: pool.getPoolData(),
      })
    } else {
      sendJson(res as RawRes, 400, {
        ok: false,
        error: result.error || 'Import failed',
        code: result.code,
      })
    }
  })
}

export function register(reg: RouteRegistrar, services: HostServices): void {
  reg({ kind: 'exact', path: '/plugins/agy-link/pool', handler: (req, res) => handlePoolList(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/begin-add', handler: (req, res) => handlePoolBeginAdd(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/complete-add', handler: (req, res) => handlePoolCompleteAdd(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/cancel-add', handler: (req, res) => handlePoolCancelAdd(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/import', handler: (req, res) => handlePoolImport(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/add', handler: (req, res) => handlePoolAdd(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/open-terminal', handler: (req, res) => handlePoolOpenTerminal(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/remove', handler: (req, res) => handlePoolRemove(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/enable', handler: (req, res) => handlePoolEnable(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/proxy', handler: (req, res) => handlePoolProxy(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/primary', handler: (req, res) => handlePoolPrimary(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/mode', handler: (req, res) => handlePoolMode(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/refresh-quota', handler: (req, res) => handlePoolRefreshQuota(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/warmup', handler: (req, res) => handlePoolWarmup(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/clear-cooldown', handler: (req, res) => handlePoolClearCooldown(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/set-active', handler: (req, res) => handlePoolSetActive(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/reorder', handler: (req, res) => handlePoolReorder(services, req, res) })
}
