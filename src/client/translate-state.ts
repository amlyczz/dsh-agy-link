// Per-reply translation action: streaming state, singleton tooltip and the
// icon-only strip button.
//
// Split out of translate.ts (behavior-preserving). The action state lives in
// module maps so a chat-panel remount (the timeline virtualises nodes and DSH
// re-creates the panel when a card lands) settles every mounted instance
// instead of stranding a spinner on the unmounted one.

import { h, useEffect, useState, win, base, currentSessionId, type ClientContextLike } from './translate-context.ts'
import { geminiMark } from './translate-card.ts'

async function postTranslate(body: Record<string, unknown>): Promise<{ ok?: boolean; text?: string; error?: string; code?: string; model?: string; effort?: string } | null> {
	try {
		const res = await win.fetch?.(base + '/plugins/agy-link/translate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})
		if (!res) return null
		const payload = (await res.json()) as Record<string, unknown>
		return payload as { ok?: boolean; text?: string; error?: string; code?: string }
	} catch {
		return null
	}
}

/** Ask the host whether this reply already owns a durable translation. */
async function getMessageState(sessionId: string, messageId: string): Promise<{ state?: string } | null> {
	try {
		const url = base + '/plugins/agy-link/translate/state?session=' + encodeURIComponent(sessionId) + '&message=' + encodeURIComponent(messageId)
		const res = await win.fetch?.(url)
		if (!res) return null
		return (await res.json()) as { state?: string }
	} catch {
		return null
	}
}

type ActionState = 'idle' | 'working' | 'done' | 'error'

function geminiGlyph(): unknown {
	// The strip icon is the same spark, but it inherits the strip's own tint like
	// every other action (copy / thumbs / link): hovering or settling changes the
	// colour, so the affordance stays in the same visual family.
	return geminiMark()
}

function spinnerGlyph(): unknown {
	return h('svg', {
		viewBox: '0 0 24 24',
		fill: 'none',
		className: 'agy-tsl-spinner',
		'aria-hidden': 'true',
		style: {
			width: '15px',
			height: '15px',
			display: 'block',
			animation: 'agy-tsl-spin 0.85s linear infinite',
			transformOrigin: 'center center',
		},
	},
		h('circle', {
			cx: '12',
			cy: '12',
			r: '9',
			stroke: 'currentColor',
			strokeWidth: '2.5',
			strokeDasharray: '38 18',
			strokeLinecap: 'round',
			opacity: '0.85',
		}),
	)
}

function checkGlyph(): unknown {
	return h('svg', {
		viewBox: '0 0 24 24',
		fill: 'none',
		stroke: 'currentColor',
		strokeWidth: '2.5',
		strokeLinecap: 'round',
		strokeLinejoin: 'round',
		'aria-hidden': 'true',
		style: { width: '15px', height: '15px', display: 'block' },
	},
		h('polyline', { points: '20 6 9 17 4 12' }),
	)
}

function errorGlyph(): unknown {
	return h('svg', {
		viewBox: '0 0 24 24',
		fill: 'none',
		stroke: 'currentColor',
		strokeWidth: '2.2',
		strokeLinecap: 'round',
		strokeLinejoin: 'round',
		'aria-hidden': 'true',
		style: { width: '15px', height: '15px', display: 'block' },
	},
		h('circle', { cx: '12', cy: '12', r: '10' }),
		h('line', { x1: '12', y1: '8', x2: '12', y2: '12' }),
		h('line', { x1: '12', y1: '16', x2: '12.01', y2: '16' }),
	)
}

/**
 * The hint lives in one body-level node, like DSH's own tooltip portal.
 *
 * Two reasons it is not a pseudo-element on the row any more:
 *   1. the transcript scroller clips its children, so a bubble anchored below the
 *      LAST reply (the row right above the composer) was cut off, and anchoring
 *      it above instead broke alignment with every other tooltip in the strip;
 *   2. `position: fixed` on the row cannot escape a transformed ancestor, so the
 *      node is appended to <body> where nothing can clip it.
 * Inline styles keep it hidden and positioned even if our stylesheet is missing,
 * so a stale sheet can never leak the label into the action row.
 */
export const TIP_ID = 'dsh-agy-link-tsl-tip'
const TIP_GAP_PX = 6
const TIP_MARGIN_PX = 8
const TIP_MAX_WIDTH_VW = 0.5

type TipNode = {
  textContent?: string
  isConnected?: boolean
  hidden?: boolean
  style: { cssText?: string; display?: string; position?: string; left?: string; top?: string }
  setAttribute?: (k: string, v: string) => void
  remove?: () => void
  getBoundingClientRect?: () => { width: number; height: number }
}
type TipDoc = {
  body?: { appendChild?: (n: unknown) => void } | null
  createElement?: (tag: string) => unknown
  getElementById?: (id: string) => unknown
}

/** Viewport size, guarded for a headless/test document. */
function viewport(): { width: number; height: number } {
  const w = win as unknown as { innerWidth?: number; innerHeight?: number }
  return { width: typeof w.innerWidth === 'number' ? w.innerWidth : 0, height: typeof w.innerHeight === 'number' ? w.innerHeight : 0 }
}

/** Hidden by default through INLINE styles — not through the stylesheet. */
function tipNode(): TipNode | null {
  if (typeof document === 'undefined') return null
  const doc = win.document as unknown as TipDoc | null | undefined
  if (doc === null || doc === undefined || typeof doc.createElement !== 'function') return null
  const found = typeof doc.getElementById === 'function' ? (doc.getElementById(TIP_ID) as TipNode | null | undefined) : null
  if (found !== null && found !== undefined && found.isConnected !== false) return found
  const created = doc.createElement('div') as TipNode
  created?.setAttribute?.('id', TIP_ID)
  created?.setAttribute?.('role', 'tooltip')
  // The bubble look (background/padding/13px/radius) lives in `.agy-tsl-tip`.
  // Without this class the node renders as bare body text — the exact symptom
  // that made the hover label show up as a plain line under the action strip.
  created?.setAttribute?.('class', 'agy-tsl-tip')
  if (created !== undefined && created !== null) {
    created.style.cssText = 'position:fixed;display:none;pointer-events:none;z-index:1100'
    created.isConnected = true
  }
  doc.body?.appendChild?.(created)
  return created ?? null
}

/**
 * Anchor box of the element the pointer is on (or `null` when it cannot be read).
 */
function anchorBox(el: unknown): { left: number; width: number; top: number; bottom: number } | null {
  const rect = (el as { getBoundingClientRect?: () => { left: number; width: number; top: number; bottom: number } } | undefined)?.getBoundingClientRect?.()
  if (rect === undefined || rect === null || typeof rect.top !== 'number' || typeof rect.left !== 'number') return null
  return { left: rect.left, width: typeof rect.width === 'number' ? rect.width : 0, top: rect.top, bottom: typeof rect.bottom === 'number' ? rect.bottom : rect.top }
}

/** Show the shared bubble under `el`, clamped to the viewport. */
function showTip(el: unknown, text: string): void {
  const node = tipNode()
  const box = anchorBox(el)
  if (node === null || node === undefined || box === null) return
  node.textContent = text
  // Repair a node left behind by an older build: it may carry no bubble class and
  // no inline `position:fixed`, in which case the label joins the document flow
  // and shows up as plain text instead of a floating hint.
  node.setAttribute?.('class', 'agy-tsl-tip')
  node.style.position = 'fixed'
  node.style.display = 'inline-flex'
  const size = node.getBoundingClientRect?.() ?? { width: 0, height: 26 }
  const vp = viewport()
  const maxWidth = vp.width > 0 ? Math.max(80, vp.width * TIP_MAX_WIDTH_VW) : 0
  const width = maxWidth > 0 ? Math.min(size.width, maxWidth) : size.width
  let left = box.left + box.width / 2 - width / 2
  if (vp.width > 0) left = Math.min(Math.max(TIP_MARGIN_PX, left), Math.max(TIP_MARGIN_PX, vp.width - width - TIP_MARGIN_PX))
  const below = box.bottom + TIP_GAP_PX
  const above = box.top - size.height - TIP_GAP_PX
  // Below is the DSH default; the flip only exists for a viewport-bottom edge the
  // composer cannot create (the node floats above it).
  const top = vp.height > 0 && below + size.height > vp.height - TIP_MARGIN_PX ? Math.max(TIP_MARGIN_PX, above) : below
  node.style.left = Math.round(left) + 'px'
  node.style.top = Math.round(top) + 'px'
}

/** Hide the shared bubble (leave/scroll/click). */
function hideTip(): void {
  const node = tipNode()
  if (node !== null && node !== undefined) node.style.display = 'none'
}

function tooltipText(props: Record<string, unknown> | undefined, key: string, fallback: string): string {
	const fn = props?.t as ((k: string) => string) | undefined
	if (typeof fn !== 'function') return fallback
	try {
		const value = fn(key)
		return value === key ? fallback : value
	} catch {
		return fallback
	}
}

/**
 * Per-reply action state, kept outside React so it survives a remount: the chat
 * timeline virtualises nodes, and DSH re-creates the whole panel whenever a new
 * card lands in the transcript. The map is the in-page truth; the host's durable
 * record is the truth across page loads.
 *
 * The bug this shape fixes: a remount that happens *while* a translation is in
 * flight re-initialises to `working`, and the promise that finishes belongs to
 * the unmounted instance — whose `setState` is a no-op. The spinner then never
 * stopped even though the card had rendered. Publishing to every mounted
 * instance is what lets the survivor settle to `done`.
 */
const ACTION_STATE = new Map<string, ActionState>()
const ACTION_INFLIGHT = new Set<string>()
const ACTION_LISTENERS = new Map<string, Set<(next: ActionState) => void>>()

function actionKey(sessionId: string, messageId: string): string {
	return sessionId + '\u0000' + messageId
}

/** Current state of one action; `working` whenever a request is in flight. */
export function actionStateOf(key: string): ActionState {
	return ACTION_INFLIGHT.has(key) ? 'working' : ACTION_STATE.get(key) ?? 'idle'
}

/** Publish a state to every mounted instance of this action. */
export function setActionState(key: string, next: ActionState): void {
	ACTION_STATE.set(key, next)
	if (next === 'working') ACTION_INFLIGHT.add(key)
	else ACTION_INFLIGHT.delete(key)
	const listeners = ACTION_LISTENERS.get(key)
	if (listeners === undefined) return
	for (const listener of [...listeners]) {
		try {
			listener(next)
		} catch {
			// a dead listener must not stop the others
		}
	}
}

/** Subscribe one mounted action instance; the returned function unsubscribes. */
export function subscribeActionState(key: string, listener: (next: ActionState) => void): () => void {
	const listeners = ACTION_LISTENERS.get(key) ?? new Set<(next: ActionState) => void>()
	listeners.add(listener)
	ACTION_LISTENERS.set(key, listeners)
	return () => {
		listeners.delete(listener)
		if (listeners.size === 0) ACTION_LISTENERS.delete(key)
	}
}

/** Strip-icon button look, tinted by the action state (same values as the CSS). */
function iconButtonStyle(state: ActionState): Record<string, unknown> {
	return {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: '24px',
		height: '24px',
		padding: '0',
		border: 'none',
		borderRadius: '6px',
		background: 'transparent',
		color:
			state === 'working'
				? 'var(--dsw-alias-state-business-primary, #2563eb)'
				: state === 'done'
					? 'var(--dsw-alias-state-success-primary, #22c55e)'
					: state === 'error'
						? 'var(--dsw-alias-state-error-primary, #ef4444)'
						: 'var(--dsw-alias-label-tertiary, #8a8f98)',
		cursor: state === 'working' ? 'wait' : 'pointer',
	}
}

/**
 * Icon-only "translate with Gemini" action rendered into the assistant action
 * strip (`conversation.chat.assistant-actions`), so it lines up with copy,
 * thumbs, link and usage. The label lives in the hover tooltip only.
 */
export const TranslateAction = (props?: Record<string, unknown>): unknown => {
	const messageId = typeof props?.messageId === 'string' ? props.messageId : ''
	const injectedSession = typeof props?.sessionId === 'string' ? props.sessionId : ''
	const ctx = props?.ctx as ClientContextLike | undefined
	const sessionId = injectedSession !== '' ? injectedSession : ctx === undefined ? '' : currentSessionId(ctx)
	const key = actionKey(sessionId, messageId)
	const [state, setState] = useState<ActionState>(() => actionStateOf(key))

	// Live updates: whoever owns the in-flight request, every mounted instance —
	// including the survivor of a remount — settles to the same state.
	useEffect(() => subscribeActionState(key, (next) => setState(next)), [key])

	// A remount must not lose a finished translation: ask the session whether a
	// durable record already exists for this reply.
	useEffect(() => {
		if (messageId === '' || sessionId === '') return
		let alive = true
		void getMessageState(sessionId, messageId).then((res) => {
			if (!alive || res === null) return
			const next: ActionState | null =
				res.state === 'ready' ? 'done' : res.state === 'busy' ? 'working' : null
			if (next === null) return
			setActionState(key, next)
		})
		return () => {
			alive = false
		}
	}, [key, messageId, sessionId])

	if (messageId === '' || sessionId === '') return null

	const apply = (next: ActionState): void => {
		setActionState(key, next)
	}

	const run = (e?: { stopPropagation?: () => void; preventDefault?: () => void }): void => {
		e?.stopPropagation?.()
		e?.preventDefault?.()
		hideTip()
		if (state === 'working') return
		apply('working')
		void postTranslate({ sessionId, messageId, persist: true })
			.then((res) => {
				if (res?.ok === true) {
					// Stay "done": the card is now in the session and this state is
					// re-derived from it on every remount, so reverting to idle would
					// only make the affordance flicker back to looking un-translated.
					apply('done')
					return
				}
				apply('error')
				setTimeout(() => {
					if (!ACTION_INFLIGHT.has(key)) apply('idle')
				}, 3_000)
			})
			.catch(() => {
				apply('error')
				setTimeout(() => {
					if (!ACTION_INFLIGHT.has(key)) apply('idle')
				}, 3_000)
			})
	}

	const title =
		state === 'working'
			? tooltipText(props, 'tsl.translating', '翻译中…')
			: state === 'error'
				? tooltipText(props, 'tsl.retry', '重试')
				: state === 'done'
					? tooltipText(props, 'tsl.done', '已生成译文')
					: tooltipText(props, 'tsl.actionTip', '用 Gemini 把这条回复译成人话')

	const glyph =
		state === 'working'
			? spinnerGlyph()
			: state === 'done'
				? checkGlyph()
				: state === 'error'
					? errorGlyph()
					: geminiGlyph()

	return h(
		'span',
		{
			className: 'agy-tsl-wrap',
			onMouseEnter: (e?: { currentTarget?: unknown }) => showTip(e?.currentTarget, title),
			onFocus: (e?: { currentTarget?: unknown }) => showTip(e?.currentTarget, title),
			onMouseLeave: () => hideTip(),
			onBlur: () => hideTip(),
		},
		h(
			'button',
			{
				type: 'button',
				className: 'agy-tsl-icon',
				'data-state': state,
				disabled: state === 'working',
				onClick: run,
				'aria-label': title,
				style: iconButtonStyle(state),
			},
			glyph,
		),
	)
}
