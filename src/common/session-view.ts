// Session-scoped account + quota readout for the conversation header badge.
//
// WHY this exists: account selection is PER MODEL FAMILY. An `Gemini 4 Argon`
// turn runs on the Argon-eligible account even when the `google` pointer still
// names a different account, and Argon bills against its OWN weekly quota book.
// The header badge used to resolve `google` unconditionally, so an Argon session
// displayed another account's alias together with that account's *Gemini*
// percentage — contradicting both the model shown in the composer and the
// console's Argon row (reported 2026-11-23). Everything here derives from the
// same pointers the scheduler uses, so all three surfaces tell one story:
//
//   session model -> family -> sticky session account -> per-family pin -> the
//   side-effect-free `resolvedActiveAccountIds` prediction.
//
// `source` keeps prediction distinct from reality: only a sticky session
// binding or an actual per-family pin may be presented as "in use".
import {
  argonSharesGoogleGroup,
  modelFamilyOf,
  type AccountPoolData,
  type ManagedAccount,
  type ModelFamily,
} from './pool-types.ts'
import { isFamilyCooling, QUOTA_FAMILIES, type QuotaFamily } from './quota-bench.ts'

/** How the reported account was established. */
export type SessionViewSource =
  /** This session (or a real per-family pin) actually uses that account. */
  | 'session'
  /** Nobody has run this family yet: the scheduler's predicted pick. */
  | 'predicted'
  /** The model family has no eligible account right now. */
  | 'none'

/** Which quota window the percentage belongs to. */
export type SessionQuotaWindow = 'five-hour' | 'weekly' | 'none'

export interface SessionView {
  model: string
  family: ModelFamily | null
  accountId: string | null
  alias: string
  email: string
  /** The alias is the synthesized default (no explicit label was set). */
  defaultAlias: boolean
  /** The alias means "the machine-wide primary credential slot". */
  systemHome: boolean
  source: SessionViewSource
  /** Remaining fraction of the FAMILY's own quota book, as a whole percent. */
  percent: number | null
  window: SessionQuotaWindow
  /** The displayed window's reset boundary has already passed (data is old). */
  stale: boolean
  cooling: boolean
  eligible: boolean
}

export const EMPTY_SESSION_VIEW: SessionView = {
  model: '',
  family: null,
  accountId: null,
  alias: '',
  email: '',
  defaultAlias: false,
  systemHome: false,
  source: 'none',
  percent: null,
  window: 'none',
  stale: false,
  cooling: false,
  eligible: false,
}

function asQuotaFamily(family: ModelFamily): QuotaFamily | null {
  return (QUOTA_FAMILIES as readonly string[]).includes(family) ? (family as QuotaFamily) : null
}

function fraction(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v * 100))) : null
}

/**
 * The reading a family's OWN quota book reports.
 *
 * Argon is weekly-only wherever the backend does not report a 5-hour window, so
 * its badge number must come from `weeklyFraction`; falling back to
 * `remainingFraction` there would print an empty or borrowed slot. Gemini,
 * Claude and GPT-OSS prefer their 5-hour window and degrade to weekly only when
 * that window is absent.
 */
function familyReading(acc: ManagedAccount | undefined, family: QuotaFamily, now: number): {
  percent: number | null
  window: SessionQuotaWindow
  stale: boolean
  resetAt: string | undefined
} {
  const dedicatedArgon = family === 'argon' && acc?.quotas?.argon !== undefined
  const info = acc?.quotas?.[family] ?? (family === 'argon' && argonSharesGoogleGroup(acc) ? acc?.quotas?.google : undefined)
  if (!info) return { percent: null, window: 'none', stale: false, resetAt: undefined }
  const five = fraction(info.remainingFraction)
  const weekly = fraction(info.weeklyFraction)
  const staleOf = (resetAt: string | undefined, pct: number | null): boolean => {
    if (pct === null || pct >= 100 || resetAt === undefined) return false
    const at = Date.parse(resetAt)
    return Number.isFinite(at) && at <= now
  }
  if (dedicatedArgon) {
    return { percent: weekly, window: weekly !== null ? 'weekly' : 'none', stale: staleOf(info.weeklyResetTime, weekly), resetAt: info.weeklyResetTime }
  }
  if (five !== null) {
    return { percent: five, window: 'five-hour', stale: staleOf(info.resetTime, five), resetAt: info.resetTime }
  }
  return { percent: weekly, window: weekly !== null ? 'weekly' : 'none', stale: staleOf(info.weeklyResetTime, weekly), resetAt: info.weeklyResetTime }
}

/**
 * Resolve what THIS session's selected model actually runs on.
 *
 * `stickyAccountId` is the account the scheduler bound to this session for that
 * family (see `stickyAccount` in provider/account-selection.ts); it is validated
 * here so a deleted/stale binding can never be announced. Without it the view
 * falls back to the per-family pin, then to the eligible-account prediction.
 */
export function buildSessionView(input: {
  poolData?: AccountPoolData | undefined
  accounts: readonly ManagedAccount[]
  model: string
  stickyAccountId?: string | undefined
  now?: number
}): SessionView {
  const model = (input.model ?? '').trim()
  const family = model === '' ? null : asQuotaFamily(modelFamilyOf(model))
  if (family === null) return { ...EMPTY_SESSION_VIEW, model }
  const now = input.now ?? Date.now()
  const poolData = input.poolData
  const pinnedId = poolData?.activeAccountIds?.[family]
  const resolvedId = poolData?.resolvedActiveAccountIds?.[family] ?? pinnedId
  const sticky = input.stickyAccountId !== undefined && input.stickyAccountId !== ''
    ? input.accounts.find((a) => a.id === input.stickyAccountId)
    : undefined
  const accountId = sticky?.id ?? resolvedId ?? null
  const acc = accountId === null ? undefined : input.accounts.find((a) => a.id === accountId)
  if (acc === undefined) {
    return { ...EMPTY_SESSION_VIEW, model, family, source: 'none' }
  }
  const source: SessionViewSource =
    sticky !== undefined || (pinnedId !== undefined && pinnedId === resolvedId)
      ? 'session'
      : 'predicted'
  const reading = familyReading(acc, family, now)
  return {
    model,
    family,
    accountId: acc.id,
    alias: acc.alias ?? '',
    email: acc.email ?? '',
    defaultAlias: acc.defaultAlias === true,
    systemHome: acc.systemHome === true,
    source,
    percent: reading.percent,
    window: reading.window,
    stale: reading.stale,
    cooling: isFamilyCooling(acc, family, now),
    eligible: acc.enabled === true,
  }
}