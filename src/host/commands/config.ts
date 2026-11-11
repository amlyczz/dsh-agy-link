// /agy config: permission mode, effort, dispatch guards, parallelism and workspace.
import { isAbsolute } from 'node:path'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { credentialSlotMutex, fastPathRunCount } from '../credential-slot.ts'
import { err, ok, type CommandContext, type CommandDeps } from './shared.ts'

export function handleConfig(deps: CommandDeps, ctx: CommandContext): CommandResult {
  const { sub, arg } = ctx

  if (sub === 'mode') {
    if (!['skip', 'plan', 'accept-edits'].includes(arg)) {
      return err('usage: /agy mode <skip|plan|accept-edits>')
    }
    deps.setOverride('permissionMode', arg)
    return ok('Permission mode set to **' + arg + '** — effective next turn.')
  }

  if (sub === 'effort') {
    if (!['low', 'medium', 'high', 'default'].includes(arg)) {
      return err('usage: /agy effort <low|medium|high|default>')
    }
    deps.setOverride('defaultEffort', arg === 'default' ? '' : arg)
    return ok('Default effort set to **' + (arg === 'default' ? 'model default' : arg) + '**.')
  }

  if (sub === 'dispatch' || sub === 'dispatch-retries') {
    const cfg = deps.cfg()
    const mutex = credentialSlotMutex
    if (arg === '') {
      const cap = cfg.dispatchTimeoutMinutes > 0 ? `${cfg.dispatchTimeoutMinutes} 分钟/次` : '不限时（无限等待）'
      const lines = [
        '**Agy 派发守护（dispatch guards）**',
        `- 硬超时：**${cap}**（重试次数 ${cfg.dispatchRetries}${cfg.dispatchTimeoutMinutes > 0 ? `，总坚持 ≈ ${(1 + cfg.dispatchRetries) * cfg.dispatchTimeoutMinutes} 分钟` : ''}）`,
        '- 同账号并行：**' + (cfg.parallelSameAccount ? '开（快路径，多会话并行跑同一账号）' : '关（同一时刻仅 1 个 agy 进程）') + '**',
        `- 并发上限：**${cfg.maxConcurrent > 0 ? cfg.maxConcurrent + ' 个流' : '不限制（原生并发）'}**`,
        `- 当前凭据槽位队列：**${mutex.waiting} 个等待者 / ${mutex.pending - mutex.waiting} 个持有者**，同身份并行活跃 **${fastPathRunCount()}** 个（主账号快路径 + 次级同授权租约）`,
        `- 排队期间：Stop 随时可停；丢失唤醒 5 秒内自愈；每 2 分钟心跳日志`,
        `- 修改：/agy dispatch <分钟|off>　/agy dispatch-retries <次数>　/agy parallel <on|off>`,
      ]
      return ok(lines.join('\n'))
    }
    if (sub === 'dispatch') {
      if (arg === 'off' || arg === '0') {
        deps.setOverride('dispatchTimeoutMinutes', 0)
        return ok('派发硬超时已关闭：排队将无限等待（仍然 Stop 可停、轮询自愈、心跳可见）。')
      }
      const minutes = Number(arg)
      if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isInteger(minutes)) {
        return err('usage: /agy dispatch <分钟数|off>')
      }
      deps.setOverride('dispatchTimeoutMinutes', minutes)
      return ok(
        `派发硬超时设为 **${minutes} 分钟/次**（含 ${cfg.dispatchRetries} 次重试，总坚持 ≈ ${(1 + cfg.dispatchRetries) * minutes} 分钟）— 下一个回合生效。`,
      )
    }
    const retries = Number(arg)
    if (!Number.isFinite(retries) || retries < 0 || !Number.isInteger(retries) || retries > 10) {
      return err('usage: /agy dispatch-retries <0-10>')
    }
    deps.setOverride('dispatchRetries', retries)
    const cap = cfg.dispatchTimeoutMinutes > 0 ? `，总坚持 ≈ ${(1 + retries) * cfg.dispatchTimeoutMinutes} 分钟` : ''
    return ok(`派发重试次数设为 **${retries}**${cap} — 下一个回合生效。`)
  }

  if (sub === 'parallel') {
    if (arg !== 'on' && arg !== 'off') {
      return err('usage: /agy parallel <on|off>')
    }
    const on = arg === 'on'
    deps.setOverride('parallelSameAccount', on)
    return ok(
      on
        ? '同账号并行已**开启**：同一账号的多个会话立即并行跑 agy（无需独占凭据槽位），仅账号切换时串行 — 下一个回合生效。'
        : '同账号并行已**关闭**：恢复同一时刻仅 1 个 agy 进程（全串行）— 下一个回合生效。',
    )
  }

  if (sub === 'max-concurrent') {
    if (arg === 'off' || arg === '0') {
      deps.setOverride('maxConcurrent', 0)
      return ok('并发上限已移除：**不限制**（原生 agy 并发，Google 速率与账号冷却为天然调节）— 下一个回合生效。')
    }
    const n = Number(arg)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 64) {
      return err('usage: /agy max-concurrent <1-64|off>')
    }
    deps.setOverride('maxConcurrent', n)
    return ok(`并发上限设为 **${n}** 个请求流 — 下一个回合生效。`)
  }

  if (sub === 'workspace') {
    if (arg === '') return ok('Current workspace: ' + (deps.cfg().workspaceRoot !== '' ? deps.cfg().workspaceRoot : '(session cwd / process cwd)'))
    if (arg === 'default' || arg === 'clear') {
      deps.setOverride('workspaceRoot', '')
      return ok('Workspace reset to session cwd / process cwd.')
    }
    if (!isAbsolute(arg)) return err('workspace must be an absolute path (or `default` to clear)')
    deps.setOverride('workspaceRoot', arg)
    return ok('Workspace set to **' + arg + '** — effective next turn.')
  }

  return err(`Unknown config command \`${sub}\`.`)
}
