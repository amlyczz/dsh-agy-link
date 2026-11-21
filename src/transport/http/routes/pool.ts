import type { HostServices } from '../../../host/services.ts'
import { isTerminalAuthError } from '../../../common/pool-types.ts'
import { normalizeModelFamily } from '../../../common/quota-bench.ts'
import { runRoute, sendJson, readBody, methodOf, type RawRes, type RouteRegistrar } from '../respond.ts'
import { QUOTA_REFRESH_DEDUP_MS } from '../../../common/timeouts.ts'
import { detectSystemProxy } from '../../../host/wincred.ts'
import { isolatedHomeEnv, openAccountTerminal } from '../../../host/runner.ts'
import { agyMcpConfigPath, registerBridgeMcpConfig } from '../../../host/mcp-bridge.ts'

function handlePoolList(services: HostServices, req: unknown, res: unknown): void {
  const { getConfig, pool } = services
      sendJson(res as RawRes, 200, pool.getPoolData(getConfig().proxyUrl.trim() || undefined))
}

function handlePoolBeginAdd(services: HostServices, req: unknown, res: unknown): void {
  const { getConfig, pool, poolAuth } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const accountId = typeof body.accountId === 'string' && body.accountId.trim() !== '' ? body.accountId.trim() : undefined
        const cfgProxy = getConfig().proxyUrl.trim()
        const bodyProxy = typeof body.proxyUrl === 'string' && body.proxyUrl.trim() !== '' ? body.proxyUrl.trim() : ''
        if (accountId !== undefined) {
          const acc = pool.getAccount(accountId)
          if (!acc) {
            sendJson(res as RawRes, 404, { ok: false, phase: 'failed', code: 'request_failed', error: 'account not found' })
            return
          }
          const effectiveProxy = bodyProxy || acc.proxyUrl || cfgProxy || detectSystemProxy() || undefined
          const st = acc.systemHome || acc.id === 'acc_primary'
            ? await poolAuth.beginPrimary(effectiveProxy)
            : await poolAuth.beginAccount(acc.id, effectiveProxy)
          sendJson(res as RawRes, st.ok ? 200 : 500, st)
          return
        }
        const alias = typeof body.alias === 'string' ? body.alias : undefined
        const proxyUrl = bodyProxy || cfgProxy || detectSystemProxy() || undefined
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
            registerBridgeMcpConfig(bridgeState, accTarget)
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
  const { pool, store, notifyPicker } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id : ''
        if (pool.deleteAccount(id)) {
          store?.cleanupStaleAccounts?.(new Set(pool.getAccounts().map((a) => a.id)))
        }
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

/** Longest alias we accept: it is a display label on a card, not free text. */
const MAX_ALIAS_LEN = 64

function handlePoolAlias(services: HostServices, req: unknown, res: unknown): void {
  const { pool } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        const alias = typeof body.alias === 'string' ? body.alias.trim() : ''
        if (id === '') {
          sendJson(res as RawRes, 400, { ok: false, error: 'id is required' })
          return
        }
        // An empty alias would leave the card with no label at all: the UI's
        // "reset to default" path sends the old value back instead.
        if (alias === '') {
          sendJson(res as RawRes, 400, { ok: false, error: 'alias must not be empty' })
          return
        }
        if (alias.length > MAX_ALIAS_LEN) {
          sendJson(res as RawRes, 400, { ok: false, error: 'alias is too long (max ' + MAX_ALIAS_LEN + ')' })
          return
        }
        if (!pool.setAccountAlias(id, alias)) {
          sendJson(res as RawRes, 404, { ok: false, error: 'account not found' })
          return
        }
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
        const prev = pool.getPoolData().primaryAccountId
        if (pool.setPrimaryAccount(id)) {
          const alreadyNotified = typeof pool.onAccountSwitch === 'function' && id !== prev
          if (!alreadyNotified) {
            notifyPicker()
            void catalog.forceRefreshAndNotify(id).catch(() => undefined)
          }
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
let catalogWarmInFlight: Promise<void> | null = null;
const warmupInFlight = new Map<string, Promise<void>>();
const WARMUP_DEDUP_MS = 180_000;

function triggerCatalogWarm(services: HostServices): void {
  if (catalogWarmInFlight !== null) return
  const { pool, catalog } = services
  if (typeof catalog.warmAccounts !== 'function') return
  const job = catalog.warmAccounts(pool.getAccounts()).catch(() => undefined).finally(() => {
    if (catalogWarmInFlight === job) catalogWarmInFlight = null
  })
  catalogWarmInFlight = job
}

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
        // A click that lands while the SAME key is already refreshing must say
        // so. It used to look identical to a fresh start ("已开始刷新") while
        // doing nothing for up to QUOTA_REFRESH_DEDUP_MS — the "I clicked and
        // nothing happened" report.
        const alreadyRunning = quotaRefreshInFlight.has(key)
        if (!alreadyRunning) {
          // The dedupe entry is owned by the REAL work, not by a short race:
          // a 30s race used to drop the entry while `agy /usage` was still
          // running, so the next click started a second overlapping pipeline.
          // A generous hard cap keeps a genuinely wedged dependency from
          // blocking future syncs forever without opening the overlap window
          // during any realistic refresh.
          const work = (async () => {
            if (id) {
              const acc = pool.getAccount(id)
              if (acc) await quota.refreshAccountQuota(acc, true)
            } else {
              await quota.refreshAllQuotas(true)
            }
            // Manual refresh also re-reads the model catalog: after an
            // external re-login the subscription tier (and thus model list)
            // may differ. Decouple background warmAccounts() so full-pool
            // `agy models` never holds the quotaRefreshInFlight dedupe lock.
            if (id) {
              await catalog.forceRefresh(id).catch(() => undefined)
            } else {
              await catalog.forceRefresh().catch(() => undefined)
              triggerCatalogWarm(services)
            }
          })().catch(() => undefined)
          let releaseTimer: ReturnType<typeof setTimeout> | undefined
          const entry: Promise<void> = work.finally(() => {
            if (releaseTimer !== undefined) clearTimeout(releaseTimer)
            if (quotaRefreshInFlight.get(key) === entry) quotaRefreshInFlight.delete(key)
          })
          quotaRefreshInFlight.set(key, entry)
          releaseTimer = setTimeout(() => {
            if (quotaRefreshInFlight.get(key) === entry) quotaRefreshInFlight.delete(key)
          }, QUOTA_REFRESH_DEDUP_MS)
          releaseTimer.unref?.()
        }
        // Answer IMMEDIATELY. The console polls /status every 3s, so the new
        // quota numbers appear on their own — no HTTP request needs to stay
        // open for the whole network cascade.
        sendJson(res as RawRes, 200, { ok: true, pending: true, alreadyRunning, pool: pool.getPoolData() })
      })
}

function isWarmupBusy(key: string, warmup: HostServices['warmup']): boolean {
  if (warmupInFlight.has(key)) return true
  if (key === '__all__' && warmupInFlight.size > 0) return true
  if (key !== '__all__' && warmupInFlight.has('__all__')) return true
  return typeof warmup?.isRunning === 'function' && warmup.isRunning()
}

function launchWarmupJob(
  services: HostServices,
  opts: { key: string; id: string; force: boolean; model?: string; ignoreFailureBackoff: boolean },
): void {
  const { pool, quota, warmup } = services
  const { key, id, force, model, ignoreFailureBackoff } = opts
  const work = (async () => {
    if (id) {
      const acc = pool.getAccount(id)
      if (!acc) return
      const results = await warmup.warmupAccount(acc, {
        force,
        ...(model !== undefined ? { model } : {}),
        ...(ignoreFailureBackoff ? { ignoreFailureBackoff: true } : {}),
      })
      if (results.some((r) => r.success === true && !r.skipped)) {
        await quota.refreshAccountQuota(acc, true).catch(() => undefined)
      }
      return
    }
    const results = await warmup.warmupAllAccounts({
      force,
      ...(ignoreFailureBackoff ? { ignoreFailureBackoff: true } : {}),
    })
    const succeededIds = new Set(
      results.filter((r) => r.success === true && !r.skipped).map((r) => r.accountId),
    )
    for (const accId of succeededIds) {
      const acc = pool.getAccount(accId)
      if (acc && acc.enabled && !isTerminalAuthError(acc.authError)) {
        await quota.refreshAccountQuota(acc, true).catch(() => undefined)
      }
    }
  })().catch(() => undefined)

  let releaseTimer: ReturnType<typeof setTimeout> | undefined
  const entry: Promise<void> = work.finally(() => {
    if (releaseTimer !== undefined) clearTimeout(releaseTimer)
    if (warmupInFlight.get(key) === entry) warmupInFlight.delete(key)
  })
  warmupInFlight.set(key, entry)
  releaseTimer = setTimeout(() => {
    if (warmupInFlight.get(key) === entry) warmupInFlight.delete(key)
  }, WARMUP_DEDUP_MS)
  releaseTimer.unref?.()
}

function handlePoolWarmup(services: HostServices, req: unknown, res: unknown): void {
  const { pool, warmup } = services
      runRoute(res, async () => {
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
        const ignoreFailureBackoff = body.ignoreFailureBackoff === true
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
        if (id && !pool.getAccount(id)) {
          sendJson(res as RawRes, 404, { error: 'Account not found' })
          return
        }
        const key = id || '__all__'
        const alreadyRunning = isWarmupBusy(key, warmup)
        if (!alreadyRunning) {
          launchWarmupJob(services, { key, id, force, model, ignoreFailureBackoff })
        }
        const warmupState = typeof warmup?.status === 'function' ? warmup.status() : null
        sendJson(res as RawRes, 200, { ok: true, pending: true, alreadyRunning, warmupState, pool: pool.getPoolData() })
      })
}

function handlePoolClearCooldown(services: HostServices, req: unknown, res: unknown): void {
  const { pool, notifyPicker } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id : undefined
        const family = typeof body.family === 'string' ? body.family : undefined
        pool.clearCooldown(id, family as never, true)
        notifyPicker()
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
        const rawFamily = typeof body.family === 'string' ? body.family : undefined
        const family = rawFamily ? normalizeModelFamily(rawFamily) : 'google'
        if (rawFamily && !family) {
          sendJson(res as RawRes, 400, { ok: false, error: 'invalid family', pool: pool.getPoolData() })
          return
        }
        const targetFamily = family ?? 'google'
        const prev = pool.getActiveAccountId(targetFamily)
        const ok = id !== '' && pool.setActiveAccount(id, targetFamily)
        if (ok) {
          const alreadyNotified = typeof pool.onAccountSwitch === 'function' && id !== prev
          if (!alreadyNotified) {
            notifyPicker()
            if (typeof catalog.forceRefreshAndNotify === 'function') {
              void catalog.forceRefreshAndNotify(id).catch(() => undefined)
            } else if (typeof catalog.forceRefresh === 'function') {
              void catalog.forceRefresh(id).catch(() => undefined)
            }
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
        const prevActive = pool.getActiveAccountId('google')
        if (pool.reorderAccounts(ids)) {
          const activeId = pool.getActiveAccountId('google')
          const alreadyNotified = typeof pool.onAccountSwitch === 'function' && Boolean(activeId && activeId !== prevActive)
          if (!alreadyNotified) {
            notifyPicker()
            if (activeId && typeof catalog.forceRefreshAndNotify === 'function') {
              void catalog.forceRefreshAndNotify(activeId).catch(() => undefined)
            } else if (activeId && typeof catalog.forceRefresh === 'function') {
              void catalog.forceRefresh(activeId).catch(() => undefined)
            }
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
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/alias', handler: (req, res) => handlePoolAlias(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/primary', handler: (req, res) => handlePoolPrimary(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/mode', handler: (req, res) => handlePoolMode(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/refresh-quota', handler: (req, res) => handlePoolRefreshQuota(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/warmup', handler: (req, res) => handlePoolWarmup(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/clear-cooldown', handler: (req, res) => handlePoolClearCooldown(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/set-active', handler: (req, res) => handlePoolSetActive(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/reorder', handler: (req, res) => handlePoolReorder(services, req, res) })
}
