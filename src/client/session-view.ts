// Per-conversation account readout for the header badge.
//
// Deliberately separate from the shared `/status` poll: that snapshot is one
// process-wide payload (and it carries the `google` pointer), while the badge
// must describe THIS conversation's model family. A short local poll keeps the
// badge in step with a model switch without touching the shared ETag cache.
import type { SessionView } from '../common/session-view.ts'
import { getJson, win } from './api.ts'
import { useEffect, useState } from './react.ts'

/** Fast enough that switching model/account re-labels the badge immediately. */
const SESSION_VIEW_POLL_MS = 1500

export function useSessionView(sessionId: string): SessionView | null {
	const [view, setView] = useState<SessionView | null>(null)
	useEffect(() => {
		if (sessionId === '') return
		let cancelled = false
		const tick = async (): Promise<void> => {
			if ((win.document as { hidden?: boolean } | undefined)?.hidden === true) return
			const next = await getJson<SessionView>(
				`/plugins/agy-link/session-view?session=${encodeURIComponent(sessionId)}`,
			)
			if (!cancelled && next !== null && typeof next === 'object') setView(next)
		}
		void tick()
		const timer = setInterval(() => { void tick() }, SESSION_VIEW_POLL_MS)
		return () => {
			cancelled = true
			clearInterval(timer)
		}
	}, [sessionId])
	return view
}