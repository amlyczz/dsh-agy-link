// /agy session, /agy goal and /agy clear — DSH session binding and goal state.
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { err, ok, type CommandContext, type CommandDeps } from './shared.ts'

type GoalSession = {
  events?: readonly { type: string; data?: unknown }[]
  append?: (t: string, d: unknown) => unknown
}

type GoalChangeData = {
  operation?: string
  goal?: { id: string; revision: number; objective: string; phase: string; maxGoalRounds?: number; blockedReason?: { message: string } }
  roundsStarted?: number
  createdAt?: number
}

type SessionView = {
  header?: { cwd?: string }
  events?: readonly unknown[]
}

/** The invocation's session, else the session store's entry for its id. */
function resolveGoalSession(deps: CommandDeps, invocation?: CommandContext['invocation']): GoalSession | undefined {
  return (invocation?.agent?.session as GoalSession | undefined)
    ?? (deps.sessions?.() && invocation?.agent?.id ? (deps.sessions()!.get(invocation.agent.id) as GoalSession) : undefined)
}

/** Most recent goal/change event in the session's event log. */
function latestGoalChange(events: GoalSession['events']): GoalChangeData | null {
  if (!events) return null
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev?.type === 'goal/change' && ev.data && typeof ev.data === 'object') {
      const d = ev.data as { kind?: string; operation?: string; goal?: unknown; roundsStarted?: number; createdAt?: number }
      if (d.kind === 'goal/change') return d as GoalChangeData
    }
  }
  return null
}

/** Append a complete/pause/resume goal transition; false when the session cannot append. */
function appendGoalOp(
  session: GoalSession,
  activeGoal: NonNullable<GoalChangeData['goal']>,
  latest: GoalChangeData,
  operation: 'complete' | 'pause' | 'resume',
  phase: string,
): boolean {
  if (typeof session.append !== 'function') return false
  session.append('goal/change', {
    kind: 'goal/change',
    version: 1,
    operation,
    goal: {
      id: activeGoal.id,
      revision: activeGoal.revision + 1,
      objective: activeGoal.objective,
      phase,
      maxGoalRounds: activeGoal.maxGoalRounds,
    },
    roundsStarted: latest.roundsStarted ?? 1,
    createdAt: latest.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  })
  return true
}

export function handleGoal(deps: CommandDeps, ctx: CommandContext): CommandResult {
  const action = ctx.arg || 'status'
  const session = resolveGoalSession(deps, ctx.invocation)

  if (!session) {
    return err('No active DSH session available for goal command.')
  }

  const latest = latestGoalChange(session.events)
  const activeGoal = latest && latest.operation !== 'clear' ? latest.goal : null

  if (action === 'status') {
    if (!activeGoal || !latest) {
      return ok('**DSH Goal Status**: No active goal in this session.')
    }
    const phaseEmoji: Record<string, string> = {
      active: '🟢',
      paused: '⏸️',
      blocked: '🚫',
      complete: '✅',
    }
    return ok([
      `**DSH Goal Status** (${phaseEmoji[activeGoal.phase] ?? '⚪'} \`${activeGoal.phase}\`)`,
      `- **Goal ID**: \`${activeGoal.id}\` (rev ${activeGoal.revision})`,
      `- **Objective**: ${activeGoal.objective}`,
      `- **Rounds**: ${latest.roundsStarted ?? 1} / ${activeGoal.maxGoalRounds ?? 256}`,
      ...(activeGoal.blockedReason ? [`- **Blocked Reason**: ${activeGoal.blockedReason.message}`] : []),
    ].join('\n'))
  }

  if (action === 'complete') {
    if (!activeGoal || !latest) return err('No active goal to complete.')
    if (!appendGoalOp(session, activeGoal, latest, 'complete', 'complete')) return err('Session cannot append events.')
    return ok(`✅ Marked goal \`${activeGoal.id}\` as complete. Automatic continuation rounds stopped.`)
  }

  if (action === 'pause') {
    if (!activeGoal || !latest) return err('No active goal to pause.')
    if (!appendGoalOp(session, activeGoal, latest, 'pause', 'paused')) return err('Session cannot append events.')
    return ok(`⏸️ Paused goal \`${activeGoal.id}\`.`)
  }

  if (action === 'resume') {
    if (!activeGoal || !latest) return err('No active goal to resume.')
    if (!appendGoalOp(session, activeGoal, latest, 'resume', 'active')) return err('Session cannot append events.')
    return ok(`▶️ Resumed goal \`${activeGoal.id}\`.`)
  }

  if (action === 'clear') {
    if (!activeGoal) return ok('No active goal to clear.')
    if (typeof session.append !== 'function') return err('Session cannot append events.')
    session.append('goal/change', {
      kind: 'goal/change',
      version: 1,
      operation: 'clear',
      cleared: {
        id: activeGoal.id,
        revision: activeGoal.revision + 1,
      },
      clearedAt: Date.now(),
    })
    return ok(`Cleared goal \`${activeGoal.id}\`.`)
  }

  return err(`Unknown goal action \`${action}\`. Usage: /agy goal [status|complete|pause|resume|clear]`)
}

export function handleSession(deps: CommandDeps, ctx: CommandContext): CommandResult {
  const action = ctx.arg || 'info'
  const sessionId = ctx.invocation?.agent?.id ? String(ctx.invocation.agent.id) : undefined
  const session = (ctx.invocation?.agent?.session as SessionView | undefined)
    ?? (deps.sessions?.() && sessionId ? (deps.sessions()!.get(sessionId) as SessionView) : undefined)

  if (action === 'info') {
    const lines: string[] = ['**DSH Session & agy Bridge Info**']
    if (sessionId) {
      lines.push(`- **Session ID**: \`${sessionId}\``)
      const cwd = session?.header?.cwd
      if (cwd) lines.push(`- **Workspace CWD**: \`${cwd}\``)
      const bindings = deps.store().all()
      const matchedKey = Object.keys(bindings).find((k) => k === sessionId || k.startsWith(`${sessionId}:`))
      if (matchedKey && bindings[matchedKey]) {
        const b = bindings[matchedKey]
        lines.push(
          `- **Bound agy Conversation**: \`${b.conversationId}\``,
          `- **Bound Model**: \`${b.model || 'default'}\``,
          `- **Last Message Count**: ${b.lastMessageCount}`,
          `- **Last Updated**: ${new Date(b.updatedAt).toLocaleTimeString()}`,
        )
      } else {
        lines.push('- **Bound agy Conversation**: *(none - next turn starts fresh)*')
      }
      if (session?.events) {
        lines.push(`- **Total Session Events**: ${session.events.length}`)
      }
    } else {
      lines.push('- Current session ID could not be identified from invocation context.')
    }
    return ok(lines.join('\n'))
  }

  if (action === 'clear') {
    if (!sessionId) {
      const all = deps.store().all()
      const keys = Object.keys(all)
      if (keys.length === 0) return ok('No conversation bindings yet.')
      const key = keys.reduce((a, b) => ((all[a]?.updatedAt ?? 0) >= (all[b]?.updatedAt ?? 0) ? a : b))
      const dropped = all[key]
      if (dropped === undefined) return ok('No conversation bindings yet.')
      deps.store().delete(key)
      return ok(`Dropped binding for session \`${key}\` (agy conversation \`${dropped.conversationId}\`). Next turn starts fresh.`)
    }

    const bindings = deps.store().all()
    let count = 0
    for (const k of Object.keys(bindings)) {
      if (k === sessionId || k.startsWith(`${sessionId}:`)) {
        deps.store().delete(k)
        count++
      }
    }
    return ok(`Dropped ${count > 0 ? count : 'any'} agy conversation binding(s) for session \`${sessionId}\`. Next turn will start a fresh agy conversation.`)
  }

  return err(`Unknown session action \`${action}\`. Usage: /agy session [info|clear]`)
}

export function handleClear(deps: CommandDeps, ctx: CommandContext): CommandResult {
  const sessionId = ctx.invocation?.agent?.id ? String(ctx.invocation.agent.id) : undefined
  if (sessionId) {
    const bindings = deps.store().all()
    const keys = Object.keys(bindings).filter((k) => k === sessionId || k.startsWith(`${sessionId}:`))
    if (keys.length > 0) {
      for (const k of keys) deps.store().delete(k)
      return ok(`Dropped binding for session \`${sessionId}\`. The next turn starts a fresh agy conversation.`)
    }
  }
  const all = deps.store().all()
  const keys = Object.keys(all)
  if (keys.length === 0) return ok('No conversation bindings yet.')
  const key = keys.reduce((a, b) => ((all[a]?.updatedAt ?? 0) >= (all[b]?.updatedAt ?? 0) ? a : b))
  const dropped = all[key]
  if (dropped === undefined) return ok('No conversation bindings yet.')
  deps.store().delete(key)
  return ok('Dropped binding for session `' + key + '` — agy conversation ' + dropped.conversationId + '. The next turn starts a fresh agy conversation.')
}