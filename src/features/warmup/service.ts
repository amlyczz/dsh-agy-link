// WarmupService: Smart 7-day weekly quota reset warmup and manual account pre-warming.
//
// Background:
// Google Antigravity (and underlying Google Cloud Code PA) manages accounts with two
// rolling windows: a 5-hour rolling limit and a 7-day weekly quota limit. Upstream,
// an account's 7-day reset timer starts ONLY once an API request is made for that
// weekly cycle. If an account sits idle at 100% quota, its 7-day window does not begin
// counting down.
//
// By sending a tiny, single-token probe when:
//   1. The weekly quota is full (remainingFraction >= 0.999) and the reset instant
//      has passed (now >= resetTime - 60s); OR
//   2. Cold-start: weeklyResetTime is uninitialized (e.g. Gemini weekly bucket not
//      yet activated this week),
// the upstream backend registers activity, advances the 7-day timer, and activates
// the new cycle with zero excess token consumption.
//
// Cooldown rules (aligned with Antigravity-Manager):
//   * Weekly reset: 6-day cooldown per cycle (${email}:${family}:weekly:${resetTs|'initial'})
//   * Manual trigger: 4-hour cooldown per model (${email}:${model}:100)
//   * Safe interval: 1500ms sequential throttle between probes to prevent WAF / 403 rate limits.
import { randomBytes, randomUUID } from 'node:crypto'
import { shouldPollAccount, type ManagedAccount } from '../../common/pool-types.ts'
import type { PluginConfig } from '../../common/types.ts'
import { agyFetch } from '../../host/net.ts'
import { AGY_ENDPOINTS } from '../../host/oauth.ts'
import type { AccountPoolManager } from '../../host/pool.ts'
import { QuotaService, agyUserAgent } from '../../host/quota.ts'
import { WarmupHistoryStore } from './history.ts'
import {
  FAILURE_BACKOFF_MS,
  FOUR_HOURS_MS,
  LOAD_PROJECT_ENDPOINTS,
  extractWarmupProjectId,
  planWarmupTargets,
  skippedWarmupResult,
  toCanonicalWarmupModel,
  warmupDelayMs,
  type WarmupResult,
  type WarmupTarget,
} from './policy.ts'

export class WarmupService {
  readonly history: WarmupHistoryStore

  constructor(
    private readonly pool: AccountPoolManager,
    private readonly quota: QuotaService,
    private readonly globalProxy: () => string = () => '',
    private readonly agyVersion: () => string | null = () => null,
    private readonly config: () => PluginConfig = () => ({} as PluginConfig),
    private readonly log: (msg: string) => void = () => undefined,
    historyStore?: WarmupHistoryStore,
  ) {
    this.history = historyStore ?? new WarmupHistoryStore()
  }

  private proxyFor(account: ManagedAccount): string | undefined {
    return account.proxyUrl?.trim() || this.globalProxy() || undefined
  }

  /**
   * Fetch cloudaicompanionProject via loadCodeAssist (official Antigravity project resolution).
   */
  async fetchProjectId(accessToken: string, proxyUrl?: string): Promise<string> {
    const reqBody = JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } })
    const userAgent = agyUserAgent(this.agyVersion())

    for (const url of LOAD_PROJECT_ENDPOINTS) {
      try {
        const res = await agyFetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': userAgent,
            // The bootstrap endpoint validates this enum strictly; `ideType`
            // alone is what the official clients send.
            'Client-Metadata': '{"ideType":"ANTIGRAVITY"}',
          },
          body: reqBody,
        }, proxyUrl)

        if (res.ok) {
          const projectId = extractWarmupProjectId(await res.json())
          if (projectId !== '') return projectId
        }
      } catch {
        // try next endpoint
      }
    }
    // No project resolved: the caller must skip the probe. Never borrow
    // another account's project id (that yields a 403 from the backend).
    return ''
  }

  /**
   * Send a minimal probe to upstream v1internal:streamGenerateContent (fallback: generateContent).
   */
  async warmupModelDirectly(
    account: ManagedAccount,
    modelName: string,
  ): Promise<{ ok: boolean; status?: number; error?: string; durationMs: number }> {
    const start = Date.now()
    const accessToken = await this.quota.getValidAccessToken(account)
    if (!accessToken) {
      return { ok: false, error: 'Could not obtain valid access token', durationMs: Date.now() - start }
    }

    const proxy = this.proxyFor(account)
    const projectId = await this.fetchProjectId(accessToken, proxy)
    if (projectId === '') {
      return {
        ok: false,
        error: 'Could not resolve cloudaicompanionProject (loadCodeAssist failed); refusing to probe a foreign project',
        durationMs: Date.now() - start,
      }
    }
    const mappedModel = toCanonicalWarmupModel(modelName)
    const isClaude = mappedModel.toLowerCase().includes('claude')
    const sessionId = `warmup_${Date.now()}_${randomBytes(4).toString('hex')}`

    const reqBody = JSON.stringify({
      ...(projectId !== '' ? { project: projectId } : {}),
      model: mappedModel,
      requestId: `agent/${randomUUID()}`,
      request: {
        contents: [
          {
            role: 'user',
            parts: [{ text: isClaude ? 'ping' : 'Say hi' }],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 1,
          ...(isClaude ? {} : { responseModalities: ['TEXT'] }),
        },
        sessionId,
      },
    })

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': agyUserAgent(this.agyVersion()),
      'Client-Metadata': '{"ideType":"ANTIGRAVITY"}',
    }
    if (isClaude) {
      headers['anthropic-beta'] = 'claude-code-20250219'
    }

    const endpoints = AGY_ENDPOINTS
    const attempts = [
      { method: 'streamGenerateContent', query: '?alt=sse' },
      { method: 'generateContent', query: '' },
    ]

    let lastStatus = 0
    let lastError = ''

    for (const attempt of attempts) {
      for (const ep of endpoints) {
        try {
          const targetUrl = `${ep}/v1internal:${attempt.method}${attempt.query}`
          const res = await agyFetch(targetUrl, {
            method: 'POST',
            headers,
            body: reqBody,
          }, proxy)

          lastStatus = res.status
          if (res.ok) {
            const bodyText = await res.text().catch(() => '')
            if (
              bodyText.includes('no longer available') ||
              bodyText.includes('is not available') ||
              bodyText.includes('is retired')
            ) {
              return {
                ok: false,
                status: res.status,
                error: `Model is retired upstream: ${mappedModel}`,
                durationMs: Date.now() - start,
              }
            }
            return { ok: true, status: res.status, durationMs: Date.now() - start }
          }

          const errBody = await res.text().catch(() => '')
          if (errBody.toLowerCase().includes('validation_required')) {
            return {
              ok: false,
              status: res.status,
              error: 'Account requires browser validation (VALIDATION_REQUIRED)',
              durationMs: Date.now() - start,
            }
          }

          lastError = `HTTP ${res.status}: ${errBody.slice(0, 160)}`
          // On auth denial 401/403, don't spam sibling endpoints
          if (res.status === 401 || res.status === 403) {
            return { ok: false, status: res.status, error: lastError, durationMs: Date.now() - start }
          }
        } catch (err) {
          lastError = String(err)
        }
      }
    }

    return { ok: false, status: lastStatus, error: lastError, durationMs: Date.now() - start }
  }

  /** Explicit single-model request (manual trigger). */
  private async warmupExplicitModel(
    account: ManagedAccount,
    model: string,
    force: boolean,
    now: number,
  ): Promise<WarmupResult> {
    const identity = account.email || account.id
    const manualKey = `${identity}:${model}:100`
    const manualFailureKey = `${manualKey}:failed`
    if (!force && this.history.checkCooldown(manualKey, FOUR_HOURS_MS, now)) {
      return skippedWarmupResult(account, model, 'Model in 4-hour warmup cooldown')
    }
    if (!force && this.history.checkCooldown(manualFailureKey, FAILURE_BACKOFF_MS, now)) {
      return skippedWarmupResult(account, model, 'Recent warmup attempt failed; retrying after backoff')
    }

    this.log(`[Warmup] pinging ${model} for account ${account.id}...`)
    const res = await this.warmupModelDirectly(account, model)
    if (res.ok) {
      this.history.record(manualKey, now)
    } else {
      this.history.record(manualFailureKey, now)
      if (res.status === 401) this.pool.markAuthRequired(account.id, 'Warmup probe rejected with HTTP 401')
    }
    return {
      accountId: account.id,
      alias: account.alias,
      email: account.email,
      model,
      success: res.ok,
      status: res.status,
      error: res.error,
      durationMs: res.durationMs,
    }
  }

  /** Execute the planned weekly probes sequentially with a randomized gap. */
  private async runWarmupTargets(
    account: ManagedAccount,
    targets: readonly WarmupTarget[],
    now: number,
  ): Promise<WarmupResult[]> {
    const results: WarmupResult[] = []
    const identity = account.email || account.id

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!
      this.log(`[Warmup] weekly warmup for ${target.model} @ ${account.id} (${target.family})...`)
      const res = await this.warmupModelDirectly(account, target.model)
      if (res.ok) {
        this.history.record(target.historyKey, now)
        this.history.record(`${identity}:${target.model}:100`, now)
      } else {
        this.history.record(target.failureKey, now)
        if (res.status === 401) this.pool.markAuthRequired(account.id, 'Warmup probe rejected with HTTP 401')
      }
      results.push({
        accountId: account.id,
        alias: account.alias,
        email: account.email,
        model: target.model,
        success: res.ok,
        status: res.status,
        error: res.error,
        durationMs: res.durationMs,
      })

      if (i < targets.length - 1) {
        await new Promise((r) => setTimeout(r, warmupDelayMs()))
      }
    }

    return results
  }

  /**
   * Warm up one account.
   * If options.model is specified, warms up that model directly.
   * Otherwise screens quota families for eligible weekly reset windows or cold-starts.
   */
  async warmupAccount(
    account: ManagedAccount,
    options: { force?: boolean; model?: string } = {},
  ): Promise<WarmupResult[]> {
    const now = Date.now()

    if (!account.enabled) {
      return [skippedWarmupResult(account, options.model ?? 'default', 'Account is disabled')]
    }

    if (account.authRequired) {
      return [skippedWarmupResult(account, options.model ?? 'default', 'Account requires authentication')]
    }

    // Scheduled runs must never probe an account that is already rate-limited
    // or auth-quarantined; a manual/forced click may still override.
    if (!options.force && !shouldPollAccount(account)) {
      return [skippedWarmupResult(account, options.model ?? 'default', 'Account is in cooldown or auth quarantine')]
    }

    // 1. Explicit single model requested
    if (options.model) {
      return [await this.warmupExplicitModel(account, options.model, options.force === true, now)]
    }

    // 2. Scan weekly quota groups for reset triggers
    const plan = planWarmupTargets({
      account,
      force: options.force === true,
      configuredModels: this.config().warmupModels,
      now,
      isCoolingDown: (key, cooldownMs) => this.history.checkCooldown(key, cooldownMs, now),
    })
    if (plan.kind === 'skip') {
      return [skippedWarmupResult(account, plan.model, plan.reason, true)]
    }
    return this.runWarmupTargets(account, plan.targets, now)
  }

  /**
   * Warm up all accounts sequentially.
   */
  async warmupAllAccounts(options: { force?: boolean } = {}): Promise<WarmupResult[]> {
    const accounts = this.pool.getAccounts().filter((a) =>
      options.force ? a.enabled && !a.authRequired : shouldPollAccount(a),
    )
    const allResults: WarmupResult[] = []

    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i]!
      const res = await this.warmupAccount(acc, options)
      allResults.push(...res)

      if (i < accounts.length - 1) {
        await new Promise((r) => setTimeout(r, warmupDelayMs()))
      }
    }

    return allResults
  }

  /**
   * Scheduled periodic run: checks weekly quotas and triggers reset activation when due.
   */
  async runScheduledWarmup(): Promise<WarmupResult[]> {
    const cfg = this.config()
    if (!cfg.autoWarmup) {
      return []
    }
    return this.warmupAllAccounts({ force: false })
  }
}
