// Translation conversation-event record (anchors/records).
//
// Split out of translate.ts (behavior-preserving). The host persists each
// translation as a `plugin:agy-link/translation` session record; this Definition
// projects that record into a chat node anchored just below the reply it
// translates, so DSH owns placement and the card survives reloads.

import { TRANSLATION_KIND, TRANSLATION_EVENT_TYPE } from './translate-context.ts'

// ---------------------------------------------------------------------------
// Conversation event Definition
// ---------------------------------------------------------------------------

function stateOf(ev: { seq?: number; data?: unknown }): Record<string, unknown> {
	const data = (ev.data ?? {}) as Record<string, unknown>
	return {
		seq: typeof ev.seq === 'number' ? ev.seq : 0,
		turn: typeof data.sourceTurn === 'number' ? data.sourceTurn : typeof data.turn === 'number' ? data.turn : 0,
		anchorSeq: typeof data.anchorSeq === 'number' ? data.anchorSeq : typeof ev.seq === 'number' ? ev.seq : 0,
		text: typeof data.text === 'string' ? data.text : '',
		original: typeof data.original === 'string' ? data.original : '',
		model: typeof data.model === 'string' ? data.model : '',
		effort: typeof data.effort === 'string' ? data.effort : '',
		accountId: typeof data.accountId === 'string' ? data.accountId : '',
		createdAt: typeof data.createdAt === 'number' ? data.createdAt : 0,
	}
}

export function translationDefinition(): Record<string, unknown> {
	return {
		kind: TRANSLATION_KIND,
		target: 'chat',
		// One node per translated reply: a forced re-translation of the same message
		// updates that node instead of stacking a second card (in replace mode every
		// stacked card would show). Legacy records without messageId stay per-record.
		match: (event: { type?: string; seq?: number; data?: unknown } | null) => {
			if (event === null || event.type !== TRANSLATION_EVENT_TYPE) return null
			const messageId = (event.data as { messageId?: unknown } | undefined)?.messageId
			return { id: typeof messageId === 'string' && messageId !== '' ? 'msg:' + messageId : String(event.seq ?? 0), role: 'start' }
		},
		start: (_context: unknown, match: { event?: { seq?: number; data?: unknown } }) => stateOf(match.event ?? {}),
		// The newest record wins; an empty one never blanks a good translation.
		update: (context: { state?: unknown }, match: { event?: { seq?: number; data?: unknown } }) => {
			const next = stateOf(match.event ?? {})
			return (next.text as string).trim() === '' ? context.state : next
		},
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
				// Session-level location + `groupTree: 'turn'` keeps the card out of
				// DSH's collapsible ProcessGroup (where a 0-tool group hides it) and
				// prevents TurnGroups from regrouping or disrupting later turns.
				location: { kind: 'session' },
				groupTree: 'turn',
				visibility: 'visible',
				data: state,
			}
		},
	}
}
