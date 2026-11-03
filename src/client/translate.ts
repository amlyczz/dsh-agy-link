// Client half of the Gemini plain-language translation (spec: .spec/translation.md).
//
// Rendering strategy: the host persists each translation as a
// `plugin:agy-link/translation` session record, and this module registers a
// Conversation event Definition that projects that record into a native chat
// node. DSH therefore places the card itself — in the timeline, right under the
// reply it translates — and the card survives reloads without any DOM surgery.
//
// Two more contributions live here:
//   * `conversation.chat.node` keyed `agy-translation` — the card renderer.
//   * `conversation.chat.assistant-actions` — the per-reply "译成人话" button
//     that requests a translation for one historical message.

type ReactApi = {
	createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown
	useState: <S>(initial: S | (() => S)) => [S, (next: S | ((prev: S) => S)) => void]
	useEffect: (setup: () => (() => void) | void, deps?: unknown[]) => void
};

const R = require('react') as ReactApi
const { createElement: h, useState, useEffect } = R

interface ClientContextLike {
	slots: {
		inject(name: string, register: () => () => void): void
		register(opts: Record<string, unknown>, Component: (props?: any) => unknown): () => void
	}
	get?: (name: string) => unknown
	[key: string]: unknown
}

interface ConversationEventsLike {
	register(definition: Record<string, unknown>): undefined | (() => void)
}

interface ConversationLike {
	events?: ConversationEventsLike
}

const win = globalThis as unknown as {
	location?: { origin?: string }
	fetch?: (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
	navigator?: { clipboard?: { writeText(text: string): Promise<void> } }
	document?: {
		body?: unknown
		head?: { appendChild(node: unknown): void } | null
		documentElement?: { appendChild(node: unknown): void } | null
		getElementById(id: string): unknown
		createElement(tag: string): { id: string; textContent: string }
	} | null
}

const base = win.location?.origin ?? ''
// Bumped when the sheet gains rules: a stale tag under the old id can no longer
// suppress the new rules the way an unchanged id once did.
const STYLE_ID = 'dsh-agy-link-tsl-css-v2'
export const TRANSLATION_KIND = 'agy-translation'
export const TRANSLATION_EVENT_TYPE = 'plugin:agy-link/translation'

const CSS = `
.agy-tsl-card {
  margin: 8px 0 2px 0;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28));
  border-left: 3px solid #8b5cf6;
  background: linear-gradient(180deg, rgba(99,102,241,.09), rgba(139,92,246,.04));
  overflow: hidden;
}
.agy-tsl-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 7px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary, #aaa);
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18));
}
.agy-tsl-badge {
  display: inline-flex; align-items: center; gap: 5px;
  font-weight: 700; font-size: 12px; color: #a78bfa;
  background: rgba(139,92,246,.14); border: 1px solid rgba(139,92,246,.35);
  padding: 2px 8px; border-radius: 999px;
}
.agy-tsl-meta { opacity: .85; font-variant-numeric: tabular-nums; }
.agy-tsl-spacer { flex: 1 1 auto; }
.agy-tsl-btn {
  background: transparent; border: 1px solid transparent; color: var(--dsw-alias-label-secondary, #aaa);
  border-radius: 6px; cursor: pointer; font-size: 12px; padding: 2px 7px;
}
.agy-tsl-btn:hover { background: var(--dsw-alias-interactive-bg-hover-solid, rgba(127,127,127,.16)); color: var(--dsw-alias-label-primary, #eee); }
.agy-tsl-body { padding: 9px 12px; font-size: 13.5px; line-height: 1.65; color: var(--dsw-alias-label-primary, #eee); }
.agy-tsl-body p { margin: 0 0 7px 0; }
.agy-tsl-body p:last-child { margin-bottom: 0; }
.agy-tsl-body ul, .agy-tsl-body ol { margin: 0 0 7px 0; padding-left: 20px; }
.agy-tsl-body li { margin: 2px 0; }
.agy-tsl-body h4, .agy-tsl-body h5 { margin: 8px 0 5px 0; font-size: 13.5px; }
.agy-tsl-body code { background: rgba(127,127,127,.18); border-radius: 4px; padding: 1px 4px; font-size: 12.5px; }
.agy-tsl-body pre { background: rgba(127,127,127,.14); border-radius: 8px; padding: 8px 10px; overflow-x: auto; margin: 0 0 7px 0; }
.agy-tsl-body pre code { background: transparent; padding: 0; }
.agy-tsl-original {
  margin: 0; padding: 8px 12px; border-top: 1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.28));
  font-size: 12.5px; color: var(--dsw-alias-label-secondary, #aaa); white-space: pre-wrap; max-height: 260px; overflow: auto;
}
/* Icon-only action that sits in the same strip as copy / thumbs / link, with
   the same neutral tint so it reads as part of that group. */
.agy-tsl-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-tertiary, #8a8f98);
  cursor: pointer; transition: background .15s ease, color .15s ease;
}
.agy-tsl-icon:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-solid, rgba(127,127,127,.14));
  color: var(--dsw-alias-label-primary, #eee);
}
.agy-tsl-icon:disabled { cursor: default; }
.agy-tsl-icon[data-state="working"] { color: var(--dsw-alias-state-business-primary, #2563eb); cursor: wait; }
.agy-tsl-icon[data-state="done"] { color: #10b981; }
.agy-tsl-icon[data-state="error"] { color: #ef4444; }
.agy-tsl-icon svg { width: 15px; height: 15px; display: block; }
@keyframes agy-tsl-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
/* Own tooltip: the native title bubble never showed inside the desktop shell,
   and DSH's Tooltip primitive is not exposed to plugin bundles. It mirrors that
   primitive: same tokens (--dsw-alias-tooltip-bg / --dsw-static-neutral-bluish-00
   / 13px-20px / 3px 7px / --dsw-radius-sm), no caret, BELOW the anchor, and — like
   the primitive's portal — a body-level fixed node, so the transcript
   scroller can neither clip it nor let the composer cover it. */
.agy-tsl-wrap { position: relative; display: inline-flex; align-items: center; }
.agy-tsl-tip {
  position: fixed; z-index: 1100;
  padding: 3px 7px; border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-tooltip-bg, #1f2229);
  color: var(--dsw-static-neutral-bluish-00, #fff);
  font-size: 13px; line-height: 20px; font-weight: 400; letter-spacing: normal;
  white-space: pre-line; overflow-wrap: break-word; text-align: center;
  box-sizing: border-box; width: max-content;
  max-width: min(50vw, calc(100vw - 24px));
  pointer-events: none;
  animation: agy-tsl-tip-in .15s var(--ds-ease-in-out, ease-in-out);
}
@keyframes agy-tsl-tip-in { 0% { opacity: 0; } 100% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .agy-tsl-tip { animation: none; }
}
`

function injectStyles(): void {
	if (typeof document === 'undefined') return
	const doc = win.document
	if (doc === null || doc === undefined) return
	const existing = doc.getElementById(STYLE_ID) as { textContent?: string } | null | undefined
	if (existing !== null && existing !== undefined) {
		// A plugin reload (the client HMR path, or a second copy of this plugin in
		// the same document) leaves the previous sheet behind. Returning early here
		// used to keep the OLD rules forever, so a newly added rule never applied —
		// that is exactly how the hover hint ended up rendered as plain inline text.
		if (existing.textContent !== CSS) existing.textContent = CSS
		return
	}
	const st = doc.createElement('style')
	st.id = STYLE_ID
	st.textContent = CSS
	const host = doc.head ?? doc.documentElement
	if (host) host.appendChild(st)
}

function service<T>(ctx: ClientContextLike, name: string): T | undefined {
	try {
		const fromGet = ctx.get?.(name)
		if (fromGet !== undefined && fromGet !== null) return fromGet as T
	} catch {
		// service not present in this composition
	}
	try {
		// Cordis throws when a non-injected service property is read, so this
		// stays guarded: an older UI without uiConversation must degrade, not crash.
		const direct = ctx[name]
		return direct === undefined || direct === null ? undefined : (direct as T)
	} catch {
		return undefined
	}
}

/** The session the visible conversation belongs to. */
export function currentSessionId(ctx: ClientContextLike): string {
	const uiSession = service<{ current?: { value?: Record<string, unknown> } }>(ctx, 'uiSession')
	const value = uiSession?.current?.value
	if (value !== undefined && value !== null) {
		for (const key of ['key', 'sessionId', 'id']) {
			const id = value[key]
			if (typeof id === 'string' && id !== '') return id
		}
	}
	const sessions = service<{ list?: { getSnapshot?: () => { byId?: Record<string, unknown> } } }>(ctx, 'sessions')
	const byId = sessions?.list?.getSnapshot?.()?.byId
	if (byId !== undefined && byId !== null) {
		const ids = Object.keys(byId)
		if (ids.length === 1 && ids[0] !== undefined) return ids[0]
	}
	return ''
}

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

// ---------------------------------------------------------------------------
// Minimal Markdown renderer.
// The translation is Markdown; DSH's own renderer is internal to the chat
// package, so this renders the small subset the translator prompt produces
// (headings, lists, fenced code, inline bold/code) without a dependency.
// Everything is created as React elements (never innerHTML), so model output
// cannot inject HTML.
// ---------------------------------------------------------------------------

function inline(text: string): unknown[] {
	const out: unknown[] = []
	const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
	let last = 0
	let m: RegExpExecArray | null
	let i = 0
	while ((m = re.exec(text)) !== null) {
		if (m.index > last) out.push(text.slice(last, m.index))
		const token = m[1] ?? ''
		if (token.startsWith('**')) out.push(h('strong', { key: 'b' + i }, token.slice(2, -2)))
		else out.push(h('code', { key: 'c' + i }, token.slice(1, -1)))
		last = m.index + token.length
		i++
	}
	if (last < text.length) out.push(text.slice(last) )
	return out
}

export function renderMarkdown(text: string): unknown {
	const lines = text.replace(/\r\n?/g, '\n').split('\n')
	const blocks: unknown[] = []
	let i = 0
	let key = 0
	while (i < lines.length) {
		const line = lines[i] ?? ''
		if (line.trim() === '') {
			i++
			continue
		}
		if (/^```/.test(line.trim())) {
			const lang = line.trim().slice(3).trim()
			const body: string[] = []
			i++
			while (i < lines.length && !/^```/.test((lines[i] ?? '').trim())) {
				body.push(lines[i] ?? '')
				i++
			}
			i++
			blocks.push(h('pre', { key: 'p' + key++ }, h('code', lang === '' ? null : { 'data-lang': lang }, body.join('\n'))))
			continue
		}
		if (/^#{1,4}\s+/.test(line)) {
			const label = line.replace(/^#{1,4}\s+/, '')
			blocks.push(h('h4', { key: 'h' + key++ }, inline(label)))
			i++
			continue
		}
		if (/^\s*[-*]\s+/.test(line)) {
			const items: unknown[] = []
			while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? '')) {
				items.push(h('li', { key: 'l' + key++ }, inline((lines[i] ?? '').replace(/^\s*[-*]\s+/, ''))))
				i++
			}
			blocks.push(h('ul', { key: 'u' + key++ }, items))
			continue
		}
		if (/^\s*\d+[.)]\s+/.test(line)) {
			const items: unknown[] = []
			while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] ?? '')) {
				items.push(h('li', { key: 'n' + key++ }, inline((lines[i] ?? '').replace(/^\s*\d+[.)]\s+/, ''))))
				i++
			}
			blocks.push(h('ol', { key: 'o' + key++ }, items))
			continue
		}
		const para: string[] = []
		while (i < lines.length) {
			const cur = lines[i] ?? ''
			if (cur.trim() === '' || /^```/.test(cur.trim()) || /^#{1,4}\s+/.test(cur) || /^\s*[-*]\s+/.test(cur) || /^\s*\d+[.)]\s+/.test(cur)) break
			para.push(cur)
			i++
		}
		blocks.push(h('p', { key: 't' + key++ }, inline(para.join('\n'))))
	}
	return h('div', null, blocks)
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface TranslationCardData {
	text?: string
	original?: string
	model?: string
	effort?: string
	accountId?: string
	createdAt?: number
}

const TranslationCard = (props?: Record<string, unknown>): unknown => {
	const node = (props?.node ?? {}) as { data?: TranslationCardData }
	const data = node.data ?? {}
	const t = (key: string, fallback?: string): string => {
		const fn = props?.t as ((k: string) => string) | undefined
		if (typeof fn !== 'function') return fallback ?? key
		try {
			const value = fn(key)
			return value === key && fallback !== undefined ? fallback : value
		} catch {
			return fallback ?? key
		}
	}
	const [open, setOpen] = useState(true)
	const [showOriginal, setShowOriginal] = useState(false)
	const [copied, setCopied] = useState(false)
	const text = typeof data.text === 'string' ? data.text : ''
	const original = typeof data.original === 'string' ? data.original : ''
	if (text.trim() === '') return null
	const meta: string[] = []
	if (typeof data.model === 'string' && data.model !== '') meta.push(data.model)
	if (typeof data.effort === 'string' && data.effort !== '') meta.push(data.effort)
	if (typeof data.accountId === 'string' && data.accountId !== '') meta.push(data.accountId)
	const copy = (): void => {
		void win.navigator?.clipboard?.writeText(text).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		}).catch(() => undefined)
	}
	return h(
		'div',
		{ className: 'agy-tsl-card', 'data-agy-translation': 'gemini', 'aria-label': t('tsl.badge', 'Gemini translation') },
		h(
			'div',
			{ className: 'agy-tsl-head' },
			h('span', { className: 'agy-tsl-badge' }, '✨ ' + t('tsl.badge', 'Gemini translation')),
			h('span', { className: 'agy-tsl-meta' }, meta.join(' · ')),
			h('span', { className: 'agy-tsl-spacer' }),
			h('button', { type: 'button', className: 'agy-tsl-btn', onClick: copy }, copied ? t('tsl.copied', 'Copied') : t('tsl.copy', 'Copy')),
			h('button', { type: 'button', className: 'agy-tsl-btn', onClick: () => setOpen(!open) }, open ? t('tsl.collapse', '收起') : t('tsl.expand', '展开')),
		),
		open ? h('div', { className: 'agy-tsl-body' }, renderMarkdown(text) as never) : null,
		original !== ''
			? h(
					'div',
					{ className: 'agy-tsl-head', style: { borderBottom: 'none', paddingTop: '0', paddingBottom: '6px' } },
					h('button', { type: 'button', className: 'agy-tsl-btn', onClick: () => setShowOriginal(!showOriginal) }, showOriginal ? t('tsl.hideOriginal', 'Hide original') : t('tsl.showOriginal', 'Show original')),
			  )
			: null,
		showOriginal && original !== '' ? h('pre', { className: 'agy-tsl-original' }, original) : null,
	)
}

// ---------------------------------------------------------------------------
// Per-turn and per-message affordances
// ---------------------------------------------------------------------------

type ActionState = 'idle' | 'working' | 'done' | 'error'

/** Four-point Gemini spark, filled with `currentColor` so it inherits the icon
 *  tint of DSH's action strip and looks native next to copy/thumbs/link. */
const GEMINI_STAR = 'M12 2 Q13.1 9.2 22 12 Q13.1 14.8 12 22 Q10.9 14.8 2 12 Q10.9 9.2 12 2 Z'

function geminiGlyph(): unknown {
	return h('svg', { viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true', style: { width: '15px', height: '15px', display: 'block' } },
		h('path', { d: GEMINI_STAR }),
	)
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
const TIP_ID = 'dsh-agy-link-tsl-tip'
const TIP_GAP_PX = 6
const TIP_MARGIN_PX = 8
const TIP_MAX_WIDTH_VW = 0.5

type TipNode = {
  textContent?: string
  isConnected?: boolean
  hidden?: boolean
  style: { cssText?: string; display?: string; left?: string; top?: string }
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
 * timeline virtualises nodes and DSH re-creates the whole panel when the window
 * regains focus, which used to reset the button to `idle` mid-flight. The map is
 * the in-page truth; the host's durable record is the truth across page loads.
 */
const ACTION_STATE = new Map<string, ActionState>()
const ACTION_INFLIGHT = new Set<string>()

/**
 * Icon-only "translate with Gemini" action rendered into the assistant action
 * strip (`conversation.chat.assistant-actions`), so it lines up with copy,
 * thumbs, link and usage. The label lives in the hover tooltip only.
 */
const TranslateAction = (props?: Record<string, unknown>): unknown => {
	const messageId = typeof props?.messageId === 'string' ? props.messageId : ''
	const injectedSession = typeof props?.sessionId === 'string' ? props.sessionId : ''
	const ctx = props?.ctx as ClientContextLike | undefined
	const sessionId = injectedSession !== '' ? injectedSession : ctx === undefined ? '' : currentSessionId(ctx)
	const key = sessionId + '\u0000' + messageId
	const [state, setState] = useState<ActionState>(() =>
		ACTION_INFLIGHT.has(key) ? 'working' : ACTION_STATE.get(key) ?? 'idle',
	)

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
			ACTION_STATE.set(key, next)
			if (next === 'working') ACTION_INFLIGHT.add(key)
			setState((prev) => (prev === next ? prev : next))
		})
		return () => {
			alive = false
		}
	}, [key, messageId, sessionId])

	if (messageId === '' || sessionId === '') return null

	const apply = (next: ActionState): void => {
		ACTION_STATE.set(key, next)
		setState(next)
	}

	const run = (e?: { stopPropagation?: () => void; preventDefault?: () => void }): void => {
		e?.stopPropagation?.()
		e?.preventDefault?.()
		hideTip()
		if (state === 'working') return
		ACTION_INFLIGHT.add(key)
		apply('working')
		void postTranslate({ sessionId, messageId, persist: true })
			.then((res) => {
				ACTION_INFLIGHT.delete(key)
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
				ACTION_INFLIGHT.delete(key)
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
				style: {
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
								? '#10b981'
								: state === 'error'
									? '#ef4444'
									: 'var(--dsw-alias-label-tertiary, #8a8f98)',
					cursor: state === 'working' ? 'wait' : 'pointer',
				},
			},
			glyph,
		),
	)
}

// ---------------------------------------------------------------------------
// Conversation event Definition
// ---------------------------------------------------------------------------

export function translationDefinition(): Record<string, unknown> {
	return {
		kind: TRANSLATION_KIND,
		target: 'chat',
		match: (event: { type?: string; seq?: number; data?: unknown } | null) =>
			event !== null && event.type === TRANSLATION_EVENT_TYPE ? { id: String(event.seq ?? 0), role: 'start' } : null,
		start: (_context: unknown, match: { event?: { seq?: number; data?: unknown } }) => {
			const ev = match.event ?? {}
			const data = (ev.data ?? {}) as Record<string, unknown>
			return {
				seq: typeof ev.seq === 'number' ? ev.seq : 0,
				turn: typeof data.turn === 'number' ? data.turn : 0,
				anchorSeq: typeof data.anchorSeq === 'number' ? data.anchorSeq : typeof ev.seq === 'number' ? ev.seq : 0,
				text: typeof data.text === 'string' ? data.text : '',
				model: typeof data.model === 'string' ? data.model : '',
				effort: typeof data.effort === 'string' ? data.effort : '',
				accountId: typeof data.accountId === 'string' ? data.accountId : '',
				createdAt: typeof data.createdAt === 'number' ? data.createdAt : 0,
			}
		},
		update: (context: { state?: unknown }) => context.state,
		buildViewNode: (context: {
			key: string
			id: string
			state?: Record<string, unknown>
			start?: { location?: unknown }
		}) => {
			const state = context.state
			if (state === undefined || typeof state.text !== 'string' || state.text.trim() === '') return null
			const anchorSeq = typeof state.anchorSeq === 'number' ? state.anchorSeq : 0
			return {
				key: context.key,
				kind: TRANSLATION_KIND,
				id: context.id,
				target: 'chat',
				// Sit immediately under the assistant message this card translates.
				anchorSeq: anchorSeq + 0.1,
				location: context.start?.location ?? { kind: 'unresolved' },
				visibility: 'visible',
				data: state,
			}
		},
	}
}

/** Mount the card renderer, the event Definition and both affordances. */
export function installTranslationUi(ctx: ClientContextLike, localeNs: string): () => void {
	injectStyles()
	const disposers: Array<() => void> = []

	const conversation = service<ConversationLike>(ctx, 'uiConversation')
	if (conversation?.events !== undefined && typeof conversation.events.register === 'function') {
		try {
			const dispose = conversation.events.register(translationDefinition())
			if (typeof dispose === 'function') disposers.push(dispose)
		} catch (e) {
			console.warn('[dsh-agy-link] translation definition registration failed:', e)
		}
	}

	try {
		// Keyed slot: the key IS the row identity (one card renderer per node kind).
		ctx.slots.inject('conversation.chat.node', () =>
			ctx.slots.register({ name: 'conversation.chat.node', key: TRANSLATION_KIND, locale: localeNs }, TranslationCard as never),
		)
		// List slots: `id` is the row identity (a registration without one never
		// renders), and a session-scoped `inject(sessionId)` face is what hands
		// the component the owning session.
		ctx.slots.inject('conversation.chat.assistant-actions', () =>
			ctx.slots.register(
				{
					name: 'conversation.chat.assistant-actions',
					id: 'agy-tsl-message',
					order: 20,
					locale: localeNs,
					inject: (sessionId: string) => ({ sessionId }),
				},
				((props?: Record<string, unknown>) => TranslateAction({ ...(props ?? {}), ctx })) as never,
			),
		)
	} catch (e) {
		// A UI without the chat slots keeps the event Definition (history cards
		// still render) and simply loses the affordances.
		console.warn('[dsh-agy-link] translation slots unavailable:', e)
	}

	return () => {
		for (const dispose of disposers) {
			try {
				dispose()
			} catch {
				// already torn down with the plugin fiber
			}
		}
		// The hint node lives on <body> (outside this fiber's subtree), so drop it
		// explicitly — and the style sheet with it.
		try {
			const doc = win.document as unknown as { getElementById?: (id: string) => { remove?: () => void } | null } | null | undefined
			doc?.getElementById?.(TIP_ID)?.remove?.()
			doc?.getElementById?.(STYLE_ID)?.remove?.()
		} catch {
			// best-effort teardown
		}
	}
}
