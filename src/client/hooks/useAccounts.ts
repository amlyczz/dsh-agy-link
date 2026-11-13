// Account-pool action handlers. All writes go through the existing /pool/*
// endpoints; busy state stays per-action so one action never disables every
// control on the panel (see test/busy-scoping.test.ts).

import type { ManagedAccount } from '../../common/pool-types.ts';
import { postPool } from '../api.ts';
import type { StatusPayload } from '../status.ts';
import type { ShowToast } from '../ui/Toast.ts';
import type { Translator } from './useTranslation.ts';

export interface AccountsDeps {
	status: StatusPayload | null;
	refresh: () => Promise<void>;
	showToast: ShowToast;
	setLoadingAction: (value: string | null) => void;
	t: Translator;
	proxyInputs: Record<string, string>;
	setEditingProxyId: (id: string | null) => void;
	setOptimisticActiveId: (id: string | null) => void;
}

export interface AccountActions {
	reorderAccounts: (newIds: string[]) => Promise<void>;
	moveAccount: (accId: string, delta: number) => Promise<void>;
	setActiveAccount: (id: string) => Promise<void>;
	removeAccount: (id: string, alias: string) => Promise<void>;
	toggleAccountEnabled: (acc: ManagedAccount) => Promise<void>;
	refreshQuota: (id?: string) => Promise<void>;
	warmupAccount: (id?: string) => Promise<void>;
	saveProxy: (id: string) => Promise<void>;
	clearCooldown: (id?: string) => Promise<void>;
}

export function useAccounts(deps: AccountsDeps): AccountActions {
	const actionFailed = (): void => {
		deps.showToast(deps.t('api.genericError'), 'error');
	};
	return {
		...reorderActions(deps, actionFailed),
		...lifecycleActions(deps, actionFailed),
		...quotaActions(deps, actionFailed),
	};
}

function reorderActions(
	deps: AccountsDeps,
	actionFailed: () => void,
): Pick<AccountActions, 'reorderAccounts' | 'moveAccount'> {
	const { status, refresh, showToast, setLoadingAction, t } = deps;

	const reorderAccounts = async (newIds: string[]): Promise<void> => {
		setLoadingAction('pool:reorder');
		const res = await postPool('reorder', { ids: newIds });
		setLoadingAction(null);
		if (res && res.ok) {
			await refresh();
			showToast(t('account.reordered'), 'success');
		} else {
			actionFailed();
		}
	};

	const moveAccount = async (accId: string, delta: number): Promise<void> => {
		const ids = (status?.pool?.accounts ?? []).map((a) => a.id);
		const idx = ids.indexOf(accId);
		if (idx === -1) return;
		const newIdx = idx + delta;
		if (newIdx < 0 || newIdx >= ids.length) return;
		const [moved] = ids.splice(idx, 1);
		if (moved) ids.splice(newIdx, 0, moved);
		await reorderAccounts(ids);
	};

	return { reorderAccounts, moveAccount };
}

function lifecycleActions(
	deps: AccountsDeps,
	actionFailed: () => void,
): Pick<AccountActions, 'setActiveAccount' | 'removeAccount' | 'toggleAccountEnabled'> {
	const { refresh, showToast, setLoadingAction, t, setOptimisticActiveId } = deps;

	const setActiveAccount = async (id: string): Promise<void> => {
		setOptimisticActiveId(id);
		setLoadingAction(`active:${id}`);
		try {
			const res = await postPool('set-active', { id });
			if (res && res.ok) {
				await refresh();
				showToast(t('account.activeSet'), 'success');
			} else {
				setOptimisticActiveId(null);
				showToast(res?.error || t('account.activeSetFailed'), 'error');
			}
		} catch {
			setOptimisticActiveId(null);
			showToast(t('account.activeSetFailed'), 'error');
		} finally {
			setOptimisticActiveId(null);
			setLoadingAction(null);
		}
	};

	const removeAccount = async (id: string, alias: string): Promise<void> => {
		setLoadingAction(`remove:${id}`);
		const res = await postPool('remove', { id });
		if (res === null || res?.ok === false) {
			setLoadingAction(null);
			actionFailed();
			return;
		}
		await refresh();
		setLoadingAction(null);
		showToast(t('account.removed', { alias }), 'info');
	};

	const toggleAccountEnabled = async (acc: ManagedAccount): Promise<void> => {
		const nextState = !acc.enabled;
		setLoadingAction(`enable:${acc.id}`);
		const res = await postPool('enable', { id: acc.id, enabled: nextState });
		if (res === null || res?.ok === false) {
			setLoadingAction(null);
			actionFailed();
			return;
		}
		await refresh();
		setLoadingAction(null);
		const legacyDefault = acc.defaultAlias === undefined && acc.systemHome && acc.alias === '主账号 (系统登录)';
		const displayAlias = acc.defaultAlias || legacyDefault
			? acc.systemHome ? t('account.defaultAlias') : acc.alias
			: acc.alias;
		showToast(t(nextState ? 'account.enabledToast' : 'account.disabledToast', { alias: displayAlias }), 'success');
	};

	return { setActiveAccount, removeAccount, toggleAccountEnabled };
}

function quotaActions(
	deps: AccountsDeps,
	actionFailed: () => void,
): Pick<AccountActions, 'refreshQuota' | 'warmupAccount' | 'saveProxy' | 'clearCooldown'> {
	const { refresh, showToast, setLoadingAction, t, proxyInputs, setEditingProxyId } = deps;

	const refreshQuota = async (id?: string): Promise<void> => {
		setLoadingAction(id ? `refresh:${id}` : 'refresh:all');
		try {
			const res = await postPool('refresh-quota', { id });
			if (res === null || res?.ok === false) {
				actionFailed();
				return;
			}
			await refresh();
			// The host answers immediately and refreshes in the background; the
			// 3s status poll delivers the new numbers. Saying "refreshed" here
			// used to be a lie (and the old blocking request left the spinner
			// spinning for the whole network cascade).
			showToast(res?.pending === true ? t('quota.refreshStarted') : t('quota.refreshed'), res?.pending === true ? 'info' : 'success');
		} finally {
			setLoadingAction(null);
		}
	};

	const warmupAccount = async (id?: string): Promise<void> => {
		setLoadingAction(id ? `warmup:${id}` : 'warmup:all');
		try {
			const res = await postPool('warmup', {
				id,
				force: true,
				...(id ? {} : { all: true }),
			});
			if (res === null || res?.ok === false) {
				actionFailed();
				return;
			}
			await refresh();
			const results: any[] = Array.isArray(res.results) ? res.results : [];
			const skippedCount = results.filter((r) => r.skipped).length;
			// `success: true, skipped: true` means "nothing was due"; it must
			// not count as a successful probe (all-failed used to toast success).
			const successCount = results.filter((r) => r.success && !r.skipped).length;
			const failedCount = results.length - skippedCount - successCount;
			if (successCount > 0) {
				showToast(id ? t('warmup.success') : t('warmup.allSuccess'), 'success');
			} else if (skippedCount > 0 && failedCount === 0) {
				showToast(t('warmup.skipped'), 'info');
			} else {
				actionFailed();
			}
		} finally {
			setLoadingAction(null);
		}
	};

	const saveProxy = async (id: string): Promise<void> => {
		setLoadingAction(`proxy:${id}`);
		const proxyUrl = proxyInputs[id];
		const res = await postPool('proxy', { id, proxyUrl });
		if (res === null || res?.ok === false) {
			setLoadingAction(null);
			actionFailed();
			return;
		}
		setEditingProxyId(null);
		await refresh();
		setLoadingAction(null);
		showToast(t('proxy.saved'), 'success');
	};

	const clearCooldown = async (id?: string): Promise<void> => {
		setLoadingAction(id ? `clearCooldown:${id}` : 'clearCooldown:all');
		const res = await postPool('clear-cooldown', { id });
		if (res === null || res?.ok === false) {
			setLoadingAction(null);
			actionFailed();
			return;
		}
		await refresh();
		setLoadingAction(null);
		showToast(t('account.clearCooldown'), 'success');
	};

	return { refreshQuota, warmupAccount, saveProxy, clearCooldown };
}
