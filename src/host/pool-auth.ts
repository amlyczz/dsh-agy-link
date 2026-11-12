// PoolAuthFlow: self-owned Google OAuth lifecycle for adding pool accounts.
//
// Replaces the old "spawn agy -p ping and scrape a login URL" probe, which
// silently broke when agy >= 1.1.15 stopped printing auth URLs in print
// mode (the probe then timed out and the route reported success anyway —
// the UI claimed "browser opened" while nothing ever happened).
//
// Flow: create staging slot -> PKCE authorize URL -> loopback callback
// listener + server-side browser open -> automatic code capture ->
// exchange -> write agy-format token file into the staging HOME -> verify
// via fetchAvailableModels/userinfo -> commit into the pool. Manual code
// (or redirect URL) paste is the fallback when the listener cannot bind.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserEmail,
  generatePkce,
  openBrowser,
  parsePastedCode,
  refreshTokens,
  startCallbackListener,
  writeAgyTokenFile,
  type CallbackHandle,
} from './oauth.ts'
import type { ManagedAccount } from '../common/pool-types.ts'
import type { AccountPoolManager } from './pool.ts'
import type { QuotaService } from './quota.ts'
import { detectSystemProxy, writeWindowsCredentialRaw } from './wincred.ts'
import { writePrimaryCredential } from './credential-slot.ts'
import { extractRefreshToken, saveCredentialBackup } from './credential-backup.ts'

export type PoolAuthPhase = 'idle' | 'waiting' | 'exchanging' | 'done' | 'failed'
export type PoolAuthStatusCode =
  | 'browser_manual'
  | 'callback_failed'
  | 'no_active_flow'
  | 'invalid_code'
  | 'invalid_state'
  | 'exchange_failed'
  | 'identity_mismatch'
  | 'identity_unverified'
  | 'primary_activated'
  | 'account_activated'
  | 'missing_code'
  | 'request_failed'

export interface PoolAuthStatus {
  phase: PoolAuthPhase
  stagingId?: string
  alias?: string
  url?: string
  /** 'auto' = loopback listener live; 'manual' = paste the code/URL back. */
  mode?: 'auto' | 'manual'
  browserOpened?: boolean
  /** Stable, locale-neutral user-facing state. Raw diagnostic details never leave the host. */
  code?: PoolAuthStatusCode
}

interface ActiveFlow {
  stagingId: string
  dir: string
  alias?: string
  proxyUrl?: string
  verifier: string
  state: string
  url: string
  mode: 'auto' | 'manual'
  listener: CallbackHandle | null
  /** Primary/system-HOME login: no staging slot, writes to the real HOME. */
  primary?: boolean
  accountId?: string
}

const DONE_STATUS_TTL_MS = 30_000

export interface PoolAuthFlowDeps {
  /** Injectable for tests; defaults to the OS browser open. */
  openBrowser?: (url: string) => Promise<boolean>
  exchangeCode?: typeof exchangeCode
  fetchUserEmail?: typeof fetchUserEmail
  refreshTokens?: typeof refreshTokens
  onUpdate?: () => void
}

export class PoolAuthFlow {
  private flow: ActiveFlow | null = null
  private statusValue: PoolAuthStatus = { phase: 'idle' }
  private doneResetTimer: NodeJS.Timeout | null = null
  private readonly open: (url: string) => Promise<boolean>
  private readonly exchange: typeof exchangeCode
  private readonly userEmail: typeof fetchUserEmail
  private readonly refresh: typeof refreshTokens
  private readonly onUpdate?: () => void

  constructor(
    private readonly pool: AccountPoolManager,
    private readonly quota: QuotaService,
    private readonly log: (msg: string) => void = () => {},
    deps: PoolAuthFlowDeps = {},
  ) {
    this.open = deps.openBrowser ?? openBrowser
    this.exchange = deps.exchangeCode ?? exchangeCode
    this.userEmail = deps.fetchUserEmail ?? fetchUserEmail
    this.refresh = deps.refreshTokens ?? refreshTokens
    this.onUpdate = deps.onUpdate
  }

  status(): PoolAuthStatus {
    return { ...this.statusValue }
  }

  private setStatus(patch: Partial<PoolAuthStatus> & { phase: PoolAuthPhase }): void {
    if (this.doneResetTimer) {
      clearTimeout(this.doneResetTimer)
      this.doneResetTimer = null
    }
    this.statusValue = { ...this.statusValue, ...patch }
    if (patch.phase === 'done') {
      // Hold the success state briefly so pollers see it, then reset.
      this.doneResetTimer = setTimeout(() => {
        if (this.statusValue.phase === 'done') this.statusValue = { phase: 'idle' }
      }, DONE_STATUS_TTL_MS)
      this.doneResetTimer.unref?.()
    }
  }

  /**
   * Shared starter: PKCE + loopback listener + server-side browser open.
   * Never reports success without a URL; bind failure degrades to manual
   * paste mode instead of pretending the browser opened.
   */
  private async startFlow(flow: Omit<ActiveFlow, 'verifier' | 'state' | 'url' | 'mode' | 'listener'>): Promise<PoolAuthStatus & { ok: boolean; dir?: string }> {
    await this.abortActive()

    const { verifier, challenge } = generatePkce()
    const state = randomBytes(16).toString('base64url')
    const url = buildAuthorizeUrl(challenge, state)

    // startCallbackListener signals bind errors by rejecting `result`;
    // give the listener one tick to bind before declaring auto mode.
    let listener: CallbackHandle | null = startCallbackListener()
    let bindFailed = false
    await Promise.race([
      listener.result.then(
        () => {},
        () => {
          bindFailed = true
        },
      ),
      new Promise((resolve) => setTimeout(resolve, 300)),
    ])
    if (bindFailed) {
      await listener.close().catch(() => undefined)
      listener = null
    }
    const mode: 'auto' | 'manual' = listener ? 'auto' : 'manual'

    const browserOpened = await this.open(url)

    const active: ActiveFlow = { ...flow, verifier, state, url, mode, listener }
    this.flow = active
    this.setStatus({
      phase: 'waiting',
      stagingId: active.stagingId,
      alias: active.alias,
      url,
      mode,
      browserOpened,
      code: browserOpened ? undefined : 'browser_manual',
    })
    this.log(`pool auth begun (${mode} mode, browserOpened=${browserOpened}${active.primary ? ', primary' : ''})`)

    if (listener) {
      void listener.result
        .then(({ code, state: returnedState }) => this.finishWithCode(code, returnedState, active))
        .catch((err: unknown) => {
          if (!this.flow || this.flow.listener !== listener) return
          this.fail('callback_failed', err)
        })
    }

    return { ok: true, ...this.statusValue, dir: active.dir }
  }

  /** Begin adding a pool account (isolated staging HOME). */
  async begin(alias?: string, proxyUrl?: string): Promise<PoolAuthStatus & { ok: boolean; dir?: string }> {
    const staging = this.pool.createStagingSlot()
    return this.startFlow({ stagingId: staging.id, dir: staging.dir, alias, proxyUrl: proxyUrl || detectSystemProxy() })
  }

  /**
   * Begin logging in the PRIMARY account (system HOME, no staging slot):
   * same browser flow, tokens land in ~/.gemini so the real agy stays signed in.
   */
  async beginPrimary(proxyUrl?: string): Promise<PoolAuthStatus & { ok: boolean; dir?: string }> {
    const { homedir } = await import('node:os')
    return this.startFlow({ stagingId: 'acc_primary', dir: homedir(), primary: true, proxyUrl: proxyUrl || detectSystemProxy() })
  }

  /** Reauthenticate an existing isolated account without replacing its pool entry. */
  async beginAccount(accountId: string, proxyUrl?: string): Promise<PoolAuthStatus & { ok: boolean; dir?: string }> {
    const account = this.pool.getAccount(accountId)
    if (!account || !account.dir || account.systemHome) {
      return { ok: false, phase: 'failed', code: 'request_failed' }
    }
    const staging = this.pool.createStagingSlot()
    return this.startFlow({
      stagingId: staging.id, dir: staging.dir, accountId, alias: account.alias,
      proxyUrl: account.proxyUrl || proxyUrl || detectSystemProxy(),
    })
  }

  /**
   * Import an account using an existing refresh_token or OAuth token JSON document.
   * If an account with matching email exists, its credential file is updated in place
   * and any authRequired flag / cooldowns are cleared.
   * If it is a new account, a staging slot is committed to pool.json.
   */
  async importRefreshToken(
    tokenInput: string,
    alias?: string,
    proxyUrl?: string,
  ): Promise<{
    ok: boolean
    account?: ManagedAccount
    isNew?: boolean
    email?: string
    error?: string
    code?: PoolAuthStatusCode
  }> {
    const refreshToken = extractRefreshToken(tokenInput)
    if (!refreshToken) {
      return { ok: false, error: 'Invalid refresh token or token JSON format', code: 'invalid_code' }
    }
    await this.abortActive()
    this.setStatus({ phase: 'exchanging' })
    try {
      const tokens = await this.refresh(refreshToken, proxyUrl)
      if (!tokens?.access_token) {
        this.fail('exchange_failed', new Error('Token endpoint did not return an access token'))
        return { ok: false, error: 'Failed to exchange refresh token', code: 'exchange_failed' }
      }
      const email = await this.userEmail(tokens.access_token, proxyUrl)
      const normalizedEmail = email?.toLowerCase()

      const existing = normalizedEmail
        ? this.pool.getAccounts().find((a) => a.email?.toLowerCase() === normalizedEmail)
        : undefined

      if (existing) {
        if (existing.dir && !existing.systemHome) {
          const stagedFile = writeAgyTokenFile(existing.dir, tokens)
          saveCredentialBackup(stagedFile)
        } else if (process.platform === 'win32') {
          try {
            const docStr = JSON.stringify({
              token: {
                access_token: tokens.access_token,
                token_type: tokens.token_type ?? 'Bearer',
                refresh_token: tokens.refresh_token,
              },
              auth_method: 'consumer',
            })
            writeWindowsCredentialRaw(docStr, 'gemini:antigravity')
            writePrimaryCredential({ raw: docStr, email, savedAt: Date.now() })
          } catch {
            // best effort
          }
        }
        if (alias?.trim()) {
          this.pool.setAccountAlias(existing.id, alias.trim())
        }
        if (proxyUrl?.trim()) {
          this.pool.setAccountProxy(existing.id, proxyUrl.trim())
        }
        this.pool.clearAuthRequired(existing.id)
        this.pool.clearCooldown(existing.id, undefined, true)
        this.pool.updateAccountQuotas(existing.id, existing.quotas ?? {}, email)
        void this.quota.refreshAccountQuota(existing).catch(() => undefined)
        this.log(`imported refresh token for existing account ${existing.id}${email ? ` <${email}>` : ''}`)
        this.setStatus({ phase: 'done', alias: existing.alias || email, code: 'account_activated' })
        this.onUpdate?.()
        return { ok: true, account: existing, isNew: false, email }
      }

      // New account: create staging slot -> write token -> commit
      const staging = this.pool.createStagingSlot()
      writeAgyTokenFile(staging.dir, tokens)
      const targetAcc = this.pool.commitStagingAccount(staging.id, staging.dir, alias, email, proxyUrl)
      const accountFile = join(targetAcc.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
      saveCredentialBackup(accountFile)
      void this.quota.refreshAccountQuota(targetAcc).catch(() => undefined)
      this.log(`imported refresh token as new account ${targetAcc.id}${email ? ` <${email}>` : ''}`)
      this.setStatus({ phase: 'done', alias: targetAcc.alias || email, code: 'account_activated' })
      this.onUpdate?.()
      return { ok: true, account: targetAcc, isNew: true, email }
    } catch (err) {
      this.fail('exchange_failed', err)
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'exchange_failed',
      }
    }
  }

  /** Manual paste fallback: accepts a bare code or the full redirect URL. */
  async submitCode(input: string): Promise<PoolAuthStatus & { ok: boolean }> {
    const flow = this.flow
    if (!flow || this.statusValue.phase !== 'waiting') {
      return { ok: false, phase: this.statusValue.phase, code: 'no_active_flow' }
    }
    const parsed = parsePastedCode(input)
    if (!parsed) {
      return { ok: false, phase: 'waiting', code: 'invalid_code' }
    }
    if (parsed.state && parsed.state !== flow.state) {
      return { ok: false, phase: 'waiting', code: 'invalid_state' }
    }
    await this.finishWithCode(parsed.code, parsed.state ?? flow.state, flow)
    const after = this.status()
    return { ...after, ok: after.phase === 'done' }
  }

  /**
   * Settle the ACTIVE flow with an authorization code.
   *
   * `owner` names the flow the code belongs to. Without it, a STALE flow's
   * late callback (its `exchangeCode` still in flight while the user cancelled
   * and began flow B) settled against `this.flow` — flow B — and either killed
   * the new flow with `invalid_state` (deleting B's staging dir) or, worse,
   * wrote flow A's token file into the freshly cleaned A dir and committed a
   * ghost account. The identity check makes a stale settlement a no-op.
   */
  private async finishWithCode(code: string, returnedState: string, owner?: ActiveFlow): Promise<void> {
    const flow = this.flow
    if (!flow || this.statusValue.phase !== 'waiting') return
    if (owner !== undefined && owner !== flow) return
    if (returnedState !== flow.state) {
      this.fail('invalid_state')
      return
    }
    this.setStatus({ phase: 'exchanging' })
    try {
      const tokens = await this.exchange(code, flow.verifier, flow.proxyUrl)
      if (this.flow !== flow) return
      if (flow.accountId) {
        const email = await this.userEmail(tokens.access_token, flow.proxyUrl)
        if (this.flow !== flow) return
        const account = this.pool.getAccount(flow.accountId)
        if (!account || !account.dir || account.systemHome || !email || !tokens.refresh_token) {
          this.fail('identity_unverified')
          return
        }
        const normalized = email.toLowerCase()
        if ((account.email && account.email.toLowerCase() !== normalized) ||
            this.pool.getAccounts().some((other) => other.id !== account.id && other.email?.toLowerCase() === normalized)) {
          this.fail('identity_mismatch')
          return
        }
        const stagedFile = writeAgyTokenFile(flow.dir, tokens)
        const targetDir = join(account.dir, '.gemini', 'antigravity-cli')
        mkdirSync(targetDir, { recursive: true })
        const targetFile = join(targetDir, 'antigravity-oauth-token')
        renameSync(stagedFile, targetFile)
        saveCredentialBackup(targetFile)
        this.pool.updateAccountQuotas(account.id, {}, email)
        this.pool.clearAuthRequired(account.id)
        this.pool.cleanupStagingSlot(flow.dir)
        void this.quota.refreshAccountQuota(account).catch(() => undefined)
        this.flow = null
        if (flow.listener) void flow.listener.close().catch(() => undefined)
        this.setStatus({ phase: 'done', alias: account.alias, code: 'account_activated' })
        return
      }
      const tokenFile = writeAgyTokenFile(flow.dir, tokens)
      if (flow.primary && process.platform === 'win32') {
        try {
          const raw = readFileSync(tokenFile, 'utf8')
          writeWindowsCredentialRaw(raw, 'gemini:antigravity')
        } catch {
          // best-effort
        }
      }
      const email = await this.userEmail(tokens.access_token, flow.proxyUrl)
      if (flow.primary && process.platform === 'win32') {
        try {
          // Record the freshly verified primary credential so every later slot
          // handoff restores THIS login instead of "whatever the slot held".
          const raw = readFileSync(tokenFile, 'utf8')
          writePrimaryCredential({ raw, email, savedAt: Date.now() })
        } catch {
          // best-effort
        }
      }
      if (flow.primary) {
        // System-HOME login: update the primary account in place, never
        // stage/commit and NEVER delete the real home directory.
        const primary =
          this.pool.getAccount('acc_primary') ??
          this.pool.getAccounts().find((a) => a.systemHome) ??
          this.pool.getAccounts()[0]
        if (primary) {
          if (flow.proxyUrl && !primary.proxyUrl) {
            this.pool.setAccountProxy(primary.id, flow.proxyUrl)
          }
          this.pool.updateAccountQuotas(primary.id, primary.quotas, email)
          void this.quota.refreshAccountQuota(primary).catch(() => undefined)
        }
        this.log(`primary account signed in${email ? ` <${email}>` : ''}`)
        this.flow = null
        if (flow.listener) void flow.listener.close().catch(() => undefined)
        this.setStatus({ phase: 'done', alias: email, code: 'primary_activated' })
        return
      }
      const acc = this.pool.commitStagingAccount(flow.stagingId, flow.dir, flow.alias, email, flow.proxyUrl)
      const accountFile = join(acc.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
      saveCredentialBackup(accountFile)
      this.log(`pool auth committed account ${acc.id}${email ? ` <${email}>` : ''}`)
      // Quota refresh is best-effort; the account is usable regardless.
      void this.quota.refreshAccountQuota(acc).catch(() => undefined)
      this.flow = null
      if (flow.listener) void flow.listener.close().catch(() => undefined)
      this.setStatus({ phase: 'done', alias: acc.alias, code: 'account_activated' })
    } catch (err) {
      if (this.flow === flow) this.fail('exchange_failed', err)
    }
  }

  private fail(code: PoolAuthStatusCode, detail?: unknown): void {
    const flow = this.flow
    // The existing host diagnostic sink may retain raw failure detail; never
    // return it through the customer-facing HTTP/status contract.
    this.log(`pool auth failed [${code}]${detail ? `: ${detail instanceof Error ? detail.message : String(detail)}` : ''}`)
    if (flow) {
      if (flow.listener) void flow.listener.close().catch(() => undefined)
      // Never delete the real HOME of a primary login attempt.
      if (!flow.primary) this.pool.cleanupStagingSlot(flow.dir)
      this.flow = null
    }
    this.setStatus({ phase: 'failed', code })
  }

  async cancel(): Promise<PoolAuthStatus & { ok: boolean }> {
    await this.abortActive()
    this.setStatus({ phase: 'idle' })
    return { ok: true, phase: 'idle' }
  }

  private async abortActive(): Promise<void> {
    const flow = this.flow
    if (!flow) return
    this.flow = null
    if (flow.listener) await flow.listener.close().catch(() => undefined)
    if (!flow.primary) this.pool.cleanupStagingSlot(flow.dir)
  }
}
