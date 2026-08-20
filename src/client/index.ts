// dsh-agy-link client half (browser). Integrated into native DSH settings & header.
import type { Context } from '@deepseek-ai/cordis';
import type { AccountPoolData, FamilyQuotaInfo, ManagedAccount } from '../common/pool-types.ts';

type ReactApi = {
	createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
	useState: <S>(initial: S) => [S, (next: S | ((prev: S) => S)) => void];
	useEffect: (setup: () => (() => void) | void, deps?: unknown[]) => void;
};
const R = require('react') as ReactApi;
const { createElement: h, useState, useEffect } = R;

const win = globalThis as unknown as {
	location?: { origin?: string };
	fetch?: (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
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

async function getStatus(): Promise<StatusPayload | null> {
	try {
		const res = await win.fetch?.(base + '/plugins/agy-link/status');
		if (!res || !res.ok) return null;
		return (await res.json()) as StatusPayload;
	} catch {
		return null;
	}
}

async function postJson(path: string, body: Record<string, unknown>): Promise<unknown> {
	try {
		const res = await win.fetch?.(base + path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		return res ?? null;
	} catch {
		return null;
	}
}

const GLOBAL_CSS = `
@keyframes agy-spin {
	0% { transform: rotate(0deg); }
	100% { transform: rotate(360deg); }
}
@keyframes agy-pulse {
	0%, 100% { opacity: 1; transform: scale(1); }
	50% { opacity: 0.4; transform: scale(0.95); }
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
	animation: agy-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
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
`;

// Design system styles
const S: Record<string, Record<string, unknown>> = {
	container: {
		lineHeight: 1.6,
		fontSize: '13px',
		fontFamily: 'inherit',
		color: 'inherit',
	},
	headerCard: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: '12px 16px',
		background: 'rgba(128,128,128,0.06)',
		border: '1px solid rgba(128,128,128,0.18)',
		borderRadius: '10px',
		marginBottom: '14px',
	},
	badgePrimary: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '4px',
		background: 'rgba(59,130,246,0.15)',
		color: '#3b82f6',
		border: '1px solid rgba(59,130,246,0.35)',
		padding: '2px 8px',
		borderRadius: '6px',
		fontSize: '11px',
		fontWeight: 600,
	},
	badgeTag: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '3px',
		background: 'rgba(128,128,128,0.12)',
		color: 'inherit',
		border: '1px solid rgba(128,128,128,0.25)',
		padding: '1px 7px',
		borderRadius: '5px',
		fontSize: '11px',
	},
	card: {
		background: 'rgba(128,128,128,0.04)',
		border: '1px solid rgba(128,128,128,0.2)',
		borderRadius: '10px',
		padding: '14px 16px',
		marginBottom: '12px',
	},
	cardPrimary: {
		background: 'rgba(59,130,246,0.03)',
		border: '1px solid rgba(59,130,246,0.3)',
		borderRadius: '10px',
		padding: '14px 16px',
		marginBottom: '12px',
	},
	quotaBox: {
		background: 'rgba(0,0,0,0.15)',
		border: '1px solid rgba(128,128,128,0.12)',
		borderRadius: '8px',
		padding: '10px 14px',
		marginTop: '10px',
		marginBottom: '6px',
	},
	progressBarBg: {
		flex: '1',
		height: '7px',
		borderRadius: '4px',
		background: 'rgba(128,128,128,0.2)',
		overflow: 'hidden',
		margin: '0 10px',
	},
	btn: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '5px 12px',
		borderRadius: '6px',
		border: '1px solid rgba(128,128,128,0.3)',
		background: 'rgba(128,128,128,0.1)',
		color: 'inherit',
		cursor: 'pointer',
		fontSize: '12px',
		fontWeight: 500,
	},
	btnPrimary: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '6px 14px',
		borderRadius: '6px',
		border: '1px solid rgba(59,130,246,0.5)',
		background: 'rgba(59,130,246,0.25)',
		color: '#3b82f6',
		cursor: 'pointer',
		fontSize: '12px',
		fontWeight: 600,
	},
	btnSuccess: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '5px 12px',
		borderRadius: '6px',
		border: '1px solid rgba(16,185,129,0.5)',
		background: 'rgba(16,185,129,0.2)',
		color: '#10b981',
		cursor: 'pointer',
		fontSize: '12px',
		fontWeight: 600,
	},
	btnDanger: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '4px 10px',
		borderRadius: '6px',
		border: '1px solid rgba(239,68,68,0.4)',
		background: 'rgba(239,68,68,0.12)',
		color: '#ef4444',
		cursor: 'pointer',
		fontSize: '11px',
		fontWeight: 500,
	},
	btnSm: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '3px 9px',
		borderRadius: '5px',
		border: '1px solid rgba(128,128,128,0.28)',
		background: 'rgba(128,128,128,0.08)',
		color: 'inherit',
		cursor: 'pointer',
		fontSize: '11px',
		fontWeight: 500,
	},
	btnSmPrimary: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '3px 9px',
		borderRadius: '5px',
		border: '1px solid rgba(59,130,246,0.4)',
		background: 'rgba(59,130,246,0.18)',
		color: '#3b82f6',
		cursor: 'pointer',
		fontSize: '11px',
		fontWeight: 600,
	},
	segGroup: {
		display: 'inline-flex',
		background: 'rgba(128,128,128,0.12)',
		borderRadius: '7px',
		padding: '2px',
		border: '1px solid rgba(128,128,128,0.18)',
	},
	segBtn: {
		padding: '4px 10px',
		borderRadius: '5px',
		border: 'none',
		background: 'transparent',
		color: 'inherit',
		cursor: 'pointer',
		fontSize: '11px',
		fontWeight: 500,
		opacity: 0.75,
	},
	segBtnActive: {
		padding: '4px 10px',
		borderRadius: '5px',
		border: 'none',
		background: 'rgba(59,130,246,0.3)',
		color: '#3b82f6',
		cursor: 'pointer',
		fontSize: '11px',
		fontWeight: 600,
		boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
		opacity: 1,
	},
	input: {
		flex: '1',
		padding: '7px 10px',
		borderRadius: '6px',
		border: '1px solid rgba(128,128,128,0.35)',
		background: 'rgba(0,0,0,0.1)',
		color: 'inherit',
		fontSize: '12px',
		outline: 'none',
	},
	muted: { color: '#9aa0a6', fontSize: '12px' },
	noticeBanner: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: '8px 12px',
		borderRadius: '8px',
		marginBottom: '12px',
		fontSize: '12px',
	},
	authBox: {
		background: 'rgba(59,130,246,0.06)',
		border: '1px solid rgba(59,130,246,0.25)',
		borderRadius: '10px',
		padding: '14px',
		margin: '12px 0',
	},
};

export function apply(ctx: ClientContext): void {
	const AgySettingsSection = (): unknown => {
		const [status, setStatus] = useState<StatusPayload | null>(null);
		const [aliasInput, setAliasInput] = useState('');
		const [proxyInputs, setProxyInputs] = useState<Record<string, string>>({});
		const [editingProxyId, setEditingProxyId] = useState<string | null>(null);
		const [addingAccount, setAddingAccount] = useState(false);
		const [loadingAction, setLoadingAction] = useState<string | null>(null);
		const [toast, setToast] = useState<ToastNotice | null>(null);

		useEffect(() => {
			let alive = true;
			const tick = async () => {
				const st = await getStatus();
				if (alive) setStatus(st);
			};
			void tick();
			const timer = setInterval(tick, 3000);
			return () => {
				alive = false;
				clearInterval(timer);
			};
		}, []);

		const showToast = (text: string, type: ToastNotice['type'] = 'info') => {
			setToast({ text, type, id: Date.now() });
			setTimeout(() => {
				setToast((prev) => (prev?.text === text ? null : prev));
			}, 7000);
		};

		const refresh = async (): Promise<void> => {
			setStatus(await getStatus());
		};

		// Unified One-Step Add Account Flow
		const handleCreateAndLoginAccount = async (): Promise<void> => {
			setLoadingAction('pool:add');
			const alias = aliasInput.trim() || `备用 Google 账号 ${(status?.pool?.accounts?.length ?? 1) + 1}`;
			await postJson('/plugins/agy-link/pool/add', { alias, autoOpenTerminal: true });
			setAliasInput('');
			setAddingAccount(false);
			await refresh();
			setLoadingAction(null);
			showToast('💻 已自动调起系统终端！请在弹出的终端窗口中登录第二个 Google 账号，完成后点击【🔄 刷新额度】即可自动入池', 'success');
		};

		const setCfg = async (key: string, value: unknown): Promise<void> => {
			setLoadingAction(`config:${key}`);
			await postJson('/plugins/agy-link/config', { key, value });
			await refresh();
			setLoadingAction(null);
			showToast(`已更新参数配置: ${key} = ${String(value)}`, 'success');
		};

		const setPrimary = async (id: string): Promise<void> => {
			setLoadingAction(`primary:${id}`);
			await postJson('/plugins/agy-link/pool/primary', { id });
			await refresh();
			setLoadingAction(null);
			showToast('⭐ 已将该账号设为主用账号', 'success');
		};

		const removeAccount = async (id: string, alias: string): Promise<void> => {
			setLoadingAction(`remove:${id}`);
			await postJson('/plugins/agy-link/pool/remove', { id });
			await refresh();
			setLoadingAction(null);
			showToast(`已从号池中移除账号: ${alias}`, 'info');
		};

		const refreshQuota = async (id?: string): Promise<void> => {
			setLoadingAction(id ? `refresh:${id}` : 'refresh:all');
			await postJson('/plugins/agy-link/pool/refresh-quota', { id });
			await refresh();
			setLoadingAction(null);
			showToast(id ? '✅ 账号状态与额度已刷新' : '✅ 全部账号状态已同步刷新', 'success');
		};

		const openTerminal = async (id: string): Promise<void> => {
			setLoadingAction(`terminal:${id}`);
			await postJson('/plugins/agy-link/pool/open-terminal', { id });
			setLoadingAction(null);
			showToast('💻 已调起 macOS 终端！请在终端中完成 agy 登录，完成后点击【🔄 刷新额度】即可激活入池', 'info');
		};

		const saveProxy = async (id: string): Promise<void> => {
			setLoadingAction(`proxy:${id}`);
			const proxyUrl = proxyInputs[id];
			await postJson('/plugins/agy-link/pool/proxy', { id, proxyUrl });
			setEditingProxyId(null);
			await refresh();
			setLoadingAction(null);
			showToast('💾 账号专属网络代理设置已保存', 'success');
		};

		const setMode = async (mode: string): Promise<void> => {
			setLoadingAction(`mode:${mode}`);
			await postJson('/plugins/agy-link/pool/mode', { mode });
			await refresh();
			setLoadingAction(null);
			showToast(`已切换号池调度模式为: ${mode === 'sequential' ? '顺次耗尽 (Sequential)' : '轮询均衡 (Round-Robin)'}`, 'success');
		};

		const clearCooldown = async (id?: string): Promise<void> => {
			setLoadingAction(id ? `clearCooldown:${id}` : 'clearCooldown:all');
			await postJson('/plugins/agy-link/pool/clear-cooldown', { id });
			await refresh();
			setLoadingAction(null);
			showToast('⚡ 已清除账号限流冷却状态', 'success');
		};

		const authPhase = status?.auth?.phase ?? 'unknown';
		const isAuthed = authPhase === 'ok' || (status?.pool?.accounts?.length ?? 0) > 0;
		const pool = status?.pool;
		const accounts = pool?.accounts ?? [];
		const isBusy = loadingAction !== null;

		// Spinner icon helper
		const renderSpinner = () => h('span', { className: 'agy-spinner' });

		// Toast Banner renderer
		const renderToastBanner = () => {
			if (!toast) return null;
			const typeStyles = {
				success: { background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.4)', color: '#10b981' },
				info: { background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.4)', color: '#3b82f6' },
				warn: { background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.4)', color: '#f59e0b' },
				error: { background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)', color: '#ef4444' },
			};
			return h('div', { style: { ...S.noticeBanner, ...typeStyles[toast.type] } },
				h('span', { style: { fontWeight: 500 } }, toast.text),
				h('button', {
					type: 'button',
					style: { background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '14px', padding: '0 4px', opacity: 0.8 },
					onClick: () => setToast(null),
				}, '✕'),
			);
		};

		// Quota Progress Bar / Status Row Helper
		const renderQuotaBar = (label: string, icon: string, info?: FamilyQuotaInfo, isKeychain = false): unknown => {
			const fraction = typeof info?.remainingFraction === 'number' ? info.remainingFraction : null;
			const percent = fraction !== null ? Math.round(fraction * 100) : null;
			
			if (percent !== null) {
				let barGradient = 'linear-gradient(90deg, #10b981, #059669)';
				let textColor = '#10b981';
				let badgeBg = 'rgba(16,185,129,0.15)';
				if (percent <= 20) {
					barGradient = 'linear-gradient(90deg, #ef4444, #dc2626)';
					textColor = '#ef4444';
					badgeBg = 'rgba(239,68,68,0.15)';
				} else if (percent <= 50) {
					barGradient = 'linear-gradient(90deg, #f59e0b, #d97706)';
					textColor = '#f59e0b';
					badgeBg = 'rgba(245,158,11,0.15)';
				}

				let resetTimeStr = '';
				if (info?.resetTime) {
					try {
						const d = new Date(info.resetTime);
						resetTimeStr = ` (${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')} 重置)`;
					} catch {
						// skip
					}
				}

				return h('div', { style: { display: 'flex', alignItems: 'center', fontSize: '11px', margin: '4px 0' } },
					h('span', { style: { width: '85px', display: 'inline-flex', alignItems: 'center', gap: '4px', fontWeight: 500 } },
						h('span', null, icon),
						label,
					),
					h('div', { style: S.progressBarBg },
						h('div', {
							className: 'agy-progress-fill',
							style: {
								width: `${Math.min(100, Math.max(0, percent))}%`,
								height: '100%',
								background: barGradient,
								borderRadius: '4px',
							},
						}),
					),
					h('div', { style: { display: 'inline-flex', alignItems: 'center', minWidth: '55px', justifyContent: 'flex-end' } },
						h('span', {
							style: {
								padding: '1px 6px',
								borderRadius: '4px',
								background: badgeBg,
								color: textColor,
								fontWeight: 600,
								fontSize: '11px',
							},
						}, `${percent}%`),
					),
					resetTimeStr ? h('span', { style: { ...S.muted, fontSize: '10px', marginLeft: '4px' } }, resetTimeStr) : null,
				);
			}

			// Active Keychain native managed state
			return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11px', margin: '3px 0' } },
				h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontWeight: 500 } },
					h('span', null, icon),
					label,
				),
				h('span', {
					style: {
						color: '#10b981',
						background: 'rgba(16,185,129,0.12)',
						padding: '1px 6px',
						borderRadius: '4px',
						fontSize: '10px',
						fontWeight: 500,
					},
				}, '🟢 官方 CLI 实时调度正常'),
			);
		};

		// Render Account Cards
		const renderedAccountCards = accounts.map((acc: ManagedAccount, idx: number) => {
			const isPrimary = acc.id === pool?.primaryAccountId;
			const hasCooldown = Object.entries(acc.cooldowns).some(([, cd]) => cd && cd.cooldownUntil > Date.now());
			const dotColor = !acc.enabled ? '#9aa0a6' : hasCooldown ? '#f59e0b' : '#10b981';
			const isEditingProxy = editingProxyId === acc.id;

			const isRefreshing = loadingAction === `refresh:${acc.id}`;
			const isOpeningTerminal = loadingAction === `terminal:${acc.id}`;
			const isSettingPrimary = loadingAction === `primary:${acc.id}`;
			const isRemoving = loadingAction === `remove:${acc.id}`;
			const isClearingCooldown = loadingAction === `clearCooldown:${acc.id}`;

			const cardStyle = isPrimary ? { ...S.cardPrimary } : { ...S.card };
			const hasExplicitQuotas = !!(acc.quotas.google?.remainingFraction || acc.quotas.anthropic?.remainingFraction || acc.quotas.openai?.remainingFraction);

			return h('div', { key: acc.id, className: 'agy-card-hover', style: cardStyle },
				// Card Header
				h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' } },
					h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
						h('span', {
							className: 'agy-pulse-dot',
							style: { background: dotColor, boxShadow: `0 0 8px ${dotColor}88` },
						}),
						h('span', { style: { fontWeight: 600, fontSize: '13px' } }, `${idx + 1}. ${acc.alias}`),
						acc.email ? h('span', { style: { ...S.badgeTag, color: '#3b82f6', borderColor: 'rgba(59,130,246,0.3)' } }, `✉️ ${acc.email}`) : null,
						isPrimary ? h('span', { style: S.badgePrimary }, '⭐ 主用账号') : null,
						acc.systemHome ? h('span', { style: S.badgeTag }, '💻 Keychain') : null,
					),
					// Card Actions
					h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap' } },
						h('button', {
							type: 'button',
							className: 'agy-btn',
							style: S.btnSm,
							disabled: isBusy,
							onClick: () => void refreshQuota(acc.id),
						}, isRefreshing ? [renderSpinner(), '刷新中...'] : '🔄 刷新状态'),
						!isPrimary && acc.dir ? h('button', {
							type: 'button',
							className: 'agy-btn',
							style: S.btnSmPrimary,
							disabled: isBusy,
							onClick: () => void openTerminal(acc.id),
						}, isOpeningTerminal ? [renderSpinner(), '打开中...'] : '💻 打开终端登录') : null,
						!isPrimary ? h('button', {
							type: 'button',
							className: 'agy-btn',
							style: S.btnSm,
							disabled: isBusy,
							onClick: () => void setPrimary(acc.id),
						}, isSettingPrimary ? [renderSpinner(), '设置中...'] : '⬆️ 设为主用') : null,
						h('button', {
							type: 'button',
							className: 'agy-btn',
							style: isEditingProxy ? S.btnSmPrimary : S.btnSm,
							disabled: isBusy,
							onClick: () => setEditingProxyId(isEditingProxy ? null : acc.id),
						}, '⚙️ 代理'),
						accounts.length > 1 ? h('button', {
							type: 'button',
							className: 'agy-btn',
							style: S.btnDanger,
							disabled: isBusy,
							onClick: () => void removeAccount(acc.id, acc.alias),
						}, isRemoving ? [renderSpinner(), '移除中...'] : '🗑️ 移除') : null,
					),
				),

				// Quota / Status Section
				h('div', { style: S.quotaBox },
					renderQuotaBar('Gemini', '✨', acc.quotas.google, acc.systemHome),
					renderQuotaBar('Claude', '🧠', acc.quotas.anthropic, acc.systemHome),
					renderQuotaBar('GPT-OSS', '⚡', acc.quotas.openai, acc.systemHome),
					!hasExplicitQuotas
						? h('div', { style: { ...S.muted, fontSize: '11px', marginTop: '6px', borderTop: '1px dashed rgba(128,128,128,0.15)', paddingTop: '4px' } },
							acc.systemHome
								? 'ℹ️ 凭据由 macOS 钥匙串托管，额度由 agy CLI 原生实时调度；触发 429 自动无缝切号'
								: '💡 账号环境已就绪。点击上方【💻 打开终端登录】在终端中回车完成 Google 登录，完成后点击【🔄 刷新状态】即可入池'
						)
						: null,
				),

				// Cooldown Alert Banner if rate-limited
				hasCooldown ? h('div', {
					style: {
						background: 'rgba(245,158,11,0.12)',
						border: '1px solid rgba(245,158,11,0.35)',
						borderRadius: '6px',
						padding: '6px 10px',
						color: '#f59e0b',
						fontSize: '11px',
						margin: '6px 0',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
					},
				},
					h('span', null, '⚠️ 当前部分模型家族处于限流冷却中 (已自动顺次切换至下一个可用账号)'),
					h('button', {
						type: 'button',
						className: 'agy-btn',
						style: { ...S.btnSm, color: '#f59e0b', borderColor: 'rgba(245,158,11,0.4)', background: 'rgba(245,158,11,0.15)' },
						disabled: isBusy,
						onClick: () => void clearCooldown(acc.id),
					}, isClearingCooldown ? [renderSpinner(), '清除中...'] : '⚡ 清除冷却'),
				) : null,

				// Proxy setting inline editor
				isEditingProxy ? h('div', {
					style: {
						marginTop: '8px',
						padding: '8px 10px',
						background: 'rgba(128,128,128,0.06)',
						borderRadius: '6px',
						border: '1px solid rgba(128,128,128,0.15)',
					},
				},
					h('div', { style: { ...S.muted, fontSize: '11px', marginBottom: '4px' } }, '独立代理 URL（留空则继承当前系统/终端环境代理）:'),
					h('div', { style: { display: 'flex', gap: '6px' } },
						h('input', {
							style: S.input,
							value: proxyInputs[acc.id] !== undefined ? proxyInputs[acc.id] : (acc.proxyUrl ?? ''),
							placeholder: '例如: http://127.0.0.1:7890 或 socks5://127.0.0.1:7890',
							onChange: (e: { target: { value: string } }) => setProxyInputs({ ...proxyInputs, [acc.id]: e.target.value }),
						}),
						h('button', {
							type: 'button',
							className: 'agy-btn',
							style: S.btnPrimary,
							disabled: isBusy,
							onClick: () => void saveProxy(acc.id),
						}, loadingAction === `proxy:${acc.id}` ? [renderSpinner(), '保存中...'] : '保存代理'),
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

		// Add Account Drawer
		const addAccountSection = addingAccount
			? h('div', { style: { ...S.authBox, marginTop: '10px' } },
				h('div', { style: { fontWeight: 600, fontSize: '14px', marginBottom: '6px' } }, '➕ 添加新 Google 账号入池 (统一标准向导)'),
				h('div', { style: { ...S.muted, marginBottom: '10px', lineHeight: 1.6 } },
					'1. 为新账号命名（如“工作账号 / 备用账号2”）；\n2. 点击下方按钮，系统将自动创建隔离环境并自动调起 macOS 终端运行官方 agy；\n3. 终端自动调起系统浏览器完成 Google 登录授权；\n4. 登录完成后回到此页面点击【🔄 刷新状态】，账号即可自动激活入池！',
				),
				h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } },
					h('input', {
						style: S.input,
						value: aliasInput,
						placeholder: '账号别名 (例如: 备用 Google 账号 2)',
						onChange: (e: { target: { value: string } }) => setAliasInput(e.target.value),
					}),
					h('button', {
						type: 'button',
						className: 'agy-btn',
						style: S.btnPrimary,
						disabled: isBusy,
						onClick: () => void handleCreateAndLoginAccount(),
					}, loadingAction === 'pool:add' ? [renderSpinner(), '创建并调起中...'] : '🚀 创建并调起终端登录'),
					h('button', {
						type: 'button',
						className: 'agy-btn',
						style: S.btn,
						disabled: isBusy,
						onClick: () => setAddingAccount(false),
					}, '取消'),
				),
			)
			: h('div', { style: { margin: '12px 0' } },
				h('button', {
					type: 'button',
					className: 'agy-btn',
					style: S.btnPrimary,
					disabled: isBusy,
					onClick: () => setAddingAccount(true),
				}, '➕ 添加新 Google 账号 (Add Google Account)'),
			);

		// Global Pool Header & Mode Toggle
		const poolHeader = h('div', {
			style: {
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				margin: '16px 0 10px',
				flexWrap: 'wrap',
				gap: '8px',
			},
		},
			h('div', { style: { fontWeight: 600, fontSize: '14px', display: 'flex', alignItems: 'center', gap: '6px' } },
				'👥 Google 多账号池',
				h('span', { style: S.badgeTag }, `${accounts.length} 个账号`),
			),
			h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
				// Segmented Mode Switch
				h('div', { style: S.segGroup },
					h('button', {
						type: 'button',
						className: 'agy-btn',
						style: pool?.mode === 'sequential' || !pool?.mode ? S.segBtnActive : S.segBtn,
						onClick: () => void setMode('sequential'),
					}, '顺次耗尽 (Sequential)'),
					h('button', {
						type: 'button',
						className: 'agy-btn',
						style: pool?.mode === 'round-robin' ? S.segBtnActive : S.segBtn,
						onClick: () => void setMode('round-robin'),
					}, '轮询均衡 (Round-Robin)'),
				),
				h('button', {
					type: 'button',
					className: 'agy-btn',
					style: S.btn,
					disabled: isBusy,
					onClick: () => void refreshQuota(),
				}, loadingAction === 'refresh:all' ? [renderSpinner(), '刷新中...'] : '🔄 刷新全部状态'),
			),
		);

		// Parameters section (permission mode / reasoning effort)
		const permissionRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', margin: '6px 0' } },
			h('span', { style: { ...S.muted, width: '70px' } }, '权限模式:'),
			h('div', { style: S.segGroup },
				h('button', {
					type: 'button',
					className: 'agy-btn',
					style: status?.permissionMode === 'plan' ? S.segBtnActive : S.segBtn,
					onClick: () => void setCfg('permissionMode', 'plan'),
				}, 'plan (只读)'),
				h('button', {
					type: 'button',
					className: 'agy-btn',
					style: status?.permissionMode === 'accept-edits' ? S.segBtnActive : S.segBtn,
					onClick: () => void setCfg('permissionMode', 'accept-edits'),
				}, 'accept-edits (自动改代码)'),
				h('button', {
					type: 'button',
					className: 'agy-btn',
					style: status?.permissionMode === 'skip' ? { ...S.segBtnActive, color: '#ef4444', background: 'rgba(239,68,68,0.2)' } : S.segBtn,
					onClick: () => void setCfg('permissionMode', 'skip'),
				}, 'skip (全自动免确认)'),
			),
		);

		const effortRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', margin: '6px 0' } },
			h('span', { style: { ...S.muted, width: '70px' } }, '思考强度:'),
			h('div', { style: S.segGroup },
				h('button', {
					type: 'button',
					className: 'agy-btn',
					style: status?.defaultEffort === '' ? S.segBtnActive : S.segBtn,
					onClick: () => void setCfg('defaultEffort', ''),
				}, 'auto (自动)'),
				h('button', {
					type: 'button',
					className: 'agy-btn',
					style: status?.defaultEffort === 'low' ? S.segBtnActive : S.segBtn,
					onClick: () => void setCfg('defaultEffort', 'low'),
				}, 'low (低)'),
				h('button', {
					type: 'button',
					className: 'agy-btn',
					style: status?.defaultEffort === 'medium' ? S.segBtnActive : S.segBtn,
					onClick: () => void setCfg('defaultEffort', 'medium'),
				}, 'medium (中)'),
				h('button', {
					type: 'button',
					className: 'agy-btn',
					style: status?.defaultEffort === 'high' ? S.segBtnActive : S.segBtn,
					onClick: () => void setCfg('defaultEffort', 'high'),
				}, 'high (高)'),
			),
		);

		return h('div', { style: S.container },
			h('style', null, GLOBAL_CSS),
			// Top Header Card
			h('div', { style: S.headerCard },
				h('div', null,
					h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700, fontSize: '15px' } },
						h('span', {
							className: 'agy-pulse-dot',
							style: { background: isAuthed ? '#10b981' : '#f59e0b', boxShadow: `0 0 10px ${isAuthed ? '#10b981' : '#f59e0b'}` },
						}),
						'Antigravity (agy CLI) 多账号号池与配额中心',
					),
					h('div', { style: { ...S.muted, marginTop: '4px', fontSize: '12px' } },
						'多账号隔离与自动轮换 · 顺次耗尽调度 · 原生 57 Agent 工具 · 多模态图文支持',
					),
				),
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
					isAuthed
						? h('span', { style: { ...S.badgePrimary, background: 'rgba(16,185,129,0.15)', color: '#10b981', borderColor: 'rgba(16,185,129,0.4)' } }, '🟢 正常就绪')
						: h('span', { style: { ...S.badgePrimary, background: 'rgba(245,158,11,0.15)', color: '#f59e0b', borderColor: 'rgba(245,158,11,0.4)' } }, '🟡 待认证'),
				),
			),

			// Toast Feedback
			renderToastBanner(),

			// Account Pool Section
			poolHeader,
			renderedAccountCards,
			addAccountSection,

			// Parameters & Execution Config
			h('div', { style: { borderTop: '1px solid rgba(128,128,128,0.18)', margin: '18px 0 12px', paddingTop: '12px' } },
				h('div', { style: { fontWeight: 600, fontSize: '13px', marginBottom: '10px' } }, '⚙️ 执行与权限参数'),
				permissionRow,
				effortRow,
			),

			// Footer tips
			h('div', { style: { ...S.muted, fontSize: '11px', marginTop: '14px', borderTop: '1px dashed rgba(128,128,128,0.15)', paddingTop: '8px' } },
				'💡 终端指令提示：聊天框输入 `/agy pool` 查看配额看板，`/agy refresh-quota` 刷新额度，`/agy doctor` 检查健康状态。',
			),
		);
	};

	const AgySessionStatus = (): unknown => {
		const [status, setStatus] = useState<StatusPayload | null>(null);
		useEffect(() => {
			let alive = true;
			const tick = async () => {
				const st = await getStatus();
				if (alive) setStatus(st);
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

		return h('button',
			{
				type: 'button',
				title: `Antigravity Multi-Account: ${accounts.length} pooled accounts`,
				style: {
					background: 'transparent',
					border: '1px solid rgba(128,128,128,0.25)',
					borderRadius: '999px',
					cursor: 'default',
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
	};

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
