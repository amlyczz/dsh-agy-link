// Mermaid asset loader: stylesheet injection, the script tag, and the one
// lazy-load promise (with a cooldown so a failed load is retried, not frozen).
//
// Split out of mermaid.ts (behavior-preserving). mermaid.js is deliberately
// not bundled; it is fetched from the plugin route on first diagram.

import { CDN_URLS, MERMAID_CSS, preferredMermaidTheme, type MermaidApi } from './mermaid-config.ts'

let loadPromise: Promise<MermaidApi | null> | null = null
let loadFailedAt = 0
const LOAD_RETRY_MS = 60_000

export function injectStyles(): void {
	if (typeof document === 'undefined') return
	if (document.getElementById('agy-mermaid-css')) return
	const st = document.createElement('style')
	st.id = 'agy-mermaid-css'
	st.textContent = MERMAID_CSS
	document.head.appendChild(st)
}

function loadScript(src: string): Promise<boolean> {
	return new Promise((resolve) => {
		const s = document.createElement('script')
		s.src = src
		s.async = true
		let settled = false
		const done = (ok: boolean): void => {
			if (settled) return
			settled = true
			s.removeEventListener('load', onLoad)
			s.removeEventListener('error', onError)
			// A timed-out script tag used to stay in the DOM: a slow response
			// would still execute later and race the fallback load.
			if (!ok) s.remove()
			resolve(ok)
		}
		const onLoad = (): void => done(true)
		const onError = (): void => done(false)
		s.addEventListener('load', onLoad)
		s.addEventListener('error', onError)
		document.head.appendChild(s)
		// A hung CDN must not wedge the observer thread.
		setTimeout(() => done(false), 15_000)
	})
}

export async function loadMermaid(): Promise<MermaidApi | null> {
	if (typeof window === 'undefined') return null
	if (window.mermaid !== undefined) return window.mermaid
	if (loadPromise !== null) return loadPromise
	// A failed CDN load is retried after a cooldown instead of never.
	if (Date.now() - loadFailedAt < LOAD_RETRY_MS) return null
	loadPromise = (async () => {
		for (const url of CDN_URLS) {
			const ok = await loadScript(url)
			if (ok && window.mermaid !== undefined) {
				try {
					window.mermaid.initialize({
						startOnLoad: false,
						securityLevel: 'strict',
						theme: preferredMermaidTheme(),
						fontFamily: 'inherit',
						suppressErrorRendering: true,
						flowchart: {
							useMaxWidth: true,
							htmlLabels: false,
						},
					})
				} catch {
					// initialize is idempotent enough; keep going
				}
				return window.mermaid
			}
		}
		loadFailedAt = Date.now()
		loadPromise = null
		return null
	})()
	return loadPromise
}
