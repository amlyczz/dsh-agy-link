// One warmup probe: run the official `agy` CLI and classify the answer.
//
// Split out of service.ts (that file is the orchestration: who to probe, when,
// how many) so the risk-control details of a single invocation have one home:
// which account env it runs in, whether `--effort` may be passed, and which
// failures are terminal (`TOS_VIOLATION`) versus merely retryable.
//
// Hard invariant (see .spec/quota-and-risk-control.md): probes go through the
// official binary only — never a Node HTTP call, never a spoofed header.
import type { ManagedAccount } from '../../common/pool-types.ts'
import type { PluginConfig } from '../../common/types.ts'
import { acquireCredentialSlot } from '../../host/credential-slot.ts'
import { StreamJsonParser } from '../../host/parser.ts'
import type { AccountPoolManager } from '../../host/pool.ts'
import { ensureIsolatedKeychain, probeProcess, resolveAgyBin } from '../../host/runner.ts'
import { parseEffortUnsupported, sameModelId } from '../../provider/effort-policy.ts'
import { supportsSshIsolation } from '../../runtime/agy/env.ts'
import { buildAgyEnv } from '../../runtime/net/account-env.ts'
import { describeWarmupError, isModelUnavailableError, toCliWarmupModel } from './policy.ts'

export interface CliProbeOutcome {
  code: number | null
  stdout: string
  stderr: string
  durationMs: number
}

export interface WarmupProbeOptions {
  /** Pass `--effort low`. Cleared for models agy refuses, so it can be retried. */
  effort?: boolean
}

export interface WarmupCliDeps {
  bin?: () => string | null
  runCliProbe?: (account: ManagedAccount, model: string, options?: WarmupProbeOptions) => Promise<CliProbeOutcome>
  /** Models agy refused `--effort` for (learned by the interactive path). */
  effortUnsupported?: () => readonly string[]
  /** Record a fresh `--effort` refusal so later runs skip it up front. */
  onEffortUnsupported?: (model: string) => void
  /** Sleep hook (tests inject a no-op; production uses a real timer). */
  sleep?: (ms: number) => Promise<void>
}

export interface WarmupProbeResult {
  ok: boolean
  status?: number
  error?: string
  durationMs: number
  terminal?: boolean
}

/** Everything one probe needs from the host, injected so tests stay offline. */
export interface WarmupProbeContext {
  pool: AccountPoolManager
  cfg: () => PluginConfig
  proxy: () => string
  agyVersion: () => string | null
  log: (msg: string) => void
  bin?: () => string | null
}

/**
 * Families whose CLI accepts `--effort`. Claude/GPT expose effort through the
 * model slug (`claude-sonnet-5-5-low`), not the flag, so they must be probed
 * without it; the learned refusal list covers any future surprise.
 */
export function supportsProbeEffort(cliModel: string): boolean {
  return cliModel.startsWith('gemini-')
}

function resolveBin(ctx: WarmupProbeContext): string | null {
  const injected = ctx.bin?.()
  if (injected) return injected
  return resolveAgyBin(ctx.cfg())
}

function classifyProbe(account: ManagedAccount, ctx: WarmupProbeContext, cliModel: string, raw: CliProbeOutcome): WarmupProbeResult {
  const parser = new StreamJsonParser()
  let responseText = ''
  let resultTotalTokens: number | undefined
  for (const ev of [...parser.feed(raw.stdout + '\n'), ...parser.flush()]) {
    if (ev.kind === 'step' && ev.stepKind === 'text' && ev.text) responseText += ev.text + '\n'
    if (ev.kind === 'result' && ev.response) responseText += ev.response
    if (ev.kind === 'result' && typeof ev.usage?.total_tokens === 'number') resultTotalTokens = ev.usage.total_tokens
  }

  const combinedText = [parser.stats.lastResultError ?? '', raw.stderr, responseText, raw.stdout].filter(Boolean).join('\n')
  const described = describeWarmupError(raw.code ?? 0, combinedText)
  if (described.terminal) {
    ctx.pool.markAuthRequired(account.id, described.error)
    ctx.log(`[agy-link] warmup: ${account.alias || account.id} hit terminal ToS restriction: ${described.error}`)
    return { ok: false, status: 403, error: described.error, durationMs: raw.durationMs, terminal: true }
  }

  if (/VALIDATION_REQUIRED|verify your account/i.test(combinedText)) {
    return { ok: false, status: 403, error: described.error, durationMs: raw.durationMs }
  }

  if (isModelUnavailableError(combinedText)) {
    return { ok: false, error: `Model is retired upstream: ${cliModel}`, durationMs: raw.durationMs }
  }

  if (raw.code === 0 && !parser.stats.lastResultError) {
    // A turn that spent zero tokens never reached the model, so the quota
    // window did not start. Reporting it as success hid the failure behind the
    // long success cooldown (and lied to a user who clicked "warm up").
    if (resultTotalTokens === 0) {
      return { ok: false, error: 'Warmup probe reached no model (0 tokens used); quota window not activated', durationMs: raw.durationMs }
    }
    return { ok: true, status: 200, durationMs: raw.durationMs }
  }

  return {
    ok: false,
    error: (parser.stats.lastResultError || raw.stderr || 'agy warmup probe failed').trim().slice(0, 1000),
    durationMs: raw.durationMs,
  }
}

async function runDefaultCliProbe(
  ctx: WarmupProbeContext,
  account: ManagedAccount,
  model: string,
  options: WarmupProbeOptions = {},
): Promise<CliProbeOutcome> {
  const bin = resolveBin(ctx)
  if (!bin) {
    return { code: 127, stdout: '', stderr: 'agy binary not found', durationMs: 0 }
  }
  const cfg = ctx.cfg()
  if (account.dir && !account.systemHome) {
    ensureIsolatedKeychain(account.dir)
  }
  const start = Date.now()
  let slotLease: Awaited<ReturnType<typeof acquireCredentialSlot>>
  const needsWinSlot =
    process.platform === 'win32'
    && process.env.NODE_TEST_CONTEXT === undefined
    && !(account.dir && !account.systemHome && supportsSshIsolation(ctx.agyVersion()))
  if (needsWinSlot) {
    try {
      slotLease = await acquireCredentialSlot(account, ctx.pool, {
        baseDir: ctx.pool.dir,
        proxyUrl: account.proxyUrl?.trim() || ctx.proxy() || undefined,
        dispatchTimeoutMs: 10_000,
        parallel: cfg.parallelSameAccount !== false,
        log: ctx.log,
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
    // `--effort` is per-model, not per-family: agy 1.5.15 rejects it outright
    // for claude-sonnet-5-5 ("--effort is not supported for model …"), and the
    // probe used to append it unconditionally, so every Anthropic warmup failed
    // locally and the weekly window was never activated. The caller decides
    // (learned-refusal list + one retry); this only obeys.
    if (options.effort !== false && supportsProbeEffort(cliModel)) {
      args.push('--effort', 'low')
    }
    args.push('-p', 'hi')
    const env = buildAgyEnv({
      account,
      cfg: {
        ...cfg,
        proxyUrl: cfg.proxyUrl || ctx.proxy() || '',
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
 * Probe one model via the official `agy` CLI.
 *
 * `--effort` is only attached when the model accepts it AND the learned refusal
 * list has no record of it; a fresh refusal is learned here and retried once
 * without the flag, because agy rejects the WHOLE invocation for that argument
 * and a warmup that never learns would fail for the family forever.
 */
export async function runWarmupProbe(
  ctx: WarmupProbeContext,
  deps: WarmupCliDeps,
  account: ManagedAccount,
  modelName: string,
): Promise<WarmupProbeResult> {
  const cliModel = toCliWarmupModel(modelName)
  const runner = deps.runCliProbe ?? ((acc, m, o) => runDefaultCliProbe(ctx, acc, m, o))
  const learned = deps.effortUnsupported?.() ?? []
  const wantEffort = supportsProbeEffort(cliModel) && !learned.some((m) => m !== '' && sameModelId(m, cliModel))
  let raw: CliProbeOutcome
  try {
    raw = await runner(account, cliModel, { effort: wantEffort })
    if (wantEffort) {
      const refused = parseEffortUnsupported([raw.stdout, raw.stderr].join('\n'))
      if (refused !== null) {
        deps.onEffortUnsupported?.(refused)
        ctx.log(`[Warmup] ${refused} refuses --effort; retrying without it`)
        raw = await runner(account, cliModel, { effort: false })
      }
    }
  } catch (err) {
    return { ok: false, error: String(err), durationMs: 0 }
  }
  return classifyProbe(account, ctx, cliModel, raw)
}
