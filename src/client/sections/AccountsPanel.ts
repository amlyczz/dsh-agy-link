// The account pool: per-account cards (priority reorder, enable/sync/warmup,
// set-active, proxy editor, quota bars, cooldown note, per-model breakdown).
//
// Rendering lives here; the async actions come in as handlers from useAccounts
// so this module stays presentational and the busy state stays per-action
// (test/busy-scoping.test.ts pins that contract).

import type { AccountPoolData, ManagedAccount, ModelQuotaInfo } from '../../common/pool-types.ts';
import { h } from '../react.ts';
import { S } from '../styles.ts';
import { uiIcon } from '../icons.ts';
import { Button } from '../ui/Button.ts';
import { Spinner } from '../ui/Spinner.ts';
import type { Translator } from '../hooks/useTranslation.ts';
import { formatQuotaWindow, renderFamilyQuotaBar } from './QuotaPanel.ts';

export interface AccountsPanelHandlers {
	moveAccount: (accId: string, delta: number) => Promise<void>;
	setActiveAccount: (id: string) => Promise<void>;
	removeAccount: (id: string, alias: string) => Promise<void>;
	toggleAccountEnabled: (acc: ManagedAccount) => Promise<void>;
	refreshQuota: (id?: string) => Promise<void>;
	warmupAccount: (id?: string) => Promise<void>;
	saveProxy: (id: string) => Promise<void>;
	clearCooldown: (id?: string) => Promise<void>;
}

export interface AccountsPanelProps {
	t: Translator;
	pool: AccountPoolData | undefined;
	accounts: ManagedAccount[];
	loadingAction: string | null;
	proxyInputs: Record<string, string>;
	setProxyInputs: (next: Record<string, string>) => void;
	editingProxyId: string | null;
	setEditingProxyId: (id: string | null) => void;
	expandedModels: Record<string, boolean>;
	toggleExpand: (accId: string) => void;
	optimisticActiveId: string | null;
	handlers: AccountsPanelHandlers;
}

export function AccountsPanel(props: AccountsPanelProps): unknown {
	const {
		t, pool, accounts, loadingAction, proxyInputs, setProxyInputs,
		editingProxyId, setEditingProxyId, expandedModels, toggleExpand,
		optimisticActiveId, handlers,
	} = props;

	// Per-action busy scoping: each control derives its own busy state from the
	// action that concerns it, so an unrelated action leaves its DOM untouched.
	const accountActionBusy = (acc: ManagedAccount, action: string): boolean =>
		loadingAction === `${action}:${acc.id}`;

	// The shimmer only animates the account actually being refreshed.
	const renderQuotaBar = (label: string, familyKey: 'google' | 'argon' | 'anthropic' | 'openai', acc: ManagedAccount): unknown =>
		renderFamilyQuotaBar(
			t,
			label,
			familyKey,
			acc,
			loadingAction === 'refresh:all' || loadingAction === `refresh:${acc.id}`,
		);

	// Authoritative active account: trust pool.activeAccountId computed by the
	// scheduler, falling back to lastActiveAccountId, activeAccountIds.google, or
	// primaryAccountId. Optimistic selection takes priority for instant feedback.
	const authoritativeActiveId = pool?.activeAccountId ?? pool?.lastActiveAccountId ?? pool?.activeAccountIds?.google ?? pool?.primaryAccountId;
	const activeAccountId = optimisticActiveId ?? authoritativeActiveId;

	return accounts.map((acc: ManagedAccount) => {
		const isPrimary = acc.id === pool?.primaryAccountId;
		const hasCooldown = Object.entries(acc.cooldowns).some(([, cd]) => cd && cd.cooldownUntil > Date.now());
		const isAuthRequired = acc.authRequired === true;
		const isInUse = Boolean(acc.enabled && !isAuthRequired && activeAccountId !== undefined && activeAccountId === acc.id);
		const dotColor = !acc.enabled ? '#64748b' : isAuthRequired ? '#ef4444' : hasCooldown ? '#f59e0b' : '#10b981';
		const isEditingProxy = editingProxyId === acc.id;
		const isExpanded = expandedModels[acc.id] ?? false;
		const accIndex = accounts.indexOf(acc);

		const cardStyle = {
			...S.card!,
			cursor: 'default',
			padding: '10px 14px',
			marginBottom: '8px',
			...(!acc.enabled ? { opacity: 0.72 } : {}),
		};
		// Built-in aliases are canonical server data; translate display only.
		const legacyDefault = acc.defaultAlias === undefined && acc.systemHome && acc.alias === '主账号 (系统登录)';
		const displayAlias = acc.defaultAlias || legacyDefault
			? acc.systemHome ? t('account.defaultAlias') : t('account.aliasDefault', { number: accIndex + 1 })
			: acc.alias;

		const allChildModels: { family: string; model: ModelQuotaInfo }[] = [
			...(acc.quotas.google?.models ?? []).map((m) => ({ family: 'Google', model: m })),
			...(acc.quotas.argon?.models ?? []).map((m) => ({ family: 'Argon', model: m })),
			...(acc.quotas.anthropic?.models ?? []).map((m) => ({ family: 'Anthropic', model: m })),
			...(acc.quotas.openai?.models ?? []).map((m) => ({ family: 'OpenAI', model: m })),
		];

		return h('div', {
			key: acc.id,
			className: 'agy-card-hover',
			style: cardStyle,
		},
			renderCardHeader(t, acc, {
				isPrimary, isAuthRequired, hasCooldown, isInUse, dotColor, isEditingProxy,
				displayAlias, accIndex, accounts, pool, loadingAction, accountActionBusy, handlers, setEditingProxyId,
			}),
			// Body: Always directly visible, showing quota
			h('div', { key: 'agy-body', style: S.quotaBox },
				renderQuotaBar('Gemini', 'google', acc),
				// Argon is gated on the data itself: free and legacy plans never see an empty panel.
				acc.quotas.argon ? renderQuotaBar('Argon', 'argon', acc) : null,
				h(Button, {
					variant: 'dashed',
					style: { color: isExpanded ? 'var(--dsw-alias-state-business-primary, #3b82f6)' : 'var(--agy-text-secondary)' },
					onClick: () => toggleExpand(acc.id),
				},
					uiIcon(isExpanded ? 'chevronUp' : 'chevronDown', 10),
					h('span', null, isExpanded ? t('account.collapseOthers') : t('account.expandOthers')),
				),
				isExpanded ? [
					renderQuotaBar('Claude', 'anthropic', acc),
					renderQuotaBar('GPT-OSS', 'openai', acc),
					allChildModels.length > 0 ? renderChildModels(t, allChildModels) : null,
				] : null,
			),
			hasCooldown ? renderCooldownBanner(t, acc, loadingAction, accountActionBusy, handlers) : null,
			isEditingProxy ? renderProxyEditor(t, acc, pool, proxyInputs, setProxyInputs, setEditingProxyId, loadingAction, accountActionBusy, handlers) : null,
		);
	});
}

interface CardHeaderCtx {
	isPrimary: boolean;
	isAuthRequired: boolean;
	hasCooldown: boolean;
	isInUse: boolean;
	dotColor: string;
	isEditingProxy: boolean;
	displayAlias: string;
	accIndex: number;
	accounts: ManagedAccount[];
	pool: AccountPoolData | undefined;
	loadingAction: string | null;
	accountActionBusy: (acc: ManagedAccount, action: string) => boolean;
	handlers: AccountsPanelHandlers;
	setEditingProxyId: (id: string | null) => void;
}

function renderStatusBadges(t: Translator, acc: ManagedAccount, ctx: CardHeaderCtx): unknown[] {
	const { isAuthRequired, hasCooldown, isInUse, pool } = ctx;
	return [
		isAuthRequired ? h('span', {
				style: {
					...S.badgeTag!,
					background: 'var(--agy-badge-email-bg)',
					color: '#ef4444',
					borderColor: '#fca5a5',
					gap: '3px',
					fontSize: '10px',
					padding: '1px 5px',
					fontWeight: 700,
					whiteSpace: 'nowrap',
					flexShrink: 0,
				},
			}, uiIcon('alert', 10, '#ef4444'), t('status.authRequired')) : null,
			hasCooldown ? h('span', {
				style: {
					...S.badgeTag!,
					background: 'rgba(245, 158, 11, 0.15)',
					color: '#f59e0b',
					borderColor: 'rgba(245, 158, 11, 0.4)',
					gap: '3px',
					fontSize: '10px',
					padding: '1px 5px',
					fontWeight: 700,
					whiteSpace: 'nowrap',
					flexShrink: 0,
				},
			}, uiIcon('alert', 10, '#f59e0b'), '冷却中') : null,
			acc.email ? h('span', {
				style: {
					...S.badgeTag!,
					background: 'var(--agy-badge-email-bg)',
					color: 'var(--agy-badge-email-text)',
					borderColor: 'var(--agy-badge-email-border)',
					gap: '4px',
					fontSize: '11px',
					padding: '1px 6px',
					whiteSpace: 'nowrap',
				},
				title: acc.email,
			}, uiIcon('mail', 10, 'var(--agy-badge-email-text)'), acc.email) : null,
			isInUse ? h('span', {
				style: {
					...S.badgeTag!,
					background: 'rgba(16, 185, 129, 0.12)',
					color: '#10b981',
					borderColor: 'rgba(16, 185, 129, 0.45)',
					gap: '3px',
					fontSize: '10px',
					padding: '1px 5px',
					fontWeight: 700,
					whiteSpace: 'nowrap',
					flexShrink: 0,
				},
				title: t('status.inUse'),
			}, uiIcon('zap', 10, '#10b981'), t('status.inUse')) : null,
			(() => {
				const effectiveProxy = acc.proxyUrl || pool?.systemProxy;
				return effectiveProxy ? h('span', {
					style: {
						...S.badgeTag!,
						background: 'var(--agy-badge-proxy-bg)',
						color: 'var(--agy-badge-proxy-text)',
						borderColor: 'var(--agy-badge-proxy-border)',
						gap: '4px',
						fontSize: '10px',
						padding: '1px 5px',
					},
					title: effectiveProxy,
				}, uiIcon('globe', 10, 'var(--agy-badge-proxy-text)'), t('status.proxy')) : null;
			})(),
			!acc.enabled ? h('span', {
				style: {
					...S.badgeTag!,
					background: 'var(--agy-bg-subbox)',
					color: 'var(--agy-text-secondary)',
					borderColor: 'var(--agy-border-subbox)',
					gap: '3px',
					fontSize: '10px',
					padding: '1px 5px',
					fontWeight: 700,
				},
				title: t('status.disabled'),
			}, uiIcon('power', 10, '#64748b'), t('status.disabled')) : null,
	];
}

function renderHeaderBadges(t: Translator, acc: ManagedAccount, ctx: CardHeaderCtx): unknown {
	const { isPrimary, isAuthRequired, hasCooldown, isInUse, dotColor, displayAlias, accIndex, accounts, pool, handlers } = ctx;
	return h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', flex: '1', minWidth: 0 } },
			h('span', {
				style: {
					...S.badgeTag!,
					fontWeight: 700,
					fontSize: '10.5px',
					padding: '1px 5px',
					background: isPrimary ? 'var(--agy-badge-primary-bg)' : 'var(--agy-badge-tag-bg)',
					color: isPrimary ? 'var(--agy-badge-primary-text)' : 'var(--agy-badge-tag-text)',
					borderColor: isPrimary ? 'var(--agy-badge-primary-border)' : 'var(--agy-badge-tag-border)',
				},
				title: `优先级 #${accIndex + 1}`,
			}, `#${accIndex + 1}`),
			accounts.length > 1 ? h('div', {
				style: { display: 'inline-flex', gap: '2px', alignItems: 'center' },
			},
				accIndex > 0 ? h(Button, {
					variant: 'default', size: 'sm', className: 'agy-btn',
					style: { padding: '1px 4px', fontSize: '10px', lineHeight: 1, height: '18px' },
					title: t('account.moveUp'),
					onClick: () => void handlers.moveAccount(acc.id, -1),
				}, uiIcon('arrowUp', 10)) : null,
				accIndex < accounts.length - 1 ? h(Button, {
					variant: 'default', size: 'sm', className: 'agy-btn',
					style: { padding: '1px 4px', fontSize: '10px', lineHeight: 1, height: '18px' },
					title: t('account.moveDown'),
					onClick: () => void handlers.moveAccount(acc.id, 1),
				}, uiIcon('arrowDown', 10)) : null,
			) : null,
			h('span', {
				className: 'agy-pulse-dot',
				style: { background: dotColor, boxShadow: `0 0 6px ${dotColor}aa`, marginLeft: '1px' },
			}),
			h('span', {
				style: { fontWeight: 700, fontSize: '13px', color: 'var(--agy-text-primary)', whiteSpace: 'nowrap' },
				title: displayAlias,
			}, displayAlias),
			h('span', {
				style: {
					...S.badgeTag!,
					background: 'rgba(59, 130, 246, 0.12)',
					color: '#3b82f6',
					borderColor: 'rgba(59, 130, 246, 0.35)',
					fontSize: '10px',
					padding: '1px 5px',
					fontWeight: 700,
				},
			}, 'AGY'),
			...renderStatusBadges(t, acc, ctx)
		);
}

function renderCardHeader(t: Translator, acc: ManagedAccount, ctx: CardHeaderCtx): unknown {
	const {
		isPrimary, isAuthRequired, hasCooldown, isInUse, dotColor, isEditingProxy,
		displayAlias, accIndex, accounts, pool, loadingAction, accountActionBusy, handlers, setEditingProxyId,
	} = ctx;
	return h('div', {
		style: {
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'space-between',
			userSelect: 'none',
			gap: '8px',
			marginBottom: '8px',
		},
	},
		renderHeaderBadges(t, acc, ctx),
		renderActionButtons(t, acc, { isEditingProxy, isInUse, displayAlias, showRemove: accounts.length > 1, loadingAction, accountActionBusy, handlers, setEditingProxyId }),
	);
}

function renderActionButtons(t: Translator, acc: ManagedAccount, ctx: {
	isEditingProxy: boolean;
	isInUse: boolean;
	displayAlias: string;
	showRemove: boolean;
	loadingAction: string | null;
	accountActionBusy: (acc: ManagedAccount, action: string) => boolean;
	handlers: AccountsPanelHandlers;
	setEditingProxyId: (id: string | null) => void;
}): unknown {
	const { isEditingProxy, isInUse, displayAlias, showRemove, loadingAction, accountActionBusy, handlers, setEditingProxyId } = ctx;
	return h('div', {
		className: 'agy-card-actions',
		style: { display: 'flex', gap: '4px', alignItems: 'center', flexShrink: 0 },
	},
		h(Button, {
			variant: acc.enabled ? 'default' : 'primary', size: 'sm', className: 'agy-btn',
			style: { gap: '3px', fontSize: '11px', padding: '2px 6px' },
			title: acc.enabled ? t('account.disableTitle') : t('account.enableTitle'),
			disabled: accountActionBusy(acc, 'enable'),
			onClick: () => void handlers.toggleAccountEnabled(acc),
		}, loadingAction === `enable:${acc.id}`
			? [Spinner(), acc.enabled ? t('account.disable') : t('account.enable')]
			: [uiIcon('power', 10, acc.enabled ? 'var(--agy-text-secondary)' : '#ffffff'), ` ${acc.enabled ? t('account.disable') : t('account.enable')}`]),
		h(Button, {
			variant: 'default', size: 'sm', className: 'agy-btn',
			style: { gap: '3px', fontSize: '11px', padding: '2px 6px', minWidth: '58px', justifyContent: 'center' },
			title: t('account.syncTitle'),
			disabled: accountActionBusy(acc, 'refresh'),
			onClick: () => void handlers.refreshQuota(acc.id),
		}, loadingAction === `refresh:${acc.id}` ? [Spinner(), t('account.syncing')] : [uiIcon('refresh', 10), ` ${t('account.sync')}`]),
		acc.enabled && !acc.authRequired ? h(Button, {
			variant: 'default', size: 'sm', className: 'agy-btn',
			style: { gap: '3px', fontSize: '11px', padding: '2px 6px', minWidth: '58px', justifyContent: 'center' },
			title: t('account.warmupTitle'),
			disabled: accountActionBusy(acc, 'warmup'),
			onClick: () => void handlers.warmupAccount(acc.id),
		}, loadingAction === `warmup:${acc.id}` ? [Spinner(), t('account.warmingUp')] : [uiIcon('flame', 10, '#f97316'), ` ${t('account.warmup')}`]) : null,
		acc.enabled && !isInUse ? h(Button, {
			variant: 'default', size: 'sm', className: 'agy-btn',
			style: { gap: '3px', fontSize: '11px', padding: '2px 6px' },
			title: t('account.setActive'),
			disabled: accountActionBusy(acc, 'active'),
			onClick: () => void handlers.setActiveAccount(acc.id),
		}, loadingAction === `active:${acc.id}` ? [Spinner(), t('account.settingActive')] : [uiIcon('zap', 10), ` ${t('account.setActive')}`]) : null,
		h(Button, {
			variant: isEditingProxy ? 'primary' : 'default', size: 'sm', className: 'agy-btn',
			style: { gap: '3px', fontSize: '11px', padding: '2px 6px' },
			disabled: accountActionBusy(acc, 'proxy'),
			onClick: () => setEditingProxyId(isEditingProxy ? null : acc.id),
		}, [uiIcon('globe', 10), ` ${t('proxy.button')}`]),
		(showRemove ? h(Button, {
			variant: 'danger', size: 'sm', className: 'agy-btn',
			style: { padding: '2px 6px', fontSize: '11px' },
			title: t('account.removeTitle'),
			'aria-label': t('account.removeTitle'),
			disabled: accountActionBusy(acc, 'remove'),
			onClick: () => void handlers.removeAccount(acc.id, displayAlias),
		}, loadingAction === `remove:${acc.id}` ? Spinner() : uiIcon('trash', 11, 'var(--agy-danger-text)')) : null),
	);
}

function renderChildModels(t: Translator, allChildModels: { family: string; model: ModelQuotaInfo }[]): unknown {
	return h('div', {
		style: {
			marginTop: '8px',
			paddingTop: '8px',
			borderTop: '1px solid var(--agy-border-box)',
		},
	},
		h('div', { style: { color: 'var(--agy-text-secondary)', marginBottom: '6px', fontWeight: 600, fontSize: '11px' } }, t('account.models')),
		allChildModels.map(({ family, model }) => {
			const frac = model.remainingFraction ?? 1;
			const pct = Math.round(frac * 100);
			const w = formatQuotaWindow(t, model.resetTime);
			const pColor = pct <= 20 ? 'var(--agy-quota-low-text)' : pct <= 50 ? 'var(--agy-quota-med-text)' : 'var(--agy-quota-high-text)';
			return h('div', { key: `${family}-${model.modelId}`, className: 'agy-submodel-row' },
				h('span', { style: { fontWeight: 500, color: 'var(--agy-text-primary)' } }, `[${family}] ${model.displayName || model.modelId}`),
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
					h('span', { style: { color: pColor, fontWeight: 700 } }, `${pct}%`),
					w.resetText ? h('span', { style: { color: 'var(--agy-text-tertiary)', fontSize: '10.5px' } }, `↻ ${w.resetText}`) : null,
				),
			);
		}),
	);
}

function renderCooldownBanner(
	t: Translator,
	acc: ManagedAccount,
	loadingAction: string | null,
	accountActionBusy: (acc: ManagedAccount, action: string) => boolean,
	handlers: AccountsPanelHandlers,
): unknown {
	return h('div', {
		key: 'cd-body',
		style: {
			background: 'var(--agy-warn-bg)',
			border: '1px solid var(--agy-warn-border)',
			borderRadius: '7px',
			padding: '6px 10px',
			color: 'var(--agy-warn-text)',
			fontSize: '11.5px',
			fontWeight: 600,
			marginTop: '8px',
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'space-between',
		},
	},
		h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
			uiIcon('alert', 13, 'var(--agy-warn-text)'),
			h('span', null, t('account.cooldown')),
		),
		h(Button, {
			variant: 'default', size: 'sm', className: 'agy-btn',
			style: { color: 'var(--agy-warn-btn-text)', borderColor: 'var(--agy-warn-btn-border)', background: 'var(--agy-warn-btn-bg)', gap: '4px' },
			disabled: accountActionBusy(acc, 'clearCooldown'),
			onClick: () => void handlers.clearCooldown(acc.id),
		}, loadingAction === `clearCooldown:${acc.id}` ? [Spinner(), ''] : [uiIcon('zap', 11, 'var(--agy-warn-btn-text)'), ` ${t('account.clearCooldown')}`]),
	);
}

function renderProxyEditor(
	t: Translator,
	acc: ManagedAccount,
	pool: AccountPoolData | undefined,
	proxyInputs: Record<string, string>,
	setProxyInputs: (next: Record<string, string>) => void,
	setEditingProxyId: (id: string | null) => void,
	loadingAction: string | null,
	accountActionBusy: (acc: ManagedAccount, action: string) => boolean,
	handlers: AccountsPanelHandlers,
): unknown {
	return h('div', {
		key: 'proxy-body',
		style: {
			marginTop: '8px',
			padding: '10px 12px',
			background: 'var(--agy-bg-subbox)',
			borderRadius: '7px',
			border: '1px solid var(--agy-border-subbox)',
		},
	},
		h('div', { style: { display: 'flex', gap: '8px' } },
			h('input', {
				style: S.input,
				value: proxyInputs[acc.id] !== undefined ? proxyInputs[acc.id] : (acc.proxyUrl ?? ''),
				placeholder: pool?.systemProxy ? `${t('proxy.placeholder')} (${pool.systemProxy})` : t('proxy.placeholder'),
				'aria-label': t('aria.proxyInput'),
				onChange: (e: { target: { value: string } }) => setProxyInputs({ ...proxyInputs, [acc.id]: e.target.value }),
			}),
			h(Button, {
				variant: 'primary', className: 'agy-btn',
				disabled: accountActionBusy(acc, 'proxy'),
				onClick: () => void handlers.saveProxy(acc.id),
			}, loadingAction === `proxy:${acc.id}` ? [Spinner(), t('proxy.save')] : t('proxy.save')),
			h(Button, {
				variant: 'default', className: 'agy-btn',
				onClick: () => setEditingProxyId(null),
			}, t('cancel')),
		),
	);
}
