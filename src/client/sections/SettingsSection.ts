// Antigravity settings console: header, OAuth form, and tabbed module router.

import { win, WRITE_TIMEOUT_MS } from '../api.ts';
import type { AccountPoolData } from '../../common/pool-types.ts';
import type { QuotaFamily } from '../../common/quota-bench.ts';
import { type EffortLabels } from '../config-options.ts';
import { effortLabel } from '../../common/reasoning.ts';
import { useAgyTranslation, type LocaleLike, type Translator } from '../hooks/useTranslation.ts';
import { useAccounts } from '../hooks/useAccounts.ts';
import { useAuthFlow } from '../hooks/useAuthFlow.ts';
import { useConfig } from '../hooks/useConfig.ts';
import { agyIcon, uiIcon } from '../icons.ts';
import { h, useEffect, useRef, useState } from '../react.ts';
import { acquireOverlaySuspend } from '../scroll-guard.ts';
import { useAgyStatus } from '../status.ts';
import { S } from '../styles.ts';
import { Button } from '../ui/Button.ts';
import { Spinner } from '../ui/Spinner.ts';
import { Toast, type ToastNotice, type ToastType } from '../ui/Toast.ts';
import { renderConsoleTabContent, type ConsoleTabId } from './ConsoleTabs.ts';
import { IMAGE_CLI_SAMPLE } from './ImageSettingsRows.ts';

let rememberedConsoleTab: ConsoleTabId = 'accounts';

export function resetConsoleTabForTest(): void {
	rememberedConsoleTab = 'accounts';
}

/** Bound any action busy flag so a stalled fetch never leaves a spinner stuck. */
function useBusyAction(): [string | null, (value: string | null) => void] {
	const [loadingAction, setLoadingAction] = useState<string | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const set = (value: string | null): void => {
		setLoadingAction(value);
		if (timerRef.current !== null) clearTimeout(timerRef.current);
		timerRef.current = value === null ? null : setTimeout(() => {
			timerRef.current = null;
			setLoadingAction(null);
		}, BUSY_TIMEOUT_MS);
	};
	useEffect(() => () => {
		if (timerRef.current !== null) clearTimeout(timerRef.current);
	}, []);
	return [loadingAction, set];
}

/** Slightly longer than a bounded write, so a normal failure still shows its own toast. */
const BUSY_TIMEOUT_MS = WRITE_TIMEOUT_MS + 5_000;

function useConsoleToast(): {
	toast: ToastNotice | null;
	clearToast: () => void;
	showToast: (text: string, type?: ToastType) => void;
} {
	const [toast, setToast] = useState<ToastNotice | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => () => {
		// Unmount must not leave a pending timer writing state into a dead
		// component; a second same-text toast also used to be cleared early
		// by the FIRST toast's leftover timer.
		if (timerRef.current !== null) clearTimeout(timerRef.current);
	}, []);
	const showToast = (text: string, type: ToastType = 'info') => {
		setToast({ text, type, id: Date.now() });
		if (timerRef.current !== null) clearTimeout(timerRef.current);
		timerRef.current = setTimeout(() => {
			timerRef.current = null;
			setToast((prev) => (prev !== null && prev.text === text ? null : prev));
		}, 6000);
	};
	return { toast, clearToast: () => setToast(null), showToast };
}

export interface SettingsSectionProps {
	isModal?: boolean;
	onClose?: () => void;
}

export function createSettingsSection(locale: LocaleLike): (props?: SettingsSectionProps) => unknown {
	return function AgySettingsSection(_props?: SettingsSectionProps): unknown {
		const t = useAgyTranslation(locale);
		const { status, refresh } = useAgyStatus();
		const { toast, clearToast, showToast } = useConsoleToast();

		const [loadingAction, setLoadingAction] = useBusyAction();
		const [proxyInputs, setProxyInputs] = useState<Record<string, string>>({});
		const [editingProxyId, setEditingProxyId] = useState<string | null>(null);
		const [aliasInputs, setAliasInputs] = useState<Record<string, string>>({});
		const [editingAliasId, setEditingAliasId] = useState<string | null>(null);
		const [expandedModels, setExpandedModels] = useState<Record<string, boolean>>({});
		const [optimisticActiveByFamily, setOptimisticActiveByFamily] = useState<Partial<Record<QuotaFamily, string>>>({});
		const [activeTab, setActiveTabState] = useState<ConsoleTabId>(() => rememberedConsoleTab);

		const selectTab = (tab: ConsoleTabId): void => {
			rememberedConsoleTab = tab;
			setActiveTabState(tab);
		};

		useEffect(() => acquireOverlaySuspend(), []);

		// Cooldown expiry and quota countdowns are Date.now()-derived while the
		// payload itself does NOT change when they lapse — tick every 30s.
		const [, setTimeTick] = useState(0);
		useEffect(() => {
			const timer = setInterval(() => setTimeTick((n) => n + 1), 30_000);
			(timer as unknown as { unref?: () => void })?.unref?.();
			return () => clearInterval(timer);
		}, []);

		const auth = useAuthFlow({ status, refresh, showToast, setLoadingAction, t });
		const config = useConfig({ status, refresh, showToast, setLoadingAction, t });
		const accountActions = useAccounts({
			status, refresh, showToast, setLoadingAction, t,
			proxyInputs, setEditingProxyId, aliasInputs, setEditingAliasId, setOptimisticActiveByFamily,
		});

		const copyImageCommand = (): void => {
			const clip = win.navigator?.clipboard;
			if (clip?.writeText === undefined) {
				showToast(t('config.imageCopyFailed'), 'warn');
				return;
			}
			void clip.writeText(IMAGE_CLI_SAMPLE)
				.then(() => showToast(t('config.imageCopied'), 'success'))
				.catch(() => showToast(t('config.imageCopyFailed'), 'warn'));
		};

		const toggleExpand = (accId: string) => setExpandedModels((prev) => ({ ...prev, [accId]: !prev[accId] }));
		const authPhase = status?.auth?.phase ?? 'unknown';
		const pool = status?.pool;
		const catalogModels = status?.catalogModels ?? [];
		const accounts = pool?.accounts ?? [];

		if (status === null) {
			return h('div', { style: { ...S.container!, minHeight: '120px', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
				h('span', { style: S.muted }, Spinner(), t('status.loading')),
			);
		}

		return h('div', { className: 'agy-console', style: S.container },
			renderHeader(t, authPhase === 'ok' || accounts.length > 0, auth.addingAccount, loadingAction !== null,
				loadingAction === 'warmup:all' || status.warmupState?.running === true,
				loadingAction === 'refresh:all' || (status.quotaRefreshing?.length ?? 0) > 0,
				{
					onAdd: () => { selectTab('accounts'); auth.setAddingAccount(true); },
					onWarmupAll: () => void accountActions.warmupAccount(),
					onRefreshAll: () => void accountActions.refreshQuota(),
				},
			),
			h(Toast, { toast, onClose: clearToast, t }),
			renderConsoleTabContent({
				t, activeTab, onSelectTab: selectTab, status, pool, accounts,
				accountModels: status.accountModels, catalogModels,
				hiddenModelSet: new Set(status.hiddenModels ?? []),
				selectedModelSet: new Set(status.selectedModels ?? []),
				loadingAction, effortLabels: effortLabels(t),
				addAccountSection: renderAddAccountSection(t, auth, pool, loadingAction !== null, loadingAction),
				proxyInputs, setProxyInputs, editingProxyId, setEditingProxyId,
				aliasInputs, setAliasInputs, editingAliasId, setEditingAliasId,
				expandedModels, toggleExpand, optimisticActiveByFamily,
				accountHandlers: { ...accountActions, beginReauth: auth.handleBeginReauth },
				setCfg: config.setCfg, setMode: config.setMode, setSelectedModels: config.setSelectedModels,
				setHiddenModels: (ids: ReadonlyArray<string>) => config.setCfg('hiddenModels', [...ids]),
				copyImageCommand, showToast,
			}),
		);
	};
}

function renderHeader(
	t: Translator,
	isAuthed: boolean,
	addingAccount: boolean,
	isBusy: boolean,
	isWarmupAllBusy: boolean,
	isRefreshAllBusy: boolean,
	actions: { onAdd: () => void; onWarmupAll: () => void; onRefreshAll: () => void },
): unknown {
	return h('div', { style: S.headerCard },
		h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
			agyIcon(18),
			h('span', { style: { fontWeight: 700, fontSize: '14px', color: 'var(--agy-text-primary)' } }, 'Antigravity'),
			h('span', { style: isAuthed ? S.badgeReady : S.badgeUnready }, isAuthed ? t('status.ready') : t('status.needsAuth')),
		),
		h('div', { className: 'agy-header-actions', style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', maxWidth: '100%' } },
			!addingAccount ? h(Button, {
				variant: 'primary', size: 'sm', className: 'agy-btn',
				style: { gap: '4px', height: '24px', padding: '2px 8px', fontSize: '11.5px' },
				onClick: actions.onAdd,
			}, uiIcon('plus', 12, '#ffffff'), ` ${t('account.add')}`) : null,
			h(Button, {
				variant: 'default', size: 'sm', className: 'agy-btn',
				style: { gap: '4px', height: '24px', padding: '2px 8px', fontSize: '11.5px' },
				disabled: isBusy || isWarmupAllBusy,
				onClick: actions.onWarmupAll,
			}, ...(isWarmupAllBusy ? [Spinner(), t('header.warmingUp')] : [uiIcon('flame', 12, '#f97316'), ` ${t('header.warmup')}`])),
			h(Button, {
				variant: 'default', size: 'sm', className: 'agy-btn',
				style: { gap: '4px', height: '24px', padding: '2px 8px', fontSize: '11.5px' },
				disabled: isBusy || isRefreshAllBusy,
				onClick: actions.onRefreshAll,
			}, ...(isRefreshAllBusy ? [Spinner(), t('header.refreshing')] : [uiIcon('refresh', 12, 'var(--agy-text-btn)'), ` ${t('header.refreshQuota')}`])),
		),
	);
}

function renderTokenImportForm(
	t: Translator,
	auth: ReturnType<typeof useAuthFlow>,
	pool: AccountPoolData | undefined,
	isBusy: boolean,
	loadingAction: string | null,
): unknown {
	return h('div', null,
		h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' } },
			h('textarea', {
				style: { ...S.input, minHeight: '68px', resize: 'vertical', fontFamily: 'monospace', fontSize: '11px' },
				value: auth.tokenInput,
				placeholder: t('auth.tokenPlaceholder'),
				'aria-label': t('auth.tokenPlaceholder'),
				onChange: (e: { target: { value: string } }) => auth.setTokenInput(e.target.value),
			}),
			h('input', {
				style: S.input,
				value: auth.aliasInput,
				placeholder: t('account.aliasPlaceholder'),
				'aria-label': t('aria.aliasInput'),
				onChange: (e: { target: { value: string } }) => auth.setAliasInput(e.target.value),
			}),
			h('input', {
				style: S.input,
				value: auth.addProxyInput,
				placeholder: pool?.systemProxy ? `${t('account.proxyPlaceholder')} (${pool.systemProxy})` : t('account.proxyPlaceholder'),
				'aria-label': t('aria.proxyInput'),
				onChange: (e: { target: { value: string } }) => auth.setAddProxyInput(e.target.value),
			}),
		),
		h('div', { style: { display: 'flex', gap: '8px' } },
			h(Button, {
				variant: 'primary', className: 'agy-btn',
				style: { gap: '4px' },
				disabled: isBusy || !auth.tokenInput.trim(),
				onClick: () => void auth.handleImportToken(),
			}, ...(loadingAction === 'pool:importToken' ? [Spinner(), t('auth.importingToken')] : [uiIcon('arrowDown', 12, '#ffffff'), ` ${t('auth.importToken')}`])),
			h(Button, {
				variant: 'default', className: 'agy-btn',
				onClick: () => void auth.handleCancelAddAccount(),
			}, t('cancel')),
		),
	);
}

function renderBrowserOAuthForm(
	t: Translator,
	auth: ReturnType<typeof useAuthFlow>,
	pool: AccountPoolData | undefined,
	isBusy: boolean,
	loadingAction: string | null,
): unknown {
	const { flowPhase, poolAuth } = auth;
	return h('div', null,
		h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' } },
			h('input', {
				style: S.input,
				value: auth.aliasInput,
				placeholder: t('account.aliasPlaceholder'),
				'aria-label': t('aria.aliasInput'),
				onChange: (e: { target: { value: string } }) => auth.setAliasInput(e.target.value),
			}),
			h('input', {
				style: S.input,
				value: auth.addProxyInput,
				placeholder: pool?.systemProxy ? `${t('account.proxyPlaceholder')} (${pool.systemProxy})` : t('account.proxyPlaceholder'),
				'aria-label': t('aria.proxyInput'),
				onChange: (e: { target: { value: string } }) => auth.setAddProxyInput(e.target.value),
			}),
		),
		h('div', { style: { display: 'flex', gap: '8px' } },
			h(Button, {
				variant: 'primary', className: 'agy-btn',
				style: { gap: '4px' },
				disabled: isBusy,
				onClick: () => void auth.handleBeginAddAccount(),
			}, ...(loadingAction === 'pool:beginAdd' ? [Spinner(), t('auth.openingBrowser')] : [uiIcon('externalLink', 12, '#ffffff'), ` ${t('auth.openBrowser')}`])),
			h(Button, {
				variant: 'default', className: 'agy-btn',
				onClick: () => void auth.handleCancelAddAccount(),
			}, t('cancel')),
		),
		flowPhase === 'failed' ? h('div', {
			style: { ...S.muted!, color: 'var(--agy-danger-text)', marginTop: '8px', display: 'flex', alignItems: 'center', gap: '5px', fontWeight: 600 },
		}, uiIcon('alert', 12, 'var(--agy-danger-text)'), auth.safeMessage(poolAuth?.code)) : null,
	);
}

function renderWaitingCodeForm(
	t: Translator,
	auth: ReturnType<typeof useAuthFlow>,
	isBusy: boolean,
	loadingAction: string | null,
): unknown {
	const { flowPhase, poolAuth } = auth;
	return h('div', null,
		h('div', { style: { display: 'flex', alignItems: 'center', color: 'var(--agy-text-secondary)', marginBottom: '8px', lineHeight: 1.5, fontSize: '12px' } },
			Spinner(),
			flowPhase === 'exchanging' ? t('auth.exchanging') : t('auth.waiting'),
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
				value: auth.authCodeInput,
				placeholder: t('auth.codePlaceholder'),
				'aria-label': t('aria.authCodeInput'),
				onChange: (e: { target: { value: string } }) => auth.setAuthCodeInput(e.target.value),
			}),
			h(Button, {
				variant: 'primary', className: 'agy-btn',
				style: { gap: '4px' },
				disabled: isBusy || !auth.authCodeInput.trim(),
				onClick: () => void auth.handleCompleteAddAccount(),
			}, ...(loadingAction === 'pool:completeAdd' ? [Spinner(), t('auth.activating')] : [uiIcon('check', 12, '#ffffff'), ` ${t('auth.activate')}`])),
			h(Button, {
				variant: 'default', className: 'agy-btn',
				onClick: () => void auth.handleCancelAddAccount(),
			}, t('cancel')),
		),
	);
}

function renderAddAccountSection(
	t: Translator,
	auth: ReturnType<typeof useAuthFlow>,
	pool: AccountPoolData | undefined,
	isBusy: boolean,
	loadingAction: string | null,
): unknown {
	const { addingAccount, flowActive } = auth;
	if (!addingAccount) return null;
	return h('div', { style: S.authModal, role: 'group', 'aria-label': t('account.add') },
		h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' } },
			h('div', { style: { fontWeight: 700, fontSize: '13.5px', display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--agy-text-primary)' } },
				uiIcon('plus', 13, 'var(--agy-btn-primary-bg)'),
				t('account.add'),
			),
			!flowActive ? h('div', { style: { display: 'flex', gap: '4px' } },
				h(Button, {
					variant: !auth.importMode ? 'primary' : 'default',
					size: 'sm', className: 'agy-btn',
					style: { height: '22px', fontSize: '11px', padding: '1px 8px' },
					onClick: () => auth.setImportMode(false),
				}, t('auth.browserTab')),
				h(Button, {
					variant: auth.importMode ? 'primary' : 'default',
					size: 'sm', className: 'agy-btn',
					style: { height: '22px', fontSize: '11px', padding: '1px 8px' },
					onClick: () => auth.setImportMode(true),
				}, t('auth.tokenTab')),
			) : null,
		),
		!flowActive
			? (auth.importMode
				? renderTokenImportForm(t, auth, pool, isBusy, loadingAction)
				: renderBrowserOAuthForm(t, auth, pool, isBusy, loadingAction))
			: renderWaitingCodeForm(t, auth, isBusy, loadingAction),
	);
}

/**
 * Effort labels for the dropdowns. Localised when the locale defines the id,
 * otherwise agy's own English name (Low/Medium/High/Extra/Max) — the same
 * names the host's model menu shows, so both surfaces read identically.
 */
function effortLabels(t: Translator): EffortLabels {
	return {
		auto: t('config.translateEffortAuto'),
		level: (id: string) => {
			const key = ('effort.' + id) as Parameters<Translator>[0];
			const localised = t(key);
			return localised === key ? effortLabel(id) : localised;
		},
	};
}
