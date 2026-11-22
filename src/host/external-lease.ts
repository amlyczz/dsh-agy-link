// External credential leases: let a process outside this plugin (for example a
// runner that launches the official `agy` itself) take part in the Windows
// credential-slot coordination.
//
// WHY: on Windows every agy process reads ONE machine-wide credential
// (`gemini:antigravity`). This plugin serializes that slot for its own runs,
// but the fast-path counters and refcounts live in this process's memory, so an
// external agy run is invisible to it: the plugin may swap the slot under it,
// and the external caller can never run as a pool secondary. A lease reuses the
// SAME pieces the plugin's own runs use — `pool.selectAccount`,
// `acquireCredentialSlot` and the shared failure settlement — so an external
// run is just one more slot holder. No switching logic lives here.
//
// An isolated account on agy >= 1.5 never touches the slot, exactly like the
// provider/ACP/warmup/quota paths: `SSH_CONNECTION` (in `isolatedHomeEnv`)
// makes agy read the account's own token file, so the lease only prepares that
// file and hands the caller the env. The primary account, and isolated accounts
// on older agy, take the slot.
//
// Leases are in memory only: a host restart drops them (the slot itself is
// restored by the normal boot hygiene) and clients re-acquire.
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeFileAtomicSync } from '../common/atomic-write.ts'
import type { PluginConfig } from '../common/types.ts'
import { modelFamilyOf, type ManagedAccount, type ModelFamily } from '../common/pool-types.ts'
import type { AccountPoolManager } from './pool.ts'
import {
  AbortedWaitError,
  SlotUnavailableError,
  WaitTimeoutError,
  acquireCredentialSlot,
  type SlotLease,
} from './credential-slot.ts'
import { detectSystemProxy } from './wincred.ts'
import { ensureIsolatedKeychain } from './runner.ts'
import {
  ensureLoopbackNoProxy,
  foldProxyEnvCase,
  isolatedHomeEnv,
  proxyEnvFor,
  supportsSshIsolation,
  withAgyQuietEnv,
} from '../runtime/agy/env.ts'
import { settleRunFailure, settleSlotUnavailable } from './run-settlement.ts'

export const LEASE_DEFAULT_TTL_MS = 120_000
export const LEASE_MIN_TTL_MS = 15_000
export const LEASE_MAX_TTL_MS = 600_000
/** Upper bound for a requested slot wait (the configured default may be longer). */
export const LEASE_MAX_WAIT_MS = 3_600_000
export const LEASE_SWEEP_INTERVAL_MS = 5_000
export const LEASE_MAX_HOLDER_LEN = 200
export const LEASE_MAX_ERROR_BYTES = 8 * 1024
export const LINK_ENDPOINT_FILE = '.link-endpoint.json'

export type LeaseOutcome = 'success' | 'quota' | 'tos' | 'model_unsupported' | 'eligibility' | 'auth' | 'other' | 'none'

export interface LeaseAcquireRequest {
  holder: string
  model?: string
  accountId?: string
  accountDir?: string
  ttlMs?: number
  waitMs?: number
}

export interface LeaseAccountView {
  id: string
  email: string
  alias: string
  primary: boolean
  isolated: boolean
  home: string
  proxyUrl: string
}

export interface LeaseGrant {
  ok: true
  leaseId: string
  ttlMs: number
  expiresAt: number
  /** True when this lease holds the Windows credential slot. */
  slot: boolean
  /** Exactly the variables the caller sets on its agy process (never the host's own env). */
  env: Record<string, string>
  account: LeaseAccountView
}

export interface LeaseFailure {
  ok: false
  status: number
  code: string
  error: string
  retryAfterMs?: number
}

export interface LeaseReleaseRequest {
  ok?: boolean
  error?: string
  model?: string
}

export interface LeaseSummary {
  leaseId: string
  holder: string
  accountId: string
  email: string
  acquiredAt: number
  expiresAt: number
  slot: boolean
}

type AcquireSlotFn = typeof acquireCredentialSlot

export interface LeaseRegistryDeps {
  pool: AccountPoolManager
  getConfig: () => PluginConfig
  log: (msg: string) => void
  /** The agy version, probed when not known yet (decides SSH isolation). */
  agyVersion: () => Promise<string | null>
  /** Bring an isolated account's own token file into the CLI safety window (QuotaService). */
  prepareIsolatedToken: (account: ManagedAccount) => Promise<boolean>
  /** Test seam; defaults to the real `acquireCredentialSlot`. */
  acquireSlot?: AcquireSlotFn
  now?: () => number
}

interface LeaseEntry {
  leaseId: string
  holder: string
  account: ManagedAccount
  model: string | undefined
  ttlMs: number
  acquiredAt: number
  expiresAt: number
  slot: SlotLease | undefined
}

// Same guard as the provider and the one-shot runner: a test run must never
// engage the real Windows Credential Manager.
const defaultAcquireSlot: AcquireSlotFn = (account, pool, options) =>
  process.env.NODE_TEST_CONTEXT !== undefined ? Promise.resolve(undefined) : acquireCredentialSlot(account, pool, options)

/** Make a client-supplied label safe for one log line. */
export function sanitizeHolder(holder: string): string {
  // JSON escaping keeps CR/LF and other control characters from forging log lines.
  return JSON.stringify(holder)
}

export function clampLeaseTtl(ttlMs: number | undefined): number {
  if (ttlMs === undefined) return LEASE_DEFAULT_TTL_MS
  return Math.min(LEASE_MAX_TTL_MS, Math.max(LEASE_MIN_TTL_MS, Math.round(ttlMs)))
}

/** The slot wait an acquire uses when the caller did not pass one: what one-shot runs use. */
export function defaultLeaseWaitMs(cfg: PluginConfig): number {
  return cfg.dispatchTimeoutMinutes > 0 ? cfg.dispatchTimeoutMinutes * 60_000 : 60_000
}

function samePath(a: string, b: string): boolean {
  const na = resolve(a)
  const nb = resolve(b)
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb
}

function isPrimary(account: ManagedAccount): boolean {
  return Boolean(account.systemHome) || !account.dir
}

/** HOME the plugin's own runs give this account: the host profile for the primary, else its isolated dir. */
function leaseHome(account: ManagedAccount): string {
  return isPrimary(account) ? homedir() : account.dir
}

/**
 * The agy env for one leased account, from the same helpers the provider uses:
 * isolated HOME (+ SSH_CONNECTION), proxy (case-folded on Windows), loopback
 * NO_PROXY and the quiet/headless switches. Nothing from the host's env.
 */
export function leaseAgyEnv(account: ManagedAccount, proxyUrl: string, platform: string = process.platform): Record<string, string> {
  const env: NodeJS.ProcessEnv = isPrimary(account) ? {} : { ...isolatedHomeEnv(account.dir) }
  Object.assign(env, proxyEnvFor(proxyUrl))
  ensureLoopbackNoProxy(env)
  foldProxyEnvCase(env, platform)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(withAgyQuietEnv(env))) if (typeof v === 'string') out[k] = v
  return out
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  // A cut mid code point decodes to U+FFFD; drop it.
  return buf.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/, '')
}

export class ExternalLeaseRegistry {
  private readonly leases = new Map<string, LeaseEntry>()
  private readonly acquireSlot: AcquireSlotFn
  private readonly now: () => number
  private readonly abort = new AbortController()
  private readonly sweeper: ReturnType<typeof setInterval>
  private disposed = false

  constructor(private readonly deps: LeaseRegistryDeps) {
    this.acquireSlot = deps.acquireSlot ?? defaultAcquireSlot
    this.now = deps.now ?? Date.now
    this.sweeper = setInterval(() => this.sweep(), LEASE_SWEEP_INTERVAL_MS)
    this.sweeper.unref?.()
  }

  async acquire(req: LeaseAcquireRequest): Promise<LeaseGrant | LeaseFailure> {
    if (this.disposed) return fail(503, 'shutting_down', 'the lease service is shutting down')
    const { pool } = this.deps
    const cfg = this.deps.getConfig()
    const model = req.model?.trim() || undefined
    const family = modelFamilyOf(model ?? 'gemini')
    const ttlMs = clampLeaseTtl(req.ttlMs)
    const deadline = this.now() + Math.min(LEASE_MAX_WAIT_MS, req.waitMs ?? defaultLeaseWaitMs(cfg))
    const opts = { holder: req.holder, model, family, ttlMs, deadline }

    const pinId = req.accountId?.trim()
    const pinDir = req.accountDir?.trim()
    if (pinId || pinDir) {
      const account = pinId
        ? pool.getAccount(pinId)
        : pool.getAccounts().find((a) => samePath(leaseHome(a), pinDir!))
      if (!account) return fail(404, 'account_not_found', 'no pool account matches ' + (pinId ? 'accountId' : 'accountDir'))
      if (!account.enabled || account.authRequired) {
        return fail(409, 'account_unavailable', 'account ' + account.id + ' is ' + (account.enabled ? 'waiting for re-login' : 'disabled'))
      }
      const taken = await this.take(account, opts)
      if (taken.kind === 'unavailable') return fail(409, 'account_unavailable', taken.error)
      return taken.result
    }

    const tried = new Set<string>()
    let lastError = ''
    for (;;) {
      const account = pool.selectAccount(family, model)
      if (!account || tried.has(account.id)) break
      tried.add(account.id)
      const taken = await this.take(account, opts)
      if (taken.kind === 'done') return taken.result
      lastError = taken.error
    }
    const retryAfterMs = pool.getEarliestResetCountdown(family)
    return {
      ...fail(503, 'no_account', lastError || 'no Antigravity account is currently selectable for ' + family),
      ...(retryAfterMs !== null && retryAfterMs > 0 ? { retryAfterMs } : {}),
    }
  }

  renew(leaseId: string, ttlMs?: number): { ok: true; expiresAt: number } | LeaseFailure {
    const entry = this.leases.get(leaseId)
    if (!entry) return notFound()
    if (entry.expiresAt <= this.now()) {
      this.drop(entry, 'expired before renew')
      return notFound()
    }
    if (ttlMs !== undefined) entry.ttlMs = clampLeaseTtl(ttlMs)
    entry.expiresAt = this.now() + entry.ttlMs
    return { ok: true, expiresAt: entry.expiresAt }
  }

  /** Release the slot exactly once, then settle the pool with the run's result. */
  release(leaseId: string, report: LeaseReleaseRequest = {}): { ok: true; outcome: LeaseOutcome } | LeaseFailure {
    const entry = this.leases.get(leaseId)
    if (!entry) return notFound()
    this.drop(entry)
    return { ok: true, outcome: this.settle(entry, report) }
  }

  list(): LeaseSummary[] {
    return [...this.leases.values()].map((e) => ({
      leaseId: e.leaseId,
      holder: e.holder,
      accountId: e.account.id,
      email: e.account.email ?? '',
      acquiredAt: e.acquiredAt,
      expiresAt: e.expiresAt,
      slot: e.slot !== undefined,
    }))
  }

  /** Release every expired lease without settling (the holder never reported). */
  sweep(): number {
    const now = this.now()
    let n = 0
    for (const entry of [...this.leases.values()]) {
      if (entry.expiresAt > now) continue
      this.drop(entry, 'expired')
      n++
    }
    return n
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.sweeper)
    this.abort.abort()
    for (const entry of [...this.leases.values()]) this.drop(entry, 'plugin disposed')
  }

  private async take(
    account: ManagedAccount,
    opts: { holder: string; model: string | undefined; family: ModelFamily; ttlMs: number; deadline: number },
  ): Promise<{ kind: 'done'; result: LeaseGrant | LeaseFailure } | { kind: 'unavailable'; error: string }> {
    const { pool, log } = this.deps
    const cfg = this.deps.getConfig()
    const waitMs = opts.deadline - this.now()
    if (waitMs <= 0) return { kind: 'done', result: fail(504, 'slot_timeout', 'timed out waiting for the agy credential slot') }
    const proxyUrl = account.proxyUrl || cfg.proxyUrl || detectSystemProxy() || ''
    // Resolve the version before deciding; an unknown version keeps the slot (safe on every agy).
    const sshIsolated = !isPrimary(account) && supportsSshIsolation(await this.deps.agyVersion().catch(() => null))
    let slot: SlotLease | undefined
    if (sshIsolated) {
      // Same prep as the CLI quota read: agy started with a dying token falls back to interactive OAuth.
      // A failed prep leaves the pool untouched, as it does there.
      const ready = await this.deps.prepareIsolatedToken(account).catch(() => false)
      if (!ready) return { kind: 'unavailable', error: 'account ' + account.id + ': its token could not be refreshed into the CLI safety window' }
    } else {
      try {
        slot = await this.acquireSlot(account, pool, {
          baseDir: pool.dir,
          ...(proxyUrl !== '' ? { proxyUrl } : {}),
          log,
          signal: this.abort.signal,
          dispatchTimeoutMs: waitMs,
          parallel: cfg.parallelSameAccount,
          respectExternalSignIn: cfg.respectExternalSignIn,
        })
      } catch (e) {
        if (e instanceof SlotUnavailableError) {
          settleSlotUnavailable(pool, account, opts.family, opts.model, e)
          return { kind: 'unavailable', error: e.message }
        }
        if (e instanceof WaitTimeoutError) {
          return { kind: 'done', result: fail(504, 'slot_timeout', 'timed out waiting for the agy credential slot') }
        }
        if (e instanceof AbortedWaitError) return { kind: 'done', result: fail(503, 'shutting_down', 'the lease service is shutting down') }
        // e.g. the primary identity could not be verified over the network: retryable, account untouched.
        return { kind: 'done', result: fail(502, 'slot_error', e instanceof Error ? e.message : String(e)) }
      }
    }
    if (this.disposed) {
      slot?.release()
      return { kind: 'done', result: fail(503, 'shutting_down', 'the lease service is shutting down') }
    }
    if (account.dir) ensureIsolatedKeychain(account.dir)
    const acquiredAt = this.now()
    const entry: LeaseEntry = {
      leaseId: randomBytes(16).toString('hex'),
      holder: opts.holder,
      account,
      model: opts.model,
      ttlMs: opts.ttlMs,
      acquiredAt,
      expiresAt: acquiredAt + opts.ttlMs,
      slot,
    }
    this.leases.set(entry.leaseId, entry)
    log(`[agy-link] external lease ${entry.leaseId.slice(0, 8)} granted to ${sanitizeHolder(opts.holder)} on account ${account.id}${slot ? ' (slot)' : ''}`)
    return {
      kind: 'done',
      result: {
        ok: true,
        leaseId: entry.leaseId,
        ttlMs: entry.ttlMs,
        expiresAt: entry.expiresAt,
        slot: slot !== undefined,
        env: leaseAgyEnv(account, proxyUrl),
        account: {
          id: account.id,
          email: account.email ?? '',
          alias: account.alias,
          primary: isPrimary(account),
          isolated: !isPrimary(account),
          home: leaseHome(account),
          proxyUrl,
        },
      },
    }
  }

  private drop(entry: LeaseEntry, reason?: string): void {
    if (!this.leases.delete(entry.leaseId)) return
    try {
      entry.slot?.release()
    } finally {
      if (reason !== undefined) {
        this.deps.log(`[agy-link] external lease ${entry.leaseId.slice(0, 8)} of ${sanitizeHolder(entry.holder)} released: ${reason}`)
      }
    }
  }

  private settle(entry: LeaseEntry, report: LeaseReleaseRequest): LeaseOutcome {
    if (report.ok === undefined) return 'none'
    const { pool } = this.deps
    const model = report.model?.trim() || entry.model
    const family = modelFamilyOf(model ?? 'gemini')
    if (report.ok) {
      pool.recordSuccess(entry.account.id, family)
      return 'success'
    }
    const error = truncateUtf8(report.error ?? '', LEASE_MAX_ERROR_BYTES).trim()
    const failure = settleRunFailure(pool, entry.account, family, model, {
      rawErr: error,
      resultText: '',
      resultOk: false,
      ...(error !== '' ? { resultError: error } : {}),
      text: '',
    })
    switch (failure?.kind) {
      case 'tos':
      case 'quota':
      case 'model_unsupported':
      case 'eligibility':
      case 'auth':
        return failure.kind
      default:
        return 'other'
    }
  }
}

function fail(status: number, code: string, error: string): LeaseFailure {
  return { ok: false, status, code, error }
}

function notFound(): LeaseFailure {
  return fail(404, 'lease_not_found', 'unknown or expired lease')
}

// ---- discovery file ---------------------------------------------------------

export interface LinkEndpoint {
  url: string
  pid: number
  startedAt: number
}

export function linkEndpointPath(poolDir: string): string {
  return join(poolDir, LINK_ENDPOINT_FILE)
}

/** Publish where external callers reach the lease API (atomic replace). */
export function writeLinkEndpoint(poolDir: string, port: number, now = Date.now()): LinkEndpoint {
  const endpoint: LinkEndpoint = { url: `http://127.0.0.1:${port}/plugins/agy-link`, pid: process.pid, startedAt: now }
  writeFileAtomicSync(linkEndpointPath(poolDir), JSON.stringify(endpoint) + '\n')
  return endpoint
}

/** Remove the discovery file only if it still names this process and url (another host may own it now). */
export function removeLinkEndpoint(poolDir: string, endpoint: LinkEndpoint): boolean {
  const file = linkEndpointPath(poolDir)
  try {
    if (!existsSync(file)) return false
    const current = JSON.parse(readFileSync(file, 'utf8')) as Partial<LinkEndpoint>
    if (current.pid !== endpoint.pid || current.url !== endpoint.url) return false
    rmSync(file, { force: true })
    return true
  } catch {
    return false
  }
}
