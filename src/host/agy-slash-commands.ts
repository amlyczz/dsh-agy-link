// Full top-level `a`-prefix command suite mirroring Antigravity CLI slash
// commands & workflows without colliding with DSH core or community plugins.
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { DIRECT_AGY_SLASH_COMMANDS } from '../common/agy-slash-list.ts'
import { PROVIDER_ID } from '../common/types.ts'
import { handleGoal } from './commands/session.ts'
import { err, ok, type CommandContext, type CommandDeps } from './commands/shared.ts'
import { handleCompact, handleFork, handleLearn } from './commands/slash-bridge.ts'

export { DIRECT_AGY_SLASH_COMMANDS }

export interface AgySlashCommandsOpts {
  deps: () => CommandDeps
  armForcedPlan: (sessionId: string) => void
  planMode?: () => { enter?: (agent: unknown) => unknown } | undefined
}

interface FollowupAgentLike {
  id?: unknown
  options?: { provider?: unknown }
  followup?: (msg: ReturnType<typeof createUserMessage>) => void
}

const GOAL_CONTROL_ACTIONS = new Set(['status', 'set', 'create', 'edit', 'pause', 'resume', 'complete', 'clear'])

function toCommandContext(sub: string, rawInput: string, invocation?: CommandInvocation): CommandContext {
  const trimmed = rawInput.trim()
  const restParts = trimmed === '' ? [] : trimmed.split(/\s+/).filter(Boolean)
  const parts = [sub, ...restParts]
  return {
    sub,
    arg: parts[1] ?? '',
    parts,
    raw: trimmed === '' ? `/agy ${sub}` : `/agy ${sub} ${trimmed}`,
    ...(invocation ? { invocation } : {}),
  }
}

function validateAgyProvider(agent: FollowupAgentLike | undefined): string | null {
  const provider = agent?.options?.provider
  if (typeof provider === 'string' && provider !== '' && provider !== PROVIDER_ID) {
    return `Current session uses provider \`${provider}\`. Switch the session model to Antigravity (\`${PROVIDER_ID}\`) before running this command.`
  }
  return null
}

function dispatchUserTurn(
  invocation: CommandInvocation | undefined,
  text: string,
  requireAgy: boolean,
): CommandResult {
  const agent = invocation?.agent as FollowupAgentLike | undefined
  if (!agent || typeof agent.followup !== 'function') {
    return err('No active DSH conversation agent is available to receive this command.')
  }
  if (requireAgy) {
    const mismatch = validateAgyProvider(agent)
    if (mismatch) return err(mismatch)
  }
  const attachments = (invocation?.attachments ?? []) as unknown as Array<{ type: 'image'; attachment: unknown }>
  const msg = createUserMessage({
    content: [{ type: 'text', text }, ...(attachments as never[])],
    source: { kind: 'user' },
  })
  agent.followup(msg)
  return { kind: 'success' }
}

function buildDirectSpec(
  name: string,
  targetCmd: string,
  description: string,
  hint: string,
  requireInput: boolean,
  getDeps: () => CommandDeps,
  transformText?: (raw: string, deps: CommandDeps, invocation?: CommandInvocation) => string | CommandResult,
): CommandDefinition {
  return {
    name,
    description,
    input: { hint, images: true },
    handler: async (invocation) => {
      const raw = (invocation.rawInput ?? '').trim()
      if (requireInput && raw === '') return err(`Usage: /${name} ${hint}`)
      if (transformText) {
        const out = transformText(raw, getDeps(), invocation)
        if (typeof out !== 'string') return out
        return dispatchUserTurn(invocation, out, true)
      }
      const line = raw !== '' ? `/${targetCmd} ${raw}` : `/${targetCmd}`
      return dispatchUserTurn(invocation, line, true)
    },
  }
}

function formatSwarmForward(raw: string, deps: CommandDeps): string {
  const notes = ['dsh-agy-link: keep worker concurrency compact under shared credential slots.']
  if (!deps.cfg().backgroundWakeup) {
    notes.push('backgroundWakeup is off — enable `/agy wakeup on` if detached workers should auto-wake this session.')
  }
  return `/swarm ${raw}\n\n[${notes.join(' ')}]`
}

function formatScheduleForward(raw: string, deps: CommandDeps): string {
  if (deps.cfg().backgroundWakeup) return `/schedule ${raw}`
  return `/schedule ${raw}\n\n[dsh-agy-link: backgroundWakeup is off — enable \`/agy wakeup on\` so scheduled timers can wake this session across turns.]`
}

function formatRawCmd(raw: string, deps: CommandDeps): string | CommandResult {
  if (raw === '' || /^list$/i.test(raw) || /^--help$/i.test(raw) || /^help$/i.test(raw)) {
    const cmds = deps.acpStatus?.().availableCommands ?? []
    if (cmds.length === 0) {
      return ok('**/acmd** — Pass any Antigravity slash command directly into this conversation.\nUsage: `/acmd </command args>` (or `/acmd command args`). No live ACP command list captured yet.')
    }
    const lines = cmds.map((c) => `- \`/${c.name}\`${c.inputHint ? ` \`${c.inputHint}\`` : ''}${c.description ? ` — ${c.description}` : ''}`)
    return ok(['**Advertised ACP Commands (`agy`)**', ...lines].join('\n'))
  }
  const normalized = raw.startsWith('/') ? raw : `/${raw}`
  const m = /^(\/[a-z][a-z0-9_-]*)(?:[ \t]+([\s\S]*))?$/i.exec(normalized)
  if (!m) {
    return err('Invalid slash command syntax. Expected `/acmd </command> [args]` (single-segment command name).')
  }
  return normalized
}

async function handleAgoalCommand(deps: CommandDeps, invocation?: CommandInvocation): Promise<CommandResult> {
  const raw = (invocation?.rawInput ?? '').trim()
  if (raw === '') return handleGoal(deps, toCommandContext('goal', 'status', invocation))
  const firstWord = (raw.split(/\s+/)[0] ?? '').toLowerCase()
  if (GOAL_CONTROL_ACTIONS.has(firstWord)) {
    const res = handleGoal(deps, toCommandContext('goal', raw, invocation))
    if (res.kind !== 'success' || (firstWord !== 'set' && firstWord !== 'create')) return res
    const objective = raw.replace(/^(?:set|create)\s+/i, '').trim()
    const agent = invocation?.agent as FollowupAgentLike | undefined
    if (objective !== '' && typeof agent?.followup === 'function') {
      return dispatchUserTurn(invocation, objective, false)
    }
    return res
  }
  const createRes = handleGoal(deps, toCommandContext('goal', `set ${raw}`, invocation))
  if (createRes.kind !== 'success') return createRes
  const agent = invocation?.agent as FollowupAgentLike | undefined
  if (typeof agent?.followup === 'function') {
    return dispatchUserTurn(invocation, raw, false)
  }
  return createRes
}

/** Register the full `a`-prefix Antigravity command catalog (except `/atw`, owned by btw-command). */
export function agySlashCommandDefinitions(opts: AgySlashCommandsOpts): CommandDefinition[] {
  const { deps, armForcedPlan, planMode } = opts
  return [
    buildDirectSpec('aplan', 'plan', 'Antigravity 只读规划模式：制定方案，本轮强制禁用写文件修改（/aplan [任务]）', '[规划目标]', false, deps, (raw, _d, inv) => {
      const sid = inv?.agent?.id ? String(inv.agent.id) : ''
      if (sid !== '') armForcedPlan(sid)
      try { if (inv?.agent) planMode?.()?.enter?.(inv.agent) } catch { /* host optional */ }
      return raw !== '' ? `/plan ${raw}` : '/plan'
    }),
    {
      name: 'agoal',
      description: 'Antigravity 长程目标：创建并立即启动首轮执行，或控制 status/pause/resume/complete（/agoal <目标>）',
      input: { hint: '<目标描述> | status | pause | resume | complete | clear', images: true },
      handler: (invocation) => handleAgoalCommand(deps(), invocation),
    },
    buildDirectSpec('agrill', 'grill-me', 'Antigravity 设计拷问（/grill-me）：在当前对话发起交互式追问对齐方案（/agrill [主题]）', '[主题或决策范围]', false, deps),
    buildDirectSpec('aboost', 'boost', 'Antigravity 深度增强（/boost）：开启深度思考、多视角分析与严格验证（/aboost [任务]）', '[复杂任务]', false, deps),
    buildDirectSpec('aswarm', 'swarm', 'Antigravity 蜂群协作（/swarm）：拆分并行子任务直接开跑（/aswarm <任务>）', '<任务描述>', true, deps, formatSwarmForward),
    buildDirectSpec('ateamwork', 'teamwork', 'Antigravity 多代理协同（/teamwork）：以共享黑板协同执行大项目（/ateamwork <任务>）', '<项目任务>', true, deps),
    buildDirectSpec('aschedule', 'schedule', 'Antigravity 定时/周期任务（/schedule）：设置计时器或定期巡检（/aschedule <指令>）', '<定时说明>', true, deps, formatScheduleForward),
    buildDirectSpec('abrowser', 'browser', 'Antigravity 浏览器自动化（/browser）：启用网页交互、抓取与核验工作流（/abrowser <任务>）', '<网页任务>', true, deps),
    buildDirectSpec('acmd', 'acmd', 'Antigravity 原生斜杠命令直通车（/acmd </命令 参数> | list）', '</command [args]> | list', false, deps, formatRawCmd),
    {
      name: 'acompact',
      description: 'Antigravity 压缩会话：生成摘要并重置 agy 会话绑定（/acompact [焦点]）',
      input: { hint: '[保留焦点]' },
      handler: (invocation) => handleCompact(deps(), toCommandContext('compact', invocation.rawInput ?? '', invocation)),
    },
    {
      name: 'afork',
      description: 'Antigravity 会话分叉与回溯：保存/列出/切换或新开分支（/afork [list|restore <id>|<探索问题>]）',
      input: { hint: '[list | restore <id> | 分支探索问题]' },
      handler: (invocation) => handleFork(deps(), toCommandContext('fork', invocation.rawInput ?? '', invocation)),
    },
    {
      name: 'alearn',
      description: 'Antigravity 经验沉淀：提炼当前会话规范并可选写入 .agents/（/alearn [--apply] [焦点]）',
      input: { hint: '[--apply] [提炼方向]' },
      handler: (invocation) => handleLearn(deps(), toCommandContext('learn', invocation.rawInput ?? '', invocation)),
    },
  ]
}
