// /agy pool (accounts), account add/enable/disable/remove and quota/cooldown ops.
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { ModelFamily } from '../../common/pool-types.ts'
import {
  QUOTA_FAMILIES,
  accountCoolingFamilies,
  isAccountCriticalAuth,
  normalizeModelFamily,
} from '../../common/quota-bench.ts'
import { redactProxyUrl } from '../diagnostics.ts'
import { err, ok, type CommandContext, type CommandDeps } from './shared.ts'

const FAMILY_LABELS: Record<string, string> = {
  google: 'Gemini',
  argon: 'Argon',
  anthropic: 'Claude',
  openai: 'GPT-OSS',
}

const fmtQuota = (q?: { remainingFraction?: number; weeklyFraction?: number }): string => {
  if (q?.remainingFraction !== undefined) return `${Math.round(q.remainingFraction * 100)}%`
  if (q?.weeklyFraction !== undefined) return `${Math.round(q.weeklyFraction * 100)}% (7d)`
  return 'unknown'
}

function resolveAccountId(
  pool: { getAccount(id: string): { id: string } | undefined; getAccounts(): readonly { id: string; alias?: string; email?: string }[] },
  selector: string,
): { id: string } | { error: string } {
  const exact = pool.getAccount(selector)
  if (exact) return { id: exact.id }
  const needle = selector.toLowerCase()
  const matches = pool.getAccounts().filter((a) =>
    [a.alias, a.email].some((v) => typeof v === 'string' && v.trim().toLowerCase() === needle))
  if (matches.length === 1) return { id: matches[0]!.id }
  if (matches.length > 1) return { error: `Multiple accounts match "${selector}"; use an account ID from /agy pool.` }
  return { error: `Account ${selector} not found` }
}

function splitSelectorAndFamily(
  pool: { getAccount(id: string): { id: string } | undefined; getAccounts(): readonly { id: string; alias?: string; email?: string }[] },
  tailParts: readonly string[],
): { selector: string; family?: ModelFamily; invalidFamily?: string } {
  const full = tailParts.join(' ').trim()
  if (!full || tailParts.length < 2) return { selector: full }
  // Try the full tail first so multi-word aliases work without ambiguity.
  if (!('error' in resolveAccountId(pool, full))) return { selector: full }
  const maybeFamilyToken = tailParts.at(-1)!
  const maybeFamily = normalizeModelFamily(maybeFamilyToken)
  if (maybeFamily) {
    return { selector: tailParts.slice(0, -1).join(' ').trim(), family: maybeFamily }
  }
  if (tailParts.length === 2 && !('error' in resolveAccountId(pool, tailParts[0]!))) {
    return { selector: tailParts[0]!, invalidFamily: maybeFamilyToken }
  }
  const prefix = tailParts.slice(0, -1).join(' ').trim()
  if (prefix && !('error' in resolveAccountId(pool, prefix))) {
    return { selector: prefix, invalidFamily: maybeFamilyToken }
  }
  return { selector: full }
}

function renderPool(deps: CommandDeps): CommandResult {
  const pool = deps.pool?.()
  if (!pool) return ok('Account pool not enabled.')
  const accounts = pool.getAccounts()
  const data = pool.getPoolData()
  const lines = [
    `**Antigravity Account Pool (${accounts.length} accounts, mode: ${data.mode})**`,
  ]
  for (let i = 0; i < accounts.length; i++) {
    const a = accounts[i]
    if (!a) continue
    const isPrimary = a.id === data.primaryAccountId
    const qG = fmtQuota(a.quotas.google)
    const qC = fmtQuota(a.quotas.anthropic)
    const qO = fmtQuota(a.quotas.openai)
    // Gemini 4 Argon (Pro/Ultra only): a weekly-only counter. Append the
    // column ONLY when the backend reported one — accounts without the
    // argon permission keep the classic three-family line.
    const qA = a.quotas.argon?.weeklyFraction ?? a.quotas.argon?.remainingFraction
    const quotaLine = `   - Quota: Gemini ${qG} | Claude ${qC} | GPT-OSS ${qO}` +
      (qA !== undefined ? ` | Argon ${Math.round(qA * 100)}%` : '')
    const now = Date.now()
    const coolingFamilies = accountCoolingFamilies(a, now)
    const activeFamilies = QUOTA_FAMILIES
      .filter((fam) => data.resolvedActiveAccountIds?.[fam] === a.id)
      .map((fam) => FAMILY_LABELS[fam] ?? fam)
    let statusText = '   - Status: 🟢 Ready'
    if (!a.enabled) {
      statusText = '   - Status: ⏸️ Disabled'
    } else if (isAccountCriticalAuth(a)) {
      statusText = `   - Status: 🔴 Auth required (${a.authError || a.quotaUnavailable?.reason || 'sign in again'})`
    } else if (coolingFamilies.length > 0) {
      const details = coolingFamilies.map((fam) => {
        const label = FAMILY_LABELS[fam] ?? fam
        const cd = a.cooldowns[fam]
        if (cd && cd.cooldownUntil > now) {
          const sec = Math.ceil((cd.cooldownUntil - now) / 1000)
          return `${label} cooling (${sec}s: ${cd.reason})`
        }
        return `${label} cooling (quota reset)`
      })
      statusText = `   - ⚠️ ${details.join('; ')}`
    }
    const activeTag = activeFamilies.length > 0 ? ` · ⚡ ${activeFamilies.join(', ')}` : ''
    lines.push(
      `${i + 1}. **${a.alias}** (${a.email || 'email unknown'}; id: \`${a.id}\`)${isPrimary ? ' ⭐ primary' : ''}${activeTag}`,
      // Proxy URLs can embed user:pass — never print them raw into the GUI.
      `   - Proxy: ${a.proxyUrl ? redactProxyUrl(a.proxyUrl) : deps.cfg().proxyUrl ? redactProxyUrl(deps.cfg().proxyUrl) : 'system default'}`,
      quotaLine,
      statusText,
    )
  }
  return ok(lines.join('\n'))
}

export async function handlePool(deps: CommandDeps, ctx: CommandContext): Promise<CommandResult> {
  const { sub, arg, parts } = ctx
  if (sub === 'pool' || sub === 'accounts') return renderPool(deps)

  if (sub === 'use' || sub === 'set-active') {
    const tailParts = parts.slice(1)
    if (tailParts.length === 0) return err('usage: /agy use <id|alias> [family]')
    const pool = deps.pool?.()
    if (!pool) return err('Account pool not available')
    const split = splitSelectorAndFamily(pool, tailParts)
    if (split.invalidFamily) {
      return err(`Unknown model family "${split.invalidFamily}". Expected: gemini, argon, claude, gpt.`)
    }
    const resolved = resolveAccountId(pool, split.selector)
    if ('error' in resolved) return err(resolved.error)
    const family: ModelFamily = split.family ?? 'google'
    const prev = pool.getActiveAccountId(family)
    const success = pool.setActiveAccount(resolved.id, family)
    if (!success) return err(`Account ${resolved.id} not found or not eligible for ${FAMILY_LABELS[family] ?? family} (disabled / cooling / auth required)`)
    if (resolved.id === prev) deps.notifyPicker?.()
    return ok(`Active account for **${FAMILY_LABELS[family] ?? family}** set to **${resolved.id}** — model picker synced.`)
  }

  if (sub === 'enable-account' || sub === 'disable-account') {
    const selector = parts.slice(1).join(' ').trim()
    if (!selector) return err(`usage: /agy ${sub} <id|alias>`)
    const pool = deps.pool?.()
    if (!pool) return err('Account pool not available')
    const resolved = resolveAccountId(pool, selector)
    if ('error' in resolved) return err(resolved.error)
    const enabled = sub === 'enable-account'
    const prevActive = pool.getActiveAccountId('google')
    const success = pool.setAccountEnabled(resolved.id, enabled)
    if (success && !(typeof pool.onAccountSwitch === 'function' && pool.getActiveAccountId('google') !== prevActive)) {
      deps.notifyPicker?.()
    }
    return success ? ok(`${enabled ? 'Enabled' : 'Disabled'} account ${resolved.id}`) : err(`Account ${arg} not found`)
  }

  if (sub === 'add-account') {
    const pool = deps.pool?.()
    if (!pool) return err('Account pool not available')
    const alias = parts.slice(1).join(' ').trim()
    const acc = pool.createAccountSlot(alias || undefined)
    // Quarantine until the terminal login completes: without the flag the
    // scheduler immediately routed real runs to the empty slot — a
    // guaranteed failure plus cooldown noise. The first successful run or
    // quota refresh clears it (recordSuccess / clearAuthRequired).
    pool.markAuthRequired(acc.id, 'not signed in yet — complete the terminal login')
    return ok([
      `**Account slot created: [${acc.alias}]** (id: \`${acc.id}\`)`,
      `- Isolated directory: \`${acc.dir}\``,
      `- Run \`/agy auth ${acc.id}\` to authenticate this Google account.`,
      `- The slot stays OUT of rotation (authRequired) until the login completes and a quota refresh verifies it.`,
      `- Once logged in, run: \`/agy pool\` or click 🔄 刷新额度 in WebUI.`,
    ].join('\n'))
  }

  if (sub === 'refresh-quota') {
    const quota = deps.quota?.()
    if (!quota) return err('Quota service not available')
    await quota.refreshAllQuotas(true)
    await deps.catalog().forceRefresh().catch(() => undefined)
    deps.notifyPicker?.()
    return ok('Refreshed quota statistics and model catalog for all accounts in pool.')
  }

  if (sub === 'clear-cooldown') {
    const pool = deps.pool?.()
    if (!pool) return err('Account pool not available')
    const tailParts = parts.slice(1)
    let targetId: string | undefined
    let targetFamily: ModelFamily | undefined
    if (tailParts.length > 0) {
      const full = tailParts.join(' ').trim()
      const singleFamily = tailParts.length === 1 && !pool.getAccount(full)
        ? normalizeModelFamily(full)
        : undefined
      if (singleFamily) {
        targetFamily = singleFamily
      } else {
        const split = splitSelectorAndFamily(pool, tailParts)
        if (split.invalidFamily) {
          return err(`Unknown model family "${split.invalidFamily}". Expected: gemini, argon, claude, gpt.`)
        }
        const resolved = resolveAccountId(pool, split.selector)
        if ('error' in resolved) return err(resolved.error)
        targetId = resolved.id
        targetFamily = split.family
      }
    }
    // includeQuotaBench: also lift the proactive low-quota rotation for the
    // cached snapshot until the next quota refresh.
    pool.clearCooldown(targetId, targetFamily, true)
    deps.notifyPicker?.()
    return ok('Cleared cooldown timers and any active low-quota bench (until the next quota refresh).')
  }

  if (sub === 'remove-account') {
    const selector = parts.slice(1).join(' ').trim()
    if (!selector) return err('usage: /agy remove-account <id|alias>')
    const pool = deps.pool?.()
    if (!pool) return err('Account pool not available')
    const resolved = resolveAccountId(pool, selector)
    if ('error' in resolved) return err(resolved.error)
    const prevActive = pool.getActiveAccountId('google')
    const success = pool.deleteAccount(resolved.id)
    if (success) {
      deps.store().cleanupStaleAccounts?.(new Set(pool.getAccounts().map((a) => a.id)))
      if (!(typeof pool.onAccountSwitch === 'function' && pool.getActiveAccountId('google') !== prevActive)) {
        deps.notifyPicker?.()
      }
    }
    return success ? ok(`Removed account ${resolved.id}`) : err(`Account ${resolved.id} not found`)
  }

  return err(`Unknown pool command \`${sub}\`.`)
}
