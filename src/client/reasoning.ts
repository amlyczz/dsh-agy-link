// Client-side reasoning presentation (dsh-agy-link).
//
// DSH web renders assistant reasoning as <div data-variant="think"> rows,
// default collapsed. We must NOT rewrite React-managed thinkBody DOM:
// clearing textContent destroys host-owned nodes and the block goes blank
// after the turn finishes and React re-renders from the message model.
//
// Approach: CSS-only styling + non-destructive disclosure click assist.
// Thought text (including [agy thinking turn · N tokens] banners) stays in
// the host's own text nodes.

const REASONING_CSS = `
/* Hover affordance on thinking disclosure rows */
div[data-variant="think"] [data-disclosure-row]:hover [class*="iconIdle"],
div[data-variant="think"] [class*="row"]:hover [class*="iconIdle"] {
	opacity: 0 !important;
}
div[data-variant="think"] [data-disclosure-row]:hover [class*="chevronHover"],
div[data-variant="think"] [class*="row"]:hover [class*="chevronHover"] {
	opacity: 1 !important;
}

/* Scrollable thinking body (does not touch DOM structure) */
div[data-variant="think"] [class*="thinkBody"] {
	max-height: 360px;
	overflow-y: auto;
	overflow-x: hidden;
	white-space: pre-wrap;
	word-break: break-word;
	padding-right: 8px;
	scrollbar-width: thin;
	scrollbar-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.2)) transparent;
}
div[data-variant="think"] [class*="thinkBody"]::-webkit-scrollbar {
	width: 6px;
	height: 6px;
}
div[data-variant="think"] [class*="thinkBody"]::-webkit-scrollbar-thumb {
	background: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.18));
	border-radius: 6px;
	background-clip: padding-box;
}
div[data-variant="think"] [class*="thinkBody"]::-webkit-scrollbar-track {
	background: transparent;
	margin: 4px 0;
}

/* Style leading banner token sequence without rewriting DOM: host text nodes
   keep ownership; this only paints the first line if the host wraps it. */
div[data-variant="think"] [class*="thinkBody"] > span:first-child,
div[data-variant="think"] [class*="thinkBody"] {
	font-family: inherit;
}
`;

function injectStyles(): void {
	if (typeof document === 'undefined') return;
	const styleId = 'dsh-agy-link-reasoning-css';
	if (document.getElementById(styleId) === null) {
		const st = document.createElement('style');
		st.id = styleId;
		st.textContent = REASONING_CSS;
		const host = document.head ?? document.documentElement;
		if (host) host.appendChild(st);
	}
}

/**
 * Try to expand a thinking row once when its body contains real prose
 * (not a bare [agy thinking turn · N tokens] chip). Uses the host's own
 * disclosure control when present — never mutates thinkBody children.
 */
function tryExpandThinkRow(root: HTMLElement): void {
	if (root.dataset.agyExpanded === 'true') return
	const body = root.querySelector<HTMLElement>('[class*="thinkBody"]')
	if (!body) return
	const text = (body.textContent ?? '').trim()
	if (text === '') return
	const bannerOnly = /^\[agy thinking turn(?: · \d+ thinking tokens)?\]\s*$/.test(text)
	if (bannerOnly) return
	// Already expanded if body is visible with height.
	const style = typeof getComputedStyle === 'function' ? getComputedStyle(body) : null
	if (style && style.display !== 'none' && body.clientHeight > 8) {
		root.dataset.agyExpanded = 'true'
		return
	}
	const toggle =
		root.querySelector<HTMLElement>('[data-disclosure-row]') ??
		root.querySelector<HTMLElement>('[class*="disclosure"]') ??
		root.querySelector<HTMLElement>('button')
	if (toggle) {
		try {
			toggle.click()
			root.dataset.agyExpanded = 'true'
		} catch {
			// host control missing — leave collapsed
		}
	}
}

function scanThinkingRows(): void {
	if (typeof document === 'undefined') return
	const rows = document.querySelectorAll<HTMLElement>('div[data-variant="think"]')
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i]
		if (row) tryExpandThinkRow(row)
	}
}

export function installAutoExpandReasoning(): void {
	if (typeof window === 'undefined' || typeof document === 'undefined') return
	injectStyles()
	const observer = new MutationObserver(() => {
		scanThinkingRows()
	})
	const setupObserver = () => {
		if (document.body) {
			observer.observe(document.body, { childList: true, subtree: true })
			scanThinkingRows()
		}
	}
	if (document.readyState === 'loading') {
		window.addEventListener('DOMContentLoaded', setupObserver, { once: true })
	} else {
		setupObserver()
	}
}
