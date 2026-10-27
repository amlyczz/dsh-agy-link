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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from '../common/config.ts'
import type { FamilyQuotaInfo, ManagedAccount, ModelFamily } from '../common/pool-types.ts'
import type { PluginConfig } from '../common/types.ts'
import { agyFetch } from './net.ts'
import { AGY_ENDPOINTS } from './oauth.ts'
import type { AccountPoolManager } from './pool.ts'
import { QuotaService, agyUserAgent } from './quota.ts'

/** Canonical model route resolution for upstream Google Cloud Code PA endpoints. */
export function toCanonicalWarmupModel(model: string): string {
  const clean = model.trim().toLowerCase()
  // Bare gemini-3.8-flash / gemini-3-flash must be mapped to physical upstream entity
  // gemini-3.8-flash-tiered to avoid 404 "Requested entity was not found" (Antigravity-Manager #3715)
  if (clean === 'gemini-3.8-flash' || clean === 'gemini-3-flash') {
    return 'gemini-3.8-flash-tiered'
  }
  if (clean.includes('argon')) {
    return 'gemini-4-argon'
  }
  return model.trim()
}

/** Select target model for a given family honoring user monitored_models preferences. */
export function pickWarmupModelForFamily(
  family: ModelFamily,
  monitoredModels: readonly string[] = [],
): string {
  if (family === 'anthropic') {
    const found = monitoredModels.find((m) => m.toLowerCase().includes('claude'))
    return found ?? 'claude-sonnet-4-6'
  }
  if (family === 'openai') {
    const found = monitoredModels.find((m) => m.toLowerCase().includes('gpt'))
    return found ?? 'gpt-oss-120b-medium'
  }
  if (family === 'argon') {
    return 'gemini-4-argon'
  }
  // google / default
  const found = monitoredModels.find((m) => m.toLowerCase().includes('gemini') && !m.toLowerCase().includes('argon'))
  return found ?? 'gemini-3.8-flash'
}

export interface WarmupResult {
  accountId: string
  alias: string
  email?: string
  model: string
  success: boolean
  status?: number
  error?: string
  durationMs: number
  skipped?: boolean
  skipReason?: string
}

const SIX_DAYS_MS = 6 * 24 * 3600 * 1000
const FOUR_HOURS_MS = 4 * 3600 * 1000
const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000

/** Project ID resolver endpoints */
const LOAD_PROJECT_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist',
  'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
]

export class WarmupHistoryStore {
  private history = new Map<string, number>()
  private filePath: string

  constructor(filePath?: string) {
    this.filePath = filePath ?? join(stateDir(), 'warmup-history.json')
    this.load()
  }

  load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf8')
        const data = JSON.parse(raw) as Record<string, number>
        if (data && typeof data === 'object') {
          this.history = new Map(Object.entries(data))
        }
      }
    } catch {
      // best-effort load
    }
  }

  save(): void {
    try {
      this.pruneOldEntries()
      const obj = Object.fromEntries(this.history.entries())
      writeFileSync(this.filePath, JSON.stringify(obj, null, 2), 'utf8')
    } catch {
      // best-effort save
    }
  }

  checkCooldown(key: string, cooldownMs: number, now = Date.now()): boolean {
    const last = this.history.get(key)
    if (last === undefined) return false
    return now - last < cooldownMs
  }

  record(key: string, now = Date.now()): void {
    this.history.set(key, now)
    this.save()
  }

  pruneOldEntries(now = Date.now()): void {
    const cutoff = now - THIRTY_DAYS_MS
    for (const [k, ts] of this.history.entries()) {
      if (ts < cutoff) {
        this.history.delete(k)
      }
    }
  }

  clear(): void {
    this.history.clear()
    this.save()
  }
}

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
          },
          body: reqBody,
        }, proxyUrl)

        if (res.ok) {
          const data = (await res.json()) as { cloudaicompanionProject?: string }
          if (data?.cloudaicompanionProject) {
            return data.cloudaicompanionProject
          }
        }
      } catch {
        // try next endpoint
      }
    }
    return 'bamboo-precept-lgxtn'
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
    const mappedModel = toCanonicalWarmupModel(modelName)
    const isClaude = mappedModel.toLowerCase().includes('claude')
    const sessionId = `warmup_${Date.now()}_${randomBytes(4).toString('hex')}`

    const reqBody = JSON.stringify({
      project: projectId,
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
          maxOutputTokens: isClaude ? 1 : 10,
          ...(isClaude ? {} : { responseModalities: ['TEXT'] }),
        },
        sessionId,
      },
    })

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': agyUserAgent(this.agyVersion()),
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

  /**
   * Warm up one account.
   * If options.model is specified, warms up that model directly.
   * Otherwise screens quota families for eligible weekly reset windows or cold-starts.
   */
  async warmupAccount(
    account: ManagedAccount,
    options: { force?: boolean; model?: string } = {},
  ): Promise<WarmupResult[]> {
    const results: WarmupResult[] = []
    const identity = account.email || account.id
    const now = Date.now()

    if (!account.enabled) {
      return [{
        accountId: account.id,
        alias: account.alias,
        email: account.email,
        model: options.model ?? 'default',
        success: false,
        durationMs: 0,
        skipped: true,
        skipReason: 'Account is disabled',
      }]
    }

    if (account.authRequired) {
      return [{
        accountId: account.id,
        alias: account.alias,
        email: account.email,
        model: options.model ?? 'default',
        success: false,
        durationMs: 0,
        skipped: true,
        skipReason: 'Account requires authentication',
      }]
    }

    // 1. Explicit single model requested
    if (options.model) {
      const model = options.model
      const manualKey = `${identity}:${model}:100`
      if (!options.force && this.history.checkCooldown(manualKey, FOUR_HOURS_MS, now)) {
        return [{
          accountId: account.id,
          alias: account.alias,
          email: account.email,
          model,
          success: false,
          durationMs: 0,
          skipped: true,
          skipReason: 'Model in 4-hour warmup cooldown',
        }]
      }

      this.log(`[Warmup] pinging ${model} for account ${identity}...`)
      const res = await this.warmupModelDirectly(account, model)
      if (res.ok) {
        this.history.record(manualKey, now)
      }
      return [{
        accountId: account.id,
        alias: account.alias,
        email: account.email,
        model,
        success: res.ok,
        status: res.status,
        error: res.error,
        durationMs: res.durationMs,
      }]
    }

    // 2. Scan weekly quota groups for reset triggers
    const monitored = this.config().warmupModels ?? ['gemini-3.8-flash', 'claude-sonnet-4-6']
    const quotas = account.quotas ?? {}
    const families = Object.keys(quotas) as ModelFamily[]
    const modelsToPing: Array<{ family: ModelFamily; model: string; historyKey: string }> = []

    for (const fam of families) {
      const q: FamilyQuotaInfo | undefined = quotas[fam]
      if (!q) continue

      const weeklyFrac = q.weeklyFraction ?? 1.0
      // Only warm up when weekly quota is full (>= 99.9%)
      if (weeklyFrac < 0.999) continue

      let shouldWarm = false
      let historyKey = ''

      if (q.weeklyResetTime) {
        const resetTs = Date.parse(q.weeklyResetTime)
        if (!isNaN(resetTs)) {
          // Reached weekly reset instant (with 60s buffer)
          if (now >= resetTs - 60_000) {
            historyKey = `${identity}:${fam}:weekly:${resetTs}`
            shouldWarm = options.force || !this.history.checkCooldown(historyKey, SIX_DAYS_MS, now)
          }
        }
      } else {
        // Cold start: weekly reset time is uninitialized upstream
        historyKey = `${identity}:${fam}:weekly:initial`
        shouldWarm = options.force || !this.history.checkCooldown(historyKey, SIX_DAYS_MS, now)
      }

      if (shouldWarm) {
        const model = pickWarmupModelForFamily(fam, monitored)
        modelsToPing.push({ family: fam, model, historyKey })
      }
    }

    // Fallback if no weekly targets hit but user forced a warmup
    if (modelsToPing.length === 0 && options.force) {
      const fallbackModel = pickWarmupModelForFamily('google', monitored)
      modelsToPing.push({
        family: 'google',
        model: fallbackModel,
        historyKey: `${identity}:google:forced:${Math.floor(now / SIX_DAYS_MS)}`,
      })
    }

    if (modelsToPing.length === 0) {
      return [{
        accountId: account.id,
        alias: account.alias,
        email: account.email,
        model: 'none',
        success: true,
        durationMs: 0,
        skipped: true,
        skipReason: 'All weekly quota windows in cooldown or not yet due for reset',
      }]
    }

    for (let i = 0; i < modelsToPing.length; i++) {
      const target = modelsToPing[i]!
      this.log(`[Warmup] weekly warmup for ${target.model} @ ${identity} (${target.family})...`)
      const res = await this.warmupModelDirectly(account, target.model)
      if (res.ok) {
        this.history.record(target.historyKey, now)
        this.history.record(`${identity}:${target.model}:100`, now)
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

      if (i < modelsToPing.length - 1) {
        await new Promise((r) => setTimeout(r, 1500))
      }
    }

    return results
  }

  /**
   * Warm up all accounts sequentially.
   */
  async warmupAllAccounts(options: { force?: boolean } = {}): Promise<WarmupResult[]> {
    const accounts = this.pool.getAccounts().filter((a) => a.enabled && !a.authRequired)
    const allResults: WarmupResult[] = []

    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i]!
      const res = await this.warmupAccount(acc, options)
      allResults.push(...res)

      if (i < accounts.length - 1) {
        await new Promise((r) => setTimeout(r, 1500))
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
