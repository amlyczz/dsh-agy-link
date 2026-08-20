// dsh-agy-link client half (browser). Integrated into native DSH settings, sidebar footer, and header.
import type { Context } from '@deepseek-ai/cordis';
import type { AccountPoolData, FamilyQuotaInfo, ManagedAccount, ModelQuotaInfo } from '../common/pool-types.ts';
import { BRAND_COLORS, BRAND_PATHS, UI_PATHS } from './brand-icons.ts';

type ReactApi = {
	createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
	useState: <S>(initial: S) => [S, (next: S | ((prev: S) => S)) => void];
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
	addEventListener?: (type: string, listener: (ev: any) => void, useCapture?: boolean) => void;
	removeEventListener?: (type: string, listener: (ev: any) => void, useCapture?: boolean) => void;
};

const bodyEl = win.document?.body ?? null;
const portalToBody = (node: unknown) => {
	if (bodyEl && reactDom && typeof reactDom.createPortal === 'function') {
		return reactDom.createPortal(node, bodyEl);
	}
	return node;
};

export const name = 'dsh-agy-link-client';
export const inject = ['slots'];

export interface ClientContext extends Context {
	slots: {
		inject(name: string, register: () => () => void): void;
		register(
			opts: { name: string; id: string; order?: number; label?: string },
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
		message?: string;
	};
	catalog?: { source: string; count: number; lastError: string | null };
	bindings?: number;
	lastRun?: { ok: boolean; code: string; durationMs: number; model: string } | null;
}

interface ToastNotice {
	text: string;
	type: 'success' | 'info' | 'warn' | 'error';
	id: number;
}

const base = win.location?.origin ?? '';

// Module-level cache for instant remount rendering
let statusCache: StatusPayload | null = null;

async function getStatus(): Promise<StatusPayload | null> {
	try {
		const res = await win.fetch?.(base + '/plugins/agy-link/status');
		if (!res || !res.ok) return null;
		const payload = (await res.json()) as StatusPayload;
		statusCache = payload;
		return payload;
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
			return await res.json();
		} catch {
			return { ok: res.ok };
		}
	} catch {
		return null;
	}
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
 * Format reset timestamp into readable date/time + relative countdown.
 */
function formatQuotaWindow(resetTimeStr?: string): {
	resetText: string;
} {
	if (!resetTimeStr) return { resetText: '' };
	try {
		const d = new Date(resetTimeStr);
		const diffMs = d.getTime() - Date.now();
		if (diffMs <= 0) return { resetText: '' };

		const totalMins = Math.ceil(diffMs / 60000);
		const days = Math.floor(totalMins / 1440);
		const hours = Math.floor((totalMins % 1440) / 60);
		const mins = totalMins % 60;
		const isWeekly = days >= 1;

		const countdown = days > 0 ? `${days}d${hours}h` : hours > 0 ? `${hours}h${mins}m` : `${mins}m`;
		const hh = d.getHours().toString().padStart(2, '0');
		const mm = d.getMinutes().toString().padStart(2, '0');
		const resetText = isWeekly
			? `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm} (${countdown})`
			: `${hh}:${mm} (${countdown})`;

		return { resetText };
	} catch {
		return { resetText: '' };
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

const FAMILY_BRAND: Record<'google' | 'anthropic' | 'openai', BrandKey> = {
	google: 'gemini',
	anthropic: 'claude',
	openai: 'openai',
};

let agyIconSeq = 0;

/** Antigravity mark: gradient orb with an orbit ring (product has no public simple-icon). */
function agyIcon(size = 14): unknown {
	const gid = `agy-g${++agyIconSeq}`;
	return h('svg', {
		viewBox: '0 0 24 24',
		width: size,
		height: size,
		'aria-hidden': true,
		style: { display: 'inline-block', verticalAlign: '-2px', flexShrink: 0 },
	},
		h('defs', null,
			h('linearGradient', { id: gid, x1: '0', y1: '0', x2: '1', y2: '1' },
				h('stop', { offset: '0', 'stop-color': '#4C8DFF' }),
				h('stop', { offset: '1', 'stop-color': '#A96BFF' }),
			),
		),
		h('circle', { cx: 12, cy: 12, r: 6, fill: `url(#${gid})` }),
		h('ellipse', {
			cx: 12, cy: 12, rx: 10.4, ry: 3.9,
			fill: 'none', stroke: `url(#${gid})`, 'stroke-width': 1.4,
			transform: 'rotate(-18 12 12)',
		}),
	);
}

const GLOBAL_CSS = `
@keyframes agy-spin {
	0% { transform: rotate(0deg); }
	100% { transform: rotate(360deg); }
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
	transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.agy-card-hover:hover {
	border-color: rgba(128,128,128,0.35) !important;
}
.agy-btn {
	transition: all 0.15s ease;
}
.agy-btn:hover:not(:disabled) {
	filter: brightness(1.12);
	transform: translateY(-0.5px);
}
.agy-btn:active:not(:disabled) {
	transform: translateY(0.5px);
}
.agy-progress-fill {
	transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
.agy-modal-backdrop {
	position: fixed;
	inset: 0;
	z-index: 9999;
	background: rgba(0, 0, 0, 0.55);
	backdrop-filter: blur(4px);
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
	background: var(--dsw-specific-menu, #1c1d22);
	border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25));
	border-radius: 12px;
	box-shadow: 0 20px 60px rgba(0,0,0,0.5);
	display: flex;
	flex-direction: column;
	overflow: hidden;
	color: inherit;
	font-family: inherit;
}
.agy-submodel-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 4px 8px;
	font-size: 11px;
	border-radius: 5px;
	background: rgba(255, 255, 255, 0.04);
	border: 1px solid rgba(255, 255, 255, 0.06);
	margin: 3px 0;
}
`;

const S: Record<string, Record<string, unknown>> = {
	container: {
		lineHeight: 1.5,
		fontSize: '13px',
		fontFamily: 'inherit',
		color: 'inherit',
	},
	headerCard: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: '12px 14px',
		background: 'rgba(255, 255, 255, 0.04)',
		border: '1px solid rgba(255, 255, 255, 0.12)',
		borderRadius: '8px',
		marginBottom: '12px',
	},
	badgePrimary: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '3px',
		background: 'rgba(59, 130, 246, 0.2)',
		color: '#60a5fa',
		border: '1px solid rgba(59, 130, 246, 0.45)',
		padding: '1px 7px',
		borderRadius: '5px',
		fontSize: '11px',
		fontWeight: 600,
	},
	badgeTag: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '3px',
		background: 'rgba(255, 255, 255, 0.06)',
		color: 'var(--dsw-alias-text-primary, #e2e8f0)',
		border: '1px solid rgba(255, 255, 255, 0.14)',
		padding: '1px 6px',
		borderRadius: '4px',
		fontSize: '11px',
	},
	card: {
		background: 'rgba(255, 255, 255, 0.03)',
		border: '1px solid rgba(255, 255, 255, 0.12)',
		borderRadius: '8px',
		padding: '12px 14px',
		marginBottom: '10px',
	},
	cardPrimary: {
		background: 'rgba(59, 130, 246, 0.05)',
		border: '1px solid rgba(59, 130, 246, 0.45)',
		borderRadius: '8px',
		padding: '12px 14px',
		marginBottom: '10px',
	},
	quotaBox: {
		background: 'rgba(0, 0, 0, 0.2)',
		border: '1px solid rgba(255, 255, 255, 0.08)',
		borderRadius: '7px',
		padding: '8px 10px',
		marginTop: '8px',
	},
	progressBarBg: {
		flex: '1',
		height: '7px',
		borderRadius: '4px',
		background: 'rgba(255, 255, 255, 0.1)',
		overflow: 'hidden',
		margin: '0 10px',
	},
	btn: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '4px 10px',
		borderRadius: '6px',
		border: '1px solid rgba(255, 255, 255, 0.16)',
		background: 'rgba(255, 255, 255, 0.07)',
		color: 'inherit',
		cursor: 'pointer',
		fontSize: '12px',
		fontWeight: 500,
	},
	btnPrimary: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '5px 12px',
		borderRadius: '6px',
		border: '1px solid rgba(59, 130, 246, 0.6)',
		background: 'rgba(59, 130, 246, 0.28)',
		color: '#60a5fa',
		cursor: 'pointer',
		fontSize: '12px',
		fontWeight: 600,
	},
	btnDanger: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '3px 8px',
		borderRadius: '5px',
		border: '1px solid rgba(239, 68, 68, 0.45)',
		background: 'rgba(239, 68, 68, 0.15)',
		color: '#f87171',
		cursor: 'pointer',
		fontSize: '11px',
		fontWeight: 500,
	},
	btnSm: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '3px 8px',
		borderRadius: '5px',
		border: '1px solid rgba(255, 255, 255, 0.14)',
		background: 'rgba(255, 255, 255, 0.06)',
		color: 'inherit',
		cursor: 'pointer',
		fontSize: '11px',
		fontWeight: 500,
	},
	btnSmPrimary: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '3px 8px',
		borderRadius: '5px',
		border: '1px solid rgba(59, 130, 246, 0.45)',
		background: 'rgba(59, 130, 246, 0.2)',
		color: '#60a5fa',
		cursor: 'pointer',
		fontSize: '11px',
		fontWeight: 600,
	},
	segGroup: {
		display: 'inline-flex',
		background: 'rgba(255, 255, 255, 0.08)',
		borderRadius: '6px',
		padding: '2px',
		border: '1px solid rgba(255, 255, 255, 0.12)',
	},
	segBtn: {
		padding: '3px 9px',
		borderRadius: '4px',
		border: 'none',
		background: 'transparent',
		color: 'inherit',
		cursor: 'pointer',
		fontSize: '11px',
		fontWeight: 500,
		opacity: 0.8,
	},
	segBtnActive: {
		padding: '3px 9px',
		borderRadius: '4px',
		border: 'none',
		background: 'rgba(59, 130, 246, 0.35)',
		color: '#60a5fa',
		cursor: 'pointer',
		fontSize: '11px',
		fontWeight: 600,
		opacity: 1,
	},
	input: {
		flex: '1',
		padding: '6px 10px',
		borderRadius: '6px',
		border: '1px solid rgba(255, 255, 255, 0.2)',
		background: 'rgba(0, 0, 0, 0.25)',
		color: 'inherit',
		fontSize: '12px',
		outline: 'none',
	},
	muted: { color: 'var(--dsw-alias-text-secondary, #94a3b8)', fontSize: '11px' },
	noticeBanner: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: '8px 12px',
		borderRadius: '6px',
		marginBottom: '10px',
		fontSize: '12px',
	},
	authModal: {
		background: 'rgba(59, 130, 246, 0.08)',
		border: '1px solid rgba(59, 130, 246, 0.35)',
		borderRadius: '8px',
		padding: '12px 14px',
		marginBottom: '12px',
	},
};

export function apply(ctx: ClientContext): void {
	const AgySettingsSection = (props?: any): unknown => {
		const [status, setStatus] = useState<StatusPayload | null>(statusCache);
		const [aliasInput, setAliasInput] = useState('');
		const [proxyInputs, setProxyInputs] = useState<Record<string, string>>({});
		const [editingProxyId, setEditingProxyId] = useState<string | null>(null);
		const [addingAccount, setAddingAccount] = useState(false);
		const [authCodeInput, setAuthCodeInput] = useState('');
		const [loadingAction, setLoadingAction] = useState<string | null>(null);
		const [toast, setToast] = useState<ToastNotice | null>(null);
		const [expandedModels, setExpandedModels] = useState<Record<string, boolean>>({});

		useEffect(() => {
			let alive = true;
			let lastJson = '';
			const tick = async () => {
				const st = await getStatus();
				if (!alive || !st) return;
				const json = JSON.stringify(st);
				if (json !== lastJson) {
					lastJson = json;
					setStatus(st);
				}
			};
			void tick();
			const timer = setInterval(tick, 3000);
			return () => {
				alive = false;
				clearInterval(timer);
			};
		}, []);

		const flowStartedRef = useRef(false);
		useEffect(() => {
			if (!addingAccount || !flowStartedRef.current) return;
			const pa = status?.poolAuth;
			if (!pa) return;
			if (pa.phase === 'done') {
				flowStartedRef.current = false;
				setAddingAccount(false);
				setAuthCodeInput('');
				setAliasInput('');
				showToast(pa.message || '账号已激活入池', 'success');
			} else if (pa.phase === 'failed') {
				flowStartedRef.current = false;
				showToast(pa.message || '授权失败', 'error');
			}
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [addingAccount, status?.poolAuth?.phase, status?.poolAuth?.message]);

		const showToast = (text: string, type: ToastNotice['type'] = 'info') => {
			setToast({ text, type, id: Date.now() });
			setTimeout(() => {
				setToast((prev) => (prev?.text === text ? null : prev));
			}, 6000);
		};

		const refresh = async (): Promise<void> => {
			setStatus(await getStatus());
		};

		const handleBeginAddAccount = async (): Promise<void> => {
			setLoadingAction('pool:beginAdd');
			const alias = aliasInput.trim() || `备用 Google 账号 ${(status?.pool?.accounts?.length ?? 1) + 1}`;
			const res = await postJson('/plugins/agy-link/pool/begin-add', { alias });
			setLoadingAction(null);
			if (res && res.ok) {
				flowStartedRef.current = true;
				await refresh();
				if (res.browserOpened) {
					showToast('浏览器已打开 Google 授权页，完成授权后将自动同步', 'info');
				} else {
					showToast('无法自动打开浏览器，请点击下方链接手动完成授权', 'warn');
				}
			} else {
				showToast(`启动 Google 授权失败: ${res?.message || '请检查网络或代理配置'}`, 'error');
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
				setAddingAccount(false);
				await refresh();
				showToast(res.message || '成功添加并激活 Google 账号', 'success');
			} else {
				showToast(res?.message || res?.error || '授权码验证失败', 'error');
			}
		};

		const handleCancelAddAccount = async (): Promise<void> => {
			flowStartedRef.current = false;
			await postJson('/plugins/agy-link/pool/cancel-add', {});
			setAuthCodeInput('');
			setAliasInput('');
			setAddingAccount(false);
			await refresh();
		};

		const setCfg = async (key: string, value: unknown): Promise<void> => {
			setLoadingAction(`config:${key}`);
			await postJson('/plugins/agy-link/config', { key, value });
			await refresh();
			setLoadingAction(null);
		};

		const setPrimary = async (id: string): Promise<void> => {
			setLoadingAction(`primary:${id}`);
			await postJson('/plugins/agy-link/pool/primary', { id });
			await refresh();
			setLoadingAction(null);
			showToast('已设为主用账号', 'success');
		};

		const removeAccount = async (id: string, alias: string): Promise<void> => {
			setLoadingAction(`remove:${id}`);
			await postJson('/plugins/agy-link/pool/remove', { id });
			await refresh();
			setLoadingAction(null);
			showToast(`已移除账号: ${alias}`, 'info');
		};

		const refreshQuota = async (id?: string): Promise<void> => {
			setLoadingAction(id ? `refresh:${id}` : 'refresh:all');
			await postJson('/plugins/agy-link/pool/refresh-quota', { id });
			await refresh();
			setLoadingAction(null);
			showToast('额度已刷新', 'success');
		};

		const saveProxy = async (id: string): Promise<void> => {
			setLoadingAction(`proxy:${id}`);
			const proxyUrl = proxyInputs[id];
			await postJson('/plugins/agy-link/pool/proxy', { id, proxyUrl });
			setEditingProxyId(null);
			await refresh();
			setLoadingAction(null);
			showToast('代理已保存', 'success');
		};

		const setMode = async (mode: string): Promise<void> => {
			setLoadingAction(`mode:${mode}`);
			await postJson('/plugins/agy-link/pool/mode', { mode });
			await refresh();
			setLoadingAction(null);
		};

		const clearCooldown = async (id?: string): Promise<void> => {
			setLoadingAction(id ? `clearCooldown:${id}` : 'clearCooldown:all');
			await postJson('/plugins/agy-link/pool/clear-cooldown', { id });
			await refresh();
			setLoadingAction(null);
			showToast('已清除冷却', 'success');
		};

		const toggleExpand = (accId: string) => {
			setExpandedModels((prev) => ({ ...prev, [accId]: !prev[accId] }));
		};

		const authPhase = status?.auth?.phase ?? 'unknown';
		const pool = status?.pool;
		const accounts = pool?.accounts ?? [];
		const isAuthed = authPhase === 'ok' || accounts.length > 0;
		const isBusy = loadingAction !== null;

		const renderSpinner = () => h('span', { className: 'agy-spinner' });

		const renderToastBanner = () => {
			if (!toast) return null;
			const typeStyles = {
				success: { background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.4)', color: '#10b981' },
				info: { background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.4)', color: '#3b82f6' },
				warn: { background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.4)', color: '#f59e0b' },
				error: { background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)', color: '#ef4444' },
			};
			const style = typeStyles[toast.type];
			return h('div', { style: { ...S.noticeBanner, ...style } },
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 500 } },
					uiIcon(toast.type === 'success' ? 'check' : toast.type === 'error' || toast.type === 'warn' ? 'alert' : 'globe', 13, style.color),
					h('span', null, toast.text),
				),
				h('button', {
					type: 'button',
					style: { background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: '0 4px', opacity: 0.8, display: 'inline-flex', alignItems: 'center' },
					onClick: () => setToast(null),
				}, uiIcon('x', 12)),
			);
		};

		const renderQuotaBar = (label: string, familyKey: 'google' | 'anthropic' | 'openai', acc: ManagedAccount): unknown => {
			const info = acc.quotas[familyKey];
			const cd = acc.cooldowns[familyKey];
			const inCooldown = cd && cd.cooldownUntil > Date.now();

			// 5-Hour limit
			const has5h = typeof info?.remainingFraction === 'number' && Number.isFinite(info.remainingFraction);
			let pct5h = has5h ? Math.max(0, Math.min(100, Math.round(info!.remainingFraction! * 100))) : -1;
			if (inCooldown) pct5h = 0;
			const w5h = formatQuotaWindow(info?.resetTime);

			// Weekly limit
			const hasWeekly = typeof info?.weeklyFraction === 'number' && Number.isFinite(info.weeklyFraction);
			const pctWeekly = hasWeekly ? Math.max(0, Math.min(100, Math.round(info!.weeklyFraction! * 100))) : -1;
			const wWeekly = formatQuotaWindow(info?.weeklyResetTime);

			const getColors = (pct: number) => {
				if (pct < 0) return { bar: 'rgba(255, 255, 255, 0.12)', text: '#94a3b8', badge: 'rgba(255, 255, 255, 0.08)' };
				if (pct <= 20) return { bar: 'linear-gradient(90deg, #ef4444, #f87171)', text: '#f87171', badge: 'rgba(239, 68, 68, 0.22)' };
				if (pct <= 50) return { bar: 'linear-gradient(90deg, #f59e0b, #fbbf24)', text: '#fbbf24', badge: 'rgba(245, 158, 11, 0.22)' };
				return { bar: 'linear-gradient(90deg, #10b981, #34d399)', text: '#34d399', badge: 'rgba(16, 185, 129, 0.22)' };
			};

			const c5h = getColors(pct5h);
			const cWeekly = getColors(pctWeekly);

			const renderLine = (windowName: string, percent: number, c: { bar: string; text: string; badge: string }, resetStr: string) => {
				return h('div', { style: { display: 'flex', alignItems: 'center', fontSize: '11px', margin: '3px 0' } },
					h('span', { style: { width: '50px', color: 'var(--dsw-alias-text-primary, #e2e8f0)', fontSize: '10.5px', fontWeight: 600, flexShrink: 0 } }, windowName),
					h('div', { style: S.progressBarBg },
						h('div', {
							className: 'agy-progress-fill',
							style: {
								width: `${percent < 0 ? 100 : percent}%`,
								height: '100%',
								background: c.bar,
								borderRadius: '4px',
							},
						}),
					),
					h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: '135px', justifyContent: 'flex-end', flexShrink: 0 } },
						h('span', {
							style: {
								padding: '1px 6px',
								borderRadius: '4px',
								background: c.badge,
								color: c.text,
								fontWeight: 700,
								fontSize: '11px',
							},
						}, percent < 0 ? '—' : `${percent}%`),
						resetStr ? h('span', { style: { color: 'var(--dsw-alias-text-secondary, #cbd5e1)', fontSize: '10.5px', fontWeight: 500 } }, `↻ ${resetStr}`) : null,
					),
				);
			};

			return h('div', { style: { margin: '6px 0', padding: '6px 8px', background: 'rgba(255, 255, 255, 0.03)', borderRadius: '6px', border: '1px solid rgba(255, 255, 255, 0.08)' } },
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, fontSize: '12px', marginBottom: '4px', color: 'var(--dsw-alias-text-primary, #f8fafc)' } },
					brandIcon(FAMILY_BRAND[familyKey], 14),
					h('span', null, label),
				),
				renderLine('5h 额度', pct5h, c5h, w5h.resetText),
				renderLine('周额度', pctWeekly, cWeekly, wWeekly.resetText),
			);
		};

		const renderedAccountCards = accounts.map((acc: ManagedAccount) => {
			const isPrimary = acc.id === pool?.primaryAccountId;
			const hasCooldown = Object.entries(acc.cooldowns).some(([, cd]) => cd && cd.cooldownUntil > Date.now());
			const dotColor = !acc.enabled ? '#9aa0a6' : hasCooldown ? '#f59e0b' : '#10b981';
			const isEditingProxy = editingProxyId === acc.id;
			const isExpanded = expandedModels[acc.id] ?? false;

			const cardStyle = isPrimary ? { ...S.cardPrimary } : { ...S.card };

			const googleModels = acc.quotas.google?.models ?? [];
			const anthropicModels = acc.quotas.anthropic?.models ?? [];
			const openaiModels = acc.quotas.openai?.models ?? [];
			const allChildModels: { family: string; model: ModelQuotaInfo }[] = [
				...googleModels.map((m) => ({ family: 'Google', model: m })),
				...anthropicModels.map((m) => ({ family: 'Anthropic', model: m })),
				...openaiModels.map((m) => ({ family: 'OpenAI', model: m })),
			];

			return h('div', { key: acc.id, className: 'agy-card-hover', style: cardStyle },
				h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' } },
					h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
						h('span', {
							className: 'agy-pulse-dot',
							style: { background: dotColor, boxShadow: `0 0 8px ${dotColor}88` },
						}),
						h('span', { style: { fontWeight: 600, fontSize: '13px' } }, acc.alias),
						acc.email ? h('span', { style: { ...S.badgeTag, color: '#3b82f6', borderColor: 'rgba(59,130,246,0.3)', gap: '4px' } },
							uiIcon('mail', 11, '#3b82f6'),
							acc.email,
						) : null,
						isPrimary ? h('span', { style: { ...S.badgePrimary, gap: '4px' } },
							uiIcon('star', 10, '#3b82f6'),
							'主用',
						) : null,
						acc.proxyUrl ? h('span', { style: { ...S.badgeTag, color: '#10b981', borderColor: 'rgba(16,185,129,0.3)', gap: '4px' } },
							uiIcon('globe', 11, '#10b981'),
							'代理',
						) : null,
					),
					h('div', { style: { display: 'flex', gap: '5px', alignItems: 'center' } },
						allChildModels.length > 0 ? h('button', {
							type: 'button',
							className: 'agy-btn',
							style: isExpanded ? { ...S.btnSmPrimary, gap: '3px' } : { ...S.btnSm, gap: '3px' },
							onClick: () => toggleExpand(acc.id),
						}, isExpanded ? [uiIcon('chevronUp', 11), ' 收起'] : [uiIcon('chevronDown', 11), ' 明细']) : null,
						!isPrimary ? h('button', {
							type: 'button',
							className: 'agy-btn',
							style: { ...S.btnSm, gap: '4px' },
							disabled: isBusy,
							onClick: () => void setPrimary(acc.id),
						}, loadingAction === `primary:${acc.id}` ? [renderSpinner(), '设置中'] : [uiIcon('star', 11), ' 设为主用']) : null,
						h('button', {
							type: 'button',
							className: 'agy-btn',
							style: isEditingProxy ? { ...S.btnSmPrimary, gap: '4px' } : { ...S.btnSm, gap: '4px' },
							disabled: isBusy,
							onClick: () => setEditingProxyId(isEditingProxy ? null : acc.id),
						}, [uiIcon('globe', 11), ' 代理']),
						accounts.length > 1 ? h('button', {
							type: 'button',
							className: 'agy-btn',
							style: { ...S.btnDanger, padding: '3px 7px' },
							title: '移除此账号',
							disabled: isBusy,
							onClick: () => void removeAccount(acc.id, acc.alias),
						}, loadingAction === `remove:${acc.id}` ? renderSpinner() : uiIcon('trash', 12, '#ef4444')) : null,
					),
				),
				h('div', { style: S.quotaBox },
					renderQuotaBar('Gemini', 'google', acc),
					renderQuotaBar('Claude', 'anthropic', acc),
					renderQuotaBar('GPT-OSS', 'openai', acc),
					isExpanded && allChildModels.length > 0 ? h('div', {
						style: {
							marginTop: '8px',
							paddingTop: '8px',
							borderTop: '1px solid rgba(255, 255, 255, 0.1)',
						},
					},
						h('div', { style: { color: 'var(--dsw-alias-text-secondary, #94a3b8)', marginBottom: '6px', fontWeight: 600, fontSize: '11px' } }, '单模型明细:'),
						allChildModels.map(({ family, model }) => {
							const frac = model.remainingFraction ?? 1;
							const pct = Math.round(frac * 100);
							const w = formatQuotaWindow(model.resetTime);
							const pColor = pct <= 20 ? '#f87171' : pct <= 50 ? '#fbbf24' : '#34d399';
							return h('div', { key: model.modelId, className: 'agy-submodel-row' },
								h('span', { style: { fontWeight: 500, color: 'var(--dsw-alias-text-primary, #e2e8f0)' } }, `[${family}] ${model.displayName || model.modelId}`),
								h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
									h('span', { style: { color: pColor, fontWeight: 700 } }, `${pct}%`),
									w.resetText ? h('span', { style: { color: 'var(--dsw-alias-text-secondary, #cbd5e1)', fontSize: '10.5px' } }, `↻ ${w.resetText}`) : null,
								),
							);
						}),
					) : null,
				),
				hasCooldown ? h('div', {
					style: {
						background: 'rgba(245,158,11,0.1)',
						border: '1px solid rgba(245,158,11,0.3)',
						borderRadius: '6px',
						padding: '4px 8px',
						color: '#f59e0b',
						fontSize: '11px',
						marginTop: '6px',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
					},
				},
					h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
						uiIcon('alert', 12, '#f59e0b'),
						h('span', null, '部分模型限流中，已自动切换账号'),
					),
					h('button', {
						type: 'button',
						className: 'agy-btn',
						style: { ...S.btnSm, color: '#f59e0b', borderColor: 'rgba(245,158,11,0.4)', background: 'rgba(245,158,11,0.15)', gap: '3px' },
						disabled: isBusy,
						onClick: () => void clearCooldown(acc.id),
					}, loadingAction === `clearCooldown:${acc.id}` ? [renderSpinner(), ''] : [uiIcon('zap', 11, '#f59e0b'), ' 清除冷却']),
				) : null,
				isEditingProxy ? h('div', {
					style: {
						marginTop: '6px',
						padding: '8px 10px',
						background: 'rgba(128,128,128,0.06)',
						borderRadius: '6px',
						border: '1px solid rgba(128,128,128,0.15)',
					},
				},
					h('div', { style: { display: 'flex', gap: '6px' } },
						h('input', {
							style: S.input,
							value: proxyInputs[acc.id] !== undefined ? proxyInputs[acc.id] : (acc.proxyUrl ?? ''),
							placeholder: '专属代理 URL (如: http://127.0.0.1:7890，留空则使用全局)',
							onChange: (e: { target: { value: string } }) => setProxyInputs({ ...proxyInputs, [acc.id]: e.target.value }),
						}),
						h('button', {
							type: 'button',
							className: 'agy-btn',
							style: S.btnPrimary,
							disabled: isBusy,
							onClick: () => void saveProxy(acc.id),
						}, loadingAction === `proxy:${acc.id}` ? [renderSpinner(), '保存'] : '保存'),
						h('button', {
							type: 'button',
							className: 'agy-btn',
							style: S.btn,
							onClick: () => setEditingProxyId(null),
						}, '取消'),
					),
				) : null,
			);
		});

		const poolAuth = status?.poolAuth;
		const flowPhase = poolAuth?.phase ?? 'idle';
		const flowActive = flowPhase === 'waiting' || flowPhase === 'exchanging';

		const addAccountSection = addingAccount
			? h('div', { style: S.authModal },
				h('div', { style: { fontWeight: 600, fontSize: '13px', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' } },
					uiIcon('plus', 13, '#3b82f6'),
					'添加 Google 账号',
				),
				!flowActive
					? h('div', null,
						h('div', { style: { display: 'flex', gap: '8px' } },
							h('input', {
								style: S.input,
								value: aliasInput,
								placeholder: '账号别名 (例如: 备用账号 2)',
								onChange: (e: { target: { value: string } }) => setAliasInput(e.target.value),
							}),
							h('button', {
								type: 'button',
								className: 'agy-btn',
								style: { ...S.btnPrimary, gap: '4px' },
								disabled: isBusy,
								onClick: () => void handleBeginAddAccount(),
							}, loadingAction === 'pool:beginAdd' ? [renderSpinner(), '正在打开浏览器...'] : [uiIcon('externalLink', 12, '#3b82f6'), ' 打开浏览器登录']),
							h('button', {
								type: 'button',
								className: 'agy-btn',
								style: S.btn,
								onClick: () => handleCancelAddAccount(),
							}, '取消'),
						),
						flowPhase === 'failed' && poolAuth?.message ? h('div', {
							style: { ...S.muted, color: '#ef4444', marginTop: '8px', display: 'flex', alignItems: 'center', gap: '5px' },
						}, uiIcon('alert', 12, '#ef4444'), poolAuth.message) : null,
					)
					: h('div', null,
						h('div', { style: { display: 'flex', alignItems: 'center', ...S.muted, marginBottom: '8px', lineHeight: 1.5 } },
							renderSpinner(),
							flowPhase === 'exchanging'
								? '正在验证授权并激活账号，请稍候...'
								: '等待浏览器中完成 Google 授权，成功后将自动激活。',
						),
						poolAuth?.url ? h('div', { style: { marginBottom: '8px' } },
							h('a', {
								href: poolAuth.url,
								target: '_blank',
								style: { color: '#3b82f6', textDecoration: 'none', fontSize: '12px', fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: '4px' },
							}, uiIcon('externalLink', 12, '#3b82f6'), '若浏览器未打开，请点击此处手动打开 Google 登录页'),
						) : null,
						h('div', { style: { ...S.muted, marginBottom: '6px', fontSize: '10px' } },
							'未完成自动回调时，可粘贴授权码或回调 URL：',
						),
						h('div', { style: { display: 'flex', gap: '8px' } },
							h('input', {
								style: S.input,
								value: authCodeInput,
								placeholder: '授权码 或 http://localhost:51121/oauth-callback?code=... 完整链接',
								onChange: (e: { target: { value: string } }) => setAuthCodeInput(e.target.value),
							}),
							h('button', {
								type: 'button',
								className: 'agy-btn',
								style: { ...S.btnPrimary, gap: '4px' },
								disabled: isBusy || !authCodeInput.trim(),
								onClick: () => void handleCompleteAddAccount(),
							}, loadingAction === 'pool:completeAdd' ? [renderSpinner(), '验证激活中...'] : [uiIcon('check', 12, '#3b82f6'), ' 手动激活']),
							h('button', {
								type: 'button',
								className: 'agy-btn',
								style: S.btn,
								onClick: () => handleCancelAddAccount(),
							}, '取消'),
						),
					),
			)
			: null;

		if (status === null) {
			return h('div', { style: { ...S.container, minHeight: '120px', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
				h('style', null, GLOBAL_CSS),
				h('span', { style: S.muted }, [renderSpinner(), '正在加载 Antigravity 状态...']),
			);
		}

		return h('div', { style: S.container },
			h('style', null, GLOBAL_CSS),
			h('div', { style: S.headerCard },
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
					agyIcon(16),
					h('span', { style: { fontWeight: 700, fontSize: '14px' } }, 'Antigravity'),
					h('span', { style: isAuthed ? { ...S.badgePrimary, color: '#10b981', background: 'rgba(16,185,129,0.12)', borderColor: 'rgba(16,185,129,0.3)' } : S.badgePrimary }, isAuthed ? '就绪' : '待认证'),
				),
				h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
					!addingAccount ? h('button', {
						type: 'button',
						className: 'agy-btn',
						style: { ...S.btnPrimary, gap: '4px' },
						onClick: () => setAddingAccount(true),
					}, [uiIcon('plus', 12, '#3b82f6'), ' 添加账号']) : null,
					h('button', {
						type: 'button',
						className: 'agy-btn',
						style: { ...S.btn, gap: '4px' },
						disabled: isBusy,
						onClick: () => void refreshQuota(),
					}, loadingAction === 'refresh:all' ? [renderSpinner(), '刷新中'] : [uiIcon('refresh', 12), ' 刷新额度']),
				),
			),
			renderToastBanner(),
			addAccountSection,
			renderedAccountCards,
			h('div', { style: { marginTop: '14px', paddingTop: '10px', borderTop: '1px solid rgba(128,128,128,0.15)' } },
				h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
					h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
						h('span', { style: S.muted }, '权限模式:'),
						h('div', { style: S.segGroup },
							h('button', {
								type: 'button',
								style: status?.permissionMode === 'plan' ? S.segBtnActive : S.segBtn,
								onClick: () => void setCfg('permissionMode', 'plan'),
							}, 'plan (只读)'),
							h('button', {
								type: 'button',
								style: status?.permissionMode === 'accept-edits' ? S.segBtnActive : S.segBtn,
								onClick: () => void setCfg('permissionMode', 'accept-edits'),
							}, 'accept-edits (改代码)'),
							h('button', {
								type: 'button',
								style: status?.permissionMode === 'skip' ? { ...S.segBtnActive, color: '#ef4444', background: 'rgba(239,68,68,0.2)' } : S.segBtn,
								onClick: () => void setCfg('permissionMode', 'skip'),
							}, 'skip (全自动免确认)'),
						),
					),
					h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
						h('span', { style: S.muted }, '思考强度:'),
						h('div', { style: S.segGroup },
							h('button', {
								type: 'button',
								style: status?.defaultEffort === '' ? S.segBtnActive : S.segBtn,
								onClick: () => void setCfg('defaultEffort', ''),
							}, 'auto'),
							h('button', {
								type: 'button',
								style: status?.defaultEffort === 'low' ? S.segBtnActive : S.segBtn,
								onClick: () => void setCfg('defaultEffort', 'low'),
							}, 'low'),
							h('button', {
								type: 'button',
								style: status?.defaultEffort === 'medium' ? S.segBtnActive : S.segBtn,
								onClick: () => void setCfg('defaultEffort', 'medium'),
							}, 'medium'),
							h('button', {
								type: 'button',
								style: status?.defaultEffort === 'high' ? S.segBtnActive : S.segBtn,
								onClick: () => void setCfg('defaultEffort', 'high'),
							}, 'high'),
						),
					),
					h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
						h('span', { style: S.muted }, '号池调度:'),
						h('div', { style: S.segGroup },
							h('button', {
								type: 'button',
								style: pool?.mode === 'sequential' || !pool?.mode ? S.segBtnActive : S.segBtn,
								onClick: () => void setMode('sequential'),
							}, '顺次耗尽'),
							h('button', {
								type: 'button',
								style: pool?.mode === 'round-robin' ? S.segBtnActive : S.segBtn,
								onClick: () => void setMode('round-robin'),
							}, '轮询均衡'),
						),
					),
				),
			),
		);
	};

	/** Modal dialog container rendered into document.body */
	const AgyModalDialog = (): unknown => {
		const [isOpen, setIsOpen] = useState(agyModalStore.open);

		useEffect(() => {
			const unsubscribe = agyModalStore.subscribe(() => {
				setIsOpen(agyModalStore.open);
			});
			return unsubscribe;
		}, []);

		useEffect(() => {
			if (!isOpen) return;
			const onKey = (e: any) => {
				if (e.key === 'Escape') {
					e.stopPropagation();
					agyModalStore.setOpen(false);
				}
			};
			win.addEventListener?.('keydown', onKey, true);
			return () => win.removeEventListener?.('keydown', onKey, true);
		}, [isOpen]);

		if (!isOpen) return null;

		return h('div', {
			className: 'agy-modal-backdrop',
			onClick: (e: { target: unknown; currentTarget: unknown }) => {
				if (e.target === e.currentTarget) agyModalStore.setOpen(false);
			},
		},
			h('div', { className: 'agy-modal-panel', role: 'dialog', 'aria-modal': true },
				h('div', {
					style: {
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
						padding: '12px 16px',
						borderBottom: '1px solid rgba(128,128,128,0.2)',
						background: 'rgba(128,128,128,0.05)',
					},
				},
					h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
						agyIcon(18),
						h('strong', { style: { fontSize: '14px' } }, 'Antigravity 管理控制台'),
					),
					h('button', {
						type: 'button',
						title: '关闭 (Esc)',
						style: {
							background: 'transparent',
							border: 'none',
							color: '#9aa0a6',
							cursor: 'pointer',
							padding: '4px 6px',
							borderRadius: '4px',
							display: 'inline-flex',
							alignItems: 'center',
						},
						onClick: () => agyModalStore.setOpen(false),
					}, uiIcon('x', 14, '#9aa0a6')),
				),
				h('div', { style: { overflowY: 'auto', padding: '16px', flex: '1' } },
					h(AgySettingsSection, { isModal: true, onClose: () => agyModalStore.setOpen(false) }),
				),
			),
		);
	};

	/** Session Header badge in chat toolbar */
	const AgySessionStatus = (): unknown => {
		const [status, setStatus] = useState<StatusPayload | null>(statusCache);
		useEffect(() => {
			let alive = true;
			let lastJson = '';
			const tick = async () => {
				const st = await getStatus();
				if (!alive || !st) return;
				const json = JSON.stringify(st);
				if (json !== lastJson) {
					lastJson = json;
					setStatus(st);
				}
			};
			void tick();
			const timer = setInterval(tick, 3000);
			return () => {
				alive = false;
				clearInterval(timer);
			};
		}, []);

		const pool = status?.pool;
		const accounts = pool?.accounts ?? [];
		const hasCooldown = accounts.some((a) => Object.entries(a.cooldowns).some(([, cd]) => cd && cd.cooldownUntil > Date.now()));
		const isAuthed = status?.auth?.phase === 'ok' || accounts.length > 0;
		const color = status === null ? '#9aa0a6' : status.dormantReason ? '#f59e0b' : hasCooldown ? '#f59e0b' : isAuthed ? '#10b981' : '#f59e0b';

		// The console modal lives with the always-mounted header badge (the
		// sidebar footer shortcut was removed per product decision).
		const badge = h('button',
			{
				type: 'button',
				title: `Antigravity: ${accounts.length} accounts ready · 点击打开控制台`,
				className: 'agy-btn',
				onClick: () => agyModalStore.setOpen(true),
				style: {
					background: 'transparent',
					border: '1px solid rgba(128,128,128,0.25)',
					borderRadius: '999px',
					cursor: 'pointer',
					padding: '2px 8px',
					fontSize: '11px',
					lineHeight: 1.5,
					color: 'inherit',
					display: 'inline-flex',
					alignItems: 'center',
					gap: '5px',
				},
			},
			h('span', { style: { display: 'inline-block', width: '7px', height: '7px', borderRadius: '50%', background: color } }),
			`AGY (${accounts.length})`,
		);
		return h('div', { style: { display: 'inline-block' } },
			badge,
			portalToBody(h(AgyModalDialog, null)),
		);
	};

	// Register in header session toolbar
	ctx.slots.inject('conversation.session.header.actions', () => {
		const dispose = ctx.slots.register(
			{
				name: 'conversation.session.header.actions',
				id: 'agy-link-status',
				order: 10,
				label: 'Antigravity',
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
				label: 'Antigravity',
			},
			AgySettingsSection,
		);
		return dispose;
	});
}

