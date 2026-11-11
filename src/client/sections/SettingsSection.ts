// The Antigravity settings console: header status card, toast banner, the
// add-account OAuth form, the account pool, and the runtime configuration rows
// (pool mode, auto-warmup, auto-translate, image generation, default effort,
// model visibility). All state/handlers live here; child panels stay
// presentational so the DOM and every i18n key remain exactly as shipped.

import { win } from '../api.ts';
import type { AccountPoolData } from '../../common/pool-types.ts';
import { geminiCatalogModels, translateEffortOptions, translateModelOptions } from '../config-options.ts';
import { useAgyTranslation, type LocaleLike, type Translator } from '../hooks/useTranslation.ts';
import { useAccounts } from '../hooks/useAccounts.ts';
import { useAuthFlow } from '../hooks/useAuthFlow.ts';
import { useConfig } from '../hooks/useConfig.ts';
import { agyIcon, uiIcon } from '../icons.ts';
import { h, useEffect, useRef, useState } from '../react.ts';
import { useAgyStatus } from '../status.ts';
import { S } from '../styles.ts';
import { Button } from '../ui/Button.ts';
import { Row } from '../ui/Row.ts';
import { Select } from '../ui/Select.ts';
import { Spinner } from '../ui/Spinner.ts';
import { Toast, type ToastNotice, type ToastType } from '../ui/Toast.ts';
import { AccountsPanel } from './AccountsPanel.ts';
import { ModelsPanel } from './ModelsPanel.ts';

// Shown (and copyable) in Settings: image generation is a CLI feature, so the
// panel documents the exact command instead of pretending to run it in-page.
const IMAGE_CLI_SAMPLE = 'dsh-agy-image -p "…" -a 16:9 -o ./image.jpg';

export interface SettingsSectionProps {
	isModal?: boolean;
	onClose?: () => void;
}

export function createSettingsSection(locale: LocaleLike): (props?: SettingsSectionProps) => unknown {
	return function AgySettingsSection(_props?: SettingsSectionProps): unknown {
		const t = useAgyTranslation(locale);
		const { status, refresh } = useAgyStatus();

		const [toast, setToast] = useState<ToastNotice | null>(null);
		const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
		useEffect(() => () => {
			// Unmount must not leave a pending timer writing state into a dead
			// component; a second same-text toast also used to be cleared early
			// by the FIRST toast's leftover timer.
			if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
		}, []);
		const showToast = (text: string, type: ToastType = 'info') => {
			setToast({ text, type, id: Date.now() });
			if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
			toastTimerRef.current = setTimeout(() => {
				toastTimerRef.current = null;
				setToast((prev) => (prev !== null && prev.text === text ? null : prev));
			}, 6000);
		};

		const [loadingAction, setLoadingAction] = useState<string | null>(null);
		const [proxyInputs, setProxyInputs] = useState<Record<string, string>>({});
		const [editingProxyId, setEditingProxyId] = useState<string | null>(null);
		const [expandedModels, setExpandedModels] = useState<Record<string, boolean>>({});
		const [optimisticActiveId, setOptimisticActiveId] = useState<string | null>(null);

		// Cooldown expiry and quota countdowns are Date.now()-derived while the
		// payload itself does NOT change when they lapse — without a wall-clock
		// tick the "cooldown" banner and the minutes-left froze forever.
		const [, setTimeTick] = useState(0);
		useEffect(() => {
			const timer = setInterval(() => setTimeTick((n) => n + 1), 30_000);
			return () => clearInterval(timer);
		}, []);

		const auth = useAuthFlow({ status, refresh, showToast, setLoadingAction, t });
		const config = useConfig({ status, refresh, showToast, setLoadingAction, t });
		const accountActions = useAccounts({
			status, refresh, showToast, setLoadingAction, t,
			proxyInputs, setEditingProxyId, setOptimisticActiveId,
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

		const toggleExpand = (accId: string) => {
			setExpandedModels((prev) => ({ ...prev, [accId]: !prev[accId] }));
		};

		const authPhase = status?.auth?.phase ?? 'unknown';
		const pool = status?.pool;
		const catalogModels = status?.catalogModels ?? [];
		const hiddenModelSet = new Set(status?.hiddenModels ?? []);
		const accounts = pool?.accounts ?? [];
		const isAuthed = authPhase === 'ok' || accounts.length > 0;
		const isBusy = loadingAction !== null;

		if (status === null) {
			return h('div', { style: { ...S.container!, minHeight: '120px', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
				h('span', { style: S.muted }, [Spinner(), t('status.loading')]),
			);
		}

		return h('div', { className: 'agy-console', style: S.container },
			renderHeader(t, isAuthed, auth.addingAccount, isBusy, loadingAction, {
				onAdd: () => auth.setAddingAccount(true),
				onWarmupAll: () => void accountActions.warmupAccount(),
				onRefreshAll: () => void accountActions.refreshQuota(),
			}),
			h(Toast, { toast, onClose: () => setToast(null), t }),
			renderAddAccountSection(t, auth, pool, isBusy, loadingAction),
			h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', padding: '0 2px' } },
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
					h('span', { style: { fontWeight: 700, fontSize: '12.5px', color: 'var(--agy-text-primary)' } }, `账号池 (${accounts.length})`),
				),
			),
			h(AccountsPanel, {
				t, pool, accounts, loadingAction,
				proxyInputs, setProxyInputs, editingProxyId, setEditingProxyId,
				expandedModels, toggleExpand, optimisticActiveId,
				handlers: accountActions,
			}),
			renderRuntimeConfig(t, status, pool, catalogModels, hiddenModelSet, loadingAction, {
				setCfg: config.setCfg,
				setMode: config.setMode,
				toggleModelHidden: config.toggleModelHidden,
				copyImageCommand,
			}),
		);
	};
}

function renderHeader(
	t: Translator,
	isAuthed: boolean,
	addingAccount: boolean,
	isBusy: boolean,
	loadingAction: string | null,
	actions: { onAdd: () => void; onWarmupAll: () => void; onRefreshAll: () => void },
): unknown {
	return h('div', { style: S.headerCard },
		h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
			agyIcon(18),
			h('span', { style: { fontWeight: 700, fontSize: '14px', color: 'var(--agy-text-primary)' } }, 'Antigravity'),
			h('span', { style: isAuthed ? S.badgeReady : S.badgeUnready }, isAuthed ? t('status.ready') : t('status.needsAuth')),
		),
		h('div', { className: 'agy-header-actions', style: { display: 'flex', gap: '6px', alignItems: 'center' } },
			!addingAccount ? h(Button, {
				variant: 'primary', size: 'sm', className: 'agy-btn',
				style: { gap: '4px', height: '24px', padding: '2px 8px', fontSize: '11.5px' },
				onClick: actions.onAdd,
			}, [uiIcon('plus', 12, '#ffffff'), ` ${t('account.add')}`]) : null,
			h(Button, {
				variant: 'default', size: 'sm', className: 'agy-btn',
				style: { gap: '4px', height: '24px', padding: '2px 8px', fontSize: '11.5px' },
				disabled: isBusy,
				onClick: actions.onWarmupAll,
			}, loadingAction === 'warmup:all' ? [Spinner(), t('header.warmingUp')] : [uiIcon('flame', 12, '#f97316'), ` ${t('header.warmup')}`]),
			h(Button, {
				variant: 'default', size: 'sm', className: 'agy-btn',
				style: { gap: '4px', height: '24px', padding: '2px 8px', fontSize: '11.5px' },
				disabled: isBusy,
				onClick: actions.onRefreshAll,
			}, loadingAction === 'refresh:all' ? [Spinner(), t('header.refreshing')] : [uiIcon('refresh', 12, 'var(--agy-text-btn)'), ` ${t('header.refreshQuota')}`]),
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
	const { addingAccount, flowActive, flowPhase, poolAuth } = auth;
	return addingAccount
		? h('div', { style: S.authModal, role: 'group', 'aria-label': t('account.add') },
			h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' } },
				h('div', { style: { fontWeight: 700, fontSize: '13.5px', display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--agy-text-primary)' } },
					uiIcon('plus', 13, 'var(--agy-btn-primary-bg)'),
					t('account.add'),
				),
			),
			(!flowActive
				? h('div', null,
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
						}, loadingAction === 'pool:beginAdd' ? [Spinner(), t('auth.openingBrowser')] : [uiIcon('externalLink', 12, '#ffffff'), ` ${t('auth.openBrowser')}`]),
						h(Button, {
							variant: 'default', className: 'agy-btn',
							onClick: () => void auth.handleCancelAddAccount(),
						}, t('cancel')),
					),
					flowPhase === 'failed' ? h('div', {
						style: { ...S.muted!, color: 'var(--agy-danger-text)', marginTop: '8px', display: 'flex', alignItems: 'center', gap: '5px', fontWeight: 600 },
					}, uiIcon('alert', 12, 'var(--agy-danger-text)'), auth.safeMessage(poolAuth?.code)) : null,
				)
				: h('div', null,
					h('div', { style: { display: 'flex', alignItems: 'center', color: 'var(--agy-text-secondary)', marginBottom: '8px', lineHeight: 1.5, fontSize: '12px' } },
						Spinner(),
						flowPhase === 'exchanging'
							? t('auth.exchanging')
							: t('auth.waiting'),
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
						}, loadingAction === 'pool:completeAdd' ? [Spinner(), t('auth.activating')] : [uiIcon('check', 12, '#ffffff'), ` ${t('auth.activate')}`]),
						h(Button, {
							variant: 'default', className: 'agy-btn',
							onClick: () => void auth.handleCancelAddAccount(),
						}, t('cancel')),
					),
				))
		)
		: null;
}

function segGroup(children: unknown[]): unknown {
	return h('div', { style: S.segGroup }, children);
}

function renderRuntimeConfig(
	t: Translator,
	status: NonNullable<ReturnType<typeof useAgyStatus>['status']>,
	pool: NonNullable<ReturnType<typeof useAgyStatus>['status']>['pool'] | undefined,
	catalogModels: ReadonlyArray<{ id: string; name: string }>,
	hiddenModelSet: Set<string>,
	loadingAction: string | null,
	actions: {
		setCfg: (key: string, value: unknown) => Promise<void>;
		setMode: (mode: string) => Promise<void>;
		toggleModelHidden: (id: string, hide: boolean) => Promise<void>;
		copyImageCommand: () => void;
	},
): unknown {
	const { setCfg, setMode, toggleModelHidden, copyImageCommand } = actions;
	const caption = (text: string, desc?: string): unknown => h('div', { style: { display: 'flex', flexDirection: 'column' } },
		h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px' } }, text),
		desc !== undefined ? h('span', { style: S.muted }, desc) : null,
	);

	return h('div', { style: { marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--agy-border-divider)' } },
		h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
			h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
				h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px' } }, t('config.runtimeTitle')),
				h('span', { style: S.muted }, t('config.runtimeDesc')),
			),
			h(Row, {
				left: h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px' } }, t('pool.label')),
				right: segGroup([
					h(Button, {
						variant: pool?.mode === 'sequential' || !pool?.mode ? 'segActive' : 'seg',
						onClick: () => void setMode('sequential'),
					}, t('pool.sequential')),
					h(Button, {
						variant: pool?.mode === 'round-robin' ? 'segActive' : 'seg',
						onClick: () => void setMode('round-robin'),
					}, t('pool.roundRobin')),
				]),
			}),
			h(Row, {
				left: caption(t('config.autoWarmup'), t('config.autoWarmupDesc')),
				right: segGroup([
					h(Button, {
						variant: status.autoWarmup === true ? 'segActive' : 'seg',
						disabled: loadingAction === 'config:autoWarmup',
						onClick: () => void setCfg('autoWarmup', true),
					}, t('config.on')),
					h(Button, {
						variant: status.autoWarmup !== true ? 'segActive' : 'seg',
						disabled: loadingAction === 'config:autoWarmup',
						onClick: () => void setCfg('autoWarmup', false),
					}, t('config.off')),
				]),
			}),
			h(Row, {
				style: { gap: '10px' },
				left: h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 0' } },
					h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px' } }, t('config.autoTranslate')),
					h('span', { style: S.muted }, t('config.autoTranslateDesc')),
				),
				right: h('div', { style: S.cfgRowRight },
					segGroup([
						h(Button, {
							variant: status.autoTranslate === true ? 'segActive' : 'seg',
							disabled: loadingAction === 'config:autoTranslate',
							onClick: () => void setCfg('autoTranslate', true),
						}, t('config.on')),
						h(Button, {
							variant: status.autoTranslate !== true ? 'segActive' : 'seg',
							disabled: loadingAction === 'config:autoTranslate',
							onClick: () => void setCfg('autoTranslate', false),
						}, t('config.off')),
					]),
					h(Select, {
						value: status.translateModel ?? '',
						ariaLabel: t('config.translateModel'),
						title: t('config.translateModelDesc'),
						disabled: loadingAction === 'config:translateModel',
						onChange: (e: { target?: { value?: string } }) => void setCfg('translateModel', e?.target?.value ?? ''),
						options: translateModelOptions(status.translateModel ?? '', geminiCatalogModels(catalogModels), t('config.translateModelAuto')),
					}),
					h(Select, {
						value: status.translateEffort ?? '',
						ariaLabel: t('config.translateEffort'),
						title: t('config.translateEffortDesc'),
						style: { minWidth: '78px', maxWidth: '110px' },
						disabled: loadingAction === 'config:translateEffort',
						onChange: (e: { target?: { value?: string } }) => void setCfg('translateEffort', e?.target?.value ?? ''),
						options: translateEffortOptions(status.translateEffort ?? '', {
							auto: t('config.translateEffortAuto'),
							low: t('effort.low'),
							medium: t('effort.medium'),
							high: t('effort.high'),
						}),
					}),
				),
			}),
			renderImageRow(t, status, catalogModels, loadingAction, setCfg, copyImageCommand),
			renderDefaultEffortRow(t, status, loadingAction, setCfg),
			h(ModelsPanel, { t, catalogModels, hiddenModelSet, loadingAction, toggleModelHidden }),
		),
	);
}

function renderDefaultEffortRow(
	t: Translator,
	status: NonNullable<ReturnType<typeof useAgyStatus>['status']>,
	loadingAction: string | null,
	setCfg: (key: string, value: unknown) => Promise<void>,
): unknown {
	const value = status.defaultEffort;
	return h(Row, {
		left: h('div', { style: { display: 'flex', flexDirection: 'column' } },
			h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px' } }, t('config.defaultEffort')),
			h('span', { style: S.muted }, t('config.defaultEffortDesc')),
		),
		right: segGroup([
			h(Button, {
				variant: value === '' ? 'segActive' : 'seg',
				disabled: loadingAction === 'config:defaultEffort',
				onClick: () => void setCfg('defaultEffort', ''),
			}, t('effort.auto')),
			h(Button, {
				variant: value === 'low' ? 'segActive' : 'seg',
				disabled: loadingAction === 'config:defaultEffort',
				onClick: () => void setCfg('defaultEffort', 'low'),
			}, t('effort.low')),
			h(Button, {
				variant: value === 'medium' ? 'segActive' : 'seg',
				disabled: loadingAction === 'config:defaultEffort',
				onClick: () => void setCfg('defaultEffort', 'medium'),
			}, t('effort.medium')),
			h(Button, {
				variant: value === 'high' ? 'segActive' : 'seg',
				disabled: loadingAction === 'config:defaultEffort',
				onClick: () => void setCfg('defaultEffort', 'high'),
			}, t('effort.high')),
		]),
	});
}

function renderImageRow(
	t: Translator,
	status: NonNullable<ReturnType<typeof useAgyStatus>['status']>,
	catalogModels: ReadonlyArray<{ id: string; name: string }>,
	loadingAction: string | null,
	setCfg: (key: string, value: unknown) => Promise<void>,
	copyImageCommand: () => void,
): unknown {
	return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
		h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' } },
			h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 0' } },
				h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px' } }, t('config.image')),
				h('span', { style: S.muted }, t('config.imageDesc')),
			),
			h('div', { style: S.cfgRowRight },
				h(Select, {
					value: status.imageModel ?? '',
					ariaLabel: t('config.imageModel'),
					title: t('config.imageModelDesc'),
					disabled: loadingAction === 'config:imageModel',
					onChange: (e: { target?: { value?: string } }) => void setCfg('imageModel', e?.target?.value ?? ''),
					options: translateModelOptions(status.imageModel ?? '', geminiCatalogModels(catalogModels), t('config.translateModelAuto')),
				}),
				h(Select, {
					value: status.imageEffort ?? '',
					ariaLabel: t('config.imageEffort'),
					title: t('config.imageEffortDesc'),
					style: { minWidth: '78px', maxWidth: '110px' },
					disabled: loadingAction === 'config:imageEffort',
					onChange: (e: { target?: { value?: string } }) => void setCfg('imageEffort', e?.target?.value ?? ''),
					options: translateEffortOptions(status.imageEffort ?? '', {
						auto: t('config.translateEffortAuto'),
						low: t('effort.low'),
						medium: t('effort.medium'),
						high: t('effort.high'),
					}),
				}),
			),
		),
		h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
			h('code', {
				style: {
					flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
					fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px',
					color: 'var(--agy-text-secondary)', background: 'var(--agy-bg-subbox)',
					border: '1px solid var(--agy-border-subbox)', borderRadius: '5px', padding: '3px 7px',
				},
			}, IMAGE_CLI_SAMPLE),
			// Same secondary small-button recipe as every other row here
			// (variant default + size sm === the original {...S.btnSm, ...}).
			h(Button, {
				variant: 'default', size: 'sm', className: 'agy-btn',
				style: { flex: '0 0 auto', whiteSpace: 'nowrap' },
				onClick: copyImageCommand,
			}, t('config.imageCopy')),
		),
	);
}
