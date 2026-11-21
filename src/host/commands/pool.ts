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
    const qG = a.quotas.google?.remainingFraction !== undefined ? `${Math.round(a.quotas.google.remainingFraction * 100)}%` : 'unknown'
    const qC = a.quotas.anthropic?.remainingFraction !== undefined ? `${Math.round(a.quotas.anthropic.remainingFraction * 100)}%` : 'unknown'
    const qO = a.quotas.openai?.remainingFraction !== undefined ? `${Math.round(a.quotas.openai.remainingFraction * 100)}%` : 'unknown'
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
    if (!arg) return err('usage: /agy use <id> [family]')
    const pool = deps.pool?.()
    if (!pool) return err('Account pool not available')
    const rawFam = parts[2]
    const parsedFamily = rawFam ? normalizeModelFamily(rawFam) : undefined
    if (rawFam && !parsedFamily) {
      return err(`Unknown model family "${rawFam}". Expected: gemini, argon, claude, gpt.`)
    }
    const family: ModelFamily = parsedFamily ?? 'google'
    const prev = pool.getActiveAccountId(family)
    const success = pool.setActiveAccount(arg, family)
    if (!success) return err(`Account ${arg} not found or not eligible for ${FAMILY_LABELS[family] ?? family} (disabled / cooling / auth required)`)
    if (arg === prev) deps.notifyPicker?.()
    return ok(`Active account for **${FAMILY_LABELS[family] ?? family}** set to **${arg}** — model picker synced.`)
  }

  if (sub === 'enable-account' || sub === 'disable-account') {
    if (!arg) return err(`usage: /agy ${sub} <id>`)
    const pool = deps.pool?.()
    if (!pool) return err('Account pool not available')
    const enabled = sub === 'enable-account'
    const prevActive = pool.getActiveAccountId('google')
    const success = pool.setAccountEnabled(arg, enabled)
    if (success && !(typeof pool.onAccountSwitch === 'function' && pool.getActiveAccountId('google') !== prevActive)) {
      deps.notifyPicker?.()
    }
    return success ? ok(`${enabled ? 'Enabled' : 'Disabled'} account ${arg}`) : err(`Account ${arg} not found`)
  }

  if (sub === 'add-account') {
    const pool = deps.pool?.()
    if (!pool) return err('Account pool not available')
    const acc = pool.createAccountSlot(arg || undefined)
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
    const arg1 = parts[1]
    const arg2 = parts[2]
    let targetId: string | undefined = arg1 || undefined
    let targetFamily: ModelFamily | undefined = arg2 ? normalizeModelFamily(arg2) : undefined
    if (arg2 && !targetFamily) {
      return err(`Unknown model family "${arg2}". Expected: gemini, argon, claude, gpt.`)
    }
    if (arg1 && !arg2 && !pool.getAccount(arg1)) {
      const maybeFamily = normalizeModelFamily(arg1)
      if (maybeFamily) {
        targetId = undefined
        targetFamily = maybeFamily
      }
    }
    // includeQuotaBench: also lift the proactive low-quota rotation for the
    // cached snapshot until the next quota refresh.
    pool.clearCooldown(targetId, targetFamily, true)
    deps.notifyPicker?.()
    return ok('Cleared cooldown timers and any active low-quota bench (until the next quota refresh).')
  }

  if (sub === 'remove-account') {
    if (!arg) return err('usage: /agy remove-account <id>')
    const pool = deps.pool?.()
    if (!pool) return err('Account pool not available')
    const prevActive = pool.getActiveAccountId('google')
    const success = pool.deleteAccount(arg)
    if (success) {
      deps.store().cleanupStaleAccounts?.(new Set(pool.getAccounts().map((a) => a.id)))
      if (!(typeof pool.onAccountSwitch === 'function' && pool.getActiveAccountId('google') !== prevActive)) {
        deps.notifyPicker?.()
      }
    }
    return success ? ok(`Removed account ${arg}`) : err(`Account ${arg} not found`)
  }

  return err(`Unknown pool command \`${sub}\`.`)
}
