// Shared platform/context primitives for the Gemini plain-language translation UI.
//
// Split out of translate.ts (behavior-preserving): the card renderer, the
// conversation-event record and the per-reply action all need the same React
// binding, the same browser globals and the same guarded service lookup. Keeping
// them here means one `win`, one `base` and one `service` instead of three
// divergent copies.

export type ReactApi = {
	createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown
	useState: <S>(initial: S | (() => S)) => [S, (next: S | ((prev: S) => S)) => void]
	useEffect: (setup: () => (() => void) | void, deps?: unknown[]) => void
};

const R = require('react') as ReactApi
export const { createElement: h, useState, useEffect } = R

export interface ClientContextLike {
	slots: {
		inject(name: string, register: () => () => void): void
		register(opts: Record<string, unknown>, Component: (props?: any) => unknown): () => void
	}
	get?: (name: string) => unknown
	[key: string]: unknown
}

export const win = globalThis as unknown as {
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

export const base = win.location?.origin ?? ''
// Bumped when the sheet gains rules: a stale tag under the old id can no longer
// suppress the new rules the way an unchanged id once did.
export const STYLE_ID = 'dsh-agy-link-tsl-css-v2'
export const TRANSLATION_KIND = 'agy-translation'
export const TRANSLATION_EVENT_TYPE = 'plugin:agy-link/translation'

export function service<T>(ctx: ClientContextLike, name: string): T | undefined {
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
