// /agy session, /agy goal and /agy clear — DSH session binding and goal state.
import { randomUUID } from 'node:crypto'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { err, ok, type CommandContext, type CommandDeps, type GoalServiceLike, type GoalViewLike } from './shared.ts'

type GoalSession = {
  log?: readonly { type: string; data?: unknown }[]
  events?: readonly { type: string; data?: unknown }[]
  snapshotEvents?: () => readonly { type: string; data?: unknown }[]
  ownEvents?: () => readonly { type: string; data?: unknown }[]
  append?: (t: string, d: unknown) => unknown
}

type GoalChangeData = {
  operation?: string
  goal?: { id: string; revision: number; objective: string; phase: string; maxGoalRounds?: number; blockedReason?: { code?: string; message: string } }
  roundsStarted?: number
  createdAt?: number
  updatedAt?: number
}

type SessionView = {
  header?: { cwd?: string }
  log?: readonly unknown[]
  events?: readonly unknown[]
  snapshotEvents?: () => readonly unknown[]
  ownEvents?: () => readonly unknown[]
}

const GOAL_USAGE = 'Usage: /agy goal [status|set <objective>|edit <objective>|pause|resume|complete|clear]'

/** The invocation's session, else the session store's entry for its id. */
function resolveGoalSession(deps: CommandDeps, invocation?: CommandContext['invocation']): GoalSession | undefined {
  return (invocation?.agent?.session as GoalSession | undefined)
    ?? (deps.sessions?.() && invocation?.agent?.id ? (deps.sessions()!.get(invocation.agent.id) as GoalSession) : undefined)
}

function readSessionEvents(session: GoalSession): readonly { type: string; data?: unknown }[] | undefined {
  return session.snapshotEvents?.() ?? session.ownEvents?.() ?? session.log ?? session.events
}

/** Most recent goal/change event and admitted round count from the session's event log. */
function latestGoalState(events: readonly { type: string; data?: unknown }[] | undefined): {
  latest: GoalChangeData | null
  roundsStarted: number
} {
  if (!events) return { latest: null, roundsStarted: 0 }
  let latestIdx = -1
  let latest: GoalChangeData | null = null
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev?.type === 'goal/change' && ev.data && typeof ev.data === 'object') {
      const d = ev.data as { kind?: string; operation?: string; goal?: unknown; roundsStarted?: number; createdAt?: number; updatedAt?: number }
      if (d.kind === 'goal/change') {
        latest = d as GoalChangeData
        latestIdx = i
        break
      }
    }
  }
  if (!latest || latest.operation === 'clear' || !latest.goal) {
    return { latest, roundsStarted: 0 }
  }
  let roundsStarted = latest.roundsStarted ?? 0
  for (let i = latestIdx + 1; i < events.length; i++) {
    const ev = events[i]
    if (ev?.type !== 'user/message' || !ev.data || typeof ev.data !== 'object') continue
    const src = (ev.data as { source?: { kind?: string; goalId?: string; revision?: number; round?: number } }).source
    if (
      src?.kind === 'goal' &&
      src.goalId === latest.goal.id &&
      src.revision === latest.goal.revision &&
      typeof src.round === 'number' &&
      src.round > roundsStarted
    ) {
      roundsStarted = src.round
    }
  }
  return { latest, roundsStarted }
}

function renderGoalStatus(goal: GoalViewLike, roundsStarted: number): CommandResult {
  const phaseEmoji: Record<string, string> = {
    active: '🟢',
    paused: '⏸️',
    blocked: '🚫',
    complete: '✅',
  }
  return ok([
    `**DSH Goal Status** (${phaseEmoji[goal.phase] ?? '⚪'} \`${goal.phase}\`)`,
    `- **Goal ID**: \`${goal.id}\` (rev ${goal.revision})`,
    `- **Objective**: ${goal.objective}`,
    `- **Rounds**: ${roundsStarted} / ${goal.maxGoalRounds ?? 256}`,
    ...(goal.activation !== undefined ? [`- **Activation**: \`${goal.activation}\``] : []),
    ...(goal.blockedReason ? [`- **Blocked Reason**: ${goal.blockedReason.message}`] : []),
  ].join('\n'))
}

function extractGoalRest(ctx: CommandContext, action: string): string {
  const raw = (ctx.raw ?? '').trim()
  if (raw !== '') {
    const afterGoal = raw.replace(/^(?:\/agy\s+)?goal\s*/i, '').trim()
    const re = new RegExp(`^${action}\\s*`, 'i')
    if (re.test(afterGoal)) return afterGoal.replace(re, '').trim()
  }
  return ctx.parts.slice(2).join(' ').trim()
}

function resolveLiveAgent(deps: CommandDeps, invocation?: CommandContext['invocation']): unknown | undefined {
  if (invocation?.agent && invocation.agent.session) {
    const id = (invocation.agent as { id?: unknown }).id
    const registered = id !== undefined ? deps.agents?.()?.get(id) : undefined
    return registered ?? invocation.agent
  }
  const id = (invocation?.agent as { id?: unknown } | undefined)?.id
  return id !== undefined ? deps.agents?.()?.get(id) : undefined
}

function handleGoalViaService(
  goals: GoalServiceLike,
  agent: unknown,
  action: string,
  ctx: CommandContext,
): CommandResult {
  try {
    const current = goals.get(agent)
    if (action === 'status') {
      if (!current) return ok('**DSH Goal Status**: No active goal in this session.')
      return renderGoalStatus(current, current.roundsStarted ?? 0)
    }
    if (action === 'set' || action === 'create') {
      const objective = extractGoalRest(ctx, action)
      if (!objective) return err(`Goal objective is required. ${GOAL_USAGE}`)
      if (current && current.phase !== 'complete') {
        return err(`A goal is already \`${current.phase}\`. Use \`/agy goal edit <objective>\` or \`/agy goal clear\` first.`)
      }
      const created = goals.create(agent, { objective })
      return ok(`🟢 Created goal \`${created.id}\`: ${created.objective}`)
    }
    if (action === 'edit') {
      const objective = extractGoalRest(ctx, 'edit')
      if (!objective) return err(`Goal editing requires a replacement objective. ${GOAL_USAGE}`)
      if (!current) return err('No active goal to edit.')
      if (current.phase === 'complete') {
        const replaced = goals.create(agent, { objective })
        return ok(`🟢 Created goal \`${replaced.id}\`: ${replaced.objective}`)
      }
      const edited = goals.edit(agent, { id: current.id, revision: current.revision }, { objective })
      return ok(`✏️ Updated goal \`${edited.id}\` (rev ${edited.revision}): ${edited.objective}`)
    }
    if (action === 'complete') {
      if (!current) return err('No active goal to complete.')
      if (current.phase === 'complete') return ok(`✅ Goal \`${current.id}\` is already complete.`)
      goals.complete(agent, { id: current.id, revision: current.revision })
      return ok(`✅ Marked goal \`${current.id}\` as complete. Automatic continuation rounds stopped.`)
    }
    if (action === 'pause') {
      if (!current) return err('No active goal to pause.')
      if (current.phase === 'paused') return ok(`⏸️ Goal \`${current.id}\` is already paused.`)
      if (current.phase !== 'active') return err(`Cannot pause goal \`${current.id}\` from phase \`${current.phase}\`; expected \`active\`.`)
      goals.pause(agent, { id: current.id, revision: current.revision })
      return ok(`⏸️ Paused goal \`${current.id}\`.`)
    }
    if (action === 'resume') {
      if (!current) return err('No active goal to resume.')
      if (current.phase === 'active' && current.activation === 'armed') {
        return ok(`▶️ Goal \`${current.id}\` is already active and armed.`)
      }
      if (current.phase === 'complete') {
        return err(`Cannot resume completed goal \`${current.id}\`. Create a new goal instead.`)
      }
      goals.resume(agent, { id: current.id, revision: current.revision })
      return ok(`▶️ Resumed goal \`${current.id}\`.`)
    }
    if (action === 'clear') {
      if (!current) return ok('No active goal to clear.')
      goals.clear(agent, { id: current.id, revision: current.revision })
      return ok(`Cleared goal \`${current.id}\`.`)
    }
    return err(`Unknown goal action \`${action}\`. ${GOAL_USAGE}`)
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }
}

/** Append a complete/pause/resume/edit/create goal transition in fallback mode. */
function appendGoalSnapshot(
  session: GoalSession,
  operation: 'create' | 'edit' | 'complete' | 'pause' | 'resume',
  goal: { id: string; revision: number; objective: string; phase: string; maxGoalRounds: number; blockedReason?: { code?: string; message: string } },
  roundsStarted: number,
  createdAt: number,
  prevUpdatedAt: number,
): boolean {
  if (typeof session.append !== 'function') return false
  const now = Math.max(Date.now(), prevUpdatedAt)
  session.append('goal/change', {
    kind: 'goal/change',
    version: 1,
    operation,
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      maxGoalRounds: goal.maxGoalRounds,
      ...(goal.phase === 'blocked' && goal.blockedReason ? { blockedReason: goal.blockedReason } : {}),
    },
    roundsStarted,
    createdAt,
    updatedAt: now,
  })
  return true
}

export function handleGoal(deps: CommandDeps, ctx: CommandContext): CommandResult {
  const action = (ctx.arg || 'status').toLowerCase()

  const goals = deps.goals?.()
  if (goals) {
    const liveAgent = resolveLiveAgent(deps, ctx.invocation)
    if (liveAgent) {
      return handleGoalViaService(goals, liveAgent, action, ctx)
    }
  }

  const session = resolveGoalSession(deps, ctx.invocation)
  if (!session) {
    return err('No active DSH session available for goal command.')
  }

  const { latest, roundsStarted } = latestGoalState(readSessionEvents(session))
  const activeGoal = latest && latest.operation !== 'clear' ? latest.goal : null

  if (action === 'status') {
    if (!activeGoal || !latest) {
      return ok('**DSH Goal Status**: No active goal in this session.')
    }
    return renderGoalStatus(activeGoal, roundsStarted)
  }

  if (action === 'set' || action === 'create') {
    const objective = extractGoalRest(ctx, action)
    if (!objective) return err(`Goal objective is required. ${GOAL_USAGE}`)
    if (activeGoal && activeGoal.phase !== 'complete') {
      return err(`A goal is already \`${activeGoal.phase}\`. Use \`/agy goal edit <objective>\` or \`/agy goal clear\` first.`)
    }
    const id = `goal-${randomUUID()}`
    const now = Date.now()
    if (!appendGoalSnapshot(session, 'create', { id, revision: 1, objective, phase: 'active', maxGoalRounds: 256 }, 0, now, now)) {
      return err('Session cannot append events.')
    }
    return ok(`🟢 Created goal \`${id}\`: ${objective}`)
  }

  if (action === 'edit') {
    const objective = extractGoalRest(ctx, 'edit')
    if (!objective) return err(`Goal editing requires a replacement objective. ${GOAL_USAGE}`)
    if (!activeGoal || !latest) return err('No active goal to edit.')
    if (activeGoal.phase === 'complete') {
      const id = `goal-${randomUUID()}`
      const now = Date.now()
      if (!appendGoalSnapshot(session, 'create', { id, revision: 1, objective, phase: 'active', maxGoalRounds: 256 }, 0, now, now)) {
        return err('Session cannot append events.')
      }
      return ok(`🟢 Created goal \`${id}\`: ${objective}`)
    }
    if (!appendGoalSnapshot(
      session,
      'edit',
      {
        id: activeGoal.id,
        revision: activeGoal.revision + 1,
        objective,
        phase: activeGoal.phase,
        maxGoalRounds: activeGoal.maxGoalRounds ?? 256,
        ...(activeGoal.blockedReason ? { blockedReason: activeGoal.blockedReason } : {}),
      },
      roundsStarted,
      latest.createdAt ?? Date.now(),
      latest.updatedAt ?? latest.createdAt ?? Date.now(),
    )) {
      return err('Session cannot append events.')
    }
    return ok(`✏️ Updated goal \`${activeGoal.id}\` (rev ${activeGoal.revision + 1}): ${objective}`)
  }

  if (action === 'complete') {
    if (!activeGoal || !latest) return err('No active goal to complete.')
    if (activeGoal.phase === 'complete') return ok(`✅ Goal \`${activeGoal.id}\` is already complete.`)
    if (!appendGoalSnapshot(
      session,
      'complete',
      { id: activeGoal.id, revision: activeGoal.revision + 1, objective: activeGoal.objective, phase: 'complete', maxGoalRounds: activeGoal.maxGoalRounds ?? 256 },
      roundsStarted,
      latest.createdAt ?? Date.now(),
      latest.updatedAt ?? latest.createdAt ?? Date.now(),
    )) {
      return err('Session cannot append events.')
    }
    return ok(`✅ Marked goal \`${activeGoal.id}\` as complete. Automatic continuation rounds stopped.`)
  }

  if (action === 'pause') {
    if (!activeGoal || !latest) return err('No active goal to pause.')
    if (activeGoal.phase === 'paused') return ok(`⏸️ Goal \`${activeGoal.id}\` is already paused.`)
    if (activeGoal.phase !== 'active') return err(`Cannot pause goal \`${activeGoal.id}\` from phase \`${activeGoal.phase}\`; expected \`active\`.`)
    if (!appendGoalSnapshot(
      session,
      'pause',
      { id: activeGoal.id, revision: activeGoal.revision + 1, objective: activeGoal.objective, phase: 'paused', maxGoalRounds: activeGoal.maxGoalRounds ?? 256 },
      roundsStarted,
      latest.createdAt ?? Date.now(),
      latest.updatedAt ?? latest.createdAt ?? Date.now(),
    )) {
      return err('Session cannot append events.')
    }
    return ok(`⏸️ Paused goal \`${activeGoal.id}\`.`)
  }

  if (action === 'resume') {
    if (!activeGoal || !latest) return err('No active goal to resume.')
    if (activeGoal.phase === 'complete') {
      return err(`Cannot resume completed goal \`${activeGoal.id}\`. Create a new goal instead.`)
    }
    const maxRounds = activeGoal.maxGoalRounds ?? 256
    if (roundsStarted >= maxRounds) {
      return err(`Goal \`${activeGoal.id}\` exhausted ${maxRounds} goal rounds.`)
    }
    if (!appendGoalSnapshot(
      session,
      'resume',
      { id: activeGoal.id, revision: activeGoal.revision + 1, objective: activeGoal.objective, phase: 'active', maxGoalRounds: maxRounds },
      roundsStarted,
      latest.createdAt ?? Date.now(),
      latest.updatedAt ?? latest.createdAt ?? Date.now(),
    )) {
      return err('Session cannot append events.')
    }
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
      clearedAt: Math.max(Date.now(), latest?.updatedAt ?? latest?.createdAt ?? 0),
    })
    return ok(`Cleared goal \`${activeGoal.id}\`.`)
  }

  return err(`Unknown goal action \`${action}\`. ${GOAL_USAGE}`)
}

function dropMostRecentBinding(store: ReturnType<CommandDeps['store']>): { key: string; conversationId: string } | null {
  const all = store.all()
  const keys = Object.keys(all)
  if (keys.length === 0) return null
  const key = keys.reduce((a, b) => ((all[a]?.updatedAt ?? 0) >= (all[b]?.updatedAt ?? 0) ? a : b))
  const dropped = all[key]
  if (dropped === undefined) return null
  store.delete(key)
  return { key, conversationId: dropped.conversationId }
}

function dropSessionBindings(store: ReturnType<CommandDeps['store']>, sessionId: string): number {
  const bindings = store.all()
  let count = 0
  for (const k of Object.keys(bindings)) {
    if (k === sessionId || k.startsWith(`${sessionId}:`)) {
      store.delete(k)
      count++
    }
  }
  return count
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
      const events = session ? readSessionEvents(session as GoalSession) : undefined
      if (events) {
        lines.push(`- **Total Session Events**: ${events.length}`)
      }
    } else {
      lines.push('- Current session ID could not be identified from invocation context.')
    }
    return ok(lines.join('\n'))
  }

  if (action === 'clear') {
    if (!sessionId) {
      const dropped = dropMostRecentBinding(deps.store())
      if (!dropped) return ok('No conversation bindings yet.')
      return ok(`Dropped binding for session \`${dropped.key}\` (agy conversation \`${dropped.conversationId}\`). Next turn starts fresh.`)
    }
    const count = dropSessionBindings(deps.store(), sessionId)
    return ok(
      count > 0
        ? `Dropped ${count} agy conversation binding(s) for session \`${sessionId}\`. Next turn will start a fresh agy conversation.`
        : `Dropped any agy conversation binding for session \`${sessionId}\`. Next turn will start a fresh agy conversation.`,
    )
  }

  return err(`Unknown session action \`${action}\`. Usage: /agy session [info|clear]`)
}

export function handleClear(deps: CommandDeps, ctx: CommandContext): CommandResult {
  const sessionId = ctx.invocation?.agent?.id ? String(ctx.invocation.agent.id) : undefined
  if (sessionId) {
    const count = dropSessionBindings(deps.store(), sessionId)
    if (count > 0) {
      return ok(`Dropped binding for session \`${sessionId}\`. The next turn starts a fresh agy conversation.`)
    }
  }
  const dropped = dropMostRecentBinding(deps.store())
  if (!dropped) return ok('No conversation bindings yet.')
  return ok('Dropped binding for session `' + dropped.key + '` — agy conversation ' + dropped.conversationId + '. The next turn starts a fresh agy conversation.')
}
