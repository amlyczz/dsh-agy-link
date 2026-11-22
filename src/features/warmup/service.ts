// WarmupService: Smart 7-day weekly quota reset warmup via official `agy` CLI.
//
// RISK-CONTROL INVARIANT (First Priority — Anti-Ban):
// Warmup probes NEVER make direct Node.js (`undici`) HTTP calls to Google's
// internal inference endpoints, NEVER spoof headers, and NEVER send chimeric
// metadata. Every probe executes through the official `agy` Go binary in
// read-only `--mode plan` with genuine Go TLS fingerprints and isolated account
// environments (including Windows `acquireCredentialSlot` protection).
import { accountPollSuppressed, modelFamilyOf, type ManagedAccount } from '../../common/pool-types.ts'
import { isAccountCriticalAuth, isFamilyCooling } from '../../common/quota-bench.ts'
import type { PluginConfig } from '../../common/types.ts'
import type {
  WarmupAccountSummary,
  WarmupAuditEntry,
  WarmupLastRunSnapshot,
  WarmupStatusSnapshot,
} from '../../common/warmup-types.ts'
import { acquireCredentialSlot } from '../../host/credential-slot.ts'
import { StreamJsonParser } from '../../host/parser.ts'
import type { AccountPoolManager } from '../../host/pool.ts'
import type { QuotaService } from '../../host/quota.ts'
import { ensureIsolatedKeychain, probeProcess, resolveAgyBin } from '../../host/runner.ts'
import { supportsSshIsolation } from '../../runtime/agy/env.ts'
import { buildAgyEnv } from '../../runtime/net/account-env.ts'
import { WarmupHistoryStore } from './history.ts'
import {
  detectSlidingIdleReset,
  isDailyScheduleDue,
  isIntervalScheduleDue,
  type ResetObservation,
} from './schedule.ts'
import {
  FAILURE_BACKOFF_MS,
  FOUR_HOURS_MS,
  describeWarmupError,
  planWarmupTargets,
  skippedWarmupResult,
  toCliWarmupModel,
  warmupDelayMs,
  type WarmupResult,
  type WarmupTarget,
} from './policy.ts'

export interface CliProbeOutcome {
  code: number | null
  stdout: string
  stderr: string
  durationMs: number
}

export interface WarmupCliDeps {
  bin?: () => string | null
  runCliProbe?: (account: ManagedAccount, model: string) => Promise<CliProbeOutcome>
}

function summarizeWarmupRun(
  scope: 'all' | string,
  startedAt: number,
  results: readonly WarmupResult[],
): WarmupLastRunSnapshot {
  const byAccount = new Map<string, WarmupAccountSummary>()
  let succeeded = 0
  let skipped = 0
  let failed = 0
  for (const r of results) {
    let entry = byAccount.get(r.accountId)
    if (!entry) {
      entry = {
        accountId: r.accountId,
        alias: r.alias || r.email || r.accountId,
        probed: 0,
        succeeded: 0,
        skipped: 0,
        failed: 0,
      }
      byAccount.set(r.accountId, entry)
    }
    if (r.skipped) {
      entry.skipped += 1
      skipped += 1
    } else if (r.success) {
      entry.probed += 1
      entry.succeeded += 1
      succeeded += 1
    } else {
      entry.probed += 1
      entry.failed += 1
      failed += 1
      if (r.error) entry.lastError = r.error
    }
  }
  return {
    scope,
    startedAt,
    finishedAt: Date.now(),
    succeeded,
    skipped,
    failed,
    accounts: [...byAccount.values()],
  }
}

const MAX_RECENT_HISTORY = 50

export class WarmupService {
  readonly history: WarmupHistoryStore
  private activeScope: 'all' | string | null = null
  private activeAccountIds: string[] = []
  private currentAccountId: string | null = null
  private activeStartedAt: number | null = null
  private activeCompleted = 0
  private activeTotal = 0
  private lastRun: WarmupLastRunSnapshot | null = null
  private readonly recentHistory: WarmupAuditEntry[] = []
  private readonly resetObservations = new Map<string, ResetObservation>()
  private readonly slidingIdleKeys = new Set<string>()
  private lastDailyFiredKey: string | null = null
  private lastIntervalRunAt: number | null = null

  constructor(
    private readonly pool: AccountPoolManager,
    private readonly _quota?: QuotaService,
    private readonly globalProxy: () => string = () => '',
    private readonly _agyVersion: () => string | null = () => null,
    private readonly config: () => PluginConfig = () => ({} as PluginConfig),
    private readonly log: (msg: string) => void = () => undefined,
    historyStore?: WarmupHistoryStore,
    private readonly cliDeps: WarmupCliDeps = {},
  ) {
    void this._quota
    void this._agyVersion
    this.history = historyStore ?? new WarmupHistoryStore()
  }

  private resolveBin(): string | null {
    const injected = this.cliDeps.bin?.()
    if (injected) return injected
    return resolveAgyBin(this.config())
  }

  private async defaultRunCliProbe(account: ManagedAccount, model: string): Promise<CliProbeOutcome> {
    const bin = this.resolveBin()
    if (!bin) {
      return { code: 127, stdout: '', stderr: 'agy binary not found', durationMs: 0 }
    }
    const cfg = this.config()
    if (account.dir && !account.systemHome) {
      ensureIsolatedKeychain(account.dir)
    }
    const start = Date.now()
    let slotLease: Awaited<ReturnType<typeof acquireCredentialSlot>>
    const needsWinSlot =
      process.platform === 'win32'
      && process.env.NODE_TEST_CONTEXT === undefined
      && !(account.dir && !account.systemHome && supportsSshIsolation(this._agyVersion()))
    if (needsWinSlot) {
      try {
        slotLease = await acquireCredentialSlot(account, this.pool, {
          baseDir: this.pool.dir,
          proxyUrl: account.proxyUrl?.trim() || this.globalProxy() || undefined,
          dispatchTimeoutMs: 10_000,
          parallel: cfg.parallelSameAccount !== false,
          log: this.log,
        })
      } catch (e) {
        return {
          code: 1,
          stdout: '',
          stderr: `credential slot busy or unavailable: ${String(e)}`,
          durationMs: Date.now() - start,
        }
      }
    }
    try {
      const cliModel = toCliWarmupModel(model)
      const args = [
        '--output-format', 'stream-json',
        '--print-timeout', '1m',
        '--mode', 'plan',
        '--model', cliModel,
      ]
      if (cliModel.startsWith('gemini-') || cliModel.startsWith('claude-sonnet-5-5') || cliModel.startsWith('claude-opus-5-5')) {
        args.push('--effort', 'low')
      }
      args.push('-p', 'hi')
      const env = buildAgyEnv({
        account,
        cfg: {
          ...cfg,
          proxyUrl: cfg.proxyUrl || this.globalProxy() || '',
        },
        telemetryFlags: Boolean(cfg.disableTelemetry),
      })
      const out = await probeProcess(bin, args, 45_000, undefined, env, cfg.suppressAgyAutoUpdate)
      return {
        code: out.code,
        stdout: out.stdout,
        stderr: out.stderrTail,
        durationMs: Date.now() - start,
      }
    } finally {
      try {
        slotLease?.release()
      } catch {
        // best-effort
      }
    }
  }

  /**
   * Probe one model via the official `agy` CLI and classify terminal ToS /
   * validation responses safely without false `authRequired` flags.
   */
  async probeModel(
    account: ManagedAccount,
    modelName: string,
  ): Promise<{ ok: boolean; status?: number; error?: string; durationMs: number; terminal?: boolean }> {
    const cliModel = toCliWarmupModel(modelName)
    const runner = this.cliDeps.runCliProbe ?? ((acc, m) => this.defaultRunCliProbe(acc, m))
    let raw: CliProbeOutcome
    try {
      raw = await runner(account, cliModel)
    } catch (err) {
      return { ok: false, error: String(err), durationMs: 0 }
    }

    const parser = new StreamJsonParser()
    let responseText = ''
    for (const ev of [...parser.feed(raw.stdout + '\n'), ...parser.flush()]) {
      if (ev.kind === 'step' && ev.stepKind === 'text' && ev.text) responseText += ev.text + '\n'
      if (ev.kind === 'result' && ev.response) responseText += ev.response
    }

    const combinedText = [parser.stats.lastResultError ?? '', raw.stderr, responseText, raw.stdout].filter(Boolean).join('\n')
    const described = describeWarmupError(raw.code ?? 0, combinedText)
    if (described.terminal) {
      this.pool.markAuthRequired(account.id, described.error)
      this.log(`[agy-link] warmup: ${account.alias || account.id} hit terminal ToS restriction: ${described.error}`)
      return { ok: false, status: 403, error: described.error, durationMs: raw.durationMs, terminal: true }
    }

    if (/VALIDATION_REQUIRED|verify your account/i.test(combinedText)) {
      return { ok: false, status: 403, error: described.error, durationMs: raw.durationMs }
    }

    if (/no longer available|is not available|is retired/i.test(combinedText)) {
      return { ok: false, error: `Model is retired upstream: ${cliModel}`, durationMs: raw.durationMs }
    }

    if (raw.code === 0 && !parser.stats.lastResultError) {
      return { ok: true, status: 200, durationMs: raw.durationMs }
    }

    return {
      ok: false,
      error: (parser.stats.lastResultError || raw.stderr || 'agy warmup probe failed').trim().slice(0, 1000),
      durationMs: raw.durationMs,
    }
  }

  /** Explicit single-model request (manual trigger). Never marks authRequired on non-terminal errors. */
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

    this.log(`[Warmup] probing ${model} via agy CLI for account ${account.id}...`)
    const res = await this.probeModel(account, model)
    if (res.ok) {
      this.history.record(manualKey, now)
    } else {
      this.history.record(manualFailureKey, now)
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
      ...(res.terminal ? { terminal: true } : {}),
    }
  }

  private pushAudit(entry: WarmupAuditEntry): void {
    this.recentHistory.unshift(entry)
    if (this.recentHistory.length > MAX_RECENT_HISTORY) {
      this.recentHistory.length = MAX_RECENT_HISTORY
    }
  }

  /**
   * Observe an account's current quota reset timestamps so two consecutive
   * readings can detect Antigravity's sliding idle reset-time behavior.
   */
  observeAccountQuotas(account: ManagedAccount, now = Date.now()): ReadonlySet<string> {
    const identity = account.email || account.id
    const quotas = account.quotas ?? {}
    for (const [fam, q] of Object.entries(quotas)) {
      if (!q) continue
      if (q.weeklyResetTime && q.weeklyFraction !== undefined) {
        const key = `${identity}:${fam}:weekly`
        const curr: ResetObservation = { resetTimeIso: q.weeklyResetTime, observedAtMs: now, remainingFraction: q.weeklyFraction }
        if (detectSlidingIdleReset(this.resetObservations.get(key), curr)) {
          this.slidingIdleKeys.add(key)
        } else if (q.weeklyFraction < 0.999) {
          this.slidingIdleKeys.delete(key)
        }
        this.resetObservations.set(key, curr)
      }
      if (q.resetTime && q.remainingFraction !== undefined) {
        const key = `${identity}:${fam}:5h`
        const curr: ResetObservation = { resetTimeIso: q.resetTime, observedAtMs: now, remainingFraction: q.remainingFraction }
        if (detectSlidingIdleReset(this.resetObservations.get(key), curr)) {
          this.slidingIdleKeys.add(key)
        } else if (q.remainingFraction < 0.999) {
          this.slidingIdleKeys.delete(key)
        }
        this.resetObservations.set(key, curr)
      }
    }
    return this.slidingIdleKeys
  }

  /** Execute the planned weekly / 5h probes sequentially with a randomized gap. */
  private async runWarmupTargets(
    account: ManagedAccount,
    targets: readonly WarmupTarget[],
    now: number,
    trigger: WarmupAuditEntry['trigger'] = 'auto',
  ): Promise<WarmupResult[]> {
    const results: WarmupResult[] = []
    const identity = account.email || account.id

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!
      const win = target.window ?? 'weekly'
      this.log(`[Warmup] ${win} CLI warmup for ${target.model} @ ${account.id} (${target.family})...`)
      const res = await this.probeModel(account, target.model)
      if (res.ok) {
        this.history.record(target.historyKey, now)
        this.slidingIdleKeys.delete(target.historyKey)
        for (const extra of target.extraHistoryKeys ?? []) {
          this.history.record(extra, now)
          this.slidingIdleKeys.delete(extra)
        }
        this.history.record(`${identity}:${target.model}:100`, now)
      } else {
        this.history.record(target.failureKey, now)
      }
      this.pushAudit({
        timestamp: Date.now(),
        accountId: account.id,
        alias: account.alias || account.email || account.id,
        model: target.model,
        window: win,
        trigger: target.slidingIdle ? 'sliding-idle' : trigger,
        success: res.ok,
        durationMs: res.durationMs,
        ...(res.error ? { error: res.error } : {}),
      })
      results.push({
        accountId: account.id,
        alias: account.alias,
        email: account.email,
        model: target.model,
        success: res.ok,
        status: res.status,
        error: res.error,
        durationMs: res.durationMs,
        ...(res.terminal ? { terminal: true } : {}),
      })
      if (res.terminal) break
      if (i < targets.length - 1) {
        await new Promise((r) => setTimeout(r, warmupDelayMs()))
      }
    }

    return results
  }

  isRunning(): boolean {
    return this.activeScope !== null
  }

  status(): WarmupStatusSnapshot {
    return {
      running: this.activeScope !== null,
      scope: this.activeScope,
      activeAccountIds: [...this.activeAccountIds],
      currentAccountId: this.currentAccountId,
      startedAt: this.activeStartedAt,
      completed: this.activeCompleted,
      total: this.activeTotal,
      lastRun: this.lastRun
        ? { ...this.lastRun, accounts: this.lastRun.accounts.map((a) => ({ ...a })) }
        : null,
      recentHistory: this.recentHistory.map((e) => ({ ...e })),
    }
  }

  async warmupAccount(
    account: ManagedAccount,
    options: { force?: boolean; model?: string; ignoreFailureBackoff?: boolean; trigger?: WarmupAuditEntry['trigger']; now?: number } = {},
  ): Promise<WarmupResult[]> {
    const now = options.now ?? Date.now()
    const trigger: WarmupAuditEntry['trigger'] = options.trigger ?? (options.force ? 'manual' : 'auto')
    const trackStandalone = this.activeScope === null
    if (trackStandalone) {
      this.activeScope = account.id
      this.activeAccountIds = [account.id]
      this.currentAccountId = account.id
      this.activeStartedAt = now
      this.activeCompleted = 0
      this.activeTotal = 1
    }
    let results: WarmupResult[] = []
    try {
      if (!account.enabled) {
        results = [skippedWarmupResult(account, options.model ?? 'default', 'Account is disabled')]
        return results
      }
      if (isAccountCriticalAuth(account)) {
        results = [skippedWarmupResult(account, options.model ?? 'default', 'Account requires authentication')]
        return results
      }
      if (!options.force && accountPollSuppressed(account, now)) {
        results = [skippedWarmupResult(account, options.model ?? 'default', 'Account quota summary unavailable')]
        return results
      }
      if (options.model) {
        const fam = modelFamilyOf(options.model)
        if (!options.force && isFamilyCooling(account, fam, now)) {
          results = [skippedWarmupResult(account, options.model, `${fam} family is cooling down`)]
          return results
        }
        const single = await this.warmupExplicitModel(account, options.model, options.force === true, now)
        if (!single.skipped) {
          this.pushAudit({
            timestamp: Date.now(),
            accountId: account.id,
            alias: account.alias || account.email || account.id,
            model: single.model,
            window: 'manual',
            trigger,
            success: single.success,
            durationMs: single.durationMs,
            ...(single.error ? { error: single.error } : {}),
          })
        }
        results = [single]
        return results
      }

      this.observeAccountQuotas(account, now)
      const cfg = this.config()
      const plan = planWarmupTargets({
        account,
        force: options.force === true,
        ignoreFailureBackoff: options.ignoreFailureBackoff === true,
        configuredModels: cfg.warmupModels,
        windows: cfg.warmupWindows ?? 'weekly',
        slidingIdleKeys: this.slidingIdleKeys,
        now,
        isCoolingDown: (key, cooldownMs) => this.history.checkCooldown(key, cooldownMs, now),
      })
      if (plan.kind === 'skip') {
        results = [skippedWarmupResult(account, plan.model, plan.reason, true)]
        return results
      }
      results = await this.runWarmupTargets(account, plan.targets, now, trigger)
      return results
    } finally {
      if (trackStandalone) {
        this.activeCompleted = 1
        this.lastRun = summarizeWarmupRun(account.id, now, results)
        this.activeScope = null
        this.activeAccountIds = []
        this.currentAccountId = null
        this.activeStartedAt = null
        this.activeCompleted = 0
        this.activeTotal = 0
      }
    }
  }

  /**
   * Warm up all eligible accounts sequentially, halting immediately if any
   * account hits a terminal `TOS_VIOLATION` (ban-sweep circuit breaker).
   */
  async warmupAllAccounts(options: { force?: boolean; ignoreFailureBackoff?: boolean; trigger?: WarmupAuditEntry['trigger']; now?: number } = {}): Promise<WarmupResult[]> {
    const startedAt = options.now ?? Date.now()
    const accounts = this.pool.getAccounts().filter((a) =>
      a.enabled && !isAccountCriticalAuth(a) && (options.force || !accountPollSuppressed(a, startedAt)),
    )
    const allResults: WarmupResult[] = []

    this.activeScope = 'all'
    this.activeAccountIds = accounts.map((a) => a.id)
    this.currentAccountId = null
    this.activeStartedAt = startedAt
    this.activeCompleted = 0
    this.activeTotal = accounts.length

    try {
      for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i]!
        this.currentAccountId = acc.id
        const res = await this.warmupAccount(acc, options)
        allResults.push(...res)
        this.activeCompleted = i + 1
        if (res.some((r) => r.terminal === true)) {
          this.log('[agy-link] warmup: terminal TOS_VIOLATION detected — halting remaining pool warmup as sweep protection')
          break
        }
        // Only pace between accounts when at least one CLI probe actually ran.
        if (i < accounts.length - 1 && res.some((r) => !r.skipped)) {
          await new Promise((r) => setTimeout(r, warmupDelayMs()))
        }
      }
      return allResults
    } finally {
      this.lastRun = summarizeWarmupRun('all', startedAt, allResults)
      this.activeScope = null
      this.activeAccountIds = []
      this.currentAccountId = null
      this.activeStartedAt = null
      this.activeCompleted = 0
      this.activeTotal = 0
    }
  }

  async runScheduledWarmup(now = Date.now()): Promise<WarmupResult[]> {
    const cfg = this.config()
    if (!cfg.autoWarmup) return []
    const dailyTime = (cfg.warmupDailyTime ?? '').trim()
    const intervalHours = cfg.warmupIntervalHours ?? 0
    if (dailyTime !== '' || intervalHours > 0) {
      const daily = dailyTime !== ''
        ? isDailyScheduleDue({
            dailyTime,
            timezone: cfg.warmupTimezone ?? '',
            now,
            lastFiredDayKey: this.lastDailyFiredKey,
          })
        : { due: false, dayKey: '' }
      const intervalDue = isIntervalScheduleDue({
        intervalHours,
        now,
        lastRunAt: this.lastIntervalRunAt,
      })
      if (!daily.due && !intervalDue) {
        // Still observe quotas on scheduled ticks so sliding-idle detection stays current.
        for (const acc of this.pool.getAccounts()) this.observeAccountQuotas(acc, now)
        return []
      }
      const trigger: WarmupAuditEntry['trigger'] = daily.due ? 'daily' : 'interval'
      if (daily.due && daily.dayKey !== '') this.lastDailyFiredKey = daily.dayKey
      if (intervalDue) this.lastIntervalRunAt = now
      return this.warmupAllAccounts({ force: false, trigger, now })
    }
    return this.warmupAllAccounts({ force: false, trigger: 'auto', now })
  }
}
