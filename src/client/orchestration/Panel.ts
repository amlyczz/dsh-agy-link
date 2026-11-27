// The 编排 (orchestration) page for the right Sidebar.
//
// agy's Orchestrator runs two seats inside one conversation — a planner that
// writes the plan and an executor that does the work — and switches between them
// mid-turn. The ACP stream says nothing about that: DSH used to show one flat run
// of identical tool cards with no hint that a different model had taken over.
// This page is the missing view: which seats are running, what the planner
// planned, the agent's own checklist, the subagents (merged out of the header
// popover), the tool flow stamped with its seat, and the real context window.

import { h, useEffect, useState } from '../react.ts'
import { useOrchestration } from './data.ts'
import { contextPercent, formatDuration, formatTokens } from './format.ts'
import type {
  BackgroundTaskItem,
  OrchestrationContext,
  OrchestrationSeat,
  OrchestrationSnapshot,
  OrchestrationStep,
  OrchestrationTodo,
  SeatRole,
  SubagentItem,
} from './types.ts'

const TEXT = 'var(--agy-text-primary)'
const MUTED = 'var(--agy-text-secondary)'
const CARD = 'var(--agy-bg-card)'
const BORDER = 'var(--agy-border-card)'
const PLANNER = '#8b5cf6'
const EXECUTOR = '#10b981'

const label: Record<SeatRole, string> = { planner: 'planner', executor: 'executor', unknown: 'seat' }

function seatColor(role: SeatRole): string {
  if (role === 'planner') return PLANNER
  if (role === 'executor') return EXECUTOR
  return MUTED
}

function section(title: string, extra: unknown, children: unknown[]): unknown {
  return h(
    'section',
    { style: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 12px', borderBottom: '1px solid ' + BORDER } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase', color: MUTED } },
      h('span', { style: { fontWeight: 600 } }, title),
      extra === undefined || extra === null ? null : h('span', { style: { marginLeft: 'auto' } }, extra),
    ),
    ...children,
  )
}

function chip(text: string, color: string, filled = false): unknown {
  return h(
    'span',
    {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '0 6px',
        height: '16px',
        borderRadius: '8px',
        fontSize: '10px',
        fontWeight: 600,
        lineHeight: '16px',
        whiteSpace: 'nowrap',
        color: filled ? '#fff' : color,
        background: filled ? color : 'transparent',
        border: '1px solid ' + (filled ? color : color),
        opacity: filled ? 1 : 0.9,
      },
      title: text,
    },
    text,
  )
}

function seatRow(seat: OrchestrationSeat): unknown {
  const color = seatColor(seat.role)
  return h(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 8px',
        borderRadius: '6px',
        background: CARD,
        border: '1px solid ' + BORDER,
        borderLeft: '3px solid ' + color,
      },
    },
    chip(label[seat.role], color, true),
    h('span', { style: { color: TEXT, fontSize: '12px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: seat.model }, seat.short || seat.model || '—'),
    h(
      'span',
      { style: { marginLeft: 'auto', display: 'flex', gap: '8px', fontSize: '11px', color: MUTED, whiteSpace: 'nowrap' } },
      h('span', { title: 'calls this turn' }, String(seat.calls) + '×'),
      h('span', { title: 'last prompt tokens (cache read)' }, formatTokens(seat.contextTokens) + (seat.cacheReadTokens !== undefined ? ' (' + formatTokens(seat.cacheReadTokens) + ' cache)' : '')),
      h('span', { title: 'this turn: input → output' }, formatTokens(seat.inputTokens) + ' → ' + formatTokens(seat.outputTokens)),
    ),
  )
}

function todoGlyph(state: OrchestrationTodo['state']): { glyph: string; color: string } {
  if (state === 'done') return { glyph: '✓', color: EXECUTOR }
  if (state === 'in_progress') return { glyph: '▶', color: PLANNER }
  return { glyph: '○', color: MUTED }
}

function todoRow(todo: OrchestrationTodo): unknown {
  const { glyph, color } = todoGlyph(todo.state)
  return h(
    'div',
    { style: { display: 'flex', gap: '6px', fontSize: '12px', alignItems: 'baseline', color: todo.state === 'done' ? MUTED : TEXT } },
    h('span', { style: { color, width: '12px', flex: '0 0 12px' } }, glyph),
    h('span', { style: { textDecoration: todo.state === 'done' ? 'line-through' : 'none' } }, todo.text),
  )
}

function subagentRow(item: SubagentItem, now: number): unknown {
  const color = item.running ? EXECUTOR : MUTED
  return h(
    'div',
    { style: { display: 'flex', gap: '6px', fontSize: '12px', alignItems: 'baseline', color: TEXT } },
    h('span', { style: { color, width: '12px', flex: '0 0 12px' }, title: item.running ? 'running' : (item.state ?? 'done') }, item.running ? '●' : '○'),
    h('span', { style: { fontWeight: 600 } }, item.role || item.typeName || 'subagent'),
    h('span', { style: { color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }, title: item.lastAction }, item.lastAction),
    h('span', { style: { color: MUTED, whiteSpace: 'nowrap', fontSize: '11px' } }, formatDuration(Math.max(0, (item.running ? now : item.lastAt) - item.startedAt))),
  )
}

function stepRow(step: OrchestrationStep, now: number, last: boolean): unknown {
  const color = seatColor(step.seat)
  const active = step.state === 'ACTIVE'
  const failed = step.state === 'ERROR'
  const end = step.endedAt ?? (active ? now : undefined)
  return h(
    'div',
    {
      style: {
        display: 'flex',
        gap: '6px',
        alignItems: 'baseline',
        fontSize: '12px',
        padding: '2px 0',
        borderBottom: last ? 'none' : '1px dashed ' + BORDER,
        opacity: step.state === 'CANCELED' ? 0.5 : 1,
      },
    },
    h('span', { style: { color, width: '6px', flex: '0 0 6px' }, title: label[step.seat] + (step.model !== undefined ? ' · ' + step.model : '') }, active ? '◐' : failed ? '✕' : '•'),
    h('span', { style: { fontFamily: 'ui-monospace, monospace', fontSize: '11px', color: failed ? '#ef4444' : TEXT, whiteSpace: 'nowrap' } }, step.tool),
    h('span', { style: { color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }, title: step.brief }, step.brief),
    end === undefined ? null : h('span', { style: { color: MUTED, fontSize: '11px', whiteSpace: 'nowrap' } }, formatDuration(end - step.startedAt)),
  )
}

function backgroundRow(task: BackgroundTaskItem): unknown {
  const tail = task.lines.slice(-6)
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '2px 0' } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', gap: '6px', fontSize: '12px' } },
      h('span', { style: { color: MUTED } }, '⌁'),
      h('span', { style: { fontFamily: 'ui-monospace, monospace', fontSize: '11px', color: TEXT } }, task.taskId),
      task.skipped > 0
        ? h('span', { style: { fontSize: '10px', color: MUTED } }, '（跳过 ' + task.skipped + ' 行）')
        : null,
      h('span', { style: { marginLeft: 'auto', fontSize: '10px', color: MUTED } }, task.lines.length + ' 行'),
    ),
    h(
      'div',
      {
        style: {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '11px',
          color: MUTED,
          whiteSpace: 'pre',
          overflowX: 'auto',
          lineHeight: 1.45,
          maxHeight: '132px',
        },
      },
      tail.join('\n'),
    ),
  )
}

function contextBar(context: OrchestrationContext, seats: OrchestrationSeat[]): unknown {
  const used = context.used
  const size = context.size
  const pct = contextPercent(used, size)
  const hot = pct !== undefined && pct >= 80
  const owner = context.seat === undefined || context.seat === 'unknown'
    ? '最近一次内部调用'
    : (context.seat === 'planner' ? 'planner 最近一次调用' : 'executor 最近一次调用')
  // Per-seat prompt occupancy: each seat reports its own context on every
  // PLANNER_RESPONSE, which is the only per-seat figure that exists at all.
  const rows = seats
    .filter(seat => seat.contextTokens !== undefined && seat.contextTokens > 0)
    .map(seat => h(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', gap: '6px', fontSize: '11px', color: MUTED } },
      h('span', { style: { color: seatColor(seat.role), fontWeight: 600 } }, label[seat.role]),
      h('span', null, formatTokens(seat.contextTokens) + (seat.cacheReadTokens !== undefined && seat.cacheReadTokens > 0 ? '（命中 ' + formatTokens(seat.cacheReadTokens) + '）' : '')),
      h('span', { style: { marginLeft: 'auto' } }, seat.short),
    ))
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', gap: '6px', fontSize: '12px', color: TEXT } },
      h('span', null, formatTokens(used) + ' / ' + formatTokens(size)),
      pct === undefined ? null : h('span', { style: { color: hot ? '#f59e0b' : MUTED } }, pct.toFixed(0) + '%'),
      h('span', { style: { marginLeft: 'auto', fontSize: '11px', color: MUTED } }, 'agy usage_update'),
    ),
    h(
      'div',
      { style: { height: '4px', borderRadius: '2px', background: BORDER, overflow: 'hidden' } },
      h('div', { style: { width: (pct ?? 0) + '%', height: '100%', background: hot ? '#f59e0b' : EXECUTOR } }),
    ),
    h('div', { style: { fontSize: '11px', color: MUTED } }, owner),
    ...rows,
  )
}

/** Plan text with a three-line preview. A real component: it owns hook state. */
function PlanText(props: { plan: string }): unknown {
  const plan = props.plan
  const [open, setOpen] = useState(false)
  const lines = plan.split(/\r?\n/)
  const preview = lines.slice(0, 3).join('\n')
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
    h(
      'pre',
      {
        style: {
          margin: 0,
          padding: '6px 8px',
          borderRadius: '6px',
          background: CARD,
          border: '1px solid ' + BORDER,
          color: TEXT,
          fontSize: '11.5px',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          maxHeight: open ? '420px' : '62px',
          overflow: 'auto',
        },
      },
      open ? plan : preview + (lines.length > 3 ? '\n…' : ''),
    ),
    lines.length > 3
      ? h(
          'button',
          {
            type: 'button',
            onClick: () => setOpen((v) => !v),
            style: { alignSelf: 'flex-start', border: 'none', background: 'transparent', color: MUTED, fontSize: '11px', cursor: 'pointer', padding: 0 },
          },
          open ? '收起计划' : '展开完整计划（' + lines.length + ' 行）',
        )
      : null,
  )
}

export interface OrchestrationPanelProps {
  sessionId?: string
  t?: (key: string, params?: Record<string, unknown>) => string
}

/** The panel body: one session's orchestration, live while a turn streams. */
export function OrchestrationPanel(props: OrchestrationPanelProps): unknown {
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
  const { snapshot, loaded } = useOrchestration(sessionId)
  const [now, setNow] = useState(Date.now())
  const live = snapshot?.live === true

  useEffect(() => {
    if (!live) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [live])

  const snap: OrchestrationSnapshot | null = snapshot
  const steps = snap?.steps ?? []
  const running = steps.filter((s) => s.state === 'ACTIVE')
  const subagentsRunning = (snap?.subagents ?? []).filter((s) => s.running).length

  const header = h(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', borderBottom: '1px solid ' + BORDER } },
    h('span', { style: { color: live ? EXECUTOR : MUTED, fontSize: '12px' }, title: live ? 'turn streaming' : 'idle' }, live ? '●' : '○'),
    h('span', { style: { color: TEXT, fontSize: '13px', fontWeight: 600 } }, '编排'),
    snap?.mode !== undefined ? chip(snap.mode, PLANNER) : null,
    snap?.title !== undefined ? h('span', { style: { color: MUTED, fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, snap.title) : null,
    h(
      'span',
      { style: { marginLeft: 'auto', color: MUTED, fontSize: '11px', display: 'flex', gap: '8px' } },
      running.length > 0 ? h('span', { style: { color: PLANNER } }, running.length + ' 运行中') : null,
      subagentsRunning > 0 ? h('span', null, subagentsRunning + ' 子代理') : null,
    ),
  )

  if (!loaded) {
    return h('div', { style: { color: MUTED, fontSize: '12px', padding: '16px 12px' } }, '正在读取编排状态…')
  }
  if (snap === null) {
    return h(
      'div',
      { style: { color: MUTED, fontSize: '12px', padding: '16px 12px', lineHeight: 1.6 } },
      '本轮还没有编排数据。',
      h('br'),
      '用 Antigravity 的 Orchestrator 模型发起一轮对话后，这里会显示规划者/执行者席位、计划、检查清单与步骤流。',
    )
  }

  const hasSeats = snap.seats.length > 0
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto', fontFamily: 'var(--agy-font-family, inherit)' } },
    header,
    hasSeats
      ? section('席位', h('span', { style: { fontSize: '10px' } }, snap.seats.length + ' 个'), snap.seats.map(seatRow))
      : section('席位', undefined, [
          h('div', { style: { color: MUTED, fontSize: '12px', lineHeight: 1.6 } }, '当前是单模型会话（未启用 Orchestrator），因此没有席位切换。'),
        ]),
    snap.plan !== undefined ? section('计划', undefined, [h(PlanText, { plan: snap.plan.text })]) : null,
    snap.todos.length > 0
      ? section('待办', h('span', { style: { fontSize: '10px' } }, snap.todos.filter((x) => x.state === 'done').length + '/' + snap.todos.length), snap.todos.map(todoRow))
      : null,
    snap.subagents.length > 0 ? section('子代理', h('span', { style: { fontSize: '10px' } }, String(snap.subagents.length)), snap.subagents.map((s) => subagentRow(s, now))) : null,
    snap.background.length > 0
      ? section('后台任务', h('span', { style: { fontSize: '10px' } }, String(snap.background.length)), snap.background.map((b) => backgroundRow(b)))
      : null,
    steps.length > 0
      ? section('步骤流', h('span', { style: { fontSize: '10px' } }, String(steps.length)), steps.map((s, i) => stepRow(s, now, i === steps.length - 1)))
      : null,
    section('本轮用量', undefined, [
      contextBar(snap.context, snap.seats),
      h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', fontSize: '11px', color: MUTED } },
        ...snap.seats.map((s) => h('span', { style: { color: seatColor(s.role) } }, label[s.role] + ' ' + formatTokens(s.inputTokens) + '→' + formatTokens(s.outputTokens))),
      ),
    ]),
  )
}

/** The tab's title row (rendered by the Sidebar's tab strip). */
export function OrchestrationTabTitle(): unknown {
  return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, h('span', { style: { color: PLANNER } }, '◈'), h('span', null, '编排'))
}
