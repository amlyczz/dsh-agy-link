// dsh-agy-link client half (browser). Integrated into native DSH settings & header.
import type { Context } from '@deepseek-ai/cordis';
import type { AccountPoolData, FamilyQuotaInfo, ManagedAccount, ModelFamily } from '../common/pool-types.ts';

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

const S: Record<string, Record<string, unknown>> = {
	row: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' },
	btn: {
		padding: '4px 10px',
		borderRadius: '6px',
		border: '1px solid rgba(128,128,128,0.4)',
		background: 'rgba(128,128,128,0.12)',
		color: 'inherit',
		cursor: 'pointer',
		fontSize: '12px',
	},
	btnPrimary: {
		padding: '6px 14px',
		borderRadius: '6px',
		border: '1px solid rgba(64,140,255,0.6)',
		background: 'rgba(64,140,255,0.25)',
		color: '#408cff',
		cursor: 'pointer',
		fontSize: '13px',
		fontWeight: 600,
	},
	btnDanger: {
		padding: '3px 8px',
		borderRadius: '6px',
		border: '1px solid rgba(229,72,77,0.5)',
		background: 'rgba(229,72,77,0.15)',
		color: '#e5484d',
		cursor: 'pointer',
		fontSize: '11px',
	},
	btnSm: {
		padding: '2px 8px',
		borderRadius: '4px',
		border: '1px solid rgba(128,128,128,0.3)',
		background: 'rgba(128,128,128,0.1)',
		color: 'inherit',
		cursor: 'pointer',
		fontSize: '11px',
	},
	input: {
		flex: '1',
		padding: '6px 8px',
		borderRadius: '6px',
		border: '1px solid rgba(128,128,128,0.4)',
		background: 'transparent',
		color: 'inherit',
		fontSize: '12px',
	},
	muted: { color: '#9aa0a6', fontSize: '12px' },
	authBox: {
		background: 'rgba(128,128,128,0.06)',
		border: '1px solid rgba(128,128,128,0.2)',
		borderRadius: '8px',
		padding: '12px',
		margin: '10px 0',
	},
	card: {
		background: 'rgba(128,128,128,0.04)',
		border: '1px solid rgba(128,128,128,0.25)',
		borderRadius: '8px',
		padding: '10px 12px',
		marginBottom: '10px',
	},
	progressBarBg: {
		flex: '1',
		height: '6px',
		borderRadius: '3px',
		background: 'rgba(128,128,128,0.2)',
		overflow: 'hidden',
		margin: '0 8px',
	},
};

export function apply(ctx: ClientContext): void {
	const AgySettingsSection = (): unknown => {
		const [status, setStatus] = useState<StatusPayload | null>(null);
		const [code, setCode] = useState('');
		const [aliasInput, setAliasInput] = useState('');
		const [proxyInputs, setProxyInputs] = useState<Record<string, string>>({});
		const [editingProxyId, setEditingProxyId] = useState<string | null>(null);
		const [addingAccount, setAddingAccount] = useState(false);
		const [busy, setBusy] = useState(false);
		const [notice, setNotice] = useState('');

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

		const refresh = async (): Promise<void> => {
			setStatus(await getStatus());
		};

		const startAuth = async (accountId?: string, homeDir?: string): Promise<void> => {
			setBusy(true);
			setNotice('');
			await postJson('/plugins/agy-link/auth', { accountId, homeDir });
			await refresh();
			setBusy(false);
		};

		const startAddAccount = async (): Promise<void> => {
			setBusy(true);
			setNotice('');
			setAddingAccount(true);
			await postJson('/plugins/agy-link/pool/add', { alias: aliasInput.trim() || undefined });
			setAliasInput('');
			await refresh();
			setBusy(false);
		};

		const cancelAuth = async (): Promise<void> => {
			setBusy(true);
			setAddingAccount(false);
			await postJson('/plugins/agy-link/auth-cancel', {});
			await refresh();
			setBusy(false);
		};

		const submitCode = async (): Promise<void> => {
			if (code.trim() === '') return;
			setBusy(true);
			await postJson('/plugins/agy-link/auth-code', { code: code.trim() });
			setCode('');
			setAddingAccount(false);
			const st = await getStatus();
			setStatus(st);
			setNotice(st?.auth?.message ?? '');
			setBusy(false);
		};

		const setCfg = async (key: string, value: unknown): Promise<void> => {
			setBusy(true);
			await postJson('/plugins/agy-link/config', { key, value });
			await refresh();
			setBusy(false);
		};

		const setPrimary = async (id: string): Promise<void> => {
			setBusy(true);
			await postJson('/plugins/agy-link/pool/primary', { id });
			await refresh();
			setBusy(false);
		};

		const removeAccount = async (id: string): Promise<void> => {
			setBusy(true);
			await postJson('/plugins/agy-link/pool/remove', { id });
			await refresh();
			setBusy(false);
		};

		const refreshQuota = async (id?: string): Promise<void> => {
			setBusy(true);
			await postJson('/plugins/agy-link/pool/refresh-quota', { id });
			await refresh();
			setBusy(false);
		};

		const saveProxy = async (id: string): Promise<void> => {
			setBusy(true);
			const proxyUrl = proxyInputs[id];
			await postJson('/plugins/agy-link/pool/proxy', { id, proxyUrl });
			setEditingProxyId(null);
			await refresh();
			setBusy(false);
		};

		const setMode = async (mode: string): Promise<void> => {
			setBusy(true);
			await postJson('/plugins/agy-link/pool/mode', { mode });
			await refresh();
			setBusy(false);
		};

		const clearCooldown = async (id?: string): Promise<void> => {
			setBusy(true);
			await postJson('/plugins/agy-link/pool/clear-cooldown', { id });
			await refresh();
			setBusy(false);
		};

		const reachable = status !== null;
		const authPhase = status?.auth?.phase ?? 'unknown';
		const isAuthed = authPhase === 'ok';
		const pool = status?.pool;
		const accounts = pool?.accounts ?? [];

		// ---- Render Quota Bar Helper ----
		const renderQuotaBar = (label: string, info?: FamilyQuotaInfo): unknown => {
			const fraction = typeof info?.remainingFraction === 'number' ? info.remainingFraction : null;
			const percent = fraction !== null ? Math.round(fraction * 100) : null;
			const barColor = percent === null ? '#9aa0a6' : percent > 50 ? '#30a46c' : percent > 20 ? '#f5a623' : '#e5484d';
			return h('div', { style: { display: 'flex', alignItems: 'center', fontSize: '11px', margin: '3px 0' } },
				h('span', { style: { width: '65px', color: '#9aa0a6' } }, label + ':'),
				h('div', { style: S.progressBarBg },
					h('div', {
						style: {
							width: percent !== null ? `${Math.min(100, Math.max(0, percent))}%` : '0%',
							height: '100%',
							background: barColor,
							borderRadius: '3px',
						},
					}),
				),
				h('span', { style: { width: '40px', textAlign: 'right', fontWeight: 600, color: barColor } },
					percent !== null ? `${percent}%` : '—',
				),
			);
		};

		// ---- Render Account Cards ----
		const renderedAccountCards = accounts.map((acc: ManagedAccount, idx: number) => {
			const isPrimary = acc.id === pool?.primaryAccountId;
			const hasCooldown = Object.entries(acc.cooldowns).some(([, cd]) => cd && cd.cooldownUntil > Date.now());
			const dotColor = !acc.enabled ? '#9aa0a6' : hasCooldown ? '#f5a623' : '#30a46c';
			const isEditingProxy = editingProxyId === acc.id;

			return h('div', { key: acc.id, style: S.card },
				h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' } },
					h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
						h('span', { style: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: dotColor } }),
						h('span', { style: { fontWeight: 600, fontSize: '13px' } }, `${idx + 1}. ${acc.alias}`),
						acc.email ? h('span', { style: { ...S.muted, fontSize: '11px' } }, `(${acc.email})`) : null,
						isPrimary ? h('span', { style: { background: 'rgba(64,140,255,0.2)', color: '#408cff', padding: '1px 6px', borderRadius: '4px', fontSize: '10px', fontWeight: 600 } }, '⭐ 主用') : null,
					),
					h('div', { style: { display: 'flex', gap: '4px' } },
						h('button', { type: 'button', style: S.btnSm, disabled: busy, onClick: () => void refreshQuota(acc.id) }, '🔄 刷新额度'),
						!isPrimary ? h('button', { type: 'button', style: S.btnSm, disabled: busy, onClick: () => void setPrimary(acc.id) }, '⬆️ 设为主用') : null,
						h('button', { type: 'button', style: S.btnSm, disabled: busy, onClick: () => setEditingProxyId(isEditingProxy ? null : acc.id) }, '⚙️ 代理'),
						h('button', { type: 'button', style: S.btnSm, disabled: busy, onClick: () => void startAuth(acc.id, acc.dir) }, '🔑 重新认证'),
						accounts.length > 1 ? h('button', { type: 'button', style: S.btnDanger, disabled: busy, onClick: () => void removeAccount(acc.id) }, '🗑️ 移除') : null,
					),
				),
				// Quota Progress Bars
				h('div', { style: { background: 'rgba(0,0,0,0.15)', borderRadius: '6px', padding: '6px 10px', margin: '6px 0' } },
					renderQuotaBar('Gemini', acc.quotas.google),
					renderQuotaBar('Claude', acc.quotas.anthropic),
					renderQuotaBar('GPT-OSS', acc.quotas.openai),
					!acc.quotas.google?.remainingFraction && !acc.quotas.anthropic?.remainingFraction && !acc.quotas.openai?.remainingFraction
						? h('div', { style: { ...S.muted, fontSize: '10px', marginTop: '2px' } }, '额度统计不可用 — 凭据存于 macOS 钥匙串，仅 agy CLI 可访问（刷新将静默跳过）')
						: null,
				),
				// Cooldown warning
				hasCooldown ? h('div', { style: { color: '#f5a623', fontSize: '11px', margin: '4px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
					h('span', null, '⚠️ 当前模型家族处于限流冷却中 (Rate-limited, auto-switching...)'),
					h('button', { type: 'button', style: { ...S.btnSm, color: '#f5a623', borderColor: 'rgba(245,166,35,0.4)' }, onClick: () => void clearCooldown(acc.id) }, '⚡ 清除冷却'),
				) : null,
				// Proxy setting editor
				isEditingProxy ? h('div', { style: { ...S.row, marginTop: '6px' } },
					h('input', {
						style: S.input,
						value: proxyInputs[acc.id] !== undefined ? proxyInputs[acc.id] : (acc.proxyUrl ?? ''),
						placeholder: '留空继承环境代理，或填 http://127.0.0.1:7890',
						onChange: (e: { target: { value: string } }) => setProxyInputs({ ...proxyInputs, [acc.id]: e.target.value }),
					}),
					h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: () => void saveProxy(acc.id) }, '保存'),
					h('button', { type: 'button', style: S.btn, onClick: () => setEditingProxyId(null) }, '取消'),
				) : null,
			);
		});

		// ---- OAuth Modal / In-line Flow ----
		let authModalContent: unknown = null;
		if (authPhase === 'pending') {
			authModalContent = h('div', { style: S.authBox },
				h('div', { style: { fontWeight: 600, marginBottom: '6px', fontSize: '13px' } }, '🟡 Google OAuth 登录进行中 (OAuth in progress)'),
				h('div', { style: { ...S.muted, marginBottom: '8px' } }, '1. 点击下方按钮在浏览器中打开 Google 授权页面（需开启代理），或手机扫码：'),
				status?.auth?.url ? h('div', { style: { margin: '8px 0' } },
					h('a', {
						href: status.auth.url,
						target: '_blank',
						rel: 'noopener noreferrer',
						style: {
							display: 'inline-block',
							padding: '8px 14px',
							borderRadius: '6px',
							background: 'rgba(64,140,255,0.2)',
							border: '1px solid rgba(64,140,255,0.6)',
							color: '#408cff',
							textDecoration: 'none',
							fontWeight: 600,
							fontSize: '13px',
						},
					}, '👉 点击在浏览器中打开 Google 授权页面 (Open Auth URL)'),
				) : null,
				status?.auth?.qrDataUrl ? h('div', { style: { textAlign: 'center', margin: '10px 0' } },
					h('img', {
						src: status.auth.qrDataUrl,
						alt: 'auth QR',
						width: 180,
						height: 180,
						style: { display: 'inline-block', borderRadius: '8px', border: '1px solid rgba(128,128,128,0.3)', background: '#fff', padding: '6px' },
					}),
					h('div', { style: { ...S.muted, fontSize: '11px', marginTop: '4px' } }, '扫描二维码完成 Google 账号授权'),
				) : null,
				h('div', { style: { ...S.muted, margin: '8px 0 4px' } }, '2. 完成授权后复制 Google 返回的授权码，粘贴在下方并点击提交激活：'),
				h('div', { style: S.row },
					h('input', {
						style: S.input,
						value: code,
						placeholder: '粘贴 Google 授权码 / Paste authorization code',
						onChange: (e: { target: { value: string } }) => setCode(e.target.value),
					}),
					h('button', { type: 'button', style: S.btnPrimary, disabled: busy || code.trim() === '', onClick: () => void submitCode() }, busy ? '提交中...' : '提交激活 (Submit)'),
					h('button', { type: 'button', style: S.btn, disabled: busy, onClick: () => void cancelAuth() }, '取消 (Cancel)'),
				),
				notice !== '' ? h('div', { style: { marginTop: '6px', color: '#f5a623', fontSize: '12px' } }, notice) : null,
			);
		} else if (authPhase === 'submitting') {
			authModalContent = h('div', { style: S.authBox },
				h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '⏳ 正在验证授权码并激活 agy 凭据...'),
				h('div', { style: S.muted }, '请稍候，完成交换后将自动就绪。'),
			);
		} else if (authPhase === 'failed') {
			authModalContent = h('div', { style: { ...S.authBox, borderColor: 'rgba(229,72,77,0.4)', background: 'rgba(229,72,77,0.08)' } },
				h('div', { style: { fontWeight: 600, color: '#e5484d', marginBottom: '6px' } }, '❌ 登录失败 / 授权码错误'),
				h('div', { style: { ...S.muted, color: '#e5484d', marginBottom: '8px' } }, status?.auth?.message ?? 'authorization code rejected or timeout'),
				h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: () => void startAuth() }, '🔄 重新开始 Google 登录'),
			);
		}

		// ---- Add Account Input Bar ----
		const addAccountBar = addingAccount && authPhase === 'idle'
			? h('div', { style: { ...S.authBox, marginTop: '8px' } },
				h('div', { style: { fontWeight: 600, fontSize: '13px', marginBottom: '6px' } }, '➕ 添加新 Google 账号入池'),
				h('div', { style: S.row },
					h('input', {
						style: S.input,
						value: aliasInput,
						placeholder: '账号别名 (例如: 备用账号 2 / Work Account)',
						onChange: (e: { target: { value: string } }) => setAliasInput(e.target.value),
					}),
					h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: () => void startAddAccount() }, '🚀 生成授权向导'),
					h('button', { type: 'button', style: S.btn, disabled: busy, onClick: () => setAddingAccount(false) }, '取消'),
				),
			)
			: h('div', { style: { margin: '10px 0' } },
				h('button', { type: 'button', style: S.btnPrimary, disabled: busy || authPhase === 'pending', onClick: () => setAddingAccount(true) }, '➕ 添加新 Google 账号 (Add Account)'),
			);

		// General controls (mode / effort)
		const modeRow = h('div', { style: { ...S.row, marginTop: '8px' } },
			h('span', { style: S.muted }, '权限模式:'),
			h('button', { type: 'button', style: status?.permissionMode === 'plan' ? S.btnPrimary : S.btn, onClick: () => void setCfg('permissionMode', 'plan') }, 'plan (安全只读)'),
			h('button', { type: 'button', style: status?.permissionMode === 'accept-edits' ? S.btnPrimary : S.btn, onClick: () => void setCfg('permissionMode', 'accept-edits') }, 'accept-edits'),
			h('button', { type: 'button', style: status?.permissionMode === 'skip' ? { ...S.btn, color: '#e5484d', borderColor: 'rgba(229,72,77,0.6)' } : S.btn, onClick: () => void setCfg('permissionMode', 'skip') }, 'skip (免确认)'),
		);

		const effortRow = h('div', { style: S.row },
			h('span', { style: S.muted }, '思考强度:'),
			h('button', { type: 'button', style: status?.defaultEffort === 'low' ? S.btnPrimary : S.btn, onClick: () => void setCfg('defaultEffort', 'low') }, 'low'),
			h('button', { type: 'button', style: status?.defaultEffort === 'medium' ? S.btnPrimary : S.btn, onClick: () => void setCfg('defaultEffort', 'medium') }, 'medium'),
			h('button', { type: 'button', style: status?.defaultEffort === 'high' ? S.btnPrimary : S.btn, onClick: () => void setCfg('defaultEffort', 'high') }, 'high'),
			h('button', { type: 'button', style: status?.defaultEffort === '' ? S.btnPrimary : S.btn, onClick: () => void setCfg('defaultEffort', '') }, 'auto'),
		);

		const poolHeader = h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '14px 0 8px' } },
			h('div', { style: { fontWeight: 600, fontSize: '13px' } }, `👥 Google 多账号池 (${accounts.length} 个账号)`),
			h('div', { style: { display: 'flex', gap: '6px' } },
				h('button', { type: 'button', style: pool?.mode === 'sequential' ? S.btnPrimary : S.btn, onClick: () => void setMode('sequential') }, '顺次耗尽 (Sequential)'),
				h('button', { type: 'button', style: pool?.mode === 'round-robin' ? S.btnPrimary : S.btn, onClick: () => void setMode('round-robin') }, '轮询均衡 (Round-Robin)'),
				h('button', { type: 'button', style: S.btn, disabled: busy, onClick: () => void refreshQuota() }, '🔄 刷新全部额度'),
			),
		);

		return h('div', { style: { lineHeight: 1.6 } },
			h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, fontSize: '14px' } },
				h('span', { style: { display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', background: isAuthed ? '#30a46c' : '#f5a623' } }),
				'Antigravity (agy CLI) Multi-Account Hub',
			),
			h('div', { style: { ...S.muted, margin: '4px 0 10px' } },
				'多账号池自动隔离凭据。账号 A 额度耗尽时自动无缝顺次切换至账号 B，默认零配置继承本地网络代理。',
			),
			authModalContent,
			poolHeader,
			renderedAccountCards,
			addAccountBar,
			h('div', { style: { borderTop: '1px solid rgba(128,128,128,0.2)', margin: '14px 0', paddingTop: '10px' } },
				h('div', { style: { fontWeight: 600, fontSize: '13px', marginBottom: '8px' } }, '⚙️ 执行与权限参数'),
				modeRow,
				effortRow,
			),
			h('div', { style: { ...S.muted, marginTop: '12px' } }, 'CLI 指令：`/agy pool` 查看配额看板，`/agy add-account` 添加账号，`/agy refresh-quota` 刷新额度。'),
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
		const color = status === null ? '#9aa0a6' : status.dormantReason ? '#f5a623' : hasCooldown ? '#f5a623' : isAuthed ? '#30a46c' : '#f5a623';

		return h('button',
			{
				type: 'button',
				title: `Antigravity Multi-Account: ${accounts.length} pooled accounts`,
				style: {
					background: 'transparent',
					border: '1px solid rgba(128,128,128,0.3)',
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
			h('span', { style: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: color } }),
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
