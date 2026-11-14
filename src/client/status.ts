// Shared status snapshot + ONE module-level fetch loop for every mounted
// consumer (settings panel, header badge, modal). Per-component 3s loops used
// to stack (three full payload fetches per interval with the modal open), had
// no overlap guard, and let a slow stale response overwrite a newer one.

import type { AccountPoolData } from '../common/pool-types.ts';
import { base, win, timedSignal, STATUS_TIMEOUT_MS } from './api.ts';
import { useEffect, useState } from './react.ts';

/** One model row, shared by the picker, the visibility chips and the dropdowns. */
export interface CatalogModelView {
	id: string;
	name: string;
	/** Effort ids this model accepts (empty = fixed-thinking, no --effort). */
	efforts?: readonly string[];
}

export interface StatusPayload {
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
	/** The catalog exactly as the host's model picker sees it (id, label, supported efforts). */
	catalogModels?: ReadonlyArray<CatalogModelView>;
	hiddenModels?: readonly string[];
	autoWarmup?: boolean;
	warmupModels?: readonly string[];
	autoTranslate?: boolean;
	translateModel?: string;
	translateEffort?: string;
	showHeaderBadge?: boolean;
	showTranslateAction?: boolean;
	poolWideCatalog?: boolean;
	imageModel?: string;
	imageEffort?: string;
	imageOutputDir?: string;
	bindings?: number;
	lastRun?: { ok: boolean; code: string; durationMs: number; model: string } | null;
}

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
		// The signal helper is shared with every write in api.ts.
		const init: Record<string, unknown> = {};
		const signal = timedSignal(STATUS_TIMEOUT_MS);
		if (signal !== undefined) init.signal = signal;
		const res = await win.fetch?.(base + '/plugins/agy-link/status', init);
		if (!res || !res.ok) return null;
		return (await res.json()) as StatusPayload;
	} catch {
		return null;
	}
}

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

/**
 * UI visibility switches are opt-out: a missing/undefined flag means the
 * affordance stays visible (older hosts, a not-yet-polled status, or a status
 * payload fetched before this version shipped). Only an explicit `false`
 * hides it.
 */
export function isUiVisible(
	status: StatusPayload | null | undefined,
	key: 'showHeaderBadge' | 'showTranslateAction',
): boolean {
	return status?.[key] !== false
}

/** Single writer for the shared status snapshot (poll loop, refresh, tests). */
function publishStatus(st: StatusPayload): void {
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

/** Publish an externally obtained snapshot to every mounted consumer. */
export function publishStatusSnapshot(st: StatusPayload): void {
	publishStatus(st)
}

async function statusPollTick(): Promise<void> {
	const seq = ++statusFetchSeq;
	const st = await getStatus();
	// A slow response from an older tick must never overwrite newer data.
	// Only notify when payload actually changed to prevent needless re-renders.
	if (st !== null && seq === statusFetchSeq) {
		if (!isStatusEqual(statusCache, st)) {
			publishStatus(st);
		}
	}
}

export function ensureStatusPolling(): void {
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

export function stopStatusPollingIfIdle(): void {
	// Keep statusCache warm so opening a session never faces an empty or stale snapshot.
	// When idle (no active mounted viewers), relax the polling interval to 15s.
	if (statusListeners.size === 0 && statusPollTimer !== null && statusPollInterval === 3000) {
		clearInterval(statusPollTimer);
		statusPollInterval = 15000;
		statusPollTimer = setInterval(() => { void statusPollTick(); }, 15000);
	}
}

/** Stop the shared poll loop (plugin teardown / reload). */
export function disposeStatusPolling(): void {
	if (statusPollTimer !== null) {
		clearInterval(statusPollTimer);
		statusPollTimer = null;
	}
}

/**
 * Subscribe a component to the shared status poll. Returns the latest
 * snapshot plus a manual refresh that keeps the last good snapshot on a
 * transient failure (a failed refresh used to flip the whole panel back to
 * its loading state).
 */
export function useAgyStatus(): { status: StatusPayload | null; refresh: () => Promise<void> } {
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
		if (st !== null && !isStatusEqual(statusCache, st)) publishStatus(st);
	};
	return { status, refresh };
}
