// ACP post-turn report & channel-notice cards.
//
// The ACP transport keeps streaming after a turn has ended: background tasks and
// subagents keep narrating. Those frames are the model's OWN words, so spending
// a fresh model turn to re-read them is pure waste (and on a busy session it
// doubles the visible reply). The host instead persists them as plugin session
// records and this Definition projects each one into a chat node, exactly like
// the translation card does — the text stays visible, the transcript stays
// append-only, and nothing enters the model-visible surface.

import { h, registerConversationDefinitions, win, type ClientContextLike } from './translate-context.ts'
import { translateOr } from './i18n-bridge.ts'

export const ACP_REPORT_KIND = 'agy-acp-report'
export const ACP_REPORT_EVENT_TYPE = 'plugin:agy-link/acp-report'
export const ACP_NOTICE_KIND = 'agy-acp-notice'
export const ACP_NOTICE_EVENT_TYPE = 'plugin:agy-link/acp-notice'

const CARD_STYLE_ID = 'dsh-agy-link-acp-css-v1'

type ChatNodeContext = {
	key: string
	id: string
	state?: Record<string, unknown>
	start?: { location?: unknown }
}

function nodeOf(context: ChatNodeContext, kind: string, data: Record<string, unknown>): Record<string, unknown> | null {
	if (data === undefined) return null
	const seq = typeof data.seq === 'number' ? data.seq : 0
	return {
		key: context.key,
		kind,
		id: context.id,
		target: 'chat',
		// Records are appended after the turn they belong to, so plain sequence
		// order already places them at the end of the conversation.
		anchorSeq: seq,
		location: context.start?.location ?? { kind: 'unresolved' },
		visibility: 'visible',
		data,
	}
}

export function acpReportDefinition(): Record<string, unknown> {
	return {
		kind: ACP_REPORT_KIND,
		target: 'chat',
		match: (event: { type?: string; seq?: number } | null) =>
			event !== null && event.type === ACP_REPORT_EVENT_TYPE ? { id: String(event.seq ?? 0), role: 'start' } : null,
		start: (_context: unknown, match: { event?: { seq?: number; data?: unknown } }) => {
			const ev = match.event ?? {}
			const data = (ev.data ?? {}) as Record<string, unknown>
			return {
				seq: typeof ev.seq === 'number' ? ev.seq : 0,
				text: typeof data.text === 'string' ? data.text : '',
				at: typeof data.at === 'number' ? data.at : 0,
			}
		},
		update: (context: { state?: unknown }) => context.state,
		buildViewNode: (context: ChatNodeContext) => {
			const state = context.state
			if (state === undefined || typeof state.text !== 'string' || state.text.trim() === '') return null
			return nodeOf(context, ACP_REPORT_KIND, state)
		},
	}
}

export function acpNoticeDefinition(): Record<string, unknown> {
	return {
		kind: ACP_NOTICE_KIND,
		target: 'chat',
		match: (event: { type?: string; seq?: number } | null) =>
			event !== null && event.type === ACP_NOTICE_EVENT_TYPE ? { id: String(event.seq ?? 0), role: 'start' } : null,
		start: (_context: unknown, match: { event?: { seq?: number; data?: unknown } }) => {
			const ev = match.event ?? {}
			const data = (ev.data ?? {}) as Record<string, unknown>
			return {
				seq: typeof ev.seq === 'number' ? ev.seq : 0,
				kind: typeof data.kind === 'string' ? data.kind : '',
				text: typeof data.text === 'string' ? data.text : '',
				at: typeof data.at === 'number' ? data.at : 0,
			}
		},
		update: (context: { state?: unknown }) => context.state,
		buildViewNode: (context: ChatNodeContext) => {
			const state = context.state
			if (state === undefined || typeof state.text !== 'string' || state.text.trim() === '') return null
			return nodeOf(context, ACP_NOTICE_KIND, state)
		},
	}
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function textBlock(text: string, className: string): unknown {
	const lines = text.split('\n')
	return h(
		'div',
		{ className },
		...lines.map((line, i) => (line === '' ? h('div', { key: String(i), className: 'agy-acp-gap' }) : h('div', { key: String(i) }, line))),
	)
}

function shell(badge: string, body: unknown, hint: string): unknown {
	return h(
		'div',
		{ className: 'agy-acp-card' },
		h(
			'div',
			{ className: 'agy-acp-head' },
			h('span', { className: 'agy-acp-badge' }, badge),
			h('span', { className: 'agy-acp-hint' }, hint),
		),
		body,
	)
}

/** The ACP turn's own post-turn narration (background task / subagent progress). */
export function AcpReportCard(props?: { node?: { data?: Record<string, unknown> } }): unknown {
	const data = props?.node?.data ?? {}
	const text = typeof data.text === 'string' ? data.text.trim() : ''
	if (text === '') return null
	return shell(
		translateOr('acp.reportBadge', 'agy background report'),
		textBlock(text, 'agy-acp-body'),
		translateOr('acp.reportHint', 'Pushed by agy · no extra turn spent'),
	)
}

/** A channel-level notice: session rebuilt from history, or a task cut by an account switch. */
export function AcpNoticeCard(props?: { node?: { data?: Record<string, unknown> } }): unknown {
	const data = props?.node?.data ?? {}
	const text = typeof data.text === 'string' ? data.text.trim() : ''
	if (text === '') return null
	const kind = typeof data.kind === 'string' ? data.kind : ''
	// The host writes one bilingual string so the record is readable outside the
	// GUI; the card prefers the viewer's own language and falls back to it.
	const drain = kind === 'acp-drain-aborted'
	const badge = drain
		? translateOr('acp.drainBadge', 'agy background task stopped')
		: translateOr('acp.resetBadge', 'agy session rebuilt')
	const body = drain
		? translateOr('acp.drainText', text)
		: translateOr('acp.resetText', text)
	return shell(badge, textBlock(body, 'agy-acp-body'), translateOr('acp.noticeHint', 'agy channel notice'))
}

const ACP_CSS = `
.agy-acp-card {
	margin: 8px 0;
	padding: 10px 12px;
	border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24));
	border-radius: var(--dsw-alias-radius-md, 8px);
	background: transparent;
	font-size: 13px;
	line-height: 1.6;
}
.agy-acp-head {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-bottom: 6px;
}
.agy-acp-badge {
	font-size: 11px;
	font-weight: 600;
	letter-spacing: 0.02em;
	color: var(--dsw-alias-label-secondary, #666);
	text-transform: none;
}
.agy-acp-hint {
	font-size: 11px;
	color: var(--dsw-alias-label-tertiary, #888);
}
.agy-acp-body {
	white-space: pre-wrap;
	word-break: break-word;
	color: var(--dsw-alias-label-primary, inherit);
}
.agy-acp-gap {
	height: 6px;
}
`

function injectStyles(): void {
	try {
		const doc = win.document
		if (!doc || doc.getElementById(CARD_STYLE_ID) !== null) return
		const el = doc.createElement('style')
		el.id = CARD_STYLE_ID
		el.textContent = ACP_CSS
		;(doc.head ?? doc.documentElement)?.appendChild(el)
	} catch {
		// a host without a document (SSR/tests) simply skips the sheet
	}
}

export function installAcpCards(ctx: ClientContextLike, localeNs: string): () => void {
	injectStyles()
	const teardowns: Array<() => void> = []
	// Definitions are what turn the persisted records into chat nodes; a host
	// without uiConversation simply shows no cards for them.
	teardowns.push(registerConversationDefinitions(ctx, 'acp', () => [acpReportDefinition(), acpNoticeDefinition()]))
	try {
		teardowns.push(
			ctx.slots.inject('conversation.chat.node', () =>
				ctx.slots.register({ name: 'conversation.chat.node', key: ACP_REPORT_KIND, locale: localeNs }, AcpReportCard as never),
			) ?? (() => {}),
		)
		teardowns.push(
			ctx.slots.inject('conversation.chat.node', () =>
				ctx.slots.register({ name: 'conversation.chat.node', key: ACP_NOTICE_KIND, locale: localeNs }, AcpNoticeCard as never),
			) ?? (() => {}),
		)
	} catch {
		// A UI without the chat slots keeps the Definitions above; nothing else breaks.
	}
	return () => {
		for (const off of teardowns) {
			try {
				off()
			} catch {
				// ignore teardown races
			}
		}
		try {
			const doc = win.document
			const el = doc?.getElementById(CARD_STYLE_ID) as { remove?: () => void } | null
			el?.remove?.()
		} catch {
			// ignore
		}
	}
}
