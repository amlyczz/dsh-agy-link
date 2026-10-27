// dsh-agy-link client half (browser). Integrated into native DSH settings, sidebar footer, and header.
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type { AccountPoolData, FamilyQuotaInfo, ManagedAccount, ModelQuotaInfo } from '../common/pool-types.ts';
import { BRAND_COLORS, BRAND_PATHS, UI_PATHS } from './brand-icons.ts';
import { installAgyToolView } from './toolview.ts';
import { installMermaidRendering } from './mermaid.ts';
import { en, es, NS, ptBR, zh, type AgyLocaleKey } from './locales.ts';
import { installAutoExpandReasoning } from './reasoning.ts';
import { installImageEnhancer } from './images.ts';
import { installDecisionChips } from './decisions.ts';
import { ensureScrollListener, disposeScrollListener } from './scroll-guard.ts';


type ReactApi = {
	createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
	useState: <S>(initial: S | (() => S)) => [S, (next: S | ((prev: S) => S)) => void];
	useEffect: (setup: () => (() => void) | void, deps?: unknown[]) => void;
	useRef: <S>(initial: S) => { current: S };
};
const R = require('react') as ReactApi;
const { createElement: h, useState, useEffect, useRef } = R;

const reactDom = require('react-dom') as {
	createPortal?: (node: unknown, container: unknown) => unknown;
};

const win = globalThis as unknown as {
	location?: { origin?: string };
	fetch?: (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
	open?: (url: string, target?: string) => void;
	document?: { body?: unknown } | null;
	localStorage?: {
		getItem(key: string): string | null;
		setItem(key: string, value: string): void;
		removeItem(key: string): void;
	};
	addEventListener?: (type: string, listener: (ev: any) => void, useCapture?: boolean) => void;
	removeEventListener?: (type: string, listener: (ev: any) => void, useCapture?: boolean) => void;
};

const portalToBody = (node: unknown) => {
	const body = win.document?.body ?? (typeof document !== 'undefined' ? document.body : null);
	if (body && reactDom && typeof reactDom.createPortal === 'function') {
		return reactDom.createPortal(node, body);
	}
	return node;
};

export const name = 'dsh-agy-link-client';
// Cordis inject entries are hard dependencies: accessing a service not listed
// here throws ("cannot get property X without inject"). locale must be declared
// for ctx.locale to be readable (issue #24). dsh-web-app ships dsh-client-locale.
export const inject = ['slots', 'locale'];

export interface ClientContext extends Context {
	slots: {
		inject(name: string, register: () => () => void): void;
		register(
			// `id` for list slots (settings.section entries), `key` for keyed
			// slots (plugins.bundle.config is keyed by package name).
			opts: { name: string; key?: string; id?: string; order?: number; label?: string | (() => string); locale?: string },
			Component: (props?: unknown) => unknown,
		): () => void;
	};
}

interface StatusPayload {
	bin?: string | null;
	version?: string | null;
	dormantReason?: string | null;
	enabled?: boolean;
	permissionMode?: string;
	workspaceRoot?: string;
	defaultModel?: string;
	defaultEffort?: string;
	auth?: {
		phase: string;
		accountId?: string;
		url?: string;
		qrDataUrl?: string;
		startedAt?: number;
		expiresAt?: number;
		message?: string;
	};
	pool?: AccountPoolData;
	poolAuth?: {
		phase: 'idle' | 'waiting' | 'exchanging' | 'done' | 'failed';
		stagingId?: string;
		alias?: string;
		url?: string;
		mode?: 'auto' | 'manual';
		browserOpened?: boolean;
		code?: string;
	};
	catalog?: { source: string; count: number; lastError: string | null };
	catalogModels?: ReadonlyArray<{ id: string; name: string }>;
	hiddenModels?: readonly string[];
	bindings?: number;
	lastRun?: { ok: boolean; code: string; durationMs: number; model: string } | null;
}

interface ToastNotice {
	text: string;
	type: 'success' | 'info' | 'warn' | 'error';
	id: number;
}

const base = win.location?.origin ?? '';

const STATUS_CACHE_KEY = 'dsh_agy_status_cache';

function loadInitialStatusCache(): StatusPayload | null {
	try {
		const raw = win.localStorage?.getItem(STATUS_CACHE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object') return parsed as StatusPayload;
		}
	} catch {
		// Ignore storage quota / parsing errors
	}
	return null;
}

// Module-level cache for instant remount rendering (preloaded from localStorage for zero-flicker startup)
let statusCache: StatusPayload | null = loadInitialStatusCache();

async function getStatus(): Promise<StatusPayload | null> {
	try {
		// A bounded fetch: the poll loop must never stack behind a hung request
		// (undici/browser defaults can park far longer than one poll period).
		const init: Record<string, unknown> = {};
		if (typeof AbortSignal !== 'undefined' && typeof (AbortSignal as { timeout?: unknown }).timeout === 'function') {
			init.signal = (AbortSignal as { timeout: (ms: number) => unknown }).timeout(5000);
		}
		const res = await win.fetch?.(base + '/plugins/agy-link/status', init);
		if (!res || !res.ok) return null;
		return (await res.json()) as StatusPayload;
	} catch {
		return null;
	}
}

async function postJson(path: string, body: Record<string, unknown>): Promise<any> {
	try {
		const res = await win.fetch?.(base + path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (!res) return null;
		try {
			const payload = await res.json();
			// Surface HTTP failure as ok:false so callers can distinguish
			// "saved" from "server refused" instead of always toasting success.
			if (!res.ok && payload !== null && typeof payload === 'object') {
				return { ok: false, ...(payload as Record<string, unknown>) };
			}
			return payload;
		} catch {
			return { ok: res.ok };
		}
	} catch {
		return null;
	}
}

async function getJson<T = any>(path: string): Promise<T | null> {
	try {
		const res = await win.fetch?.(base + path);
		if (!res || !res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

// ---- shared status polling ----
// ONE module-level fetch loop serves every mounted consumer (settings panel,
// header badge, modal). Per-component 3s loops used to stack (three full
// payload fetches per interval with the modal open), had no overlap guard,
// and let a slow stale response overwrite a newer one.
const statusListeners = new Set<(s: StatusPayload) => void>();
let statusPollTimer: ReturnType<typeof setInterval> | null = null;
let statusPollInterval = 3000;
let statusFetchSeq = 0;

function isStatusEqual(a: StatusPayload | null, b: StatusPayload | null): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
}

function notifyStatus(st: StatusPayload): void {
	statusCache = st;
	try {
		win.localStorage?.setItem(STATUS_CACHE_KEY, JSON.stringify(st));
	} catch {
		// Ignore storage quota / parsing errors
	}
	for (const fn of [...statusListeners]) {
		try { fn(st); } catch { /* a dead consumer must not kill the loop */ }
	}
}

async function statusPollTick(): Promise<void> {
	const seq = ++statusFetchSeq;
	const st = await getStatus();
	// A slow response from an older tick must never overwrite newer data.
	// Only notify when payload actually changed to prevent needless re-renders.
	if (st !== null && seq === statusFetchSeq) {
		if (!isStatusEqual(statusCache, st)) {
			notifyStatus(st);
		}
	}
}

function ensureStatusPolling(): void {
	if (statusPollTimer !== null) {
		if (statusPollInterval !== 3000) {
			clearInterval(statusPollTimer);
			statusPollTimer = null;
		} else {
			return;
		}
	}
	statusPollInterval = 3000;
	void statusPollTick();
	statusPollTimer = setInterval(() => { void statusPollTick(); }, 3000);
}

function stopStatusPollingIfIdle(): void {
	// Keep statusCache warm so opening a session never faces an empty or stale snapshot.
	// When idle (no active mounted viewers), relax the polling interval to 15s.
	if (statusListeners.size === 0 && statusPollTimer !== null && statusPollInterval === 3000) {
		clearInterval(statusPollTimer);
		statusPollInterval = 15000;
		statusPollTimer = setInterval(() => { void statusPollTick(); }, 15000);
	}
}

/**
 * Subscribe a component to the shared status poll. Returns the latest
 * snapshot plus a manual refresh that keeps the last good snapshot on a
 * transient failure (a failed refresh used to flip the whole panel back to
 * its loading state).
 */
function useAgyStatus(): { status: StatusPayload | null; refresh: () => Promise<void> } {
	const [status, setStatus] = useState<StatusPayload | null>(statusCache);
	useEffect(() => {
		statusListeners.add(setStatus);
		ensureStatusPolling();
		return () => {
			statusListeners.delete(setStatus);
			stopStatusPollingIfIdle();
		};
	}, []);
	const refresh = async (): Promise<void> => {
		const st = await getStatus();
		if (st !== null && !isStatusEqual(statusCache, st)) notifyStatus(st);
	};
	return { status, refresh };
}

/** Global modal state for opening Antigravity console dialog from footer shortcut or header status */
const agyModalStore = {
	open: false,
	listeners: new Set<() => void>(),
	setOpen(v: boolean) {
		agyModalStore.open = v;
		agyModalStore.listeners.forEach((fn) => fn());
	},
	subscribe(fn: () => void) {
		agyModalStore.listeners.add(fn);
		return () => {
			agyModalStore.listeners.delete(fn);
		};
	},
};

/**
 * Global modal host manager: ensures exactly one mounted session header
 * hosts the modal dialog portal reactively. The most recently focused or mounted
 * header is prioritized immediately to prevent host handoff flicker when opened.
 * If the primary header unmounts, the next available header is seamlessly notified.
 */
const modalHostManager = {
	listeners: new Map<string, (isPrimary: boolean) => void>(),
	activeId: null as string | null,

	register(id: string, onChange: (isPrimary: boolean) => void) {
		modalHostManager.listeners.set(id, onChange);
		// The first mounted session header takes priority as the active host.
		// Never steal activeId if a host is already assigned (prevents unmount/remount
		// thrashing during multi-header updates or quota sync).
		if (modalHostManager.activeId === null) {
			modalHostManager.activeId = id;
		}
		onChange(modalHostManager.activeId === id);

		return () => {
			modalHostManager.listeners.delete(id);
			if (modalHostManager.activeId === id) {
				const next = modalHostManager.listeners.keys().next().value ?? null;
				modalHostManager.activeId = next;
				if (next) {
					try { modalHostManager.listeners.get(next)?.(true); } catch {}
				}
			}
		};
	},

	claim(id: string) {
		if (modalHostManager.activeId !== id) {
			const prev = modalHostManager.activeId;
			modalHostManager.activeId = id;
			if (prev && prev !== id) {
				try { modalHostManager.listeners.get(prev)?.(false); } catch {}
			}
			try { modalHostManager.listeners.get(id)?.(true); } catch {}
		}
	},
};

/**
 * Format reset timestamp into readable date/time + relative countdown.
 */
function formatQuotaWindow(t: (key: AgyLocaleKey) => string, resetTimeStr?: string): {
	resetText: string;
	/** resetTime exists but is already in the past (window has rolled over). */
	expired: boolean;
} {
	if (!resetTimeStr) return { resetText: '', expired: false };
	try {
		const d = new Date(resetTimeStr);
		const diffMs = d.getTime() - Date.now();
		// A stale (already passed) resetTime means the window has ROLLED OVER —
		// the backend keeps reporting the previous boundary once the quota is
		// back at 100%, and a countdown into the past would be nonsense. Hide
		// the time but tell the caller so it can say "已重置" instead of a
		// mysterious blank (2026-10-16: every full 5h row lost its ↻ note).
		if (Number.isNaN(d.getTime()) || diffMs <= 0) return { resetText: '', expired: true };

		const totalMins = Math.ceil(diffMs / 60000);
		const days = Math.floor(totalMins / 1440);
		const hours = Math.floor((totalMins % 1440) / 60);
		const mins = totalMins % 60;
		const isWeekly = days >= 1;

		const countdown = days > 0
			? `${days}${t('duration.day')} ${hours}${t('duration.hour')}`
			: hours > 0 ? `${hours}${t('duration.hour')} ${mins}${t('duration.minute')}` : `${mins}${t('duration.minute')}`;
		const hh = d.getHours().toString().padStart(2, '0');
		const mm = d.getMinutes().toString().padStart(2, '0');
		const resetText = isWeekly
			? `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm} (${countdown})`
			: `${hh}:${mm} (${countdown})`;

		return { resetText, expired: false };
	} catch {
		return { resetText: '', expired: true };
	}
}

type BrandKey = keyof typeof BRAND_PATHS;
type UiIconKey = keyof typeof UI_PATHS;

/** Inline brand logo (Gemini / Claude / OpenAI) as a crisp SVG mark. */
function brandIcon(key: BrandKey, size = 13): unknown {
	return h('svg', {
		viewBox: '0 0 24 24',
		width: size,
		height: size,
		'aria-hidden': true,
		style: { display: 'inline-block', verticalAlign: '-2px', flexShrink: 0 },
	}, h('path', { d: BRAND_PATHS[key], fill: BRAND_COLORS[key] }));
}

/** Clean outline/filled SVG icon (Lucide-style), zero emoji dependency. */
function uiIcon(key: UiIconKey, size = 12, color = 'currentColor'): unknown {
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

const FAMILY_BRAND: Record<'google' | 'argon' | 'anthropic' | 'openai', BrandKey> = {
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
function agyIcon(size = 16): unknown {
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

function installSettingsNavIcon(ctx: ClientContext, resolveLabel: () => string): () => void {
	if (typeof document === 'undefined') return () => {};
	const tag = document.createElement('style');
	tag.dataset.plugin = 'dsh-agy-link';
	tag.dataset.pluginCss = 'dsh-agy-link/settings-nav-icon';
	tag.textContent = navIconCss(agyNavLogoUrl());
	document.head.appendChild(tag);
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
	const observer = new MutationObserver(schedule);
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
	return () => {
		disposed = true;
		observer.disconnect();
		for (const row of Array.from(document.querySelectorAll(`[${NAV_ICON_MARKER}]`))) {
			row.removeAttribute(NAV_ICON_MARKER);
		}
		tag.remove();
	};
}

/**
 * One family's quota block: brand mark + 5h/weekly bars with reset countdowns
 * and cooldown notes. Module-level so the settings section and the Plugins-page
 * dashboard render IDENTICAL quota visuals from one implementation.
 */
function renderFamilyQuotaBar(
	t: (key: AgyLocaleKey) => string,
	label: string,
	familyKey: 'google' | 'argon' | 'anthropic' | 'openai',
	acc: ManagedAccount,
	isRefreshing = false,
): unknown {
	const info = acc.quotas[familyKey];
	const cd = acc.cooldowns[familyKey];
	const inCooldown = cd && cd.cooldownUntil > Date.now();

	// 5-Hour limit
	const has5h = typeof info?.remainingFraction === 'number' && Number.isFinite(info.remainingFraction);
	const pct5h = has5h ? Math.max(0, Math.min(100, Math.round(info!.remainingFraction! * 100))) : -1;
	// Cooldown is a LOCAL heuristic — never overwrite the server-reported
	// fraction with 0% (a ghost cooldown used to show a 98%-full account as
	// empty). Surface it as a note next to the reset time instead.
	const cdNote = inCooldown ? t('account.localCooldown') : '';
	const w5h = formatQuotaWindow(t, info?.resetTime);
	// Full-quota rows: the backend keeps the LAST window's resetTime, so
	// the row would go silently blank. When the time has expired but the
	// fraction is full, say "已重置" instead — the quota is usable now.
	const expiredFull5h = w5h.expired && has5h && pct5h >= 100;

	// Weekly limit
	const hasWeekly = typeof info?.weeklyFraction === 'number' && Number.isFinite(info.weeklyFraction);
	const pctWeekly = hasWeekly ? Math.max(0, Math.min(100, Math.round(info!.weeklyFraction! * 100))) : -1;
	const wWeekly = formatQuotaWindow(t, info?.weeklyResetTime);
	const expiredFullWeekly = wWeekly.expired && hasWeekly && pctWeekly >= 100;

	const getColors = (pct: number) => {
		if (pct < 0) {
			return {
				bar: 'var(--agy-quota-none-border)',
				text: 'var(--agy-quota-none-text)',
				bg: 'var(--agy-quota-none-bg)',
				border: 'var(--agy-quota-none-border)',
			};
		}
		if (pct <= 20) {
			return {
				bar: 'linear-gradient(90deg, #dc2626, #ef4444)',
				text: 'var(--agy-quota-low-text)',
				bg: 'var(--agy-quota-low-bg)',
				border: 'var(--agy-quota-low-border)',
			};
		}
		if (pct <= 50) {
			return {
				bar: 'linear-gradient(90deg, #d97706, #f59e0b)',
				text: 'var(--agy-quota-med-text)',
				bg: 'var(--agy-quota-med-bg)',
				border: 'var(--agy-quota-med-border)',
			};
		}
		return {
			bar: 'linear-gradient(90deg, #059669, #10b981)',
			text: 'var(--agy-quota-high-text)',
			bg: 'var(--agy-quota-high-bg)',
			border: 'var(--agy-quota-high-border)',
		};
	};

	const c5h = getColors(pct5h);
	const cWeekly = getColors(pctWeekly);

	const renderLine = (windowName: string, percent: number, c: { bar: string; text: string; bg: string; border: string }, resetStr: string, rawFraction?: number, rawReset?: string) => {
		const isShimmer = percent < 0 || isRefreshing;
		const tooltipText = typeof rawFraction === 'number'
			? `${(rawFraction * 100).toFixed(1)}% (raw: ${rawFraction})${rawReset ? ` · reset: ${rawReset}` : ''}`
			: resetStr ? `↻ ${resetStr}` : undefined;
		return h('div', { style: { display: 'flex', alignItems: 'center', fontSize: '11.5px', margin: '4px 0' } },
			h('span', { style: { width: '52px', color: 'var(--agy-text-window-label)', fontSize: '11px', fontWeight: 700, flexShrink: 0 } }, windowName),
			h('div', {
				className: isShimmer ? 'agy-shimmer-track' : '',
				style: S.progressBarBg,
			},
				h('div', {
					className: 'agy-progress-fill',
					style: {
						width: `${percent < 0 ? 100 : percent}%`,
						height: '100%',
						background: c.bar,
						borderRadius: '3px',
					},
				}),
			),
			h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', minWidth: '140px', justifyContent: 'flex-end', flexShrink: 0 } },
				h('span', {
					title: tooltipText,
					style: {
						padding: '2px 7px',
						borderRadius: '4px',
						background: c.bg,
						color: c.text,
						border: `1px solid ${c.border}`,
						fontWeight: 700,
						fontSize: '11.5px',
						lineHeight: 1.2,
						cursor: tooltipText ? 'help' : 'default',
					},
				}, percent < 0 ? '—' : `${percent}%`),
				resetStr ? h('span', { style: { color: 'var(--agy-text-secondary)', fontSize: '11px', fontWeight: 500 } }, `↻ ${resetStr}`) : null,
			),
		);
	};

	return h('div', { style: { margin: '6px 0', padding: '8px 10px', background: 'var(--agy-bg-subbox)', borderRadius: '7px', border: '1px solid var(--agy-border-box)' } },
		h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, fontSize: '12.5px', marginBottom: '5px', color: 'var(--agy-text-primary)' } },
			brandIcon(FAMILY_BRAND[familyKey], 14),
			h('span', null, label),
		),
		// Argon is a WEEKLY-only counter today: render the 5h row only when
		// the backend actually reports one, never as a permanent "—" ghost.
		(familyKey !== 'argon' || has5h) ? renderLine(t('quota.fiveHour'), pct5h, c5h, w5h.resetText ? w5h.resetText + cdNote : expiredFull5h ? t('quota.windowReset') + cdNote : cdNote.replace(/^ · /, ''), info?.remainingFraction, info?.resetTime) : null,
		renderLine(t('quota.weekly'), pctWeekly, cWeekly, wWeekly.resetText ? wWeekly.resetText : expiredFullWeekly ? t('quota.windowReset') : '', info?.weeklyFraction, info?.weeklyResetTime),
	);
}

const GLOBAL_CSS = `
@keyframes agy-spin {
	0% { transform: rotate(0deg); }
	100% { transform: rotate(360deg); }
}

:root, body {
	--agy-font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif);
	--agy-bg-panel: var(--dsw-alias-bg-layer-2, #ffffff);
	--agy-bg-card: var(--dsw-alias-bg-layer-2, #ffffff);
	--agy-bg-card-primary: #f0f7ff;
	--agy-bg-header: var(--dsw-alias-bg-layer-1, #f8fafc);
	--agy-bg-box: var(--dsw-alias-bg-layer-1, #f8fafc);
	--agy-bg-subbox: var(--dsw-alias-bg-layer-3, #f1f5f9);
	--agy-bg-input: var(--dsw-alias-bg-layer-1, #ffffff);
	--agy-bg-btn: var(--dsw-alias-bg-layer-3, #f1f5f9);
	--agy-bg-btn-hover: var(--dsw-alias-interactive-bg-hover, #e2e8f0);
	--agy-bg-btn-primary: var(--dsw-alias-state-business-primary, #2563eb);
	--agy-bg-progress-track: #e2e8f0;

	--agy-border-card: var(--dsw-alias-border-l2, #e2e8f0);
	--agy-border-card-primary: #3b82f6;
	--agy-border-box: var(--dsw-alias-border-l1, #e2e8f0);
	--agy-border-subbox: var(--dsw-alias-border-l2, #cbd5e1);
	--agy-border-input: var(--dsw-alias-border-l2, #cbd5e1);
	--agy-border-input-focus: var(--dsw-alias-state-business-primary, #2563eb);
	--agy-border-btn: var(--dsw-alias-border-l2, #cbd5e1);
	--agy-border-btn-primary: #2563eb;
	--agy-border-divider: var(--dsw-alias-border-l2, #e2e8f0);

	--agy-text-primary: var(--dsw-alias-label-primary, #0f172a);
	--agy-text-secondary: var(--dsw-alias-label-secondary, #334155);
	--agy-text-tertiary: var(--dsw-alias-label-tertiary, #64748b);
	--agy-text-muted: var(--dsw-alias-label-caption, #94a3b8);
	--agy-text-btn: var(--dsw-alias-label-primary, #0f172a);
	--agy-text-btn-primary: #ffffff;
	--agy-text-window-label: #2563eb;

	--agy-shadow-card: 0 1px 3px rgba(0, 0, 0, 0.05);
	--agy-shadow-card-hover: 0 4px 12px rgba(0, 0, 0, 0.08);
	--agy-shadow-card-primary: 0 0 0 1px #3b82f6, 0 4px 14px rgba(37, 99, 235, 0.12);
	--agy-shadow-modal: 0 20px 50px rgba(0, 0, 0, 0.18);
	--agy-modal-backdrop: rgba(15, 23, 42, 0.5);

	/* Badges */
	--agy-badge-primary-bg: #dbeafe;
	--agy-badge-primary-text: #1e40af;
	--agy-badge-primary-border: #60a5fa;

	--agy-badge-tag-bg: #f1f5f9;
	--agy-badge-tag-text: #334155;
	--agy-badge-tag-border: #cbd5e1;

	--agy-badge-email-bg: #eff6ff;
	--agy-badge-email-text: #1d4ed8;
	--agy-badge-email-border: #bfdbfe;

	--agy-badge-proxy-bg: #ecfdf5;
	--agy-badge-proxy-text: #047857;
	--agy-badge-proxy-border: #a7f3d0;

	--agy-badge-ready-bg: #ecfdf5;
	--agy-badge-ready-text: #047857;
	--agy-badge-ready-border: #a7f3d0;

	--agy-badge-unready-bg: #eff6ff;
	--agy-badge-unready-text: #1d4ed8;
	--agy-badge-unready-border: #bfdbfe;

	/* Quota status pills */
	--agy-quota-high-bg: #ecfdf5;
	--agy-quota-high-text: #047857;
	--agy-quota-high-border: #a7f3d0;
	--agy-quota-med-bg: #fffbeb;
	--agy-quota-med-text: #b45309;
	--agy-quota-med-border: #fde68a;
	--agy-quota-low-bg: #fef2f2;
	--agy-quota-low-text: #b91c1c;
	--agy-quota-low-border: #fecaca;
	--agy-quota-none-bg: #f1f5f9;
	--agy-quota-none-text: #64748b;
	--agy-quota-none-border: #cbd5e1;

	/* Danger button */
	--agy-danger-bg: #fef2f2;
	--agy-danger-text: #b91c1c;
	--agy-danger-border: #fecaca;
	--agy-danger-hover-bg: #fee2e2;

	/* Warning banner */
	--agy-warn-bg: #fffbeb;
	--agy-warn-text: #92400e;
	--agy-warn-border: #fcd34d;
	--agy-warn-btn-bg: #fef3c7;
	--agy-warn-btn-text: #92400e;
	--agy-warn-btn-border: #f59e0b;

	/* Toast notices */
	--agy-toast-success-bg: #ecfdf5;
	--agy-toast-success-text: #065f46;
	--agy-toast-success-border: #6ee7b7;
	--agy-toast-info-bg: #eff6ff;
	--agy-toast-info-text: #1e40af;
	--agy-toast-info-border: #93c5fd;
	--agy-toast-warn-bg: #fffbeb;
	--agy-toast-warn-text: #92400e;
	--agy-toast-warn-border: #fcd34d;
	--agy-toast-error-bg: #fef2f2;
	--agy-toast-error-text: #991b1b;
	--agy-toast-error-border: #fca5a5;

	/* Auth Modal / Box */
	--agy-auth-box-bg: #f0f7ff;
	--agy-auth-box-border: #3b82f6;

	/* Segment control */
	--agy-seg-group-bg: #e2e8f0;
	--agy-seg-group-border: #cbd5e1;
	--agy-seg-btn-text: #475569;
	--agy-seg-btn-active-bg: var(--dsw-alias-state-business-primary, #2563eb);
	--agy-seg-btn-active-text: #ffffff;
	--agy-seg-danger-bg: #dc2626;
	--agy-seg-danger-text: #ffffff;
	--agy-seg-danger-border: #b91c1c;
}

body[data-ds-dark-theme],
body.dark,
[data-theme="dark"] {
	--agy-bg-panel: var(--dsw-alias-bg-layer-2, #0f172a);
	--agy-bg-card: var(--dsw-alias-bg-layer-2, #1e293b);
	--agy-bg-card-primary: #111d33;
	--agy-bg-header: var(--dsw-alias-bg-layer-1, #1e293b);
	--agy-bg-box: var(--dsw-alias-bg-layer-1, #0f172a);
	--agy-bg-subbox: var(--dsw-alias-bg-layer-3, #090d16);
	--agy-bg-input: var(--dsw-alias-bg-layer-3, #090d16);
	--agy-bg-btn: var(--dsw-alias-bg-layer-3, #334155);
	--agy-bg-btn-hover: var(--dsw-alias-interactive-bg-hover, #475569);
	--agy-bg-btn-primary: var(--dsw-alias-state-business-primary, #2563eb);
	--agy-bg-progress-track: #1e293b;

	--agy-border-card: var(--dsw-alias-border-l2, #334155);
	--agy-border-card-primary: #3b82f6;
	--agy-border-box: var(--dsw-alias-border-l1, #1e293b);
	--agy-border-subbox: var(--dsw-alias-border-l2, #334155);
	--agy-border-input: var(--dsw-alias-border-l2, #334155);
	--agy-border-input-focus: #3b82f6;
	--agy-border-btn: var(--dsw-alias-border-l2, #475569);
	--agy-border-btn-primary: #3b82f6;
	--agy-border-divider: var(--dsw-alias-border-l2, #334155);

	--agy-text-primary: var(--dsw-alias-label-primary, #f8fafc);
	--agy-text-secondary: var(--dsw-alias-label-secondary, #cbd5e1);
	--agy-text-tertiary: var(--dsw-alias-label-tertiary, #94a3b8);
	--agy-text-muted: var(--dsw-alias-label-caption, #64748b);
	--agy-text-btn: var(--dsw-alias-label-primary, #ffffff);
	--agy-text-btn-primary: #ffffff;
	--agy-text-window-label: #93c5fd;

	--agy-shadow-card: 0 2px 8px rgba(0, 0, 0, 0.3);
	--agy-shadow-card-hover: 0 6px 16px rgba(0, 0, 0, 0.4);
	--agy-shadow-card-primary: 0 0 16px rgba(59, 130, 246, 0.25);
	--agy-shadow-modal: 0 25px 60px rgba(0, 0, 0, 0.8);
	--agy-modal-backdrop: rgba(0, 0, 0, 0.75);

	/* Badges */
	--agy-badge-primary-bg: #1e3a8a;
	--agy-badge-primary-text: #93c5fd;
	--agy-badge-primary-border: #3b82f6;

	--agy-badge-tag-bg: #0f172a;
	--agy-badge-tag-text: #cbd5e1;
	--agy-badge-tag-border: #334155;

	--agy-badge-email-bg: #1e293b;
	--agy-badge-email-text: #93c5fd;
	--agy-badge-email-border: #3b82f6;

	--agy-badge-proxy-bg: #064e3b;
	--agy-badge-proxy-text: #6ee7b7;
	--agy-badge-proxy-border: #059669;

	--agy-badge-ready-bg: rgba(16, 185, 129, 0.15);
	--agy-badge-ready-text: #34d399;
	--agy-badge-ready-border: rgba(16, 185, 129, 0.35);

	--agy-badge-unready-bg: rgba(59, 130, 246, 0.15);
	--agy-badge-unready-text: #93c5fd;
	--agy-badge-unready-border: rgba(59, 130, 246, 0.35);

	/* Quota status pills */
	--agy-quota-high-bg: #064e3b;
	--agy-quota-high-text: #6ee7b7;
	--agy-quota-high-border: #059669;
	--agy-quota-med-bg: #451a03;
	--agy-quota-med-text: #fde68a;
	--agy-quota-med-border: #d97706;
	--agy-quota-low-bg: #450a0a;
	--agy-quota-low-text: #fca5a5;
	--agy-quota-low-border: #dc2626;
	--agy-quota-none-bg: #1e293b;
	--agy-quota-none-text: #94a3b8;
	--agy-quota-none-border: #475569;

	/* Danger button */
	--agy-danger-bg: #450a0a;
	--agy-danger-text: #fca5a5;
	--agy-danger-border: #ef4444;
	--agy-danger-hover-bg: #5f1313;

	/* Warning banner */
	--agy-warn-bg: #451a03;
	--agy-warn-text: #fde68a;
	--agy-warn-border: #d97706;
	--agy-warn-btn-bg: #78350f;
	--agy-warn-btn-text: #fde68a;
	--agy-warn-btn-border: #d97706;

	/* Toast notices */
	--agy-toast-success-bg: #064e3b;
	--agy-toast-success-text: #6ee7b7;
	--agy-toast-success-border: #059669;
	--agy-toast-info-bg: #1e3a8a;
	--agy-toast-info-text: #93c5fd;
	--agy-toast-info-border: #3b82f6;
	--agy-toast-warn-bg: #451a03;
	--agy-toast-warn-text: #fde68a;
	--agy-toast-warn-border: #d97706;
	--agy-toast-error-bg: #450a0a;
	--agy-toast-error-text: #fca5a5;
	--agy-toast-error-border: #dc2626;

	/* Auth Modal / Box */
	--agy-auth-box-bg: #0f223a;
	--agy-auth-box-border: #3b82f6;

	/* Segment control */
	--agy-seg-group-bg: #090d16;
	--agy-seg-group-border: #334155;
	--agy-seg-btn-text: #94a3b8;
	--agy-seg-btn-active-bg: var(--dsw-alias-state-business-primary, #2563eb);
	--agy-seg-btn-active-text: #ffffff;
	--agy-seg-danger-bg: #7f1d1d;
	--agy-seg-danger-text: #fca5a5;
	--agy-seg-danger-border: #ef4444;
}

.agy-spinner {
	display: inline-block;
	width: 12px;
	height: 12px;
	border: 2px solid currentColor;
	border-top-color: transparent;
	border-radius: 50%;
	animation: agy-spin 0.75s linear infinite;
	vertical-align: -2px;
	margin-right: 5px;
}
.agy-pulse-dot {
	display: inline-block;
	width: 8px;
	height: 8px;
	border-radius: 50%;
}
.agy-card-hover {
	transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.18s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
}
.agy-card-hover:hover {
	border-color: var(--agy-border-card-primary, #3b82f6) !important;
	box-shadow: var(--agy-shadow-card-hover) !important;
}

.agy-btn {
	transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, filter 0.15s ease, transform 0.15s ease;
	user-select: none;
}
.agy-btn:hover:not(:disabled) {
	filter: brightness(1.08);
	transform: translateY(-0.5px);
}
.agy-btn:active:not(:disabled) {
	transform: translateY(0.5px);
}
.agy-progress-fill {
	transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes agy-shimmer {
	0% { transform: translateX(-100%); }
	100% { transform: translateX(100%); }
}
.agy-shimmer-track {
	position: relative;
	overflow: hidden;
	contain: paint;
	transform: translateZ(0);
	isolation: isolate;
}
.agy-shimmer-track::after {
	content: '';
	position: absolute;
	top: 0; left: 0; right: 0; bottom: 0;
	background: linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.22) 50%, transparent 100%);
	transform: translateX(-100%) translateZ(0);
	will-change: transform;
	animation: agy-shimmer 1.8s infinite ease-in-out;
	pointer-events: none;
}
.agy-modal-backdrop {
	position: fixed;
	inset: 0;
	z-index: 9999;
	background: var(--agy-modal-backdrop);
	-webkit-backdrop-filter: blur(6px);
	backdrop-filter: blur(6px);
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 16px;
	box-sizing: border-box;
}
.agy-modal-panel {
	position: relative;
	width: 100%;
	max-width: 640px;
	max-height: min(820px, calc(100vh - 48px));
	background: var(--agy-bg-panel);
	border: 1px solid var(--agy-border-card);
	border-radius: 14px;
	box-shadow: var(--agy-shadow-modal);
	display: flex;
	flex-direction: column;
	overflow: hidden;
	color: var(--agy-text-primary);
	font-family: var(--agy-font-family);
	transform: translateZ(0);
	contain: content;
}
.agy-submodel-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 7px 10px;
	font-size: 11.5px;
	border-radius: 6px;
	background: var(--agy-bg-subbox);
	border: 1px solid var(--agy-border-box);
	margin: 4px 0;
	color: var(--agy-text-primary);
}
`;

function injectGlobalStyles(): void {
	if (typeof document === 'undefined') return;
	const styleId = 'dsh-agy-link-global-css';
	if (document.getElementById(styleId) === null) {
		const st = document.createElement('style');
		st.id = styleId;
		st.textContent = GLOBAL_CSS;
		const host = document.head ?? document.documentElement;
		if (host) host.appendChild(st);
	}
}

const S: Record<string, Record<string, unknown>> = {
	container: {
		lineHeight: 1.5,
		fontSize: '13px',
		fontFamily: 'var(--agy-font-family)',
		color: 'var(--agy-text-primary)',
	},
	headerCard: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: '12px 16px',
		background: 'var(--agy-bg-header)',
		border: '1px solid var(--agy-border-card)',
		borderRadius: '10px',
		marginBottom: '12px',
		color: 'var(--agy-text-primary)',
		boxShadow: 'var(--agy-shadow-card)',
	},
	badgePrimary: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '4px',
		background: 'var(--agy-badge-primary-bg)',
		color: 'var(--agy-badge-primary-text)',
		border: '1px solid var(--agy-badge-primary-border)',
		padding: '2px 8px',
		borderRadius: '5px',
		fontSize: '11px',
		fontWeight: 700,
	},
	badgeTag: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '4px',
		background: 'var(--agy-badge-tag-bg)',
		color: 'var(--agy-badge-tag-text)',
		border: '1px solid var(--agy-badge-tag-border)',
		padding: '2px 7px',
		borderRadius: '5px',
		fontSize: '11px',
		fontWeight: 600,
	},
	badgeReady: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '4px',
		background: 'var(--agy-badge-ready-bg)',
		color: 'var(--agy-badge-ready-text)',
		border: '1px solid var(--agy-badge-ready-border)',
		padding: '2px 8px',
		borderRadius: '5px',
		fontSize: '11px',
		fontWeight: 700,
	},
	badgeUnready: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '4px',
		background: 'var(--agy-badge-unready-bg)',
		color: 'var(--agy-badge-unready-text)',
		border: '1px solid var(--agy-badge-unready-border)',
		padding: '2px 8px',
		borderRadius: '5px',
		fontSize: '11px',
		fontWeight: 700,
	},
	card: {
		background: 'var(--agy-bg-card)',
		border: '1px solid var(--agy-border-card)',
		borderRadius: '8px',
		padding: '10px 14px',
		marginBottom: '8px',
		color: 'var(--agy-text-primary)',
		boxShadow: 'var(--agy-shadow-card)',
		transition: 'border-color 0.18s ease, box-shadow 0.18s ease, opacity 0.18s ease',
	},
	cardPrimary: {
		background: 'var(--agy-bg-card)',
		border: '1px solid var(--agy-border-card)',
		borderRadius: '8px',
		padding: '10px 14px',
		marginBottom: '8px',
		color: 'var(--agy-text-primary)',
		boxShadow: 'var(--agy-shadow-card)',
		transition: 'border-color 0.18s ease, box-shadow 0.18s ease, opacity 0.18s ease',
	},
	quotaBox: {
		background: 'var(--agy-bg-box)',
		border: '1px solid var(--agy-border-box)',
		borderRadius: '8px',
		padding: '8px 10px',
		marginTop: '8px',
	},
	progressBarBg: {
		flex: '1',
		height: '8px',
		borderRadius: '4px',
		background: 'var(--agy-bg-progress-track)',
		border: '1px solid var(--agy-border-box)',
		overflow: 'hidden',
		margin: '0 10px',
	},
	btn: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '5px 12px',
		borderRadius: '6px',
		border: '1px solid var(--agy-border-btn)',
		background: 'var(--agy-bg-btn)',
		color: 'var(--agy-text-btn)',
		cursor: 'pointer',
		fontSize: '12px',
		fontWeight: 600,
	},
	btnPrimary: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '5px 13px',
		borderRadius: '6px',
		border: '1px solid var(--agy-border-btn-primary)',
		background: 'var(--agy-bg-btn-primary)',
		color: 'var(--agy-text-btn-primary)',
		cursor: 'pointer',
		fontSize: '12px',
		fontWeight: 700,
		boxShadow: '0 2px 6px rgba(37, 99, 235, 0.35)',
	},
	btnDanger: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '4px 9px',
		borderRadius: '6px',
		border: '1px solid var(--agy-danger-border)',
		background: 'var(--agy-danger-bg)',
		color: 'var(--agy-danger-text)',
		cursor: 'pointer',
		fontSize: '11px',
		fontWeight: 600,
	},
	btnSm: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '4px 9px',
		borderRadius: '5px',
		border: '1px solid var(--agy-border-btn)',
		background: 'var(--agy-bg-btn)',
		color: 'var(--agy-text-btn)',
		cursor: 'pointer',
		fontSize: '11.5px',
		fontWeight: 600,
	},
	btnSmPrimary: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '4px 9px',
		borderRadius: '5px',
		border: '1px solid var(--agy-border-btn-primary)',
		background: 'var(--agy-bg-btn-primary)',
		color: 'var(--agy-text-btn-primary)',
		cursor: 'pointer',
		fontSize: '11.5px',
		fontWeight: 700,
	},
	segGroup: {
		display: 'inline-flex',
		background: 'var(--agy-seg-group-bg)',
		borderRadius: '7px',
		padding: '3px',
		border: '1px solid var(--agy-seg-group-border)',
	},
	segBtn: {
		padding: '4px 10px',
		borderRadius: '4px',
		border: 'none',
		background: 'transparent',
		color: 'var(--agy-seg-btn-text)',
		cursor: 'pointer',
		fontSize: '11.5px',
		fontWeight: 600,
	},
	segBtnActive: {
		padding: '4px 10px',
		borderRadius: '4px',
		border: 'none',
		background: 'var(--agy-seg-btn-active-bg)',
		color: 'var(--agy-seg-btn-active-text)',
		cursor: 'pointer',
		fontSize: '11.5px',
		fontWeight: 700,
		boxShadow: '0 2px 4px rgba(37, 99, 235, 0.4)',
	},
	input: {
		flex: '1',
		padding: '7px 12px',
		borderRadius: '6px',
		border: '1.5px solid var(--agy-border-input)',
		background: 'var(--agy-bg-input)',
		color: 'var(--agy-text-primary)',
		fontSize: '12.5px',
		outline: 'none',
	},
	muted: { color: 'var(--agy-text-tertiary)', fontSize: '11.5px' },
	noticeBanner: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: '10px 14px',
		borderRadius: '8px',
		marginBottom: '12px',
		fontSize: '12.5px',
		fontWeight: 500,
	},
	authModal: {
		background: 'var(--agy-auth-box-bg)',
		border: '1.5px solid var(--agy-auth-box-border)',
		borderRadius: '10px',
		padding: '14px 16px',
		marginBottom: '14px',
		color: 'var(--agy-text-primary)',
	},
};

export function apply(ctx: ClientContext): void {
	injectGlobalStyles();
	ctx.effect(() => {
		ensureStatusPolling();
		return () => {
			if (statusPollTimer !== null) {
				clearInterval(statusPollTimer);
				statusPollTimer = null;
			}
		};
	}, 'agy-link: status polling');
	// locale is declared in inject — cordis guarantees ctx.locale (issue #24).
	const locale = ctx.locale;
	ctx.effect(() => {
		const disposePtBR = locale.addLanguage({ id: 'pt-BR', label: 'Português (Brasil)', fallback: 'en' });
		const disposeEs = locale.addLanguage({ id: 'es', label: 'Español', fallback: 'en' });
		// Untyped single-locale form: 'agy-link' is not in the host LocaleNamespaceMap merge table.
		const disposeZh = locale.register(NS, 'zh', zh);
		const disposeEn = locale.register(NS, 'en', en);
		const disposePtBRDictionary = locale.register(NS, 'pt-BR', ptBR);
		const disposeEsDictionary = locale.register(NS, 'es', es);
		return () => { disposeEsDictionary(); disposePtBRDictionary(); disposeEn(); disposeZh(); disposeEs(); disposePtBR(); };
	}, 'agy-link: locale dictionaries');
	const useAgyTranslation = () => {
		const [, rerender] = useState(0);
		useEffect(() => locale.subscribe(() => rerender((revision) => revision + 1)), []);
		return locale.bind(NS) as (key: AgyLocaleKey, params?: Record<string, unknown>) => string;
	};
	const AgySettingsSection = (props?: any): unknown => {
		const t = useAgyTranslation();
		const { status, refresh } = useAgyStatus();
		const [aliasInput, setAliasInput] = useState('');
		const [proxyInputs, setProxyInputs] = useState<Record<string, string>>({});
		const [editingProxyId, setEditingProxyId] = useState<string | null>(null);
		const [addingAccount, setAddingAccount] = useState(false);
		const [authCodeInput, setAuthCodeInput] = useState('');
		const [loadingAction, setLoadingAction] = useState<string | null>(null);
		const [toast, setToast] = useState<ToastNotice | null>(null);
		const [expandedModels, setExpandedModels] = useState<Record<string, boolean>>({});
		const [addProxyInput, setAddProxyInput] = useState('');
		const [optimisticActiveId, setOptimisticActiveId] = useState<string | null>(null);


		// Cooldown expiry and quota countdowns are Date.now()-derived while the
		// payload itself does NOT change when they lapse — without a wall-clock
		// tick the "cooldown" banner and the minutes-left froze forever.
		const [, setTimeTick] = useState(0);
		useEffect(() => {
			const timer = setInterval(() => setTimeTick((n) => n + 1), 30_000);
			return () => clearInterval(timer);
		}, []);

		const flowStartedRef = useRef(false);
		const safeMessage = (code?: string): string => {
			const key = `auth.code.${code ?? ''}` as AgyLocaleKey;
			return code && key in en ? t(key) : t('api.genericError');
		};
		useEffect(() => {
			if (!addingAccount || !flowStartedRef.current) return;
			const pa = status?.poolAuth;
			if (!pa) return;
			if (pa.phase === 'done') {
				flowStartedRef.current = false;
				setAddingAccount(false);
				setAuthCodeInput('');
				setAliasInput('');
				setAddProxyInput('');
				showToast(safeMessage(pa.code), 'success');
			} else if (pa.phase === 'failed') {
				flowStartedRef.current = false;
				showToast(safeMessage(pa.code), 'error');
			}
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [addingAccount, status?.poolAuth?.phase, status?.poolAuth?.code]);

		const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
		useEffect(() => () => {
			// Unmount must not leave a pending timer writing state into a dead
			// component; a second same-text toast also used to be cleared early
			// by the FIRST toast's leftover timer.
			if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
		}, []);
		const showToast = (text: string, type: ToastNotice['type'] = 'info') => {
			setToast({ text, type, id: Date.now() });
			if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
			toastTimerRef.current = setTimeout(() => {
				toastTimerRef.current = null;
				setToast((prev) => (prev !== null && prev.text === text ? null : prev));
			}, 6000);
		};

		const actionFailed = (): void => {
			showToast(t('api.genericError'), 'error');
		};

		const handleBeginAddAccount = async (): Promise<void> => {
			setLoadingAction('pool:beginAdd');
			const alias = aliasInput.trim();
			const proxyUrl = addProxyInput.trim();
			const res = await postJson('/plugins/agy-link/pool/begin-add', {
				...(alias ? { alias } : {}),
				...(proxyUrl ? { proxyUrl } : {}),
			});
			setLoadingAction(null);
			if (res && res.ok) {
				flowStartedRef.current = true;
				await refresh();
				if (res.browserOpened) {
					showToast(t('auth.browserOpened'), 'info');
				} else {
					showToast(t('auth.browserManual'), 'warn');
				}
			} else {
				showToast(res?.code ? safeMessage(res.code) : t('auth.startFailed'), 'error');
			}
		};

		const handleCompleteAddAccount = async (): Promise<void> => {
			if (!authCodeInput.trim()) return;
			setLoadingAction('pool:completeAdd');
			const res = await postJson('/plugins/agy-link/pool/complete-add', { code: authCodeInput.trim() });
			setLoadingAction(null);
			if (res && res.ok) {
				flowStartedRef.current = false;
				setAuthCodeInput('');
				setAliasInput('');
				setAddProxyInput('');
				setAddingAccount(false);
				await refresh();
				showToast(safeMessage(res.code), 'success');
			} else {
				showToast(safeMessage(res?.code), 'error');
			}
		};

		const handleCancelAddAccount = async (): Promise<void> => {
			flowStartedRef.current = false;
			await postJson('/plugins/agy-link/pool/cancel-add', {});
			setAuthCodeInput('');
			setAliasInput('');
			setAddProxyInput('');
			setAddingAccount(false);
			await refresh();
		};

		const reorderAccounts = async (newIds: string[]): Promise<void> => {
			setLoadingAction('pool:reorder');
			const res = await postJson('/plugins/agy-link/pool/reorder', { ids: newIds });
			setLoadingAction(null);
			if (res && res.ok) {
				await refresh();
				showToast(t('account.reordered'), 'success');
			} else {
				actionFailed();
			}
		};

		const moveAccount = async (accId: string, delta: number): Promise<void> => {
			const ids = (status?.pool?.accounts ?? []).map((a) => a.id);
			const idx = ids.indexOf(accId);
			if (idx === -1) return;
			const newIdx = idx + delta;
			if (newIdx < 0 || newIdx >= ids.length) return;
			const [moved] = ids.splice(idx, 1);
			if (moved) ids.splice(newIdx, 0, moved);
			await reorderAccounts(ids);
		};

		const setCfg = async (key: string, value: unknown): Promise<void> => {
			setLoadingAction(`config:${key}`);
			const res = await postJson('/plugins/agy-link/config', { key, value });
			if (res === null || res?.ok === false) {
				setLoadingAction(null);
				actionFailed();
				return;
			}
			await refresh();
			setLoadingAction(null);
		};

		const hiddenPendingRef = useRef<Set<string> | null>(null);
		const toggleModelHidden = async (id: string, hide: boolean): Promise<void> => {
			// Merge against the PENDING set, not the last-rendered snapshot:
			// two rapid clicks used to read the same stale status and the
			// second silently overwrote the first (lost update).
			const next = new Set(hiddenPendingRef.current ?? status?.hiddenModels ?? []);
			if (hide) next.add(id); else next.delete(id);
			hiddenPendingRef.current = next;
			try {
				await setCfg('hiddenModels', Array.from(next));
			} finally {
				if (hiddenPendingRef.current === next) hiddenPendingRef.current = null;
			}
		};

		const setActiveAccount = async (id: string): Promise<void> => {
			setOptimisticActiveId(id);
			setLoadingAction(`active:${id}`);
			try {
				const res = await postJson('/plugins/agy-link/pool/set-active', { id });
				if (res && res.ok) {
					await refresh();
					showToast(t('account.activeSet'), 'success');
				} else {
					setOptimisticActiveId(null);
					showToast(res?.error || t('account.activeSetFailed'), 'error');
				}
			} catch {
				setOptimisticActiveId(null);
				showToast(t('account.activeSetFailed'), 'error');
			} finally {
				setOptimisticActiveId(null);
				setLoadingAction(null);
			}
		};

		const removeAccount = async (id: string, alias: string): Promise<void> => {
			setLoadingAction(`remove:${id}`);
			const res = await postJson('/plugins/agy-link/pool/remove', { id });
			if (res === null || res?.ok === false) {
				setLoadingAction(null);
				actionFailed();
				return;
			}
			await refresh();
			setLoadingAction(null);
			showToast(t('account.removed', { alias }), 'info');
		};

		const toggleAccountEnabled = async (acc: ManagedAccount): Promise<void> => {
			const nextState = !acc.enabled;
			setLoadingAction(`enable:${acc.id}`);
			const res = await postJson('/plugins/agy-link/pool/enable', { id: acc.id, enabled: nextState });
			if (res === null || res?.ok === false) {
				setLoadingAction(null);
				actionFailed();
				return;
			}
			await refresh();
			setLoadingAction(null);
			const legacyDefault = acc.defaultAlias === undefined && acc.systemHome && acc.alias === '主账号 (系统登录)';
			const displayAlias = acc.defaultAlias || legacyDefault
				? acc.systemHome ? t('account.defaultAlias') : acc.alias
				: acc.alias;
			showToast(t(nextState ? 'account.enabledToast' : 'account.disabledToast', { alias: displayAlias }), 'success');
		};

		const refreshQuota = async (id?: string): Promise<void> => {
			setLoadingAction(id ? `refresh:${id}` : 'refresh:all');
			try {
				const res = await postJson('/plugins/agy-link/pool/refresh-quota', { id });
				if (res === null || res?.ok === false) {
					actionFailed();
					return;
				}
				await refresh();
				showToast(t('quota.refreshed'), 'success');
			} finally {
				setLoadingAction(null);
			}
		};

		const saveProxy = async (id: string): Promise<void> => {
			setLoadingAction(`proxy:${id}`);
			const proxyUrl = proxyInputs[id];
			const res = await postJson('/plugins/agy-link/pool/proxy', { id, proxyUrl });
			if (res === null || res?.ok === false) {
				setLoadingAction(null);
				actionFailed();
				return;
			}
			setEditingProxyId(null);
			await refresh();
			setLoadingAction(null);
			showToast(t('proxy.saved'), 'success');
		};

		const setMode = async (mode: string): Promise<void> => {
			setLoadingAction(`mode:${mode}`);
			const res = await postJson('/plugins/agy-link/pool/mode', { mode });
			if (res === null || res?.ok === false) {
				setLoadingAction(null);
				actionFailed();
				return;
			}
			await refresh();
			setLoadingAction(null);
		};

		const clearCooldown = async (id?: string): Promise<void> => {
			setLoadingAction(id ? `clearCooldown:${id}` : 'clearCooldown:all');
			const res = await postJson('/plugins/agy-link/pool/clear-cooldown', { id });
			if (res === null || res?.ok === false) {
				setLoadingAction(null);
				actionFailed();
				return;
			}
			await refresh();
			setLoadingAction(null);
			showToast(t('account.clearCooldown'), 'success');
		};

		const toggleExpand = (accId: string) => {
			setExpandedModels((prev) => ({ ...prev, [accId]: !prev[accId] }));
		};

		const authPhase = status?.auth?.phase ?? 'unknown';
		const pool = status?.pool;
		const catalogModels = status?.catalogModels ?? [];
		const hiddenModelSet = new Set(status?.hiddenModels ?? []);
		const accounts = pool?.accounts ?? [];
		const isAuthed = authPhase === 'ok' || accounts.length > 0;
		// Per-action busy scoping (2026-10-23): `isBusy` used to be
		// `loadingAction !== null` and was applied to EVERY account button, so
		// one refresh flipped 40 `disabled` attributes at once (measured: 40
		// attribute mutations for 2 added nodes) and repainted the whole panel.
		// Each control now derives its own busy state from the action that
		// concerns it, so an unrelated action leaves its DOM untouched.
		const isBusy = loadingAction !== null;
		/** Busy for a per-account action; also blocks while a global action runs. */
		const accountActionBusy = (acc: ManagedAccount, action: string): boolean =>
			loadingAction === `${action}:${acc.id}`;
		/** Global actions (add/sync-all/save) genuinely conflict with everything. */
		const globalBusy = isBusy && !loadingAction?.includes(':');

		const renderSpinner = () => h('span', { className: 'agy-spinner' });

		const renderToastBanner = () => {
			if (!toast) return null;
			const typeStyles = {
				success: { background: 'var(--agy-toast-success-bg)', border: '1px solid var(--agy-toast-success-border)', color: 'var(--agy-toast-success-text)' },
				info: { background: 'var(--agy-toast-info-bg)', border: '1px solid var(--agy-toast-info-border)', color: 'var(--agy-toast-info-text)' },
				warn: { background: 'var(--agy-toast-warn-bg)', border: '1px solid var(--agy-toast-warn-border)', color: 'var(--agy-toast-warn-text)' },
				error: { background: 'var(--agy-toast-error-bg)', border: '1px solid var(--agy-toast-error-border)', color: 'var(--agy-toast-error-text)' },
			};
			const style = typeStyles[toast.type];
			return h('div', { style: { ...S.noticeBanner, ...style } },
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 } },
					uiIcon(toast.type === 'success' ? 'check' : toast.type === 'error' || toast.type === 'warn' ? 'alert' : 'globe', 14, style.color),
					h('span', null, toast.text),
				),
				h('button', {
					type: 'button',
					style: { background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: '0 4px', opacity: 0.8, display: 'inline-flex', alignItems: 'center' },
					onClick: () => setToast(null),
					'aria-label': t('aria.closeToast'),
				}, uiIcon('x', 12)),
			);
		};

		// Scoped shimmer (2026-10-23): the global 'refresh-quota' flag used to be
		// passed to EVERY account's quota bars, so refreshing one account started
		// the infinite shimmer animation on all of them — extra compositing and
		// repaints across the whole panel while the user scrolls.
		const renderQuotaBar = (label: string, familyKey: 'google' | 'argon' | 'anthropic' | 'openai', acc: ManagedAccount): unknown =>
			renderFamilyQuotaBar(
				t,
				label,
				familyKey,
				acc,
				loadingAction === 'refresh:all' || loadingAction === `refresh:${acc.id}`,
			);

		// Authoritative active account: trust pool.activeAccountId computed by
		// the scheduler, falling back to lastActiveAccountId, activeAccountIds.google, or primaryAccountId.
		// Optimistic selection takes priority for instant zero-flicker feedback.
		const authoritativeActiveId = pool?.activeAccountId ?? pool?.lastActiveAccountId ?? pool?.activeAccountIds?.google ?? pool?.primaryAccountId;
		const activeAccountId = optimisticActiveId ?? authoritativeActiveId;
		const renderedAccountCards = accounts.map((acc: ManagedAccount) => {
			const isPrimary = acc.id === pool?.primaryAccountId;
			const hasCooldown = Object.entries(acc.cooldowns).some(([, cd]) => cd && cd.cooldownUntil > Date.now());
			const isAuthRequired = acc.authRequired;
			const isInUse = acc.enabled && !isAuthRequired && activeAccountId !== undefined && activeAccountId === acc.id;
			const dotColor = !acc.enabled ? '#64748b' : isAuthRequired ? '#ef4444' : hasCooldown ? '#f59e0b' : '#10b981';
			const isEditingProxy = editingProxyId === acc.id;
			const isExpanded = expandedModels[acc.id] ?? false;
			const accIndex = accounts.indexOf(acc);

			const cardStyle = {
				...S.card,
				cursor: 'default',
				padding: '10px 14px',
				marginBottom: '8px',
				...(!acc.enabled ? { opacity: 0.72 } : {}),
			};
			// Built-in aliases are canonical server data; translate display only.
			const legacyDefault = acc.defaultAlias === undefined && acc.systemHome && acc.alias === '主账号 (系统登录)';
			const displayAlias = acc.defaultAlias || legacyDefault
				? acc.systemHome ? t('account.defaultAlias') : t('account.aliasDefault', { number: accIndex + 1 })
				: acc.alias;

			const googleModels = acc.quotas.google?.models ?? [];
			const argonModels = acc.quotas.argon?.models ?? [];
			const anthropicModels = acc.quotas.anthropic?.models ?? [];
			const openaiModels = acc.quotas.openai?.models ?? [];
			const allChildModels: { family: string; model: ModelQuotaInfo }[] = [
				...googleModels.map((m) => ({ family: 'Google', model: m })),
				...argonModels.map((m) => ({ family: 'Argon', model: m })),
				...anthropicModels.map((m) => ({ family: 'Anthropic', model: m })),
				...openaiModels.map((m) => ({ family: 'OpenAI', model: m })),
			];

			return h('div', {
				key: acc.id,
				className: 'agy-card-hover',
				style: cardStyle,
			},
				// Header row
				h('div', {
					style: {
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
						userSelect: 'none',
						gap: '8px',
						marginBottom: '8px',
					},
				},
					h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', flex: '1', minWidth: 0 } },
						h('span', {
							style: {
								...S.badgeTag,
								fontWeight: 700,
								fontSize: '10.5px',
								padding: '1px 5px',
								background: isPrimary ? 'var(--agy-badge-primary-bg)' : 'var(--agy-badge-tag-bg)',
								color: isPrimary ? 'var(--agy-badge-primary-text)' : 'var(--agy-badge-tag-text)',
								borderColor: isPrimary ? 'var(--agy-badge-primary-border)' : 'var(--agy-badge-tag-border)',
							},
							title: `优先级 #${accIndex + 1}`,
						}, `#${accIndex + 1}`),
						accounts.length > 1 ? h('div', {
							style: { display: 'inline-flex', gap: '2px', alignItems: 'center' },
						},
							accIndex > 0 ? h('button', {
								type: 'button',
								className: 'agy-btn',
								style: { ...S.btnSm, padding: '1px 4px', fontSize: '10px', lineHeight: 1, height: '18px' },
								title: t('account.moveUp'),
								onClick: () => void moveAccount(acc.id, -1),
							}, uiIcon('arrowUp', 10)) : null,
							accIndex < accounts.length - 1 ? h('button', {
								type: 'button',
								className: 'agy-btn',
								style: { ...S.btnSm, padding: '1px 4px', fontSize: '10px', lineHeight: 1, height: '18px' },
								title: t('account.moveDown'),
								onClick: () => void moveAccount(acc.id, 1),
							}, uiIcon('arrowDown', 10)) : null,
						) : null,
						h('span', {
							className: 'agy-pulse-dot',
							style: { background: dotColor, boxShadow: `0 0 6px ${dotColor}aa`, marginLeft: '1px' },
						}),
						h('span', {
							style: {
								fontWeight: 700,
								fontSize: '13px',
								color: 'var(--agy-text-primary)',
								whiteSpace: 'nowrap',
							},
							title: displayAlias,
						}, displayAlias),
						h('span', {
							style: {
								...S.badgeTag,
								background: 'rgba(59, 130, 246, 0.12)',
								color: '#3b82f6',
								borderColor: 'rgba(59, 130, 246, 0.35)',
								fontSize: '10px',
								padding: '1px 5px',
								fontWeight: 700,
							},
						}, 'AGY'),
						isAuthRequired ? h('span', {
							style: {
								...S.badgeTag,
								background: 'var(--agy-badge-email-bg)',
								color: '#ef4444',
								borderColor: '#fca5a5',
								gap: '3px',
								fontSize: '10px',
								padding: '1px 5px',
								fontWeight: 700,
							},
						}, uiIcon('alert', 10, '#ef4444'), t('status.authRequired')) : null,
						hasCooldown ? h('span', {
							style: {
								...S.badgeTag,
								background: 'rgba(245, 158, 11, 0.15)',
								color: '#f59e0b',
								borderColor: 'rgba(245, 158, 11, 0.4)',
								gap: '3px',
								fontSize: '10px',
								padding: '1px 5px',
								fontWeight: 700,
							},
						}, uiIcon('alert', 10, '#f59e0b'), '冷却中') : null,
						acc.email ? h('span', {
							style: {
								...S.badgeTag,
								background: 'var(--agy-badge-email-bg)',
								color: 'var(--agy-badge-email-text)',
								borderColor: 'var(--agy-badge-email-border)',
								gap: '4px',
								fontSize: '11px',
								padding: '1px 6px',
								whiteSpace: 'nowrap',
							},
							title: acc.email,
						}, uiIcon('mail', 10, 'var(--agy-badge-email-text)'), acc.email) : null,
						isInUse ? h('span', {
							style: {
								...S.badgeTag,
								background: 'rgba(16, 185, 129, 0.12)',
								color: '#10b981',
								borderColor: 'rgba(16, 185, 129, 0.45)',
								gap: '3px',
								fontSize: '10px',
								padding: '1px 5px',
								fontWeight: 700,
							},
							title: t('status.inUse'),
						}, uiIcon('zap', 10, '#10b981'), t('status.inUse')) : null,
						(() => {
							const effectiveProxy = acc.proxyUrl || pool?.systemProxy;
							return effectiveProxy ? h('span', {
								style: {
									...S.badgeTag,
									background: 'var(--agy-badge-proxy-bg)',
									color: 'var(--agy-badge-proxy-text)',
									borderColor: 'var(--agy-badge-proxy-border)',
									gap: '4px',
									fontSize: '10px',
									padding: '1px 5px',
								},
								title: effectiveProxy,
							}, uiIcon('globe', 10, 'var(--agy-badge-proxy-text)'), t('status.proxy')) : null;
						})(),
						!acc.enabled ? h('span', {
							style: {
								...S.badgeTag,
								background: 'var(--agy-bg-subbox)',
								color: 'var(--agy-text-secondary)',
								borderColor: 'var(--agy-border-subbox)',
								gap: '3px',
								fontSize: '10px',
								padding: '1px 5px',
								fontWeight: 700,
							},
							title: t('status.disabled'),
						}, uiIcon('power', 10, '#64748b'), t('status.disabled')) : null,
					),
					h('div', {
						style: { display: 'flex', gap: '4px', alignItems: 'center', flexShrink: 0 },
					},
						h('button', {
							type: 'button',
							className: 'agy-btn',
							style: acc.enabled
								? { ...S.btnSm, gap: '3px', fontSize: '11px', padding: '2px 6px' }
								: { ...S.btnSmPrimary, gap: '3px', fontSize: '11px', padding: '2px 6px' },
							title: acc.enabled ? t('account.disableTitle') : t('account.enableTitle'),
							disabled: accountActionBusy(acc, 'enable'),
							onClick: () => void toggleAccountEnabled(acc),
						}, loadingAction === `enable:${acc.id}`
							? [renderSpinner(), acc.enabled ? t('account.disable') : t('account.enable')]
							: [uiIcon('power', 10, acc.enabled ? 'var(--agy-text-secondary)' : '#ffffff'), ` ${acc.enabled ? t('account.disable') : t('account.enable')}`]),
						h('button', {
							type: 'button',
							className: 'agy-btn',
							style: { ...S.btnSm, gap: '3px', fontSize: '11px', padding: '2px 6px', minWidth: '58px', justifyContent: 'center' },
							title: t('account.syncTitle'),
							disabled: accountActionBusy(acc, 'refresh'),
							onClick: () => void refreshQuota(acc.id),
						}, loadingAction === `refresh:${acc.id}` ? [renderSpinner(), t('account.syncing')] : [uiIcon('refresh', 10), ` ${t('account.sync')}`]),
						acc.enabled && !isInUse ? h('button', {
							type: 'button',
							className: 'agy-btn',
							style: { ...S.btnSm, gap: '3px', fontSize: '11px', padding: '2px 6px' },
							title: t('account.setActive'),
							disabled: accountActionBusy(acc, 'active'),
							onClick: () => void setActiveAccount(acc.id),
						}, loadingAction === `active:${acc.id}` ? [renderSpinner(), t('account.settingActive')] : [uiIcon('zap', 10), ` ${t('account.setActive')}`]) : null,

						h('button', {
							type: 'button',
							className: 'agy-btn',
							style: isEditingProxy ? { ...S.btnSmPrimary, gap: '3px', fontSize: '11px', padding: '2px 6px' } : { ...S.btnSm, gap: '3px', fontSize: '11px', padding: '2px 6px' },
							disabled: accountActionBusy(acc, 'proxy'),
							onClick: () => setEditingProxyId(isEditingProxy ? null : acc.id),
						}, [uiIcon('globe', 10), ` ${t('proxy.button')}`]),
						accounts.length > 1 ? h('button', {
							type: 'button',
							className: 'agy-btn',
							style: { ...S.btnDanger, padding: '2px 6px', fontSize: '11px' },
							title: t('account.removeTitle'),
							'aria-label': t('account.removeTitle'),
							disabled: accountActionBusy(acc, 'remove'),
							onClick: () => void removeAccount(acc.id, displayAlias),
						}, loadingAction === `remove:${acc.id}` ? renderSpinner() : uiIcon('trash', 11, 'var(--agy-danger-text)')) : null,
					),
				),
				// Body: Always directly visible, showing quota
h('div', { key: 'agy-body', style: S.quotaBox },
						renderQuotaBar('Gemini', 'google', acc),
						// Gemini 4 Argon (Pro/Ultra only): the backend reports its own
						// quota group/weekly bucket ONLY for accounts that have the
						// permission, so gate the row on the data itself — free and
						// legacy plans never see an empty Argon panel.
						acc.quotas.argon ? renderQuotaBar('Argon', 'argon', acc) : null,
						h('button', {
							type: 'button',
							className: 'agy-btn',
							style: {
								width: '100%',
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'center',
								gap: '5px',
								marginTop: '6px',
								padding: '5px 10px',
								fontSize: '11px',
								fontWeight: 600,
								cursor: 'pointer',
								color: isExpanded ? 'var(--dsw-alias-state-business-primary, #3b82f6)' : 'var(--agy-text-secondary)',
								background: 'var(--agy-bg-subbox)',
								border: '1px dashed var(--agy-border-box)',
								borderRadius: '6px',
							},
							onClick: () => toggleExpand(acc.id),
						},
							uiIcon(isExpanded ? 'chevronUp' : 'chevronDown', 10),
							h('span', null, isExpanded ? t('account.collapseOthers') : t('account.expandOthers')),
						),
						isExpanded ? [
							renderQuotaBar('Claude', 'anthropic', acc),
							renderQuotaBar('GPT-OSS', 'openai', acc),
							allChildModels.length > 0 ? h('div', {
								style: {
									marginTop: '8px',
									paddingTop: '8px',
									borderTop: '1px solid var(--agy-border-box)',
								},
							},
								h('div', { style: { color: 'var(--agy-text-secondary)', marginBottom: '6px', fontWeight: 600, fontSize: '11px' } }, t('account.models')),
								allChildModels.map(({ family, model }) => {
									const frac = model.remainingFraction ?? 1;
									const pct = Math.round(frac * 100);
									const w = formatQuotaWindow(t, model.resetTime);
									const pColor = pct <= 20 ? 'var(--agy-quota-low-text)' : pct <= 50 ? 'var(--agy-quota-med-text)' : 'var(--agy-quota-high-text)';
									return h('div', { key: `${family}-${model.modelId}`, className: 'agy-submodel-row' },
										h('span', { style: { fontWeight: 500, color: 'var(--agy-text-primary)' } }, `[${family}] ${model.displayName || model.modelId}`),
										h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
											h('span', { style: { color: pColor, fontWeight: 700 } }, `${pct}%`),
											w.resetText ? h('span', { style: { color: 'var(--agy-text-tertiary)', fontSize: '10.5px' } }, `↻ ${w.resetText}`) : null,
										),
									);
								}),
							) : null,
						] : null,
					),
				hasCooldown ? h('div', {
					key: 'cd-body',
					style: {
						background: 'var(--agy-warn-bg)',
						border: '1px solid var(--agy-warn-border)',
						borderRadius: '7px',
						padding: '6px 10px',
						color: 'var(--agy-warn-text)',
						fontSize: '11.5px',
						fontWeight: 600,
						marginTop: '8px',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
					},
				},
					h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
						uiIcon('alert', 13, 'var(--agy-warn-text)'),
						h('span', null, t('account.cooldown')),
					),
					h('button', {
						type: 'button',
						className: 'agy-btn',
						style: { ...S.btnSm, color: 'var(--agy-warn-btn-text)', borderColor: 'var(--agy-warn-btn-border)', background: 'var(--agy-warn-btn-bg)', gap: '4px' },
						disabled: accountActionBusy(acc, 'clearCooldown'),
						onClick: () => void clearCooldown(acc.id),
					}, loadingAction === `clearCooldown:${acc.id}` ? [renderSpinner(), ''] : [uiIcon('zap', 11, 'var(--agy-warn-btn-text)'), ` ${t('account.clearCooldown')}`]),
				) : null,
				isEditingProxy ? h('div', {
					key: 'proxy-body',
					style: {
						marginTop: '8px',
						padding: '10px 12px',
						background: 'var(--agy-bg-subbox)',
						borderRadius: '7px',
						border: '1px solid var(--agy-border-subbox)',
					},
				},
					h('div', { style: { display: 'flex', gap: '8px' } },
						h('input', {
							style: S.input,
							value: proxyInputs[acc.id] !== undefined ? proxyInputs[acc.id] : (acc.proxyUrl ?? ''),
							placeholder: pool?.systemProxy ? `${t('proxy.placeholder')} (${pool.systemProxy})` : t('proxy.placeholder'),
							'aria-label': t('aria.proxyInput'),
							onChange: (e: { target: { value: string } }) => setProxyInputs({ ...proxyInputs, [acc.id]: e.target.value }),
						}),
						h('button', {
							type: 'button',
							className: 'agy-btn',
							style: S.btnPrimary,
							disabled: accountActionBusy(acc, 'proxy'),
							onClick: () => void saveProxy(acc.id),
						}, loadingAction === `proxy:${acc.id}` ? [renderSpinner(), t('proxy.save')] : t('proxy.save')),
						h('button', {
							type: 'button',
							className: 'agy-btn',
							style: S.btn,
							onClick: () => setEditingProxyId(null),
						}, t('cancel')),
					),
				) : null,
			);
		});

		const poolAuth = status?.poolAuth;
		const flowPhase = poolAuth?.phase ?? 'idle';
		const flowActive = flowPhase === 'waiting' || flowPhase === 'exchanging';

		const addAccountSection = addingAccount
			? h('div', { style: S.authModal, role: 'group', 'aria-label': t('account.add') },
				h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' } },
					h('div', { style: { fontWeight: 700, fontSize: '13.5px', display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--agy-text-primary)' } },
						uiIcon('plus', 13, 'var(--agy-btn-primary-bg)'),
						t('account.add'),
					),
					),
				(!flowActive
						? h('div', null,
							h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' } },
								h('input', {
									style: S.input,
									value: aliasInput,
									placeholder: t('account.aliasPlaceholder'),
									'aria-label': t('aria.aliasInput'),
									onChange: (e: { target: { value: string } }) => setAliasInput(e.target.value),
								}),
								h('input', {
									style: S.input,
									value: addProxyInput,
									placeholder: pool?.systemProxy ? `${t('account.proxyPlaceholder')} (${pool.systemProxy})` : t('account.proxyPlaceholder'),
									'aria-label': t('aria.proxyInput'),
									onChange: (e: { target: { value: string } }) => setAddProxyInput(e.target.value),
								}),
							),
							h('div', { style: { display: 'flex', gap: '8px' } },
								h('button', {
									type: 'button',
									className: 'agy-btn',
									style: { ...S.btnPrimary, gap: '4px' },
									disabled: isBusy,
									onClick: () => void handleBeginAddAccount(),
								}, loadingAction === 'pool:beginAdd' ? [renderSpinner(), t('auth.openingBrowser')] : [uiIcon('externalLink', 12, '#ffffff'), ` ${t('auth.openBrowser')}`]),
								h('button', {
									type: 'button',
									className: 'agy-btn',
									style: S.btn,
									onClick: () => handleCancelAddAccount(),
								}, t('cancel')),
							),
							flowPhase === 'failed' ? h('div', {
								style: { ...S.muted, color: 'var(--agy-danger-text)', marginTop: '8px', display: 'flex', alignItems: 'center', gap: '5px', fontWeight: 600 },
							}, uiIcon('alert', 12, 'var(--agy-danger-text)'), safeMessage(poolAuth?.code)) : null,
						)
						: h('div', null,
							h('div', { style: { display: 'flex', alignItems: 'center', color: 'var(--agy-text-secondary)', marginBottom: '8px', lineHeight: 1.5, fontSize: '12px' } },
								renderSpinner(),
								flowPhase === 'exchanging'
									? t('auth.exchanging')
									: t('auth.waiting'),
							),
							poolAuth?.url ? h('div', { style: { marginBottom: '8px' } },
								h('a', {
									href: poolAuth.url,
									target: '_blank',
									style: { color: 'var(--dsw-alias-state-business-primary, #2563eb)', textDecoration: 'underline', fontSize: '12px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '4px' },
								}, uiIcon('externalLink', 12, 'currentColor'), t('auth.openManual')),
							) : null,
							h('div', { style: { color: 'var(--agy-text-tertiary)', marginBottom: '6px', fontSize: '11px', fontWeight: 500 } },
								t('auth.pasteHint'),
							),
							h('div', { style: { display: 'flex', gap: '8px' } },
								h('input', {
									style: S.input,
									value: authCodeInput,
									placeholder: t('auth.codePlaceholder'),
									'aria-label': t('aria.authCodeInput'),
									onChange: (e: { target: { value: string } }) => setAuthCodeInput(e.target.value),
								}),
								h('button', {
									type: 'button',
									className: 'agy-btn',
									style: { ...S.btnPrimary, gap: '4px' },
									disabled: isBusy || !authCodeInput.trim(),
									onClick: () => void handleCompleteAddAccount(),
								}, loadingAction === 'pool:completeAdd' ? [renderSpinner(), t('auth.activating')] : [uiIcon('check', 12, '#ffffff'), ` ${t('auth.activate')}`]),
								h('button', {
									type: 'button',
									className: 'agy-btn',
									style: S.btn,
									onClick: () => handleCancelAddAccount(),
								}, t('cancel')),
							),
						))
)
			: null;

		if (status === null) {
			return h('div', { style: { ...S.container, minHeight: '120px', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
				h('span', { style: S.muted }, [renderSpinner(), t('status.loading')]),
			);
		}

		return h('div', { style: S.container },
			h('div', { style: S.headerCard },
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
					agyIcon(18),
					h('span', { style: { fontWeight: 700, fontSize: '14px', color: 'var(--agy-text-primary)' } }, 'Antigravity'),
					h('span', { style: isAuthed ? S.badgeReady : S.badgeUnready }, isAuthed ? t('status.ready') : t('status.needsAuth')),
				),
				h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
					!addingAccount ? h('button', {
						type: 'button',
						className: 'agy-btn',
						style: { ...S.btnPrimary, gap: '4px' },
						onClick: () => setAddingAccount(true),
					}, [uiIcon('plus', 12, '#ffffff'), ` ${t('account.add')}`]) : null,
					h('button', {
						type: 'button',
						className: 'agy-btn',
						style: { ...S.btn, gap: '4px' },
						disabled: isBusy,
						onClick: () => void refreshQuota(),
					}, loadingAction === 'refresh:all' ? [renderSpinner(), t('header.refreshing')] : [uiIcon('refresh', 12, 'var(--agy-text-btn)'), ` ${t('header.refreshQuota')}`]),
				),
			),
			renderToastBanner(),
			addAccountSection,
			h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', padding: '0 2px' } },
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
					h('span', { style: { fontWeight: 700, fontSize: '12.5px', color: 'var(--agy-text-primary)' } }, `账号池 (${accounts.length})`),
				),
			),
			renderedAccountCards,
			h('div', { style: { marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--agy-border-divider)' } },
				h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
					h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
						h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px' } }, t('permission.label')),
						h('div', { style: S.segGroup },
							h('button', {
								type: 'button',
								style: status?.permissionMode === 'plan' ? S.segBtnActive : S.segBtn,
								onClick: () => void setCfg('permissionMode', 'plan'),
							}, t('permission.plan')),
							h('button', {
								type: 'button',
								style: status?.permissionMode === 'accept-edits' ? S.segBtnActive : S.segBtn,
								onClick: () => void setCfg('permissionMode', 'accept-edits'),
							}, t('permission.acceptEdits')),
							h('button', {
								type: 'button',
								style: status?.permissionMode === 'skip' ? { ...S.segBtnActive, color: 'var(--agy-seg-danger-text)', background: 'var(--agy-seg-danger-bg)', border: '1px solid var(--agy-seg-danger-border)' } : S.segBtn,
								onClick: () => void setCfg('permissionMode', 'skip'),
							}, t('permission.skip')),
						),
					),
					h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
						h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px' } }, t('effort.label')),
						h('div', { style: S.segGroup },
							h('button', {
								type: 'button',
								style: status?.defaultEffort === '' ? S.segBtnActive : S.segBtn,
								onClick: () => void setCfg('defaultEffort', ''),
							}, t('effort.auto')),
							h('button', {
								type: 'button',
								style: status?.defaultEffort === 'low' ? S.segBtnActive : S.segBtn,
								onClick: () => void setCfg('defaultEffort', 'low'),
							}, t('effort.low')),
							h('button', {
								type: 'button',
								style: status?.defaultEffort === 'medium' ? S.segBtnActive : S.segBtn,
								onClick: () => void setCfg('defaultEffort', 'medium'),
							}, t('effort.medium')),
							h('button', {
								type: 'button',
								style: status?.defaultEffort === 'high' ? S.segBtnActive : S.segBtn,
								onClick: () => void setCfg('defaultEffort', 'high'),
							}, t('effort.high')),
						),
					),
					h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
						h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px' } }, t('pool.label')),
						h('div', { style: S.segGroup },
							h('button', {
								type: 'button',
								style: pool?.mode === 'sequential' || !pool?.mode ? S.segBtnActive : S.segBtn,
								onClick: () => void setMode('sequential'),
							}, t('pool.sequential')),
							h('button', {
								type: 'button',
								style: pool?.mode === 'round-robin' ? S.segBtnActive : S.segBtn,
								onClick: () => void setMode('round-robin'),
							}, t('pool.roundRobin')),
						),
					),
					h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
						h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px' } }, t('models.label')),
						catalogModels.length === 0
							? h('span', { style: S.muted }, t('models.empty'))
							: h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
								catalogModels.map((m) => {
									const isHidden = hiddenModelSet.has(m.id);
									return h('button', {
										type: 'button',
										key: m.id,
										title: m.id,
										disabled: loadingAction === 'config:hiddenModels',
										style: isHidden ? { ...S.segBtn, opacity: 0.45, textDecoration: 'line-through' } : S.segBtnActive,
										onClick: () => void toggleModelHidden(m.id, !isHidden),
									}, m.name);
								}),
							),
						h('span', { style: S.muted }, t('models.hint')),
					),
				),
			),
		);
	};

	/** Modal dialog container rendered into document.body */
	const AgyModalDialog = (): unknown => {
		const t = useAgyTranslation();

		useEffect(() => {
			const onKey = (e: any) => {
				if (e.key === 'Escape') {
					e.stopPropagation();
					agyModalStore.setOpen(false);
				}
			};
			win.addEventListener?.('keydown', onKey, true);
			return () => win.removeEventListener?.('keydown', onKey, true);
		}, []);

		return h('div', {
			className: 'agy-modal-backdrop',
			onClick: (e: { target: unknown; currentTarget: unknown }) => {
				if (e.target === e.currentTarget) agyModalStore.setOpen(false);
			},
		},
			h('div', { className: 'agy-modal-panel', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'agy-console-title' },
				h('div', {
					style: {
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
						padding: '14px 18px',
						borderBottom: '1px solid var(--agy-border-card)',
						background: 'var(--agy-bg-header)',
						color: 'var(--agy-text-primary)',
					},
				},
					h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
						agyIcon(18),
						h('strong', { id: 'agy-console-title', style: { fontSize: '14.5px', fontWeight: 700, color: 'var(--agy-text-primary)' } }, t('console.title')),
					),
					h('button', {
						type: 'button',
						title: t('console.close'),
						'aria-label': t('console.close'),
						style: {
							background: 'var(--agy-bg-btn)',
							border: '1px solid var(--agy-border-btn)',
							color: 'var(--agy-text-btn)',
							cursor: 'pointer',
							padding: '4px 8px',
							borderRadius: '6px',
							display: 'inline-flex',
							alignItems: 'center',
						},
						onClick: () => agyModalStore.setOpen(false),
					}, uiIcon('x', 14, 'var(--agy-text-btn)')),
				),
				h('div', { style: { overflowY: 'auto', padding: '18px', flex: '1', background: 'var(--agy-bg-panel)' } },
					h(AgySettingsSection, { isModal: true, onClose: () => agyModalStore.setOpen(false) }),
				),
			),
		);
	};

	/** Session Header badge in chat toolbar */
	const AgySessionStatus = (): unknown => {
		const hostIdRef = useRef<string | null>(null);
		if (hostIdRef.current === null) {
			hostIdRef.current = 'host_' + Math.random().toString(36).slice(2);
		}
		const hostId = hostIdRef.current;

		const [isPrimaryHost, setIsPrimaryHost] = useState<boolean>(() => {
			if (modalHostManager.activeId === null) {
				modalHostManager.activeId = hostId;
				return true;
			}
			return modalHostManager.activeId === hostId;
		});
		useEffect(() => {
			return modalHostManager.register(hostId, setIsPrimaryHost);
		}, [hostId]);

		const [isModalOpen, setIsModalOpen] = useState(agyModalStore.open);
		useEffect(() => {
			return agyModalStore.subscribe(() => {
				setIsModalOpen(agyModalStore.open);
			});
		}, []);

		const t = useAgyTranslation();
		const { status } = useAgyStatus();
		// Wall-clock tick: cooldown dots derive from Date.now() and the payload
		// does not change when a cooldown lapses.
		const [, setTimeTick] = useState(0);
		useEffect(() => {
			const timer = setInterval(() => setTimeTick((n) => n + 1), 30_000);
			return () => clearInterval(timer);
		}, []);

		const pool = status?.pool;
		const accounts = pool?.accounts ?? [];
		const rawActiveId = pool?.activeAccountId ?? pool?.lastActiveAccountId ?? pool?.activeAccountIds?.google ?? pool?.primaryAccountId;
		// Display EXACTLY the server-scheduled account — same semantics as the
		// console's per-card "当前使用" badge. The old eligibility fallback
		// (any enabled account, else accounts[0]) made the header name a
		// DIFFERENT account than the console whenever the scheduled slot was
		// cooling down or auth-flagged: the header is a readout, not a picker.
		const activeAcc = rawActiveId !== undefined ? accounts.find((a) => a.id === rawActiveId) : undefined;
		const activeAuthRequired = activeAcc?.authRequired === true;
		const activeHasCooldown = activeAcc ? Object.entries(activeAcc.cooldowns ?? {}).some(([, cd]) => cd && cd.cooldownUntil > Date.now()) : false;
		const allInCooldown = accounts.length > 0 && accounts.every((a) => !a.enabled || a.authRequired || Object.entries(a.cooldowns ?? {}).some(([, cd]) => cd && cd.cooldownUntil > Date.now()));
		const isAuthed = status?.auth?.phase === 'ok' || accounts.length > 0;
		const color = status === null ? '#64748b' : status.dormantReason ? '#f59e0b' : allInCooldown ? '#f59e0b' : activeAuthRequired ? '#ef4444' : activeHasCooldown ? '#f59e0b' : isAuthed ? '#10b981' : '#f59e0b';

		const legacyDefault = activeAcc && activeAcc.defaultAlias === undefined && activeAcc.systemHome && activeAcc.alias === '主账号 (系统登录)';
		const displayAlias = activeAcc ? (activeAcc.defaultAlias || legacyDefault
			? activeAcc.systemHome ? t('account.defaultAlias') : t('account.aliasDefault', { number: accounts.indexOf(activeAcc) + 1 })
			: activeAcc.alias) : '';
		// Only an ELIGIBLE account may be announced as "in use": the fallback
		// chain can land on a disabled/quarantined slot, and the badge then
		// claimed a dead account was serving traffic next to an amber dot.
		const activeEligible = activeAcc !== undefined && activeAcc.enabled && !activeAcc.authRequired;
		const activeDetail = activeAcc !== undefined && activeEligible ? ` · ${t('status.inUse')}: ${displayAlias}${activeAcc.email ? ` (${activeAcc.email})` : ''}` : '';
		const badgeTitle = status === null
			? t('header.badgeLoading')
			: `${t('header.badgeTitle', { count: accounts.length })}${activeDetail}`;
		const buttonLabel = status === null
			? 'AGY'
			: displayAlias ? `AGY · ${displayAlias}` : `AGY (${accounts.length})`;

		const badge = h('button',
			{
				type: 'button',
				title: badgeTitle,
				className: 'agy-btn',
				onClick: () => {
					modalHostManager.claim(hostId);
					agyModalStore.setOpen(true);
				},
				style: {
					background: 'var(--agy-bg-header)',
					border: '1px solid var(--agy-border-card)',
					borderRadius: '999px',
					cursor: 'pointer',
					padding: '3px 10px',
					fontSize: '11.5px',
					fontWeight: 600,
					lineHeight: 1.5,
					color: 'var(--agy-text-primary)',
					display: 'inline-flex',
					alignItems: 'center',
					gap: '6px',
					boxShadow: 'var(--agy-shadow-card)',
					flexShrink: 0,
					whiteSpace: 'nowrap',
				},
			},
			h('span', { style: { display: 'inline-block', width: '7px', height: '7px', borderRadius: '50%', background: color } }),
			buttonLabel,
		);
		return h('div', { style: { display: 'inline-block' } },
			badge,
			isPrimaryHost && isModalOpen ? portalToBody(h(AgyModalDialog, null)) : null,
		);
	};

	// Register in header session toolbar
	ctx.slots.inject('conversation.session.header.actions', () => {
		const dispose = ctx.slots.register(
			{
				name: 'conversation.session.header.actions',
				id: 'agy-link-status',
				order: 10,
				label: () => locale.bind(NS)('section.label'),
				locale: NS,
			},
			AgySessionStatus,
		);
		return dispose;
	});

	// Register in settings section (under Gear icon -> Antigravity)
	ctx.slots.inject('settings.section', () => {
		const dispose = ctx.slots.register(
			{
				name: 'settings.section',
				id: 'agy-link',
				order: 20,
				label: () => locale.bind(NS)('section.label'),
				locale: NS,
			},
			AgySettingsSection,
		);
		return dispose;
	});

	// Plugins page (sidebar → 插件 → dsh-agy-link): the bundle's detail panel.
	// Directly reuses the identical Antigravity management console (AgySettingsSection),
	// providing 100% feature parity and zero redundancy.
	// When view === "summary", returns null to keep plugin list cards compact and clean.
	ctx.slots.inject('plugins.bundle.config', () => {
		const dispose = ctx.slots.register(
			{ name: 'plugins.bundle.config', key: 'dsh-agy-link', locale: NS },
			(ownerProps?: unknown) => {
				const view = (ownerProps as { view?: string } | undefined)?.view;
				if (view === 'summary') return null;
				return h(AgySettingsSection, { isModal: false });
			},
		);
		return dispose;
	});

	// Also register row config for the agy-link row, so clicking through row
	// items renders the identical Antigravity management console.
	ctx.slots.inject('plugins.row.config', () => {
		const dispose = ctx.slots.register(
			{ name: 'plugins.row.config', key: 'dsh-agy-link#agy-link', locale: NS },
			(ownerProps?: unknown) => {
				const view = (ownerProps as { view?: string } | undefined)?.view;
				if (view === 'summary') return null;
				return h(AgySettingsSection, { isModal: false });
			},
		);
		return dispose;
	});

	// Global scroll activity coordinator: suppresses layout-shifting DOM mutations during scrolling
	ctx.effect(() => {
		ensureScrollListener();
		return disposeScrollListener;
	});

	// Native tool-card rendering for the agy_tool mirror (DSH >= 0.1.5):
	// the browser conversation UI keys tool cards by wire name; registering
	// `tool.call.toolview` for `agy_tool` makes every mirrored agy step render
	// as a terminal / diff / read / search card instead of a generic text row.
	installAgyToolView(ctx);

	// Auto-expand reasoning blocks containing full model thought prose.
	// Installed through ctx.effect so a plugin reload DISCONNECTS the old
	// MutationObserver instead of stacking one observer per reload.
	ctx.effect(() => installAutoExpandReasoning());

	// Draw ```mermaid fences (DSH's shiki pass has no mermaid grammar and
	// leaves them as plain code blocks). Same lifecycle contract as above.
	ctx.effect(() => installMermaidRendering());

	// Local image display + fullscreen lightbox (recovered working tree).
	ctx.effect(() => installImageEnhancer());

	// Interactive user decision & choice chips (recovered working tree).
	ctx.effect(() => installDecisionChips());

	// Custom Antigravity brand icon inside Settings dialog nav list
	ctx.effect(() => installSettingsNavIcon(ctx, () => locale.bind(NS)('section.label')));
}
