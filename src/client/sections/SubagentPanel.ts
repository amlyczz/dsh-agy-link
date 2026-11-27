// Header control for agy's LIVE subagents, styled like DSH's background-job
// list but fed from our own /status snapshot.
//
// Why not register them as DSH jobs: the job registry caps `running + stopping`
// at maxConcurrentJobsPerOwner (default 10) SHARED with bash background jobs,
// and every settlement notifies the owning agent — which here is agy itself, so
// it would inject a "background job … finished" message agy never started. Agy
// turns can spawn 10 subagents at once (observed 2026-11-23), so that path would
// hit JOB_LIMIT_REACHED and pollute the model's context. This control reuses the
// LOOK, not the job ledger: no notices, no cap, no cross-session leakage.
import { h, useEffect, useRef, useState } from '../react.ts';
import { win } from '../api.ts';
import { Button } from '../ui/Button.ts';
import { portalToBody } from '../ui/Modal.ts';
import { canOpenOrchestrationTab, openOrchestrationTab } from '../orchestration/tab.ts';

export interface SubagentItem {
	conversationId: string
	role: string
	typeName: string
	state?: string
	running: boolean
	lastAction: string
	startedAt: number
	lastAt: number
}

export interface DurationWords {
	day: string
	hour: string
	minute: string
	second: string
}

/** Split a flat list into the running/finished sections the panel renders. */
export function groupSubagents(items: readonly SubagentItem[]): { running: SubagentItem[]; finished: SubagentItem[] } {
	const running: SubagentItem[] = []
	const finished: SubagentItem[] = []
	for (const it of items) (it.running ? running : finished).push(it)
	return { running, finished }
}

/** Compact elapsed label: `2天 3小时`, `1小时 05分钟`, `4分钟 12秒`, `9秒`. */
export function formatElapsed(ms: number, w: DurationWords): string {
	const total = Math.max(0, Math.floor(ms / 1000))
	const d = Math.floor(total / 86400)
	const hh = Math.floor((total % 86400) / 3600)
	const mm = Math.floor((total % 3600) / 60)
	const ss = total % 60
	if (d > 0) return `${d}${w.day} ${hh}${w.hour}`
	if (hh > 0) return `${hh}${w.hour} ${String(mm).padStart(2, '0')}${w.minute}`
	if (mm > 0) return `${mm}${w.minute} ${ss}${w.second}`
	return `${ss}${w.second}`
}

function durationWords(t: (key: string) => string): DurationWords {
	return {
		day: t('duration.day'),
		hour: t('duration.hour'),
		minute: t('duration.minute'),
		second: t('duration.second'),
	}
}

function row(t: (key: string) => string, it: SubagentItem, now: number): unknown {
	const words = durationWords(t)
	const end = it.running ? now : it.lastAt
	const elapsed = formatElapsed(end - it.startedAt, words)
	const tone = it.running ? '#10b981' : 'var(--agy-text-secondary)'
	return h('div', {
		key: `sub-${it.conversationId}`,
		style: {
			display: 'flex', alignItems: 'flex-start', gap: '7px',
			padding: '5px 8px', borderRadius: '6px', background: 'var(--agy-bg-subbox)',
		},
	},
		h('span', {
			style: {
				width: '7px', height: '7px', borderRadius: '50%', background: tone,
				flexShrink: 0, marginTop: '5px',
			},
		}),
		h('div', { style: { flex: 1, minWidth: 0 } },
			h('div', {
				style: {
					display: 'flex', alignItems: 'baseline', gap: '5px',
					fontSize: '11.5px', fontWeight: 700, color: 'var(--agy-text-primary)',
					whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
				},
			},
				h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, it.role),
				h('span', { style: { fontWeight: 500, fontSize: '10px', color: 'var(--agy-text-secondary)' } }, `· ${it.typeName}`),
			),
			h('div', {
				title: it.lastAction,
				style: {
					fontSize: '10.5px', color: 'var(--agy-text-secondary)', marginTop: '1px',
					whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
				},
			}, it.lastAction),
		),
		h('span', { style: { fontSize: '10px', color: 'var(--agy-text-secondary)', flexShrink: 0, marginTop: '2px' } }, elapsed),
	)
}

/**
 * The dropdown body. Pure (takes `now`), so it is unit-testable as markup.
 *
 * Mirrors DSH's own background-task list: ONLY live work is shown. agy keeps
 * finished subagent descriptors around (and never flips them off ALIVE), so a
 * history section here produced a permanent "已结束 45" panel on idle sessions.
 */
export function renderSubagentList(
	t: (key: string) => string,
	items: readonly SubagentItem[],
	now: number,
): unknown {
	const running = items.filter((it) => it.running)
	return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px', padding: '8px', minWidth: '260px', maxWidth: '340px' } },
		running.length > 0
			? h('div', { style: { fontSize: '10px', fontWeight: 700, color: 'var(--agy-text-secondary)', margin: '0 2px 2px' } }, `${t('subagent.running')} ${running.length}`)
			: null,
		...running.map((it) => row(t, it, now)),
		running.length === 0 ? h('div', { style: { fontSize: '11px', color: 'var(--agy-text-secondary)' } }, t('subagent.empty')) : null,
	)
}

/**
 * Header control: a compact count pill that opens the live subagent panel.
 * Renders nothing when the session has no tracked subagents.
 */
export function SubagentControl(props: {
	t: (key: string, vars?: Record<string, string | number>) => string
	items: readonly SubagentItem[]
}): unknown {
	const { t, items } = props
	const [open, setOpen] = useState(false)
	const [, setTick] = useState(0)
	const triggerRef = useRef<HTMLElement | null>(null)
	const panelRef = useRef<HTMLElement | null>(null)

	useEffect(() => {
		if (!open) return () => undefined
		const timer = setInterval(() => setTick((n) => n + 1), 1000)
		const onKey = (e: unknown): void => { if ((e as { key?: string } | null)?.key === 'Escape') setOpen(false) }
		const onDown = (e: unknown): void => {
			const target = (e as { target?: unknown } | null)?.target as { contains?: (n: unknown) => boolean } | null
			const insidePanel = panelRef.current !== null && target?.contains?.(panelRef.current) === true
			const insideTrigger = triggerRef.current !== null && target?.contains?.(triggerRef.current) === true
			if (!insidePanel && !insideTrigger) setOpen(false)
		}
		const doc = (win as unknown as {
			document?: {
				addEventListener?: (type: string, handler: (e: unknown) => void) => void
				removeEventListener?: (type: string, handler: (e: unknown) => void) => void
			}
		}).document
		doc?.addEventListener?.('keydown', onKey)
		doc?.addEventListener?.('mousedown', onDown)
		return () => {
			clearInterval(timer)
			doc?.removeEventListener?.('keydown', onKey)
			doc?.removeEventListener?.('mousedown', onDown)
		}
	}, [open])

	// One door per header: on a host that can open the 编排 page, that page's own
	// chip already carries the live count (`OrchestrationButton`), so this pill
	// would only be a second button leading to the same place (v0.6.107 showed
	// both). The popover stays for hosts without a right Sidebar.
	if (canOpenOrchestrationTab()) return null

	// Idle sessions must not show a count pill at all: agy's descriptor files
	// outlive the run, so "finished" history is not a reason to occupy the header.
	const runningItems = items.filter((i) => i.running)
	if (runningItems.length === 0) return null
	const runningCount = runningItems.length
	const tint = '#8b5cf6'

	const trigger = h(Button, {
		variant: 'pill',
		title: t('subagent.triggerTitle'),
		className: 'agy-btn agy-subagent-chain',
		style: { padding: '2px 8px', fontSize: '11px', gap: '4px' },
		...(open ? {} : {}),
		// Merged into the 编排 page: the popover only remains for hosts without a right
	// Sidebar, where there is nowhere else to show the list.
	onClick: () => {
		if (openOrchestrationTab()) return
		setOpen((v) => !v)
	},
	},
		h('span', { style: { color: tint, fontSize: '11px' } }, '●'),
		h('span', { style: { color: tint, fontWeight: 700, fontSize: '10.5px' } }, String(runningCount)),
	)

	let panel: unknown = null
	if (open) {
		const rect = triggerRef.current?.getBoundingClientRect?.()
		const top = rect === undefined ? 64 : Math.round(rect.bottom + 6)
		const viewportWidth = (win as unknown as { innerWidth?: number }).innerWidth ?? 1024
		const right = rect === undefined ? 16 : Math.max(8, Math.round(viewportWidth - rect.right))
		panel = portalToBody(h('div', {
			ref: (el: HTMLElement | null) => { panelRef.current = el },
			role: 'dialog',
			style: {
				position: 'fixed', top: `${top}px`, right: `${right}px`, zIndex: 2147483000,
				background: 'var(--agy-bg-header)', border: '1px solid var(--agy-border-card)',
				borderRadius: '8px', boxShadow: 'var(--agy-shadow-card)', maxHeight: '60vh', overflow: 'auto',
			},
		},
			h('div', {
				style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '7px 8px 0' },
			},
				h('strong', { style: { fontSize: '11.5px', color: 'var(--agy-text-primary)' } }, `${t('subagent.title')} · ${runningCount}`),
				h('button', {
					type: 'button',
					style: { background: 'transparent', border: 'none', color: 'var(--agy-text-secondary)', cursor: 'pointer', fontSize: '11px' },
					onClick: () => setOpen(false),
				}, t('console.close')),
			),
			renderSubagentList(t, runningItems, Date.now()),
		))
	}

	return h('span', {
		ref: (el: HTMLElement | null) => { triggerRef.current = el },
		style: { display: 'inline-flex', alignItems: 'center' },
	}, trigger, panel)
}
