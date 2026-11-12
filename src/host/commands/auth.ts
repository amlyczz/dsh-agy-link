// /agy auth, auth-status and auth-code — OAuth login orchestration.
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { err, ok, type CommandContext, type CommandDeps } from './shared.ts'

export async function handleAuth(deps: CommandDeps, ctx: CommandContext): Promise<CommandResult> {
  const { sub, arg, parts, raw } = ctx

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

  if (sub === 'import' || sub === 'import-token') {
    const rest = (raw ?? '').trim().replace(new RegExp(`^(?:/agy\\s+)?${sub}\\s*`, 'i'), '').trim()
    if (!rest) {
      return err('用法: /agy import <refresh_token 或 Token JSON> [alias]\nUsage: /agy import <refresh_token_or_json> [alias]')
    }
    const flow = deps.poolAuth?.()
    if (!flow) return err('auth flow not available')

    let tokenStr = rest
    let alias: string | undefined
    if (tokenStr.startsWith('{')) {
      const lastBrace = tokenStr.lastIndexOf('}')
      if (lastBrace !== -1 && lastBrace < tokenStr.length - 1) {
        alias = tokenStr.slice(lastBrace + 1).trim()
        tokenStr = tokenStr.slice(0, lastBrace + 1).trim()
      }
    } else {
      const spaceIdx = tokenStr.indexOf(' ')
      if (spaceIdx !== -1) {
        alias = tokenStr.slice(spaceIdx + 1).trim()
        tokenStr = tokenStr.slice(0, spaceIdx).trim()
      }
    }

    const res = await flow.importRefreshToken(tokenStr, alias, deps.cfg().proxyUrl || undefined)
    if (res.ok) {
      deps.store().clear()
      const acc = res.account
      const label = acc ? (acc.alias || acc.email || acc.id) : (res.email || 'account')
      return ok(`成功导入凭据 (${label})${res.isNew ? '，已加入账号池' : '，已更新已有账号凭据'}。\nSuccessfully imported token for ${label} (${res.isNew ? 'added to pool' : 'updated existing'}).`)
    }
    return err(`导入失败: ${res.error || res.code || 'token invalid or exchange failed'}`)
  }

  return err(`Unknown auth command \`${sub}\`.`)
}
