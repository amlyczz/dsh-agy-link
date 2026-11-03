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
const STYLE_ID = 'dsh-agy-link-tsl-css'
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
.agy-tsl-action {
  display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px;
  border-radius: 999px; border: 1px solid rgba(139,92,246,.35); background: rgba(139,92,246,.10);
  color: #a78bfa; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap;
}
.agy-tsl-action:hover { background: rgba(139,92,246,.2); }
.agy-tsl-action[data-state="working"] { opacity: .7; cursor: progress; }
.agy-tsl-action[data-state="error"] { border-color: rgba(244,63,94,.5); color: #f43f5e; background: rgba(244,63,94,.1); }
.agy-tsl-row { display: flex; align-items: center; gap: 6px; padding: 2px 0 4px 2px; }
`

function injectStyles(): void {
	if (typeof document === 'undefined') return
	const doc = win.document
	if (doc === null || doc === undefined) return
	if (doc.getElementById(STYLE_ID) !== null) return
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

type ActionState = 'idle' | 'working' | 'done' | 'error' | 'hidden'

async function getTurnState(sessionId: string, turn: number): Promise<{ state?: string } | null> {
	try {
		const res = await win.fetch?.(
			base + '/plugins/agy-link/translate/turn?session=' + encodeURIComponent(sessionId) + '&turn=' + String(turn),
		)
		if (!res || !res.ok) return null
		return (await res.json()) as { state?: string }
	} catch {
		return null
	}
}

function translateLabel(props: Record<string, unknown> | undefined, key: string, fallback: string): string {
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
 * Per-reply hover action ("译成人话"). Session scopes hand the owning session id
 * through the slot's `inject(sessionId)` face, so no global session lookup is
 * needed here.
 */
const TranslateAction = (props?: Record<string, unknown>): unknown => {
	const messageId = typeof props?.messageId === 'string' ? props.messageId : ''
	const injectedSession = typeof props?.sessionId === 'string' ? props.sessionId : ''
	const ctx = props?.ctx as ClientContextLike | undefined
	const fallbackSession = injectedSession === '' && ctx !== undefined ? currentSessionId(ctx) : ''
	const sessionId = injectedSession !== '' ? injectedSession : fallbackSession
	const [state, setState] = useState<ActionState>('idle')
	if (messageId === '') return null
	const run = (): void => {
		if (state === 'working' || sessionId === '') return
		setState('working')
		void postTranslate({ sessionId, messageId, persist: true }).then((res) => {
			setState(res?.ok === true ? 'done' : 'error')
			setTimeout(() => setState('idle'), 2_000)
		}).catch(() => setState('error'))
	}
	const label =
		state === 'working'
			? translateLabel(props, 'tsl.translating', 'Translating…')
			: state === 'done'
				? translateLabel(props, 'tsl.badge', 'Gemini translation')
				: state === 'error'
					? translateLabel(props, 'tsl.retry', 'Retry')
					: '🗣 ' + translateLabel(props, 'tsl.translate', 'Translate to plain language')
	return h('button', { type: 'button', className: 'agy-tsl-action', 'data-state': state, onClick: run, title: translateLabel(props, 'tsl.byGemini', 'Translated by Gemini') }, label)
}

/**
 * Per-turn chip shown at the end of every completed turn. This is the visible
 * "Gemini 翻译" option the user asked for: it appears after each turn, hides
 * itself once a durable translation exists for that turn, and pays nothing
 * until clicked.
 */
const TurnTranslateChip = (props?: Record<string, unknown>): unknown => {
	const injectedSession = typeof props?.sessionId === 'string' ? props.sessionId : ''
	const ctx = props?.ctx as ClientContextLike | undefined
	const fallbackSession = injectedSession === '' && ctx !== undefined ? currentSessionId(ctx) : ''
	const sessionId = injectedSession !== '' ? injectedSession : fallbackSession
	const rawTurn = props?.turn as { turn?: unknown } | number | undefined
	const turn =
		typeof rawTurn === 'number'
			? rawTurn
			: rawTurn !== null && typeof rawTurn === 'object' && typeof rawTurn.turn === 'number'
				? rawTurn.turn
				: undefined
	const [state, setState] = useState<ActionState>('idle')
	useEffect(() => {
		if (sessionId === '' || turn === undefined) return
		let cancelled = false
		void getTurnState(sessionId, turn).then((res) => {
			if (!cancelled && res?.state === 'ready') setState('hidden')
		})
		return () => {
			cancelled = true
		}
	}, [sessionId, turn])
	if (sessionId === '' || turn === undefined) return null
	if (state === 'hidden' || state === 'done') return null
	const run = (): void => {
		if (state === 'working') return
		setState('working')
		void postTranslate({ sessionId, turn, persist: true }).then((res) => {
			setState(res?.ok === true ? 'done' : 'error')
			if (res?.ok !== true) setTimeout(() => setState('idle'), 2_500)
		}).catch(() => setState('error'))
	}
	const label =
		state === 'working'
			? '✨ ' + translateLabel(props, 'tsl.translating', 'Translating…')
			: state === 'error'
				? translateLabel(props, 'tsl.retry', 'Retry')
				: '🗣 ' + translateLabel(props, 'tsl.translate', 'Translate to plain language')
	return h('div', { className: 'agy-tsl-row' },
		h('button', {
			type: 'button',
			className: 'agy-tsl-action',
			'data-state': state,
			onClick: run,
			title: translateLabel(props, 'tsl.byGemini', 'Translated by Gemini'),
		}, label),
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
		ctx.slots.inject('conversation.chat.turnTail', () =>
			ctx.slots.register(
				{
					name: 'conversation.chat.turnTail',
					id: 'agy-tsl-turn',
					order: 20,
					locale: localeNs,
					inject: (sessionId: string) => ({ sessionId }),
				},
				((props?: Record<string, unknown>) => TurnTranslateChip({ ...(props ?? {}), ctx })) as never,
			),
		)
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
	}
}
