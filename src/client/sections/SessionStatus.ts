// Session header badge: shows the scheduled active account, opens the console
// modal, and (on exactly one mounted header) hosts the modal portal. The header
// is a READOUT, not a picker — it displays exactly the server-scheduled account.

import {
	isAccountCriticalAuth,
	isAccountFullyCooling,
	isFamilyCooling,
} from '../../common/quota-bench.ts';
import { agyIcon } from '../icons.ts';
import { h, useEffect, useRef, useState } from '../react.ts';
import { isUiVisible, useAgyStatus } from '../status.ts';
import { Button } from '../ui/Button.ts';
import { agyModalStore, modalHostManager, Modal, portalToBody } from '../ui/Modal.ts';
import { useAgyTranslation, type LocaleLike } from '../hooks/useTranslation.ts';

export type SettingsSectionComponent = (props?: { isModal?: boolean; onClose?: () => void }) => unknown;

export function createSessionStatus(locale: LocaleLike, SettingsSection: SettingsSectionComponent): () => unknown {
	return function AgySessionStatus(): unknown {
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

		const t = useAgyTranslation(locale);
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
		const rawActiveId = pool?.resolvedActiveAccountIds?.google ?? pool?.activeAccountId ?? pool?.lastActiveAccountId ?? pool?.activeAccountIds?.google ?? pool?.primaryAccountId;
		// Display EXACTLY the server-scheduled account — same semantics as the
		// console's per-family "当前使用" badge.
		const activeAcc = rawActiveId !== undefined ? accounts.find((a) => a.id === rawActiveId) : undefined;
		const now = Date.now();
		const activeAuthRequired = activeAcc ? isAccountCriticalAuth(activeAcc) : false;
		const activeHasCooldown = activeAcc ? isFamilyCooling(activeAcc, 'google', now) : false;
		const allInCooldown = accounts.length > 0 && accounts.every((a) =>
			!a.enabled || isAccountCriticalAuth(a) || isAccountFullyCooling(a, now)
		);
		const isAuthed = status?.auth?.phase === 'ok' || accounts.length > 0;
		const color = status === null ? '#64748b' : status.dormantReason ? '#f59e0b' : allInCooldown ? '#f59e0b' : activeAuthRequired ? '#ef4444' : activeHasCooldown ? '#f59e0b' : isAuthed ? '#10b981' : '#f59e0b';

		const legacyDefault = activeAcc && activeAcc.defaultAlias === undefined && activeAcc.systemHome && activeAcc.alias === '主账号 (系统登录)';
		const displayAlias = activeAcc ? (activeAcc.defaultAlias || legacyDefault
			? activeAcc.systemHome ? t('account.defaultAlias') : t('account.aliasDefault', { number: accounts.indexOf(activeAcc) + 1 })
			: activeAcc.alias) : '';
		const gFrac = activeAcc?.quotas?.google?.remainingFraction;
		const activePct = typeof gFrac === 'number' && Number.isFinite(gFrac)
			? Math.max(0, Math.min(100, Math.round(gFrac * 100)))
			: null;
		// Only an ELIGIBLE account may be announced as "in use".
		const activeEligible = activeAcc !== undefined && activeAcc.enabled && !activeAuthRequired;
		const activeDetail = activeAcc !== undefined && activeEligible
			? ` · ${t('status.inUse')}: ${displayAlias}${activeAcc.email ? ` (${activeAcc.email})` : ''}${activePct !== null ? ` · ${activePct}%` : ''}`
			: '';
		const badgeTitle = status === null
			? t('header.badgeLoading')
			: `${t('header.badgeTitle', { count: accounts.length })}${activeDetail}`;
		const buttonLabel = status === null
			? 'AGY'
			: displayAlias ? `AGY · ${displayAlias}` : `AGY (${accounts.length})`;
		const pctColor = activePct === null ? undefined : activePct <= 20 ? '#ef4444' : activePct <= 50 ? '#f59e0b' : '#10b981';

		const badge = h(Button,
			{
				variant: 'pill',
				title: badgeTitle,
				className: 'agy-btn agy-session-status-btn',
				onClick: () => {
					modalHostManager.claim(hostId);
					agyModalStore.setOpen(true);
				},
			},
			h('span', { style: { display: 'inline-block', width: '7px', height: '7px', borderRadius: '50%', background: color, flexShrink: 0 } }),
			h('span', { className: 'agy-session-status-label' }, buttonLabel),
			activePct !== null && activeEligible
				? h('span', { className: 'agy-session-status-label', style: { color: pctColor, fontWeight: 700, fontSize: '10.5px' } }, `${activePct}%`)
				: null,
		);
		const modalPortal = isPrimaryHost && isModalOpen ? portalToBody(h(ConsoleDialog, { t, SettingsSection })) : null;
		if (!isUiVisible(status, 'showHeaderBadge')) {
			return modalPortal;
		}
		return h('div', { style: { display: 'inline-block' } },
			badge,
			modalPortal,
		);
	};
}

function ConsoleDialog({ t, SettingsSection }: { t: (key: any, params?: Record<string, unknown>) => string; SettingsSection: SettingsSectionComponent }): unknown {
	return h(Modal, {
		heading: h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
			agyIcon(18),
			h('strong', { id: 'agy-console-title', style: { fontSize: '14.5px', fontWeight: 700, color: 'var(--agy-text-primary)' } }, t('console.title')),
		),
		closeLabel: t('console.close'),
		ariaLabelledby: 'agy-console-title',
		onClose: () => agyModalStore.setOpen(false),
		children: h(SettingsSection, { isModal: true, onClose: () => agyModalStore.setOpen(false) }),
	});
}
