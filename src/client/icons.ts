// Icons for the Antigravity UI: brand marks (Gemini / Claude / OpenAI), the
// clean Lucide-style outline set, and the Antigravity orbit logo. Also owns
// the settings-nav icon injection that swaps the generic gear for the brand
// mark in the DSH settings dialog.

import { BRAND_COLORS, BRAND_PATHS, UI_PATHS } from './brand-icons.ts';
import { h } from './react.ts';

export type BrandKey = keyof typeof BRAND_PATHS;
export type UiIconKey = keyof typeof UI_PATHS;

/** Inline brand logo (Gemini / Claude / OpenAI) as a crisp SVG mark. */
export function brandIcon(key: BrandKey, size = 13): unknown {
	return h('svg', {
		viewBox: '0 0 24 24',
		width: size,
		height: size,
		'aria-hidden': true,
		style: { display: 'inline-block', verticalAlign: '-2px', flexShrink: 0 },
	}, h('path', { d: BRAND_PATHS[key], fill: BRAND_COLORS[key] }));
}

/** Clean outline/filled SVG icon (Lucide-style), zero emoji dependency. */
export function uiIcon(key: UiIconKey, size = 12, color = 'currentColor'): unknown {
	const p = UI_PATHS[key];
	const isFilled = key === 'star';
	return h('svg', {
		viewBox: '0 0 24 24',
		width: size,
		height: size,
		'aria-hidden': true,
		style: { display: 'inline-block', verticalAlign: '-1.5px', flexShrink: 0 },
	}, h('path', {
		d: p,
		fill: isFilled ? color : 'none',
		stroke: isFilled ? 'none' : color,
		'stroke-width': isFilled ? undefined : 2,
		'stroke-linecap': isFilled ? undefined : 'round',
		'stroke-linejoin': isFilled ? undefined : 'round',
	}));
}

export const FAMILY_BRAND: Record<'google' | 'argon' | 'anthropic' | 'openai', BrandKey> = {
	google: 'gemini',
	// Gemini 4 Argon is a Google model — it keeps the Gemini mark.
	argon: 'gemini',
	anthropic: 'claude',
	openai: 'openai',
};

/**
 * Antigravity logo mark: 3D orbit sphere with specular highlight, luminous front/back rings
 * and twin satellite nodes matching the official assets/icon.svg.
 */
export function agyIcon(size = 16): unknown {
	const uid = 'agy-logo';
	return h('svg', {
		viewBox: '0 0 36 36',
		width: size,
		height: size,
		fill: 'none',
		'aria-hidden': true,
		style: { display: 'inline-block', verticalAlign: '-2.5px', flexShrink: 0 },
	},
		h('defs', null,
			h('linearGradient', { id: `${uid}-orb`, x1: '12', y1: '11', x2: '25', y2: '25', gradientUnits: 'userSpaceOnUse' },
				h('stop', { offset: '0%', 'stop-color': '#38BDF8' }),
				h('stop', { offset: '45%', 'stop-color': '#6366F1' }),
				h('stop', { offset: '85%', 'stop-color': '#9333EA' }),
				h('stop', { offset: '100%', 'stop-color': '#C026D3' }),
			),
			h('linearGradient', { id: `${uid}-rf`, x1: '6', y1: '24', x2: '31', y2: '12', gradientUnits: 'userSpaceOnUse' },
				h('stop', { offset: '0%', 'stop-color': '#00D2FF' }),
				h('stop', { offset: '40%', 'stop-color': '#38BDF8' }),
				h('stop', { offset: '70%', 'stop-color': '#818CF8' }),
				h('stop', { offset: '100%', 'stop-color': '#F43F5E' }),
			),
			h('linearGradient', { id: `${uid}-rb`, x1: '7', y1: '12', x2: '29', y2: '24', gradientUnits: 'userSpaceOnUse' },
				h('stop', { offset: '0%', 'stop-color': '#38BDF8', 'stop-opacity': '0.4' }),
				h('stop', { offset: '100%', 'stop-color': '#A855F7', 'stop-opacity': '0.4' }),
			),
			h('linearGradient', { id: `${uid}-hl`, x1: '14', y1: '12', x2: '19', y2: '18', gradientUnits: 'userSpaceOnUse' },
				h('stop', { offset: '0%', 'stop-color': '#FFFFFF', 'stop-opacity': '0.65' }),
				h('stop', { offset: '100%', 'stop-color': '#FFFFFF', 'stop-opacity': '0.05' }),
			),
		),
		h('path', {
			d: 'M 6.8 14.2 C 8.2 9.6 17.8 7.2 26.2 10.8 C 28.0 11.6 29.3 12.6 30.2 13.8',
			stroke: `url(#${uid}-rb)`,
			'stroke-width': '2.4',
			'stroke-linecap': 'round',
		}),
		h('circle', { cx: 18, cy: 18, r: 7.5, fill: `url(#${uid}-orb)` }),
		h('path', {
			d: 'M 13.2 15.2 A 5.5 5.5 0 0 1 21.0 13.0 A 6.2 6.2 0 0 0 14.0 18.0 Z',
			fill: `url(#${uid}-hl)`,
		}),
		h('path', {
			d: 'M 30.2 13.8 C 31.4 18.2 21.8 26.2 12.8 24.2 C 9.4 23.4 7.4 21.8 6.6 19.6',
			stroke: `url(#${uid}-rf)`,
			'stroke-width': '2.6',
			'stroke-linecap': 'round',
		}),
		h('circle', { cx: 8.2, cy: 18.2, r: 2.2, fill: '#00D2FF' }),
		h('circle', { cx: 8.2, cy: 18.2, r: 1.0, fill: '#FFFFFF' }),
		h('circle', { cx: 28.4, cy: 20.4, r: 1.8, fill: '#F43F5E' }),
		h('circle', { cx: 28.4, cy: 20.4, r: 0.8, fill: '#FFFFFF' }),
	);
}

/**
 * Settings dialog navigation icon replacement for Antigravity.
 * DSH settings shell projects nav glyphs from a closed list and falls back to a generic gear
 * for third-party sections. We dynamically inject a stylesheet matching Antigravity's section
 * row to display the custom Antigravity brand logo.
 */
const NAV_ICON_MARKER = 'data-dsh-agy-nav-icon';
const NAV_ROW_SELECTOR = '[role="dialog"] nav button, [role="dialog"] nav a, [role="dialog"] aside button, .dsh-settings-nav button';

const AGY_NAV_LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" fill="none">'
	+ '<defs>'
	+ '<linearGradient id="an-orb" x1="12" y1="11" x2="25" y2="25" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#38BDF8"/><stop offset="45%" stop-color="#6366F1"/><stop offset="85%" stop-color="#9333EA"/><stop offset="100%" stop-color="#C026D3"/></linearGradient>'
	+ '<linearGradient id="an-rf" x1="6" y1="24" x2="31" y2="12" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#00D2FF"/><stop offset="40%" stop-color="#38BDF8"/><stop offset="70%" stop-color="#818CF8"/><stop offset="100%" stop-color="#F43F5E"/></linearGradient>'
	+ '<linearGradient id="an-rb" x1="7" y1="12" x2="29" y2="24" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#38BDF8" stop-opacity="0.4"/><stop offset="100%" stop-color="#A855F7" stop-opacity="0.4"/></linearGradient>'
	+ '<linearGradient id="an-hl" x1="14" y1="12" x2="19" y2="18" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.65"/><stop offset="100%" stop-color="#FFFFFF" stop-opacity="0.05"/></linearGradient>'
	+ '</defs>'
	+ '<path d="M 6.8 14.2 C 8.2 9.6 17.8 7.2 26.2 10.8 C 28.0 11.6 29.3 12.6 30.2 13.8" stroke="url(#an-rb)" stroke-width="2.4" stroke-linecap="round"/>'
	+ '<circle cx="18" cy="18" r="7.5" fill="url(#an-orb)"/>'
	+ '<path d="M 13.2 15.2 A 5.5 5.5 0 0 1 21.0 13.0 A 6.2 6.2 0 0 0 14.0 18.0 Z" fill="url(#an-hl)"/>'
	+ '<path d="M 30.2 13.8 C 31.4 18.2 21.8 26.2 12.8 24.2 C 9.4 23.4 7.4 21.8 6.6 19.6" stroke="url(#an-rf)" stroke-width="2.6" stroke-linecap="round"/>'
	+ '<circle cx="8.2" cy="18.2" r="2.2" fill="#00D2FF"/>'
	+ '<circle cx="8.2" cy="18.2" r="1.0" fill="#FFFFFF"/>'
	+ '<circle cx="28.4" cy="20.4" r="1.8" fill="#F43F5E"/>'
	+ '<circle cx="28.4" cy="20.4" r="0.8" fill="#FFFFFF"/>'
	+ '</svg>';

function agyNavLogoUrl(): string {
	return `data:image/svg+xml,${encodeURIComponent(AGY_NAV_LOGO_SVG)}`;
}

function isOwnNavRow(rowText: string | null | undefined, wantedLabel: string): boolean {
	const wanted = String(wantedLabel ?? '').trim().toLowerCase();
	const text = String(rowText ?? '').trim().toLowerCase();
	if (!wanted && !text) return false;
	return text === wanted || text.includes('antigravity');
}

function navIconCss(logoUrl: string): string {
	return [
		`[${NAV_ICON_MARKER}] > svg { display: none !important; }`,
		`[${NAV_ICON_MARKER}] > [class*="icon"] > svg { display: none !important; }`,
		`[${NAV_ICON_MARKER}]::before {`,
		`  content: '';`,
		`  flex: none;`,
		`  width: 16px;`,
		`  height: 16px;`,
		`  background-image: url("${logoUrl}");`,
		`  background-repeat: no-repeat;`,
		`  background-position: center;`,
		`  background-size: 16px 16px;`,
		`  opacity: 0.92;`,
		`  transition: opacity 0.15s ease, transform 0.15s ease;`,
		`}`,
		`[${NAV_ICON_MARKER}]:hover::before,`,
		`[${NAV_ICON_MARKER}][aria-selected="true"]::before,`,
		`[${NAV_ICON_MARKER}].active::before,`,
		`[${NAV_ICON_MARKER}][data-state="active"]::before {`,
		`  opacity: 1;`,
		`  transform: scale(1.08);`,
		`}`,
	].join('\n');
}

export function installSettingsNavIcon(_ctx: unknown, resolveLabel: () => string): () => void {
	if (typeof document === 'undefined') return () => {};
	const tag = document.createElement('style');
	tag.dataset.plugin = 'dsh-agy-link';
	tag.dataset.pluginCss = 'dsh-agy-link/settings-nav-icon';
	tag.textContent = navIconCss(agyNavLogoUrl());
	const head = document.head ?? document.documentElement;
	if (head) head.appendChild(tag);
	let disposed = false;
	let scheduled = false;
	const sync = () => {
		scheduled = false;
		if (disposed) return;
		const wanted = resolveLabel();
		// Only touch the DOM when the marker is not already correct. Unconditional
		// writes made every sync pass enqueue another sync pass (the observer
		// watches this very attribute), which turned a single host re-render into
		// a self-sustaining loop during streaming/scroll reflows (2026-10-23).
		for (const row of Array.from(document.querySelectorAll(NAV_ROW_SELECTOR))) {
			const shouldMark = isOwnNavRow(row.textContent, wanted);
			const marked = row.hasAttribute(NAV_ICON_MARKER);
			if (shouldMark === marked) continue;
			if (shouldMark) row.setAttribute(NAV_ICON_MARKER, '');
			else row.removeAttribute(NAV_ICON_MARKER);
		}
	};
	const schedule = () => {
		if (scheduled || disposed) return;
		scheduled = true;
		queueMicrotask(sync);
	};
	sync();
	let observer: MutationObserver | null = null;
	const setupObserver = () => {
		if (disposed || !document.body) return;
		try {
			observer = new MutationObserver(schedule);
			// attributeFilter is load-bearing: sync() writes NAV_ICON_MARKER, and an
			// unfiltered subtree observer re-fires on its own writes (measured 5
			// self-induced passes per host mutation). characterData is deliberately
			// NOT observed — label text changes arrive as childList of the row, and
			// watching every text node made the host's streaming output drive full
			// nav sweeps.
			observer.observe(document.body, {
				childList: true,
				subtree: true,
				attributeFilter: [NAV_ICON_MARKER],
			});
		} catch (err) {
			console.warn('[dsh-agy-link] nav icon observer setup failed:', err);
		}
	};
	if (document.readyState === 'loading') {
		window.addEventListener('DOMContentLoaded', setupObserver, { once: true });
	} else {
		setupObserver();
	}
	return () => {
		disposed = true;
		if (observer !== null) {
			observer.disconnect();
			observer = null;
		}
		for (const row of Array.from(document.querySelectorAll(`[${NAV_ICON_MARKER}]`))) {
			row.removeAttribute(NAV_ICON_MARKER);
		}
		tag.remove();
	};
}
