// Shared status snapshot + ONE module-level fetch loop for every mounted
// consumer (settings panel, header badge, modal). Per-component 3s loops used
// to stack (three full payload fetches per interval with the modal open), had
// no overlap guard, and let a slow stale response overwrite a newer one.

import type { AccountPoolData } from '../common/pool-types.ts';
import type { WarmupStatusSnapshot } from '../common/warmup-types.ts';
import { base, win, timedSignal, STATUS_TIMEOUT_MS } from './api.ts';
import { useEffect, useState } from './react.ts';
import { isScrollActive, onScrollIdle } from './scroll-guard.ts';

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
	sandbox?: boolean;
	agent?: string;
	agySettings?: string;
	transport?: 'cli' | 'acp';
	acpStatus?: {
		activeProcesses: number
		sessions: number
		keys: readonly string[]
		/** Processes still finishing background work for a switched-away account. */
		drainingProcesses?: number
		drainingKeys?: readonly string[]
		/** `agy acp` children of this host the pool no longer tracks. */
		strayProcesses?: number
		strayPids?: readonly number[]
		/** Total strays killed since the pool started. */
		reapedStrays?: number
		/** Times another agy rewrote the machine-wide credential slot under us. */
		slotOverwriteDetectedCount?: number
		lastSlotRecoveryAt?: number | null
	} | null;
	backgroundWakeup?: boolean;
	mcpBridge?: boolean;
	mcpBridgeScope?: 'all' | 'host-only';
	bridgeDiagnostic?: import('../common/bridge-tools.ts').BridgeDiagnostic | null;
	imageTool?: boolean;
	syncAccountCustomizations?: boolean;
	workspaceRoot?: string;
	defaultModel?: string;
	defaultEffort?: string;
	orchestratorPlannerModel?: string;
	orchestratorPlannerEffort?: string;
	orchestratorExecutorModel?: string;
	orchestratorExecutorEffort?: string;
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
	/** Account ids with a quota refresh in flight on the host (real progress). */
	quotaRefreshing?: readonly string[];
	/** Live + last-run warmup state exposed by the host WarmupService. */
	warmupState?: WarmupStatusSnapshot | null;
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
	/**
	 * Every model the settings panel can offer a tick for.
	 *
	 * NOT filtered by `selectedModels`/`hiddenModels`: unticking must stay
	 * reversible, so the full universe ships with the current selection
	 * alongside it. Includes models only the account's quota snapshot knows
	 * about (hosts without the agy CLI have no discovered catalog, issue #131).
	 */
	catalogModels?: ReadonlyArray<CatalogModelView>;
	/** Per-account discovered catalog models, keyed by account id. */
	accountModels?: Readonly<Record<string, ReadonlyArray<CatalogModelView>>>;
	hiddenModels?: readonly string[];
	/** Model ids ticked in the settings panel; empty means "show everything". */
	selectedModels?: readonly string[];
	autoWarmup?: boolean;
	warmupModels?: readonly string[];
	warmupWindows?: 'weekly' | '5h' | 'both';
	warmupMaxProbesPerRun?: number;
	autoTranslate?: boolean;
	translateDisplay?: 'card' | 'replace';
	translateModel?: string;
	translateEffort?: string;
	showHeaderBadge?: boolean;
	showTranslateAction?: boolean;
	poolWideCatalog?: boolean;
	imageModel?: string;
	imageEffort?: string;
	imageOutputDir?: string;
	btwEnabled?: boolean;
	btwModel?: string;
	btwEffort?: string;
	bindings?: number;
	/**
	 * Host summary of the most recent run. Diagnostic only: no client surface
	 * reads it today, and its shape is the host's (`processOk`/`processCode`),
	 * not a boolean `ok`/`code` pair.
	 */
	lastRun?: {
		processOk: boolean
		processCode: string
		durationMs: number
		model: string
		toolErrors: readonly string[]
	} | null;
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
let lastEtag: string | null = null;
let inFlightStatus: Promise<{ kind: 'ok'; data: StatusPayload } | { kind: 'not-modified' } | { kind: 'error' }> | null = null;

async function fetchStatusRaw(force: boolean): Promise<{ kind: 'ok'; data: StatusPayload } | { kind: 'not-modified' } | { kind: 'error' }> {
	if (!force && inFlightStatus !== null) return inFlightStatus;
	const job = (async (): Promise<{ kind: 'ok'; data: StatusPayload } | { kind: 'not-modified' } | { kind: 'error' }> => {
		try {
			const init: Record<string, unknown> = {};
			const signal = timedSignal(STATUS_TIMEOUT_MS);
			if (signal !== undefined) init.signal = signal;
			if (!force && lastEtag !== null) {
				init.headers = { 'If-None-Match': lastEtag };
			}
			const res = await win.fetch?.(base + '/plugins/agy-link/status', init) as {
				ok?: boolean;
				status?: number;
				headers?: { get?: (name: string) => string | null };
				json?: () => Promise<unknown>;
			} | undefined;
			if (!res) return { kind: 'error' };
			if (res.status === 304) return { kind: 'not-modified' };
			if (!res.ok) return { kind: 'error' };
			const etag = res.headers?.get?.('etag') ?? res.headers?.get?.('ETag') ?? null;
			if (typeof etag === 'string' && etag !== '') lastEtag = etag;
			const data = (await res.json?.()) as StatusPayload;
			return data && typeof data === 'object' ? { kind: 'ok', data } : { kind: 'error' };
		} catch {
			return { kind: 'error' };
		}
	})().finally(() => {
		if (inFlightStatus === job) inFlightStatus = null;
	});
	inFlightStatus = job;
	return job;
}

const statusListeners = new Set<(s: StatusPayload) => void>();
let statusPollTimer: ReturnType<typeof setInterval> | null = null;
let statusPollInterval = 3000;
let statusFetchSeq = 0;
let visibilityCleanup: (() => void) | null = null;

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

/**
 * A poll that lands mid-scroll used to re-render the whole console (every panel,
 * every quota bar) while the compositor was already repainting a moving
 * scroller - a visible hitch or flash during the gesture. The snapshot is still
 * stored immediately (state stays truthful); only the LISTENER notification is
 * deferred until the scroll settles, then flushed once with the newest payload.
 */
let pendingPublish: StatusPayload | null = null;

function notifyListeners(st: StatusPayload): void {
	for (const fn of [...statusListeners]) {
		try { fn(st); } catch { /* a dead consumer must not kill the loop */ }
	}
}

function flushPendingPublish(): void {
	const pending = pendingPublish;
	pendingPublish = null;
	if (pending !== null) notifyListeners(pending);
}

/**
 * `onScrollIdle` keeps a Set, so re-registering the same callback is a no-op.
 * Binding on every deferred publish (instead of a module flag) keeps working
 * after a teardown cleared the listeners: the next publish re-subscribes, while
 * the steady state still holds exactly one listener.
 */
function bindSettleFlush(): void {
	onScrollIdle(flushPendingPublish);
}

/** Single writer for the shared status snapshot (poll loop, refresh, tests). */
function publishStatus(st: StatusPayload): void {
	statusCache = st;
	try {
		win.localStorage?.setItem(STATUS_CACHE_KEY, JSON.stringify(st));
	} catch {
		// Ignore storage quota / parsing errors
	}
	if (isScrollActive()) {
		pendingPublish = st;
		bindSettleFlush();
		return;
	}
	notifyListeners(st);
}

/** Publish an externally obtained snapshot to every mounted consumer. */
export function publishStatusSnapshot(st: StatusPayload): void {
	publishStatus(st)
}

async function statusPollTick(force = false): Promise<void> {
	// Skip background ticks when window/tab is hidden to avoid idle CPU/network.
	if (!force && (win.document as { hidden?: boolean } | undefined)?.hidden === true) return;
	const seq = ++statusFetchSeq;
	const res = await fetchStatusRaw(force);
	// A slow response from an older tick must never overwrite newer data.
	// 304 Not Modified or equal JSON skips notification and re-renders.
	if (res.kind === 'ok' && seq === statusFetchSeq) {
		if (!isStatusEqual(statusCache, res.data)) {
			publishStatus(res.data);
		}
	}
}

function attachVisibilityWake(): void {
	if (visibilityCleanup !== null) return;
	const doc = win.document as { addEventListener?: (t: string, cb: () => void) => void; removeEventListener?: (t: string, cb: () => void) => void; hidden?: boolean } | undefined;
	const w = win as { addEventListener?: (t: string, cb: () => void) => void; removeEventListener?: (t: string, cb: () => void) => void };
	const onWake = () => {
		if (doc?.hidden !== true && statusListeners.size > 0) {
			void statusPollTick(false);
		}
	};
	doc?.addEventListener?.('visibilitychange', onWake);
	w.addEventListener?.('focus', onWake);
	visibilityCleanup = () => {
		doc?.removeEventListener?.('visibilitychange', onWake);
		w.removeEventListener?.('focus', onWake);
	};
}

export function ensureStatusPolling(): void {
	attachVisibilityWake();
	if (statusPollTimer !== null) {
		if (statusPollInterval !== 3000) {
			clearInterval(statusPollTimer);
			statusPollTimer = null;
		} else {
			return;
		}
	}
	statusPollInterval = 3000;
	void statusPollTick(false);
	statusPollTimer = setInterval(() => { void statusPollTick(false); }, 3000);
	(statusPollTimer as unknown as { unref?: () => void })?.unref?.();
}

export function stopStatusPollingIfIdle(): void {
	// Keep statusCache warm so opening a session never faces an empty or stale snapshot.
	// When idle (no active mounted viewers), relax the polling interval to 15s.
	if (statusListeners.size === 0 && statusPollTimer !== null && statusPollInterval === 3000) {
		clearInterval(statusPollTimer);
		statusPollInterval = 15000;
		statusPollTimer = setInterval(() => { void statusPollTick(false); }, 15000);
		(statusPollTimer as unknown as { unref?: () => void })?.unref?.();
	}
}

/** Stop the shared poll loop (plugin teardown / reload). */
export function disposeStatusPolling(): void {
	if (statusPollTimer !== null) {
		clearInterval(statusPollTimer);
		statusPollTimer = null;
	}
	visibilityCleanup?.();
	visibilityCleanup = null;
	lastEtag = null;
	inFlightStatus = null;
	pendingPublish = null;
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
	const refresh = (): Promise<void> => statusPollTick(true);
	return { status, refresh };
}
