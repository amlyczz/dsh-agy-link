// /agy auth, auth-status and auth-code — OAuth login orchestration.
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { err, ok, type CommandContext, type CommandDeps } from './shared.ts'

export async function handleAuth(deps: CommandDeps, ctx: CommandContext): Promise<CommandResult> {
  const { sub, arg, parts } = ctx

  if (sub === 'auth') {
    const flow = deps.poolAuth?.()
    if (!flow) return err('auth flow not available')
    const selector = parts.slice(1).join(' ')
    let st
    if (!selector) {
      st = await flow.beginPrimary()
    } else {
      const pool = deps.pool?.()
      if (!pool) return err('Account pool not available')
      const matches = pool.getAccounts().filter((a) =>
        [a.id, a.alias, a.email].some((value) => value?.toLowerCase() === selector.toLowerCase()))
      if (matches.length !== 1) {
        return err(matches.length ? 'Multiple accounts match; use an account ID from /agy pool.' : 'Account not found; use /agy pool to list account IDs.')
      }
      const account = matches[0]!
      st = account.systemHome || !account.dir
        ? await flow.beginPrimary(account.proxyUrl || deps.cfg().proxyUrl || undefined)
        : await flow.beginAccount(account.id, deps.cfg().proxyUrl || undefined)
    }
    if (st.ok && st.url) {
      return ok([
        st.browserOpened
          ? '**浏览器已打开 Google 授权页** — 批准访问后自动完成登录。'
          : '**请手动打开下面的 URL 完成 Google 授权：**',
        '',
        st.url,
        '',
        '授权后请在 30 秒内运行 `/agy auth-status` 检查登录结果。',
        '备用：授权完成后运行 `/agy auth-code <授权码或完整回调URL>`。',
      ].join('\n'))
    }
    return err(`failed to start the login flow (${st.code ?? 'request_failed'})`)
  }

  if (sub === 'auth-status') {
    const flow = deps.poolAuth?.()
    if (!flow) return err('auth flow not available')
    const st = flow.status()
    if (st.phase === 'done') return ok(`Login completed${st.alias ? ` for ${st.alias}` : ''}.`)
    if (st.phase === 'failed') return err(`Login failed (${st.code ?? 'request_failed'}).`)
    if (st.phase === 'waiting' || st.phase === 'exchanging') return ok(`Login ${st.phase}; authorization is not complete yet.`)
    return ok('No login is in progress.')
  }

  if (sub === 'auth-code') {
    if (arg === '') return err('usage: /agy auth-code <code-or-callback-url>')
    const flow = deps.poolAuth?.()
    if (!flow) return err('auth flow not available')
    const st = await flow.submitCode(arg)
    if (st.ok) {
      deps.store().clear()
      return ok('Logged in to Antigravity.')
    }
    return err(`login failed (${st.code ?? 'request_failed'})`)
  }

  return err(`Unknown auth command \`${sub}\`.`)
}
