// WarmupService: Smart 7-day weekly quota reset warmup via official `agy` CLI.
//
// RISK-CONTROL INVARIANT (First Priority — Anti-Ban):
// Warmup probes NEVER make direct Node.js (`undici`) HTTP calls to Google's
// internal inference endpoints, NEVER spoof headers, and NEVER send chimeric
// metadata. Every probe executes through the official `agy` Go binary in
// read-only `--mode plan` with genuine Go TLS fingerprints and isolated account
// environments (including Windows `acquireCredentialSlot` protection).
import { shouldPollAccount, type ManagedAccount } from '../../common/pool-types.ts'
import type { PluginConfig } from '../../common/types.ts'
import { acquireCredentialSlot } from '../../host/credential-slot.ts'
import { StreamJsonParser } from '../../host/parser.ts'
import type { AccountPoolManager } from '../../host/pool.ts'
import type { QuotaService } from '../../host/quota.ts'
import { ensureIsolatedKeychain, probeProcess, resolveAgyBin } from '../../host/runner.ts'
import { buildAgyEnv } from '../../runtime/net/account-env.ts'
import { WarmupHistoryStore } from './history.ts'
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

export class WarmupService {
  readonly history: WarmupHistoryStore

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
    if (process.platform === 'win32' && process.env.NODE_TEST_CONTEXT === undefined) {
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
      this.log(`[Warmup] weekly CLI warmup for ${target.model} @ ${account.id} (${target.family})...`)
      const res = await this.probeModel(account, target.model)
      if (res.ok) {
        this.history.record(target.historyKey, now)
        this.history.record(`${identity}:${target.model}:100`, now)
      } else {
        this.history.record(target.failureKey, now)
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
        ...(res.terminal ? { terminal: true } : {}),
      })
      if (res.terminal) break
      if (i < targets.length - 1) {
        await new Promise((r) => setTimeout(r, warmupDelayMs()))
      }
    }

    return results
  }

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
    if (!options.force && !shouldPollAccount(account)) {
      return [skippedWarmupResult(account, options.model ?? 'default', 'Account is in cooldown or auth quarantine')]
    }
    if (options.model) {
      return [await this.warmupExplicitModel(account, options.model, options.force === true, now)]
    }

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
   * Warm up all eligible accounts sequentially, halting immediately if any
   * account hits a terminal `TOS_VIOLATION` (ban-sweep circuit breaker).
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
      if (res.some((r) => r.terminal === true)) {
        this.log('[agy-link] warmup: terminal TOS_VIOLATION detected — halting remaining pool warmup as sweep protection')
        break
      }
      if (i < accounts.length - 1) {
        await new Promise((r) => setTimeout(r, warmupDelayMs()))
      }
    }

    return allResults
  }

  async runScheduledWarmup(): Promise<WarmupResult[]> {
    if (!this.config().autoWarmup) return []
    return this.warmupAllAccounts({ force: false })
  }
}
