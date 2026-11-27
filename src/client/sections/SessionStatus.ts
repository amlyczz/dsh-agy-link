// Session header badge: shows the account serving THIS conversation's model
// family, opens the console modal, and (on exactly one mounted header) hosts
// the modal portal. The header is a READOUT, not a picker.
//
// The readout is FAMILY-scoped. Account selection routes per family (an Argon
// turn runs on the Argon-eligible account even when the `google` pointer names
// another one, and Argon bills its own weekly book), so resolving `google`
// unconditionally here made an Argon session announce a different account's
// Gemini percentage — contradicting both the composer's model and the console's
// Argon row (reported 2026-11-23). `/session-view` supplies the resolved model
// of this conversation; the console and the badge now agree by construction.
import {
	isAccountCriticalAuth,
	isAccountFullyCooling,
	isFamilyCooling,
} from '../../common/quota-bench.ts';
import type { AccountPoolData, ManagedAccount, ModelFamily } from '../../common/pool-types.ts';
import type { SessionQuotaWindow, SessionView } from '../../common/session-view.ts';
import { agyIcon } from '../icons.ts';
import { h, useEffect, useRef, useState } from '../react.ts';
import { useSessionView } from '../session-view.ts';
import { isUiVisible, useAgyStatus } from '../status.ts';
import { Button } from '../ui/Button.ts';
import { SubagentControl } from './SubagentPanel.ts';
import { OrchestrationButton } from './OrchestrationButton.ts';
import { accountDisplayAlias, type AliasTranslator } from './account-alias.ts';
import { agyModalStore, modalHostManager, Modal, portalToBody } from '../ui/Modal.ts';
import { useAgyTranslation, type LocaleLike } from '../hooks/useTranslation.ts';

export type SettingsSectionComponent = (props?: { isModal?: boolean; onClose?: () => void }) => unknown;

/** How the badge's account was established (drives the "in use" wording). */
export type BadgeSource = 'session' | 'predicted' | 'legacy' | 'none'

export interface BadgeReadout {
  account: ManagedAccount | undefined
  accountId: string | null
  percent: number | null
  /** Which quota window `percent` describes. */
  window: SessionQuotaWindow
  family: ModelFamily | null
  model: string
  source: BadgeSource
  eligible: boolean
  cooling: boolean
  stale: boolean
}

/** Brand names used by the console's per-family rows, so both agree verbatim. */
const FAMILY_LABEL: Record<string, string> = {
  google: 'Gemini',
  argon: 'Argon',
  anthropic: 'Claude',
  openai: 'GPT-OSS',
};

/**
 * Decide what the badge may claim.
 *
 * With a session view, the answer is exactly that view (family-correct). A
 * conversation whose view has not answered yet claims NOTHING — no alias, no
 * percentage — instead of falling back to another family's pointer. Only a
 * caller with no session context at all (settings preview, older host) falls
 * back to the `google` readout, which is what this badge showed historically.
 */
export function resolveBadgeReadout(input: {
  pool?: AccountPoolData | undefined
  accounts: readonly ManagedAccount[]
  view: SessionView | null
  sessionScoped: boolean
  now: number
}): BadgeReadout {
  const { pool, accounts, view, sessionScoped, now } = input
  if (view !== null) {
    const account = view.accountId === null ? undefined : accounts.find((a) => a.id === view.accountId)
    return {
      account,
      accountId: view.accountId,
      percent: view.percent,
      window: view.window,
      family: view.family,
      model: view.model,
      source: view.source,
      eligible: view.eligible,
      cooling: view.cooling,
      stale: view.stale,
    }
  }
  const empty: BadgeReadout = {
    account: undefined,
    accountId: null,
    percent: null,
    window: 'none',
    family: null,
    model: '',
    source: 'none',
    eligible: false,
    cooling: false,
    stale: false,
  }
  if (sessionScoped) return empty
  const rawId = pool?.activeAccountId ?? pool?.lastActiveAccountId ?? pool?.activeAccountIds?.google ?? pool?.primaryAccountId
  const account = rawId === undefined ? undefined : accounts.find((a) => a.id === rawId)
  if (account === undefined) return empty
  const gFrac = account.quotas?.google?.remainingFraction
  return {
    account,
    accountId: account.id,
    percent: typeof gFrac === 'number' && Number.isFinite(gFrac)
      ? Math.max(0, Math.min(100, Math.round(gFrac * 100)))
      : null,
    window: 'five-hour',
    family: 'google',
    model: '',
    source: 'legacy',
    eligible: account.enabled === true && !isAccountCriticalAuth(account),
    cooling: isFamilyCooling(account, 'google', now),
    stale: false,
  }
}

type StatusTranslator = ReturnType<typeof useAgyTranslation>;

const closeConsoleModal = (): void => {
	agyModalStore.setOpen(false);
};

function HeaderBadge({ hostId, sessionId, t }: { hostId: string; sessionId: string; t: StatusTranslator }): unknown {
	const { status } = useAgyStatus();
	const view = useSessionView(sessionId);
	// Wall-clock tick: cooldown dots derive from Date.now() and the payload
	// does not change when a cooldown lapses.
	const [, setTimeTick] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => setTimeTick((n) => n + 1), 30_000);
		return () => clearInterval(timer);
	}, []);

	if (!isUiVisible(status, 'showHeaderBadge')) {
		return null;
	}

	const pool = status?.pool;
	// Live agy-internal subagents for THIS session (injected by the header slot).
	const subSessions = (status as unknown as { subagents?: Array<{ session: string; total: number; running: number; items: Array<{ role: string; lastAction: string; running: boolean }> }> })?.subagents ?? [];
	const mySubs = sessionId !== '' ? subSessions.find((s) => s.session === sessionId) : undefined;
	const subItems = mySubs?.items ?? [];
	const accounts = pool?.accounts ?? [];
	const now = Date.now();
	const readout = resolveBadgeReadout({ pool, accounts, view, sessionScoped: sessionId !== '', now });
	const activeAcc = readout.account;
	const activeAuthRequired = activeAcc ? isAccountCriticalAuth(activeAcc) : false;
	const allInCooldown = accounts.length > 0 && accounts.every((a) =>
		!a.enabled || isAccountCriticalAuth(a) || isAccountFullyCooling(a, now)
	);
	const isAuthed = status?.auth?.phase === 'ok' || accounts.length > 0;
	const color = status === null ? '#64748b' : status.dormantReason ? '#f59e0b' : allInCooldown ? '#f59e0b' : activeAuthRequired ? '#ef4444' : readout.cooling ? '#f59e0b' : isAuthed ? '#10b981' : '#f59e0b';

	const displayAlias = accountDisplayAlias(t as unknown as AliasTranslator, activeAcc, activeAcc ? accounts.indexOf(activeAcc) : -1);
	const activePct = readout.percent;
	// A percentage is only printed when it comes from the family in use (or,
	// with no session context, from an eligible google account).
	const showPct = activePct !== null && (view !== null || readout.eligible);
	const inUseLabel = readout.source === 'predicted' ? t('account.predictedInUse') : t('status.inUse');
	const windowLabel = readout.window === 'weekly' ? t('quota.weekly') : readout.window === 'five-hour' ? t('quota.fiveHour') : '';
	const detail = activeAcc !== undefined && readout.eligible
		? ` · ${inUseLabel}: ${displayAlias}${activeAcc.email ? ` (${activeAcc.email})` : ''}${showPct ? ` · ${windowLabel} ${activePct}%` : ''}${readout.stale ? ` · ${t('header.quotaStale')}` : ''}${readout.model ? ` · ${t('header.model')}: ${readout.model}` : ''}`
		: readout.family !== null && readout.accountId === null
			? ` · ${t('header.familyNoAccount', { family: FAMILY_LABEL[readout.family] ?? readout.family })}`
			: '';
	const badgeTitle = status === null
		? t('header.badgeLoading')
		: `${t('header.badgeTitle', { count: accounts.length })}${detail}`;
	const buttonLabel = status === null
		? 'AGY'
		: displayAlias ? `AGY · ${displayAlias}` : `AGY (${accounts.length})`;
	const pctColor = activePct === null ? undefined : readout.stale ? 'var(--agy-text-secondary)' : activePct <= 20 ? '#ef4444' : activePct <= 50 ? '#f59e0b' : '#10b981';

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
		showPct
			? h('span', { className: 'agy-session-status-label', style: { color: pctColor, fontWeight: 700, fontSize: '10.5px' } }, `${activePct}%`)
			: null,
	);
	return h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
		badge,
		h(OrchestrationButton, { t, sessionId }),
		h(SubagentControl, { t, items: subItems }),
	);
}

export function createSessionStatus(locale: LocaleLike, SettingsSection: SettingsSectionComponent): () => unknown {
	return function AgySessionStatus(props?: { sessionId?: string }): unknown {
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
		const sessionId = props?.sessionId ?? '';
		// Keep ConsoleDialog outside HeaderBadge's 1.5s session-view and 30s clock
		// subscriptions so polling the header never re-renders the open console.
		const modalPortal = isPrimaryHost && isModalOpen ? portalToBody(h(ConsoleDialog, { t, SettingsSection })) : null;
		return h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
			h(HeaderBadge, { hostId, sessionId, t }),
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
		onClose: closeConsoleModal,
		children: h(SettingsSection, { isModal: true, onClose: closeConsoleModal }),
	});
}