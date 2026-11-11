// /agy pool (accounts), account add/enable/disable/remove and quota/cooldown ops.
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { redactProxyUrl } from '../diagnostics.ts'
import { err, ok, type CommandContext, type CommandDeps } from './shared.ts'

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
    const cds: string[] = []
    for (const [fam, cd] of Object.entries(a.cooldowns)) {
      if (cd && cd.cooldownUntil > Date.now()) {
        const sec = Math.ceil((cd.cooldownUntil - Date.now()) / 1000)
        cds.push(`${fam} cooldown: ${sec}s left (${cd.reason})`)
      }
    }
    let statusText = '   - Status: 🟢 Ready'
    if (!a.enabled) {
      statusText = '   - Status: ⏸️ Disabled'
    } else if (a.authRequired) {
      statusText = `   - Status: 🔴 Auth required (${a.authError || 'sign in again'})`
    } else if (cds.length > 0) {
      statusText = `   - ⚠️ ${cds.join('; ')}`
    }
    lines.push(
      `${i + 1}. **${a.alias}** (${a.email || 'email unknown'}; id: \`${a.id}\`)${isPrimary ? ' ⭐ primary' : ''}`,
      // Proxy URLs can embed user:pass — never print them raw into the GUI.
      `   - Proxy: ${a.proxyUrl ? redactProxyUrl(a.proxyUrl) : deps.cfg().proxyUrl ? redactProxyUrl(deps.cfg().proxyUrl) : 'system default'}`,
      quotaLine,
      statusText,
    )
  }
  return ok(lines.join('\n'))
}

export async function handlePool(deps: CommandDeps, ctx: CommandContext): Promise<CommandResult> {
  const { sub, arg } = ctx
  if (sub === 'pool' || sub === 'accounts') return renderPool(deps)

  if (sub === 'enable-account' || sub === 'disable-account') {
    if (!arg) return err(`usage: /agy ${sub} <id>`)
    const pool = deps.pool?.()
    if (!pool) return err('Account pool not available')
    const enabled = sub === 'enable-account'
    const success = pool.setAccountEnabled(arg, enabled)
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
    await quota.refreshAllQuotas()
    return ok('Refreshed quota statistics for all accounts in pool.')
  }

  if (sub === 'clear-cooldown') {
    const pool = deps.pool?.()
    if (!pool) return err('Account pool not available')
    // includeQuotaBench: also lift the proactive low-quota rotation for the
    // cached snapshot. Without it this command only touched 429 timers, so
    // it could never clear the "quota-exhausted" block the error mentioned.
    pool.clearCooldown(arg || undefined, undefined, true)
    return ok('Cleared cooldown timers and any active low-quota bench (until the next quota refresh).')
  }

  if (sub === 'remove-account') {
    if (!arg) return err('usage: /agy remove-account <id>')
    const pool = deps.pool?.()
    if (!pool) return err('Account pool not available')
    const success = pool.deleteAccount(arg)
    return success ? ok(`Removed account ${arg}`) : err(`Account ${arg} not found`)
  }

  return err(`Unknown pool command \`${sub}\`.`)
}
