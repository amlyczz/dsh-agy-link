// /agy config: permission mode, effort, dispatch guards, parallelism and workspace.
import { isAbsolute } from 'node:path'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { isEffortId, REASONING_EFFORTS } from '../../common/reasoning.ts'
import { credentialSlotMutex, fastPathRunCount } from '../credential-slot.ts'
import { err, ok, type CommandContext, type CommandDeps } from './shared.ts'

export function handleConfig(deps: CommandDeps, ctx: CommandContext): CommandResult {
  const { sub, arg, raw } = ctx

  if (sub === 'mode') {
    const val = arg.toLowerCase()
    if (val === '') {
      return ok(`Current permission mode: **${deps.cfg().permissionMode}** (usage: /agy mode <skip|auto|plan|accept-edits>)`)
    }
    if (!['skip', 'auto', 'plan', 'accept-edits'].includes(val)) {
      return err('usage: /agy mode <skip|auto|plan|accept-edits>')
    }
    deps.setOverride('permissionMode', val)
    return ok('Permission mode set to **' + val + '** — effective next turn.')
  }

  if (sub === 'sandbox') {
    const val = arg.toLowerCase()
    if (val === '') {
      return ok(`Current terminal sandbox: **${deps.cfg().sandbox ? 'on' : 'off'}** (usage: /agy sandbox <on|off>)`)
    }
    if (val !== 'on' && val !== 'off') {
      return err('usage: /agy sandbox <on|off>')
    }
    const on = val === 'on'
    deps.setOverride('sandbox', on)
    return ok(`Terminal sandbox set to **${val}** — effective next turn.`)
  }

  if (sub === 'agent') {
    const rawAgent = (raw ?? '').trim().replace(/^(?:\/agy\s+)?agent\s*/i, '').trim()
    const target = rawAgent !== '' ? rawAgent : arg
    const lowered = target.toLowerCase()
    if (target === '') {
      const cur = deps.cfg().agent.trim()
      return ok('Current custom agent: **' + (cur !== '' ? cur : '(default)') + '** (usage: /agy agent <name|off>)')
    }
    if (lowered === 'off' || lowered === 'clear' || lowered === 'default') {
      deps.setOverride('agent', '')
      return ok('Custom agent cleared (back to default agy agent) — effective next turn.')
    }
    deps.setOverride('agent', target)
    return ok(`Custom agent set to **${target}** — effective next turn.`)
  }

  if (sub === 'settings') {
    const rawVal = (raw ?? '').trim().replace(/^(?:\/agy\s+)?settings\s*/i, '').trim()
    const target = rawVal !== '' ? rawVal : arg
    const lowered = target.toLowerCase()
    if (target === '' || lowered === 'show') {
      const cur = deps.cfg().agySettings.trim()
      return ok('Current `--settings` override: ' + (cur !== '' ? '`' + cur + '`' : '*(none)*'))
    }
    if (lowered === 'off' || lowered === 'clear') {
      deps.setOverride('agySettings', '')
      return ok('Cleared `--settings` override.')
    }
    if (target.startsWith('{')) {
      try {
        const parsed = JSON.parse(target)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return err('inline --settings JSON must be a plain object')
        }
      } catch (e) {
        return err('invalid inline JSON for --settings: ' + (e instanceof Error ? e.message : String(e)))
      }
    }
    deps.setOverride('agySettings', target)
    return ok('`--settings` override updated — effective next turn.')
  }

  if (sub === 'transport') {
    const cur = deps.cfg().transport
    const lowered = arg.toLowerCase()
    if (lowered === '' || lowered === 'status') {
      const st = deps.acpStatus?.()
      const extra = st ? ` (ACP active processes: ${st.activeProcesses}, sessions: ${st.sessions})` : ''
      return ok(`Current transport: **${cur}**${extra} (usage: /agy transport <cli|acp>)`)
    }
    const mode = arg.toLowerCase()
    if (mode !== 'cli' && mode !== 'acp') {
      return err('usage: /agy transport <cli|acp|status>')
    }
    deps.setOverride('transport', mode)
    return ok(`Transport set to **${mode}** — effective next turn.`)
  }

  if (sub === 'wakeup') {
    const cur = deps.cfg().backgroundWakeup
    if (arg === '' || arg === 'status') {
      const st = deps.backgroundStatus?.()
      const extra = st
        ? ` (watches: ${st.activeWatches}, timers: ${st.pendingTimers}, tasks: ${st.pendingTasks})`
        : ''
      return ok(`Cross-turn background wakeup: **${cur ? 'on' : 'off'}**${extra} (usage: /agy wakeup <on|off|status>)`)
    }
    const val = arg.toLowerCase()
    if (val !== 'on' && val !== 'off') {
      return err('usage: /agy wakeup <on|off|status>')
    }
    deps.setOverride('backgroundWakeup', val === 'on')
    return ok(`Cross-turn background wakeup set to **${val}**.`)
  }

  if (sub === 'effort') {
    if (arg === '') {
      const cur = deps.cfg().defaultEffort || 'model default'
      return ok(`Current default effort: **${cur}** (usage: /agy effort <${REASONING_EFFORTS.join('|')}|default>)`)
    }
    const normalized = arg.toLowerCase()
    if (normalized !== 'default' && !isEffortId(normalized)) {
      return err(`usage: /agy effort <${REASONING_EFFORTS.join('|')}|default>`)
    }
    deps.setOverride('defaultEffort', normalized === 'default' ? '' : normalized)
    deps.notifyPicker?.()
    return ok('Default effort set to **' + (normalized === 'default' ? 'model default' : normalized) + '**.')
  }

  if (sub === 'quota-poll' || sub === 'quota-interval') {
    const curMin = Math.round(deps.cfg().quotaPollIntervalMs / 60_000)
    if (arg === '') {
      return ok(
        `后台配额全量扫描间隔：**${curMin} 分钟**（用法：/agy config quota-poll <分钟>）\n` +
          '注意：正在使用的账号在一轮结束后会**单独立即刷新**（节流 5 分钟），所以这个间隔只决定"全量扫描"的频率，不等于你看到的数据新鲜度上限。',
      )
    }
    const minutes = Number(arg)
    if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      return err('usage: /agy config quota-poll <1-1440>')
    }
    deps.setOverride('quotaPollIntervalMs', minutes * 60_000)
    return ok(`后台配额全量扫描间隔设为 **${minutes} 分钟** — 下一个定时周期生效。`)
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
      const val = arg.toLowerCase()
      if (val === 'off' || val === '0') {
        deps.setOverride('dispatchTimeoutMinutes', 0)
        return ok('派发硬超时已关闭：排队将无限等待（仍然 Stop 可停、轮询自愈、心跳可见）。')
      }
      const minutes = Number(val)
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
    const val = arg.toLowerCase()
    if (val === '') {
      const on = deps.cfg().parallelSameAccount
      return ok(`同账号并行当前状态：**${on ? 'on（开启）' : 'off（关闭）'}**（用法：/agy parallel <on|off>）`)
    }
    if (val !== 'on' && val !== 'off') {
      return err('usage: /agy parallel <on|off>')
    }
    const on = val === 'on'
    deps.setOverride('parallelSameAccount', on)
    return ok(
      on
        ? '同账号并行已**开启**：同一账号的多个会话立即并行跑 agy（无需独占凭据槽位），仅账号切换时串行 — 下一个回合生效。'
        : '同账号并行已**关闭**：恢复同一时刻仅 1 个 agy 进程（全串行）— 下一个回合生效。',
    )
  }

  if (sub === 'max-concurrent') {
    const val = arg.toLowerCase()
    if (val === '') {
      const cur = deps.cfg().maxConcurrent
      return ok(`当前并发上限：**${cur > 0 ? `${cur} 个请求流` : 'off（不限制，原生并发）'}**（用法：/agy max-concurrent <1-64|off>）`)
    }
    if (val === 'off' || val === '0') {
      deps.setOverride('maxConcurrent', 0)
      return ok('并发上限已移除：**不限制**（原生 agy 并发，Google 速率与账号冷却为天然调节）— 下一个回合生效。')
    }
    const n = Number(val)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 64) {
      return err('usage: /agy max-concurrent <1-64|off>')
    }
    deps.setOverride('maxConcurrent', n)
    return ok(`并发上限设为 **${n}** 个请求流 — 下一个回合生效。`)
  }

  if (sub === 'workspace') {
    const rawPath = (raw ?? '').trim().replace(/^(?:\/agy\s+)?workspace\s*/i, '').trim()
    const target = (rawPath !== '' ? rawPath : arg).replace(/^(['"])(.*)\1$/, '$2').trim()
    const lowered = target.toLowerCase()
    if (target === '') return ok('Current workspace: ' + (deps.cfg().workspaceRoot !== '' ? deps.cfg().workspaceRoot : '(session cwd / process cwd)'))
    if (lowered === 'default' || lowered === 'clear') {
      deps.setOverride('workspaceRoot', '')
      return ok('Workspace reset to session cwd / process cwd.')
    }
    if (!isAbsolute(target)) return err('workspace must be an absolute path (or `default` to clear)')
    deps.setOverride('workspaceRoot', target)
    return ok('Workspace set to **' + target + '** — effective next turn.')
  }

  return err(`Unknown config command \`${sub}\`.`)
}
