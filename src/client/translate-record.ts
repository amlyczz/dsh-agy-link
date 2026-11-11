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
