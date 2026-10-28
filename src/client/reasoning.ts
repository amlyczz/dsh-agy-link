import { isInteractionLocked, onScrollSettle } from './scroll-guard.ts';

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
//
// VIRTUALIZER STABILITY (Incident 2026-10-23 — "scrolling flashes ~3 times"):
// DSH mounts chat messages inside TanStack Virtualizer with dynamic measurement.
// During scrolling, messages unmount and remount as brand new DOM nodes. If
// auto-expand uses DOM-bound markers (dataset or WeakSet<HTMLElement>), remounted
// items lose the guard and trigger synthetic `toggle.click()` mid-scroll, causing
// a 332px height jump that forces virtualizer scroll rewrites.
//
// Solutions:
// 1. Stable turn-fingerprint cache (`handledTurns` Set) persists across DOM remounts.
// 2. Interaction lock (`isInteractionLocked` = active scroll OR an overlay owns the screen) suppresses all scans and click synthesis.
// 3. User manual interaction permanently claims the turn so the scanner never interferes.

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
 * Persistent cache of handled thinking turns (keyed by turn fingerprint).
 * Survived across TanStack Virtualizer unmount/remount cycles.
 */
const handledTurns = new Set<string>();

export function clearHandledTurnsForTest(): void {
	handledTurns.clear();
}

function getTurnKey(root: HTMLElement, text: string): string {
	const parent = root.closest<HTMLElement>('[data-message-id], [data-item-index], [data-index], [data-role="message-content"]');
	const parentId = parent?.getAttribute('data-message-id') ?? parent?.getAttribute('data-index') ?? parent?.getAttribute('data-item-index') ?? '';
	return `${parentId}:${text.slice(0, 100)}`;
}

/**
 * Try to expand a thinking row once when its body contains real prose
 * (not a bare [agy thinking turn · N tokens] chip). Uses the host's own
 * disclosure control when present — never mutates thinkBody children.
 */
export function tryExpandThinkRow(root: HTMLElement): void {
	if (root.dataset.agyExpanded === 'true') return;
	const body = root.querySelector<HTMLElement>('[class*="thinkBody"]');
	if (!body) return;
	const text = (body.textContent ?? '').trim();
	if (text === '') return;
	const bannerOnly = /^\[agy(?: thinking turn)?(?: · \d+ (?:thinking )?tokens)?\]\s*$/.test(text);
	if (bannerOnly) return;

	const turnKey = getTurnKey(root, text);
	if (handledTurns.has(turnKey)) {
		root.dataset.agyExpanded = 'true';
		return;
	}

	const toggle =
		root.querySelector<HTMLElement>('[data-disclosure-row]') ??
		root.querySelector<HTMLElement>('[class*="disclosure"]') ??
		root.querySelector<HTMLElement>('button');
	if (!toggle) return;

	// Bind click listener so any manual user toggle is permanently respected
	if (!toggle.dataset.agyClickBound) {
		toggle.dataset.agyClickBound = 'true';
		toggle.addEventListener('click', () => {
			handledTurns.add(turnKey);
		}, { capture: true, passive: true });
	}

	// Never synthesize clicks during active scrolling — virtualizer measurement must stay stable
	if (isInteractionLocked()) return;

	// Already expanded if body is visible with height.
	if (body.clientHeight > 8) {
		handledTurns.add(turnKey);
		root.dataset.agyExpanded = 'true';
		return;
	}

	// Record handle intent BEFORE clicking: the click itself mutates the DOM
	handledTurns.add(turnKey);
	root.dataset.agyExpanded = 'true';
	try {
		toggle.click();
	} catch {
		// host control missing — leave collapsed
	}
}

export function scanThinkingRows(): void {
	if (typeof document === 'undefined') return;
	if (isInteractionLocked()) return;
	const rows = document.querySelectorAll<HTMLElement>('div[data-variant="think"]');
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (row) tryExpandThinkRow(row);
	}
}

// Streaming conversations mutate the DOM at high frequency: coalesce
// mutation bursts into one scan pass (mirrors the mermaid scanner's debounce).
let scanTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleScan(): void {
	if (isInteractionLocked()) return;
	if (scanTimer !== null) return;
	scanTimer = setTimeout(() => {
		scanTimer = null;
		if (isInteractionLocked()) return;
		scanThinkingRows();
	}, 150);
}

let activeObserver: MutationObserver | null = null;
let domContentLoadedHandler: (() => void) | null = null;
let unbindSettle: (() => void) | null = null;

/**
 * Install the auto-expand reasoning overlay. Returns a disposer that
 * disconnects the MutationObserver — wrap it in ctx.effect so a plugin
 * reload cannot stack observers.
 */
export function installAutoExpandReasoning(): () => void {
	if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
	disposeAutoExpandReasoning();
	injectStyles();
	const observer = new MutationObserver(() => {
		scheduleScan();
	});
	activeObserver = observer;
	unbindSettle = onScrollSettle(() => {
		scheduleScan();
	});
	const setupObserver = () => {
		if (document.body) {
			observer.observe(document.body, { childList: true, subtree: true });
			scanThinkingRows();
		}
	};
	if (document.readyState === 'loading') {
		domContentLoadedHandler = setupObserver;
		window.addEventListener('DOMContentLoaded', setupObserver, { once: true });
	} else {
		setupObserver();
	}
	return disposeAutoExpandReasoning;
}

/** Disconnect the observer and cancel pending work. */
export function disposeAutoExpandReasoning(): void {
	if (activeObserver !== null) {
		activeObserver.disconnect();
		activeObserver = null;
	}
	if (unbindSettle !== null) {
		unbindSettle();
		unbindSettle = null;
	}
	if (domContentLoadedHandler !== null) {
		window.removeEventListener('DOMContentLoaded', domContentLoadedHandler);
		domContentLoadedHandler = null;
	}
	if (scanTimer !== null) {
		clearTimeout(scanTimer);
		scanTimer = null;
	}
}
