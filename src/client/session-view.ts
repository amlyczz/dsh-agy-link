// Per-conversation account readout for the header badge.
//
// Deliberately separate from the shared `/status` poll: that snapshot is one
// process-wide payload (and it carries the `google` pointer), while the badge
// must describe THIS conversation's model family. A short local poll keeps the
// badge in step with a model switch without touching the shared ETag cache.
import type { SessionView } from '../common/session-view.ts'
import { getJson, win } from './api.ts'
import { useEffect, useState } from './react.ts'
import { isScrollActive, onScrollIdle } from './scroll-guard.ts'

/** Fast enough that switching model/account re-labels the badge immediately. */
const SESSION_VIEW_POLL_MS = 1500

export function isSessionViewEqual(a: SessionView | null, b: SessionView | null): boolean {
	if (a === b) return true
	if (a === null || b === null) return false
	return (
		a.model === b.model &&
		a.family === b.family &&
		a.accountId === b.accountId &&
		a.alias === b.alias &&
		a.email === b.email &&
		a.defaultAlias === b.defaultAlias &&
		a.systemHome === b.systemHome &&
		a.source === b.source &&
		a.percent === b.percent &&
		a.window === b.window &&
		a.stale === b.stale &&
		a.cooling === b.cooling &&
		a.eligible === b.eligible
	)
}

export function useSessionView(sessionId: string): SessionView | null {
	const [view, setView] = useState<SessionView | null>(null)
	useEffect(() => {
		if (sessionId === '') return
		let cancelled = false
		let pendingView: SessionView | null = null
		let cancelScrollWait: (() => void) | null = null

		const commitView = (next: SessionView): void => {
			setView((prev) => (isSessionViewEqual(prev, next) ? prev : next))
		}

		const tick = async (): Promise<void> => {
			if ((win.document as { hidden?: boolean } | undefined)?.hidden === true) return
			const next = await getJson<SessionView>(
				`/plugins/agy-link/session-view?session=${encodeURIComponent(sessionId)}`,
			)
			if (cancelled || next === null || typeof next !== 'object') return
			// Never re-render the header/overlay tree mid-scroll; flush once settled.
			if (isScrollActive()) {
				pendingView = next
				if (!cancelScrollWait) {
					cancelScrollWait = onScrollIdle(() => {
						cancelScrollWait = null
						if (cancelled || pendingView === null) return
						const deferred = pendingView
						pendingView = null
						commitView(deferred)
					})
				}
				return
			}
			pendingView = null
			if (cancelScrollWait) {
				cancelScrollWait()
				cancelScrollWait = null
			}
			commitView(next)
		}
		void tick()
		const timer = setInterval(() => { void tick() }, SESSION_VIEW_POLL_MS)
		return () => {
			cancelled = true
			clearInterval(timer)
			pendingView = null
			if (cancelScrollWait) {
				cancelScrollWait()
				cancelScrollWait = null
			}
		}
	}, [sessionId])
	return view
}