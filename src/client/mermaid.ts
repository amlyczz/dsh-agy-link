// Client-side mermaid rendering (dsh-agy-link).
//
// DSH's markdown pipeline (marked + shiki) has no mermaid grammar: a
// ```mermaid fence falls through `highlightToHtml` as unknown language and
// lands as a plain <pre> inside div.md-code-block, with the
// fence language printed in the banner infostring. So the diagram source is
// in the DOM — it just never gets drawn.
//
// Approach: non-destructive overlay. React owns the code-block subtree, so
// we never rewrite data-code-block-content; we insert a sibling render
// node and hide the source pre via a class. A MutationObserver re-tries
// whenever React rebuilds the block.
//
// mermaid.js is NOT bundled (it would 8x client.js). It is lazy-loaded on
// the first diagram; when that fails (offline / blocked CDN) the source
// block is left visible. Failed loads are retried after a cooldown.
//
// Split across mermaid-config (theme/fence config), mermaid-loader (asset
// loading) and mermaid-render (overlay/scanner); this file owns the observer
// lifecycle and re-exports the original public API.

import { onScrollSettle } from './scroll-guard.ts'
import { injectStyles } from './mermaid-loader.ts'
import { cleanupTempElements, scan, scheduleScan, cancelScheduledScan } from './mermaid-render.ts'

export { MERMAID_CSS, looksLikeMermaidSource, isMermaidBlock, isMermaidFence } from './mermaid-config.ts'
export {
	cleanupTempElements,
	repairMermaidSource,
	isInvalidOrCollapsedSvg,
	enqueueMermaidRender,
	sourceSignature,
	mermaidScanAction,
} from './mermaid-render.ts'
export type { MermaidScanAction } from './mermaid-render.ts'

let activeObserver: MutationObserver | null = null
let domContentLoadedHandler: (() => void) | null = null
let unbindMermaidSettle: (() => void) | null = null

/**
 * Install the mermaid overlay. Returns a disposer that disconnects the
 * MutationObserver and cancels pending setup — wrap it in ctx.effect so a
 * plugin reload cannot stack observers over the same document.
 */
export function installMermaidRendering(): () => void {
	if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
	// A previous install (plugin reload) must not keep observing forever.
	disposeMermaidRendering()
	injectStyles()
	cleanupTempElements()
	const observer = new MutationObserver(() => {
		scheduleScan()
	})
	activeObserver = observer
	unbindMermaidSettle = onScrollSettle(() => {
		scheduleScan()
	})
	const setup = (): void => {
		if (document.body) {
			cleanupTempElements()
			observer.observe(document.body, { childList: true, subtree: true })
			scan()
		}
	}
	if (document.readyState === 'loading') {
		domContentLoadedHandler = setup
		window.addEventListener('DOMContentLoaded', setup, { once: true })
	} else {
		setup()
	}
	return disposeMermaidRendering
}

/** Disconnect the observer and cancel pending setup work. */
export function disposeMermaidRendering(): void {
	if (activeObserver !== null) {
		activeObserver.disconnect()
		activeObserver = null
	}
	if (unbindMermaidSettle !== null) {
		unbindMermaidSettle()
		unbindMermaidSettle = null
	}
	if (domContentLoadedHandler !== null) {
		window.removeEventListener('DOMContentLoaded', domContentLoadedHandler)
		domContentLoadedHandler = null
	}
	cancelScheduledScan()
}
