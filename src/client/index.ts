// dsh-agy-link client half (browser). The DSH Web GUI stays untouched;
// this client adds two surfaces:
//   1. A conversation header pill (`AGY`) so the current session always shows
//      whether the bridge is ready/needs login/dormant.
//   2. A settings.section page under DSH Settings -> Antigravity: bridge
//      status (binary / auth / models / bindings / last run), Google OAuth
//      login (QR + authorization code), and mode/effort quick controls.
// The old sidebar footer button was removed by user request; all of its
// function now lives on the settings page.
// State comes from the host route /plugins/agy-link/status (JSON); QR is a
// host-served PNG at /plugins/agy-link/qr.

import type { Context } from '@deepseek-ai/cordis';

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
		url?: string;
		qrDataUrl?: string;
		startedAt?: number;
		expiresAt?: number;
		message?: string;
	};
	catalog?: { source: string; count: number; lastError: string | null };
	bindings?: number;
	lastRun?: { ok: boolean; code: string; durationMs: number; model: string } | null;
}

const base = win.location?.origin ?? '';

async function getStatus(): Promise<StatusPayload | null> {
	try {
		const res = await win.fetch?.(base + '/plugins/agy-link/status')
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
		})
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
		padding: '4px 10px',
		borderRadius: '6px',
		border: '1px solid rgba(229,72,77,0.5)',
		background: 'rgba(229,72,77,0.15)',
		color: '#e5484d',
		cursor: 'pointer',
		fontSize: '12px',
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
};

export function apply(ctx: ClientContext): void {
	const AgySettingsSection = (): unknown => {
		const [status, setStatus] = useState<StatusPayload | null>(null)
		const [code, setCode] = useState('')
		const [busy, setBusy] = useState(false)
		const [notice, setNotice] = useState('')

		useEffect(() => {
			let alive = true
			const tick = async () => {
				const st = await getStatus()
				if (alive) setStatus(st)
			}
			void tick()
			const timer = setInterval(tick, 2500)
			return () => {
				alive = false
				clearInterval(timer)
			}
		}, [])

		const refresh = async (): Promise<void> => {
			setStatus(await getStatus())
		}

		const startAuth = async (): Promise<void> => {
			setBusy(true)
			setNotice('')
			await postJson('/plugins/agy-link/auth', {})
			await refresh()
			setBusy(false)
		}

		const cancelAuth = async (): Promise<void> => {
			setBusy(true)
			await postJson('/plugins/agy-link/auth-cancel', {})
			await refresh()
			setBusy(false)
		}

		const submitCode = async (): Promise<void> => {
			if (code.trim() === '') return
			setBusy(true)
			await postJson('/plugins/agy-link/auth-code', { code: code.trim() })
			setCode('')
			const st = await getStatus()
			setStatus(st)
			setNotice(st?.auth?.message ?? '')
			setBusy(false)
		}

		const setCfg = async (key: string, value: unknown): Promise<void> => {
			setBusy(true)
			await postJson('/plugins/agy-link/config', { key, value })
			await refresh()
			setBusy(false)
		}

		const reachable = status !== null
		const authPhase = status?.auth?.phase ?? 'unknown'
		const isAuthed = authPhase === 'ok'
		const summary =
			!reachable
				? 'Status endpoint unreachable — the plugin host did not answer /plugins/agy-link/status. Restart the DSH web server and check its logs.'
				: status.dormantReason
					? 'Not ready — ' + status.dormantReason
					: isAuthed
						? 'Ready — agy is connected and authenticated'
						: authPhase === 'pending'
							? 'Google OAuth login in progress — approve in browser or scan QR'
							: 'Needs Google login — click below to start OAuth flow'
		const color =
			!reachable
				? '#e5484d'
				: status.dormantReason
					? '#f5a623'
					: isAuthed
						? '#30a46c'
						: '#f5a623'

		const infoBlock = h(
			'div',
			{ style: { ...S.muted, lineHeight: 1.6, margin: '6px 0 12px' } },
			h('div', null, 'agy binary: ', status?.bin ?? 'not found', status?.version ? ' — v' + status.version : ''),
			h('div', null, 'auth: ', authPhase + (status?.auth?.message ? ' (' + status.auth.message + ')' : '')),
			h('div', null, 'workspace: ', status?.workspaceRoot ? status.workspaceRoot : '(session cwd / process cwd)'),
			h('div', null, 'models: ', String(status?.catalog?.count ?? 0), ' — ', status?.catalog?.source ?? ''),
			h('div', null, 'bindings: ', String(status?.bindings ?? 0)),
			h('div', null, 'last run: ', status?.lastRun ? (status.lastRun.ok ? 'ok' : status.lastRun.code) + ' — ' + status.lastRun.model : 'none'),
		)

		const modeRow = h(
			'div',
			{ style: { ...S.row, marginTop: '8px' } },
			h('span', { style: S.muted }, 'mode:'),
			h('button', { type: 'button', style: status?.permissionMode === 'plan' ? S.btnPrimary : S.btn, onClick: () => void setCfg('permissionMode', 'plan') }, 'plan'),
			h('button', { type: 'button', style: status?.permissionMode === 'accept-edits' ? S.btnPrimary : S.btn, onClick: () => void setCfg('permissionMode', 'accept-edits') }, 'accept-edits'),
			h('button', { type: 'button', style: status?.permissionMode === 'skip' ? { ...S.btn, color: '#e5484d', borderColor: 'rgba(229,72,77,0.6)' } : S.btn, onClick: () => void setCfg('permissionMode', 'skip') }, 'skip'),
		)

		const effortRow = h(
			'div',
			{ style: S.row },
			h('span', { style: S.muted }, 'effort:'),
			h('button', { type: 'button', style: status?.defaultEffort === 'low' ? S.btnPrimary : S.btn, onClick: () => void setCfg('defaultEffort', 'low') }, 'low'),
			h('button', { type: 'button', style: status?.defaultEffort === 'medium' ? S.btnPrimary : S.btn, onClick: () => void setCfg('defaultEffort', 'medium') }, 'medium'),
			h('button', { type: 'button', style: status?.defaultEffort === 'high' ? S.btnPrimary : S.btn, onClick: () => void setCfg('defaultEffort', 'high') }, 'high'),
			h('button', { type: 'button', style: status?.defaultEffort === '' ? S.btnPrimary : S.btn, onClick: () => void setCfg('defaultEffort', '') }, 'auto'),
		)

		const skipWarn = h(
			'div',
			{ style: { ...S.muted, marginBottom: '8px' } },
			'skip runs agy tools with --dangerously-skip-permissions (no approval prompts). plan is the safe read-only default.',
		)

		const reAuthRow = h(
			'div',
			{ style: { marginTop: '10px' } },
			h('button', { type: 'button', style: S.btn, disabled: busy, onClick: () => void startAuth() }, '🔄 重新登录 Google 账号 (Re-authenticate)'),
		)

		// ---- Auth state machine rendering ----
		let authContent: unknown = null
		if (authPhase === 'pending') {
			authContent = h(
				'div',
				{ style: S.authBox },
				h('div', { style: { fontWeight: 600, marginBottom: '6px', fontSize: '13px' } }, '🟡 Google OAuth 登录进行中 (Login in progress)'),
				h('div', { style: { ...S.muted, marginBottom: '8px' } }, '1. 点击下方按钮在浏览器中打开 Google 授权页面（需开启代理），或手机扫码：'),
				status?.auth?.url
					? h('div', { style: { margin: '8px 0' } },
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
					)
					: null,
				(status?.auth?.qrDataUrl || status?.auth?.url)
					? h('div', { style: { textAlign: 'center', margin: '10px 0' } },
						h('img', {
							src: status.auth.qrDataUrl ?? (base + '/plugins/agy-link/qr'),
							alt: 'auth QR',
							width: 180,
							height: 180,
							style: { display: 'inline-block', borderRadius: '8px', border: '1px solid rgba(128,128,128,0.3)', background: '#fff', padding: '6px' },
						}),
						h('div', { style: { ...S.muted, fontSize: '11px', marginTop: '4px' } }, '扫描二维码完成 Google 账号授权'),
					)
					: null,
				h('div', { style: { ...S.muted, margin: '8px 0 4px' } }, '2. 完成授权后复制 Google 返回的授权码，粘贴在下方并点击提交激活：'),
				h(
					'div',
					{ style: S.row },
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
			)
		} else if (authPhase === 'submitting') {
			authContent = h(
				'div',
				{ style: S.authBox },
				h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '⏳ 正在验证授权码并激活 agy 凭据...'),
				h('div', { style: S.muted }, '请稍候，完成交换后将自动就绪。'),
			)
		} else if (authPhase === 'failed') {
			authContent = h(
				'div',
				{ style: { ...S.authBox, borderColor: 'rgba(229,72,77,0.4)', background: 'rgba(229,72,77,0.08)' } },
				h('div', { style: { fontWeight: 600, color: '#e5484d', marginBottom: '6px' } }, '❌ 登录失败 / 授权码错误'),
				h('div', { style: { ...S.muted, color: '#e5484d', marginBottom: '8px' } }, status?.auth?.message ?? 'authorization code rejected or timeout'),
				h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: () => void startAuth() }, '🔄 重新开始 Google 登录'),
			)
		} else if (!isAuthed) {
			authContent = h(
				'div',
				{ style: S.authBox },
				h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, 'Google login required (需要登录 Google 账号)'),
				h('div', { style: { ...S.muted, marginBottom: '10px' } }, 'agy 当前未登录。点击下方按钮开始 Google OAuth 授权流程，通过浏览器授权或扫码激活：'),
				h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: () => void startAuth() }, '🚀 开始 Google OAuth 登录 (Start Google Login)'),
			)
		}

		const controls =
			!reachable
				? null
				: status.dormantReason
					? h('div', { style: S.muted }, 'Bridge dormant: ', status.dormantReason)
					: isAuthed
						? h('div', null, infoBlock, modeRow, effortRow, skipWarn, reAuthRow)
						: authContent

		return h('div', { style: { lineHeight: 1.6 } },
			h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, fontSize: '14px' } },
				h('span', { style: { display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', background: color } }),
				'Antigravity (agy CLI)'),
			h('div', { style: { ...S.muted, margin: '6px 0 12px' } }, summary),
			controls,
			h('div', { style: { ...S.muted, marginTop: '12px' } }, 'Run `/agy status` for full diagnostics, `/agy doctor` to export a report.'),
		)
	}

	const AgySessionStatus = (): unknown => {
		const [status, setStatus] = useState<StatusPayload | null>(null)
		useEffect(() => {
			let alive = true
			const tick = async () => {
				const st = await getStatus()
				if (alive) setStatus(st)
			}
			void tick()
			const timer = setInterval(tick, 3000)
			return () => {
				alive = false
				clearInterval(timer)
			}
		}, [])
		const color =
			status === null
				? '#9aa0a6'
				: status.dormantReason
					? '#f5a623'
					: status.auth?.phase === 'ok'
						? '#30a46c'
						: '#f5a623'
		const title =
			status === null
				? 'Antigravity (agy) status…'
				: status.dormantReason
					? 'Antigravity not ready: ' + status.dormantReason
					: status.auth?.phase === 'ok'
						? 'Antigravity ready — agy is connected'
						: 'Antigravity needs Google login'
		return h('button',
			{
				type: 'button',
				title,
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
			'AGY',
		)
	}

	ctx.slots.inject('conversation.session.header.actions', () => {
		const dispose = ctx.slots.register(
			{
				name: 'conversation.session.header.actions',
				id: 'agy-link-status',
				order: 10,
				label: 'Antigravity',
			},
			AgySessionStatus,
		)
		return dispose
	})

	ctx.slots.inject('settings.section', () => {
		const dispose = ctx.slots.register(
			{
				name: 'settings.section',
				id: 'agy-link',
				order: 20,
				label: 'Antigravity',
			},
			AgySettingsSection,
		)
		return dispose
	})
}
