// dsh-agy-link client half (browser). The DSH Web GUI stays untouched;
// this client adds one surface — a sidebar footer action whose popover is a
// small state machine over (dormant / needs-auth / ok):
//   dormant      -> install guidance for the agy CLI
//   needs-auth   -> Google login: QR + consent URL + code paste box
//   ok           -> mode/effort quick controls and live bridge status
// State comes from the host route /plugins/agy-link/status (JSON); QR is a
// host-served PNG at /plugins/agy-link/qr. The popover renders through a
// React portal to document.body so peer footer-slot plugins can never
// displace it (dsh-lark-link GH issue #3 lesson).

import type { Context } from '@deepseek-ai/cordis';

type ReactApi = {
	createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
	useState: <S>(initial: S) => [S, (next: S | ((prev: S) => S)) => void];
	useEffect: (setup: () => (() => void) | void, deps?: unknown[]) => void;
};
const R = require('react') as ReactApi;
const { createElement: h, useState, useEffect } = R;
const reactDom = require('react-dom') as {
	createPortal?: (node: unknown, container: unknown) => unknown;
};

const win = globalThis as unknown as {
	location?: { origin?: string };
	fetch?: (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
	document?: { body?: unknown } | null;
};
const bodyEl = win.document?.body;
const portalToBody =
	bodyEl != null && reactDom.createPortal
		? (node: unknown) => reactDom.createPortal!(node, bodyEl)
		: (node: unknown) => node;

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
	defaultModel?: string;
	defaultEffort?: string;
	auth?: { phase: string; url?: string; message?: string };
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
		padding: '6px 12px',
		borderRadius: '6px',
		border: '1px solid rgba(64,140,255,0.6)',
		background: 'rgba(64,140,255,0.25)',
		color: 'inherit',
		cursor: 'pointer',
		fontSize: '13px',
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
};

export function apply(ctx: ClientContext): void {
	const AgyPanel = (): unknown => {
		const [open, setOpen] = useState(false)
		const [status, setStatus] = useState<StatusPayload | null>(null)
		const [code, setCode] = useState('')
		const [busy, setBusy] = useState(false)
		const [notice, setNotice] = useState('')

		useEffect(() => {
			if (!open) return
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
		}, [open])

		const dot =
			status === null
				? '#9aa0a6'
				: status.dormantReason
					? '#f5a623'
					: status.auth?.phase === 'pending' || status.auth?.phase === 'failed' || status.auth?.phase === 'submitting'
						? '#f5a623'
						: status.lastRun && !status.lastRun.ok
							? '#e5484d'
							: '#30a46c'

		const startAuth = async (): Promise<void> => {
			setBusy(true)
			setNotice('')
			await postJson('/plugins/agy-link/auth', {})
			const st = await getStatus()
			setStatus(st)
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
			const st = await getStatus()
			setStatus(st)
			setBusy(false)
		}

		const badge = h(
			'button',
			{
				type: 'button',
				onClick: () => setOpen(!open),
				style: { background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 6px', fontSize: '14px', lineHeight: 1 },
				title: 'Antigravity (agy) bridge',
			},
			h('span', { style: { display: 'inline-block', width: '9px', height: '9px', borderRadius: '50%', background: dot } }),
		)

		if (!open) return badge

		const needsAuth =
			status !== null &&
			!status.dormantReason &&
			status.auth !== undefined &&
			status.auth.phase !== 'ok'

		const dormantLine = h('div', null, 'Bridge dormant: ', status?.dormantReason ?? '')

		const infoBlock = h(
			'div',
			{ style: { ...S.muted, lineHeight: 1.5 } },
			h('div', null, 'agy: ', status?.bin ?? 'not found', ' — v', status?.version ?? '?'),
			h('div', null, 'auth: ', status?.auth?.phase ?? 'unknown'),
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
			{ style: S.muted },
			'skip runs agy tools with --dangerously-skip-permissions (no approval prompts). plan is the safe read-only default.',
		)

		const authBlock = h(
			'div',
			null,
			h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, 'Google login required'),
			h('div', null, 'agy is not signed in. Start the login flow, scan the QR or open the URL, then paste the authorization code below.'),
			h('img', { src: base + '/plugins/agy-link/qr', alt: 'auth QR', width: 200, height: 200, style: { display: 'block', margin: '8px auto' } }),
			h('div', { style: { wordBreak: 'break-all' } }, status?.auth?.url ?? ''),
			h(
				'div',
				{ style: S.row },
				h('input', { style: S.input, value: code, placeholder: 'authorization code', onChange: (e: { target: { value: string } }) => setCode(e.target.value) }),
				h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: () => void submitCode() }, 'Submit code'),
				h('button', { type: 'button', style: S.btn, disabled: busy, onClick: () => void startAuth() }, 'Restart login'),
			),
			notice !== '' ? h('div', null, notice) : null,
		)

		const body = status?.dormantReason
			? dormantLine
			: needsAuth
				? authBlock
				: h('div', null, infoBlock, modeRow, effortRow, skipWarn)

		const header = h(
			'div',
			{ style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } },
			h('span', { style: { fontWeight: 600, fontSize: '13px' } }, 'Antigravity bridge'),
			h('button', { type: 'button', style: S.btn, onClick: () => setOpen(false) }, 'close'),
		)

		const popover = h(
			'div',
			{
				style: {
					position: 'fixed',
					bottom: '56px',
					left: '16px',
					width: '300px',
					maxHeight: '70vh',
					overflowY: 'auto',
					padding: '12px 14px',
					borderRadius: '10px',
					border: '1px solid rgba(128,128,128,0.35)',
					background: 'rgba(28,28,32,0.98)',
					boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
					zIndex: 1000,
				},
			},
			header,
			body,
		)

		return h('div', { style: { display: 'contents' } }, badge, portalToBody(popover))
	}

	ctx.slots.inject('sidebar.footer.action', () => {
		const dispose = ctx.slots.register(
			{
				name: 'ui-sidebar',
				id: 'agy-link',
				order: 30,
				label: 'Antigravity',
			},
			AgyPanel,
		)
		return dispose
	})
}
