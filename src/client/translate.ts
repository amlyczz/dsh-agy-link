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
//
// The implementation is split across translate-card/_record/_state (and the
// shared translate-context) so each surface stays reviewable; this file keeps
// the install entry point and re-exports the original public API.

import { STYLE_ID, win, service, TRANSLATION_KIND, type ClientContextLike } from './translate-context.ts'
import { injectStyles, TranslationCard } from './translate-card.ts'
import { TranslateAction, TIP_ID } from './translate-state.ts'
import { translationDefinition } from './translate-record.ts'

export { TRANSLATION_KIND, TRANSLATION_EVENT_TYPE, currentSessionId } from './translate-context.ts'
export { renderMarkdown } from './translate-card.ts'
export { actionStateOf, setActionState, subscribeActionState } from './translate-state.ts'
export { translationDefinition }

interface ConversationEventsLike {
	register(definition: Record<string, unknown>): undefined | (() => void)
}

interface ConversationLike {
	events?: ConversationEventsLike
}

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
