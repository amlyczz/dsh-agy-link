// Header chip: which seat is working right now, and the way into the 编排 page.
//
// The point is that Orchestrator sessions change driver mid-turn: this chip says
// "planner: orchestrator neon" then "executor: hydrogen" without opening
// anything, and clicking it opens the page with the whole picture.

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
}

/** Renders nothing until the session has orchestration data (or the host has no Sidebar). */
export function OrchestrationButton(props: OrchestrationButtonProps): unknown {
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
  const { snapshot } = useOrchestration(sessionId)
  if (snapshot === null || !canOpenOrchestrationTab()) return null
  const seats = snapshot.seats
  const live = snapshot.live
  const active = live
    ? seats.find((s) => s.role === 'executor') ?? seats.find((s) => s.role === 'planner') ?? seats[0]
    : seats[0]
  const color = active === undefined ? 'var(--agy-text-secondary)' : active.role === 'planner' ? PLANNER : active.role === 'executor' ? EXECUTOR : 'var(--agy-text-secondary)'
  const title = active === undefined
    ? '打开编排页'
    : `${LABEL[active.role] ?? '模型'}: ${active.model} · ${active.calls} 次调用 · 本轮 ${active.inputTokens}→${active.outputTokens} tokens`
  return h(
    Button,
    {
      variant: 'pill',
      title,
      className: 'agy-btn agy-orchestration-btn',
      style: { padding: '2px 8px', fontSize: '11px', gap: '4px' },
      onClick: () => {
        openOrchestrationTab()
      },
    },
    h('span', { style: { color, fontSize: '11px' }, title: live ? '本轮进行中' : '上一轮已结束' }, live ? '◐' : '◈'),
    h('span', { style: { color: 'var(--agy-text-secondary)', fontSize: '10.5px' } }, active === undefined ? '编排' : LABEL[active.role] ?? '编排'),
    active !== undefined && active.short !== ''
      ? h('span', { style: { color, fontWeight: 700, fontSize: '10.5px' } }, active.short)
      : null,
    snapshot.subagents.filter((s) => s.running).length > 0
      ? h('span', { style: { color: EXECUTOR, fontSize: '10.5px' } }, String(snapshot.subagents.filter((s) => s.running).length))
      : null,
  )
}