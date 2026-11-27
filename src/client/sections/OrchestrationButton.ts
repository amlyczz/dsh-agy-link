// Header chip: which seat is working right now, and the way into the 编排 page.
//
// The point is that Orchestrator sessions change driver mid-turn: this chip says
// "planner: orchestrator neon" then "executor: hydrogen" without opening
// anything, and clicking it opens the page with the whole picture.
//
// It is the ONE header entry for orchestration + live subagents: the count of
// running subagents/tasks comes from the /status tracker (`liveRunning`), which
// every host answers, so the chip stays informative even while the 编排
// snapshot itself is unavailable. The standalone count pill is therefore not
// rendered next to it on hosts that can open the page.

import { h } from '../react.ts'
import { Button } from '../ui/Button.ts'
import { useOrchestration } from '../orchestration/data.ts'
import { canOpenOrchestrationTab, openOrchestrationTab } from '../orchestration/tab.ts'

const PLANNER = '#8b5cf6'
const EXECUTOR = '#10b981'

const LABEL: Record<string, string> = { planner: '规划', executor: '执行', unknown: '模型' }

export interface OrchestrationButtonProps {
  t: (key: string, vars?: Record<string, string | number>) => string
  sessionId?: string
  /** Live subagents/background tasks for this session, from the /status tracker. */
  liveRunning?: number
}

/**
 * The chip: seat and workload once a turn has run, and a plain "编排" entry
 * before that. It deliberately stays visible on any host with a right Sidebar —
 * the page has its own empty state, and a control that only appears after the
 * fact is a control nobody finds.
 */
export function OrchestrationButton(props: OrchestrationButtonProps): unknown {
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
  const { snapshot, unavailable } = useOrchestration(sessionId)
  if (!canOpenOrchestrationTab()) return null
  const liveRunning = Math.max(0, Math.floor(props.liveRunning ?? 0))
  const style = { padding: '2px 8px', fontSize: '11px', gap: '4px' } as const
  const open = (): void => {
    openOrchestrationTab()
  }
  const count = (n: number): unknown =>
    h('span', { style: { color: EXECUTOR, fontSize: '10.5px', fontWeight: 700 } }, String(n))
  if (snapshot === null) {
    return h(
      Button,
      {
        variant: 'pill',
        title: unavailable
          ? '打开编排页（宿主暂未提供编排数据，可能需要重启 DSH）'
          : liveRunning > 0 ? `打开编排页 · ${liveRunning} 个子代理/后台任务运行中` : '打开编排页（本轮还没有数据）',
        className: 'agy-btn agy-orchestration-btn',
        style,
        onClick: open,
      },
      h('span', { style: { color: liveRunning > 0 ? EXECUTOR : 'var(--agy-text-secondary)', fontSize: '11px' } }, liveRunning > 0 ? '◐' : '◈'),
      h('span', { style: { color: 'var(--agy-text-secondary)', fontSize: '10.5px' } }, '编排'),
      liveRunning > 0 ? count(liveRunning) : null,
    )
  }
  const seats = snapshot.seats
  const live = snapshot.live
  const active = live
    ? seats.find((s) => s.role === 'executor') ?? seats.find((s) => s.role === 'planner') ?? seats[0]
    : seats[0]
  const color = active === undefined ? 'var(--agy-text-secondary)' : active.role === 'planner' ? PLANNER : active.role === 'executor' ? EXECUTOR : 'var(--agy-text-secondary)'
  const title = active === undefined
    ? '打开编排页'
    : `${LABEL[active.role] ?? '模型'}: ${active.model} · ${active.calls} 次调用 · 本轮 ${active.inputTokens}→${active.outputTokens} tokens`
  // The snapshot's own subagent list and the live tracker can disagree for a
  // tick; the larger count is the one the user can act on right now.
  const running = Math.max(snapshot.subagents.filter((s) => s.running).length, liveRunning)
  return h(
    Button,
    {
      variant: 'pill',
      title,
      className: 'agy-btn agy-orchestration-btn',
      style,
      onClick: open,
    },
    h('span', { style: { color, fontSize: '11px' }, title: live ? '本轮进行中' : '上一轮已结束' }, live ? '◐' : '◈'),
    h('span', { style: { color: 'var(--agy-text-secondary)', fontSize: '10.5px' } }, active === undefined ? '编排' : LABEL[active.role] ?? '编排'),
    active !== undefined && active.short !== ''
      ? h('span', { style: { color, fontWeight: 700, fontSize: '10.5px' } }, active.short)
      : null,
    running > 0 ? count(running) : null,
  )
}
