// I/O orchestration for a single account's quota refresh: REST fetch fan-out,
// CLI-usage fallback, credential/slot ordering and pool mutations. All network
// calls, token resolution and pool side effects are injected; the returned
// family rows come from the pure parsers in src/domain/quota/parse.ts.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { FamilyQuotaInfo, ManagedAccount, ModelFamily } from '../../common/pool-types.ts'
import { shouldReleaseOrphanedCooldown, summaryHasArgonGroup } from '../../domain/quota/buckets.ts'
import {
  buildFamilyQuotas,
  buildModelsCatalog,
  type DiscoveredModelsResponse,
  type QuotaSummaryResponse,
  type UserQuotaResponse,
} from '../../domain/quota/parse.ts'

/** A durable primary credential record (mirrors credential-slot.PrimaryCredential). */
interface PrimaryCredentialLike {
  raw: string
  email?: string
  savedAt: number
}

/** The subset of AccountPoolManager the refresh pipeline mutates. */
export interface QuotaRefreshPool {
  readonly dir: string
  getAccounts(): readonly ManagedAccount[]
  markAuthRequired(id: string, reason?: string): void
  clearAuthRequired(id: string): void
  noteDedicatedGroup(id: string, family: ModelFamily): void
  forgetDedicatedGroup(id: string, family: ModelFamily): void
  clearQuotaFamily(id: string, family: ModelFamily): void
  clearCooldown(id?: string, family?: ModelFamily, includeQuotaBench?: boolean): void
  hasDedicatedGroup(id: string, family: ModelFamily): boolean
  resetAccountIdentity(id: string, email: string): void
  updateAccountQuotas(id: string, quotas: Partial<Record<ModelFamily, FamilyQuotaInfo>>, email?: string): void
}

/**
 * Every I/O seam the pipeline needs. QuotaService supplies these by closing
 * over its own (subclass-overridable) methods, so test doubles that override
 * fetchQuotaSummary/fetchAvailableModels/fetchUserQuota/getValidAccessToken
 * keep working unchanged.
 */
export interface QuotaRefreshDeps {
  pool: QuotaRefreshPool
  shouldUseCli(): boolean
  readCliUsageFamilies(account: ManagedAccount): Promise<Partial<Record<ModelFamily, FamilyQuotaInfo>> | null>
  getValidAccessToken(account: ManagedAccount): Promise<string | null>
  proxyFor(account: ManagedAccount): string | undefined
  fetchUserInfo(token: string, proxyUrl?: string): Promise<{ email?: string; name?: string } | null>
  fetchQuotaSummary(token: string, proxyUrl?: string): Promise<QuotaSummaryResponse | null>
  fetchAvailableModels(token: string, proxyUrl?: string): Promise<DiscoveredModelsResponse | null>
  fetchUserQuota(token: string, proxyUrl?: string): Promise<UserQuotaResponse | null>
  getTokenFilePath(account: ManagedAccount): string
  detectEmailFromLogs(home: string): string | undefined
  readPrimaryCredential(baseDir: string): PrimaryCredentialLike | null
  writePrimaryCredential(cred: PrimaryCredentialLike, baseDir: string): boolean
  credentialFingerprint(raw: string | null | undefined): string | null
}

/**
 * Fetch and aggregate live quota statistics (both 5-hour limit and weekly limit)
 * for a single account across model families.
 * Includes 10s cache throttle to avoid spamming Google APIs on fast clicks.
 */
export async function refreshAccountQuotaPipeline(
  deps: QuotaRefreshDeps,
  account: ManagedAccount,
  force = false,
): Promise<Partial<Record<ModelFamily, FamilyQuotaInfo>> | null> {
  const now = Date.now()
  if (!force && account.quotas) {
    const latestUpdate = Math.max(
      ...Object.values(account.quotas).map((q) => q?.updatedAt ?? 0),
    )
    if (latestUpdate > 0 && now - latestUpdate < 10_000) {
      return account.quotas
    }
  }
  const home = account.systemHome || !account.dir ? homedir() : account.dir

  // An isolated pool account must never carry the SAME OAuth grant as the
  // primary. When it does, its login was overwritten by the shared Windows
  // credential slot, and every number fetched under this row would actually
  // belong to the primary. Quarantine the slot instead of displaying — and
  // failing over onto — someone else's quota. Deterministic and offline.
  if (account.dir && process.platform === 'win32') {
    const stored = deps.readPrimaryCredential(deps.pool.dir)
    const file = deps.getTokenFilePath(account)
    const own = existsSync(file) ? readFileSync(file, 'utf8') : null
    const ownFingerprint = own ? deps.credentialFingerprint(own) : null
    if (
      stored &&
      ownFingerprint !== null &&
      ownFingerprint === deps.credentialFingerprint(stored.raw)
    ) {
      deps.pool.markAuthRequired(
        account.id,
        "stored credential is the primary account's — this login was overwritten, sign in again",
      )
      return null
    }
  }

  let email = account.email
  // On Windows, the primary account rides the durable store (.primary-credential.json)
  // whose identity is verified directly against Google. That verified identity
  // wins over stale account labels and never relies on ambiguous log scraping.
  if ((account.systemHome || !account.dir) && process.platform === 'win32') {
    const stored = deps.readPrimaryCredential(deps.pool.dir)
    if (stored?.email) {
      email = stored.email
    }
  }

  // Only inspect logs when the email is completely missing. Never adopt a
  // sibling account's email: log scraping can pick up secondary account runs
  // that temporarily executed under the same profile.
  if (!email) {
    const detected = deps.detectEmailFromLogs(home)
    const siblingEmails = new Set(
      deps.pool
        .getAccounts()
        .filter((a) => a.id !== account.id && a.email)
        .map((a) => a.email!),
    )
    if (detected && !siblingEmails.has(detected)) {
      email = detected
    }
  }

  // 1. CLI-FIRST PATH (Anti-Risk Control):
  // When CLI is available and enabled (default), run official `agy -p /usage`.
  // 100% official Google binary, real Go TLS fingerprint, native token refresh by agy Go runtime.
  // Zero Node.js REST calls to Google's internal APIs.
  if (deps.shouldUseCli()) {
    const cliFamilies = await deps.readCliUsageFamilies(account)
    if (cliFamilies !== null && Object.keys(cliFamilies).length > 0) {
      if (account.authRequired) {
        deps.pool.clearAuthRequired(account.id)
      }
      if (cliFamilies.argon) {
        deps.pool.noteDedicatedGroup(account.id, 'argon')
      } else {
        deps.pool.clearQuotaFamily(account.id, 'argon')
        deps.pool.forgetDedicatedGroup(account.id, 'argon')
        deps.pool.clearCooldown(account.id, 'argon')
      }
      deps.pool.updateAccountQuotas(account.id, cliFamilies, email)
      return cliFamilies
    }
  }

  const accessToken = await deps.getValidAccessToken(account)
  if (!accessToken) {
    return null
  }

  // Manual refresh (刷新/同步): the TOKEN is the only authoritative identity
  // anchor. Log scraping lies — observed live: the slot was labeled
  // q98…@gmail.com while the stored token actually belonged to
  // elegantmanco@…, so every manual click fetched and displayed the WRONG
  // account's quota under the primary's name. One userinfo call per
  // explicit user click re-anchors the identity; background polls keep
  // the zero-network log-scan path below.
  if (force) {
    const info = await deps.fetchUserInfo(accessToken, deps.proxyFor(account))
    if (info?.email) {
      email = info.email
      if ((account.systemHome || !account.dir) && process.platform === 'win32') {
        const stored = deps.readPrimaryCredential(deps.pool.dir)
        if (stored && stored.email !== info.email) {
          deps.writePrimaryCredential({ ...stored, email: info.email, savedAt: Date.now() }, deps.pool.dir)
        }
      }
    }
  }

  // External re-login: the slot now hosts a DIFFERENT Google account.
  // Identity-bound state (cooldowns / quotas / auth quarantine) belongs to
  // the previous email and must be reset before anything else — otherwise
  // the new account inherits the old one's restrictions (and poll gating
  // would keep the slot quarantined forever after an invalid_grant).
  if (email && email !== account.email) {
    // An ISOLATED pool account's identity is fixed by the credential the user
    // signed in with. If the resolved email matches ANOTHER slot's email,
    // this account's token file was overwritten by that account (the
    // documented Windows slot-corruption failure) — quarantine it instead of
    // relabeling, which is how one corrupted token made every row report the
    // same identity and spend the same quota.
    const collisionsWithSibling =
      Boolean(account.dir) &&
      deps.pool.getAccounts().some(
        (other) =>
          other.id !== account.id &&
          other.email !== undefined &&
          other.email === email &&
          other.dir !== account.dir,
      )
    if (collisionsWithSibling) {
      deps.pool.markAuthRequired(
        account.id,
        `stored credential belongs to ${email} (another account's login) — sign in again`,
      )
      return null
    }
    deps.pool.resetAccountIdentity(account.id, email)
  }

  const [summary, discovered, userQuota] = await Promise.all([
    deps.fetchQuotaSummary(accessToken, deps.proxyFor(account)),
    deps.fetchAvailableModels(accessToken, deps.proxyFor(account)),
    deps.fetchUserQuota(accessToken, deps.proxyFor(account)).catch(() => null),
  ])

  // Query the userinfo endpoint ONLY when the email is still unknown.
  // Account switching on systemHome accounts is already caught locally by
  // detectEmailFromAgyLogs (no network); calling userinfo every poll cycle
  // was pure risk-control exposure for a value that never changes.
  if (!email) {
    const info = await deps.fetchUserInfo(accessToken, deps.proxyFor(account))
    if (info?.email) email = info.email
  }

  const modelsCatalog = buildModelsCatalog(discovered, userQuota)

  if (!summary && Object.keys(modelsCatalog).length === 0) {
    return null
  }

  // Authenticated backend calls just succeeded with this token: any stale
  // authRequired flag (e.g. set while the OLD account was logging out) is
  // disproven — clear it so the slot rejoins selection and polling.
  if (account.authRequired) {
    deps.pool.clearAuthRequired(account.id)
  }

  const { familyQuotas, summaryGroups } = buildFamilyQuotas({
    summary,
    modelsCatalog,
    prevQuotas: account.quotas,
    now,
  })

  // Track whether this account reports a dedicated Argon bucket, so a retired one
  // can be told apart from one that never existed (see shouldReleaseOrphanedCooldown).
  if (summaryGroups.length > 0) {
    const argonGroupPresent = summaryHasArgonGroup(summaryGroups)
    if (argonGroupPresent) {
      deps.pool.noteDedicatedGroup(account.id, 'argon')
    } else {
      // The backend stopped reporting a dedicated Argon group. A synthesized
      // `argon` row may still exist because the model-level fallback projects
      // the shared Gemini bucket onto it — that row is NOT evidence that the
      // group is present. Checking `familyQuotas.argon` here made this branch
      // unreachable in exactly the Pro -> Ultra fold it was written for, so a
      // cooldown taken against the retired pool was never released.
      const groupSeenBefore = deps.pool.hasDedicatedGroup(account.id, 'argon')
      if (familyQuotas.argon === undefined) {
        deps.pool.clearQuotaFamily(account.id, 'argon')
      }
      if (shouldReleaseOrphanedCooldown({
        summaryAuthoritative: true,
        groupPresent: false,
        groupSeenBefore,
        hasCooldown: account.cooldowns?.argon !== undefined,
      })) {
        deps.pool.clearCooldown(account.id, 'argon')
      }
      deps.pool.forgetDedicatedGroup(account.id, 'argon')
    }
  }

  deps.pool.updateAccountQuotas(account.id, familyQuotas, email)
  return familyQuotas
}
