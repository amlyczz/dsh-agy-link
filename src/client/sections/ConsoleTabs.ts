// Modular console tabs and card-grouped panels for SettingsSection.
// Separates high-frequency account/quota controls from model/orchestrator setup,
// translation/image assistants, and low-frequency runtime/ecosystem settings.
import type { AccountPoolData, ManagedAccount } from '../../common/pool-types.ts';
import type { QuotaFamily } from '../../common/quota-bench.ts';
import { modelMatches } from '../../common/pool-types.ts';
import {
	catalogEfforts,
	geminiCatalogModels,
	translateEffortOptions,
	translateModelOptions,
	type EffortLabels,
} from '../config-options.ts';
import type { Translator } from '../hooks/useTranslation.ts';
import { h } from '../react.ts';
import type { CatalogModelView, StatusPayload } from '../status.ts';
import { S } from '../styles.ts';
import { Button } from '../ui/Button.ts';
import { Row, rowCaption } from '../ui/Row.ts';
import { segGroup } from '../ui/SegGroup.ts';
import { Select } from '../ui/Select.ts';
import type { ToastType } from '../ui/Toast.ts';
import { AccountsPanel, type AccountsPanelHandlers } from './AccountsPanel.ts';
import { renderBtwRow } from './BtwSettingsRows.ts';
import { renderPoolWideCatalogRow } from './CatalogRows.ts';
import { EcosystemPanel } from './EcosystemPanel.ts';
import { renderImageRow } from './ImageSettingsRows.ts';
import { ModelsPanel } from './ModelsPanel.ts';
import { renderOrchestratorRows } from './OrchestratorSettingsRows.ts';
import {
	RuntimeControlsSection,
	renderImageToolRow,
	renderSyncCustomizationsRow,
} from './RuntimeControlsRows.ts';
import { renderHeaderBadgeRow, renderTranslateVisibilityRows } from './VisibilityRows.ts';
import { warmupConfigRows } from './WarmupConfigRows.ts';
import { WarmupStatusBar } from './WarmupStatusBar.ts';

export type ConsoleTabId = 'accounts' | 'models' | 'features' | 'runtime';

export interface ConsoleTabsProps {
	t: Translator;
	activeTab: ConsoleTabId;
	onSelectTab: (tab: ConsoleTabId) => void;
	status: StatusPayload;
	pool: AccountPoolData | undefined;
	accounts: ManagedAccount[];
	accountModels?: Readonly<Record<string, ReadonlyArray<CatalogModelView>>>;
	catalogModels: ReadonlyArray<CatalogModelView>;
	hiddenModelSet: Set<string>;
	selectedModelSet: Set<string>;
	loadingAction: string | null;
	effortLabels: EffortLabels;
	addAccountSection: unknown;
	proxyInputs: Record<string, string>;
	setProxyInputs: (next: Record<string, string>) => void;
	editingProxyId: string | null;
	setEditingProxyId: (id: string | null) => void;
	aliasInputs: Record<string, string>;
	setAliasInputs: (next: Record<string, string>) => void;
	editingAliasId: string | null;
	setEditingAliasId: (id: string | null) => void;
	expandedModels: Record<string, boolean>;
	toggleExpand: (accId: string) => void;
	optimisticActiveByFamily: Partial<Record<QuotaFamily, string>>;
	accountHandlers: AccountsPanelHandlers;
	setCfg: (key: string, value: unknown) => Promise<void>;
	setMode: (mode: string) => Promise<void>;
	setSelectedModels: (ids: ReadonlyArray<string>) => Promise<void>;
	setHiddenModels: (ids: ReadonlyArray<string>) => Promise<void>;
	copyImageCommand: () => void;
	showToast: (text: string, type?: ToastType) => void;
}

function sectionCard(key: string, title: string, children: unknown[], rightHead?: unknown): unknown {
	return h('div', { key, style: S.sectionCard },
		h('div', { style: S.sectionCardHead },
			h('span', { style: S.sectionCardTitle }, title),
			rightHead ?? null,
		),
		...children,
	);
}

function visibleModelCount(
	catalogModels: ReadonlyArray<CatalogModelView>,
	hiddenModelSet: Set<string>,
	selectedModelSet: Set<string>,
): number {
	if (catalogModels.length === 0) return 0;
	const unrestricted = selectedModelSet.size === 0;
	const selected = Array.from(selectedModelSet);
	return catalogModels.filter((m) =>
		!hiddenModelSet.has(m.id) && (unrestricted || selected.some((w) => modelMatches(w, m.id))),
	).length;
}

export function renderConsoleTabBar(params: {
	t: Translator;
	activeTab: ConsoleTabId;
	onSelectTab: (tab: ConsoleTabId) => void;
	accountCount: number;
	visibleModels: number;
	totalModels: number;
}): unknown {
	const { t, activeTab, onSelectTab, accountCount, visibleModels, totalModels } = params;
	const tabs: Array<{ id: ConsoleTabId; label: string; badge?: string }> = [
		{ id: 'accounts', label: t('tab.accounts'), badge: String(accountCount) },
		{
			id: 'models',
			label: t('tab.models'),
			...(totalModels > 0 ? { badge: `${visibleModels}/${totalModels}` } : {}),
		},
		{ id: 'features', label: t('tab.features') },
		{ id: 'runtime', label: t('tab.runtime') },
	];
	return h('div', { className: 'agy-console-tabs', role: 'tablist', style: S.tabBar },
		...tabs.map((tab) => {
			const active = activeTab === tab.id;
			return h('button', {
				key: tab.id,
				type: 'button',
				role: 'tab',
				'aria-selected': active,
				'data-tab': tab.id,
				style: active ? S.tabBtnActive : S.tabBtn,
				onClick: () => onSelectTab(tab.id),
			},
				h('span', null, tab.label),
				tab.badge !== undefined ? h('span', { style: S.tabCount }, tab.badge) : null,
			);
		}),
	);
}

function renderAccountsTab(p: ConsoleTabsProps): unknown {
	const { t, status, pool, accounts, loadingAction, setCfg, setMode } = p;

	return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
		p.addAccountSection,
		h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 2px', gap: '8px', flexWrap: 'wrap' } },
			h('span', { style: { fontWeight: 700, fontSize: '12.5px', color: 'var(--agy-text-primary)' } },
				t('account.poolHeading', { count: accounts.length })),
			h(WarmupStatusBar, { t, warmupState: status.warmupState ?? null, accounts }),
		),
		h(AccountsPanel, {
			t, pool, accounts, accountModels: p.accountModels, loadingAction,
			quotaRefreshing: status.quotaRefreshing ?? [],
			warmupState: status.warmupState ?? null,
			proxyInputs: p.proxyInputs, setProxyInputs: p.setProxyInputs,
			editingProxyId: p.editingProxyId, setEditingProxyId: p.setEditingProxyId,
			aliasInputs: p.aliasInputs, setAliasInputs: p.setAliasInputs,
			editingAliasId: p.editingAliasId, setEditingAliasId: p.setEditingAliasId,
			expandedModels: p.expandedModels, toggleExpand: p.toggleExpand,
			optimisticActiveByFamily: p.optimisticActiveByFamily,
			handlers: p.accountHandlers,
		}),
		sectionCard('pool-schedule', t('section.poolSchedule'), [
			h(Row, {
				key: 'pool-mode',
				left: rowCaption(t('pool.label')),
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
				key: 'auto-warmup',
				left: rowCaption(t('config.autoWarmup'), t('config.autoWarmupDesc')),
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
			...warmupConfigRows({ t, status, loadingAction, setCfg }),
		]),
	);
}

function renderDefaultEffortRow(p: ConsoleTabsProps): unknown {
	const { t, status, catalogModels, loadingAction, setCfg, effortLabels } = p;
	const value = status.defaultEffort;
	const levels = catalogEfforts(catalogModels);
	const configured = (value ?? '').trim().toLowerCase();
	const shown = configured !== '' && !levels.includes(configured) ? [...levels, configured] : levels;
	return h(Row, {
		key: 'default-effort',
		left: rowCaption(t('config.defaultEffort'), t('config.defaultEffortDesc')),
		right: segGroup([
			h(Button, {
				variant: value === '' ? 'segActive' : 'seg',
				disabled: loadingAction === 'config:defaultEffort',
				onClick: () => void setCfg('defaultEffort', ''),
			}, t('effort.auto')),
			...shown.map((level) => h(Button, {
				key: level,
				variant: value === level ? 'segActive' : 'seg',
				disabled: loadingAction === 'config:defaultEffort',
				onClick: () => void setCfg('defaultEffort', level),
			}, effortLabels.level(level))),
		]),
	});
}

function renderModelsTab(p: ConsoleTabsProps): unknown {
	const { t, status, catalogModels, hiddenModelSet, selectedModelSet, loadingAction, setCfg } = p;
	return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
		sectionCard('model-catalog', t('section.modelCatalog'), [
			renderPoolWideCatalogRow({ t, status, loadingAction, setCfg }),
			h('div', { key: 'div', style: { borderTop: '1px solid var(--agy-border-divider)', paddingTop: '8px' } },
				h(ModelsPanel, {
					t, catalogModels, hiddenModelSet, selectedModelSet, loadingAction,
					setSelectedModels: p.setSelectedModels, setHiddenModels: p.setHiddenModels,
				}),
			),
		]),
		sectionCard('thinking-orch', t('section.thinkingOrchestrator'), [
			renderDefaultEffortRow(p),
			...renderOrchestratorRows(t, status, catalogModels, loadingAction, setCfg, p.effortLabels),
		]),
	);
}

function renderFeaturesTab(p: ConsoleTabsProps): unknown {
	const { t, status, catalogModels, loadingAction, setCfg, effortLabels } = p;
	return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
		sectionCard('translation', t('section.translation'), [
			h(Row, {
				key: 'auto-tsl',
				style: { gap: '8px 10px' },
				left: rowCaption(t('config.autoTranslate'), t('config.autoTranslateDesc')),
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
						options: translateEffortOptions(status.translateEffort ?? '', effortLabels, status.translateModel ?? '', catalogModels),
					}),
				),
			}),
			...renderTranslateVisibilityRows({ t, status, loadingAction, setCfg }),
		]),
		sectionCard('image-gen', t('section.imageGen'), [
			renderImageRow(t, status, catalogModels, loadingAction, setCfg, p.copyImageCommand, effortLabels),
			renderImageToolRow({ t, status, loadingAction, setCfg }),
		]),
		sectionCard('btw', t('section.btw'), [
			renderBtwRow(t, status, catalogModels, loadingAction, setCfg, effortLabels),
		]),
		sectionCard('slash-commands', t('section.slashCommands'), [
			h(Row, {
				key: 'slash-direct',
				left: rowCaption(t('slash.directTitle'), t('slash.directDesc')),
				right: h('code', { style: { fontSize: '11px', color: 'var(--agy-text-secondary)', wordBreak: 'break-word' } }, t('slash.directList')),
			}),
			h(Row, {
				key: 'slash-meta',
				left: rowCaption(t('slash.metaTitle'), t('slash.metaDesc')),
				right: h('code', { style: { fontSize: '11px', color: 'var(--agy-text-secondary)', wordBreak: 'break-word' } }, t('slash.metaList')),
			}),
		]),
		sectionCard('ui-display', t('section.uiDisplay'), [
			renderHeaderBadgeRow({ t, status, loadingAction, setCfg }),
		]),
	);
}

function renderRuntimeTab(p: ConsoleTabsProps): unknown {
	const { t, status, loadingAction, setCfg, showToast } = p;
	return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
		sectionCard('execution', t('section.execution'), [
			h(RuntimeControlsSection, {
				t, status, loadingAction, setCfg,
				exclude: { imageTool: true, syncCustomizations: true },
			}),
		]),
		sectionCard('ecosystem', t('section.ecosystem'), [
			renderSyncCustomizationsRow({ t, status, loadingAction, setCfg }),
			h(EcosystemPanel, {
				t, currentAgent: status.agent ?? '', loadingAction, setCfg, showToast,
				defaultExpanded: true,
			}),
		]),
	);
}

export function renderConsoleTabContent(p: ConsoleTabsProps): unknown {
	const visible = visibleModelCount(p.catalogModels, p.hiddenModelSet, p.selectedModelSet);
	const bar = renderConsoleTabBar({
		t: p.t,
		activeTab: p.activeTab,
		onSelectTab: p.onSelectTab,
		accountCount: p.accounts.length,
		visibleModels: visible,
		totalModels: p.catalogModels.length,
	});
	const body = p.activeTab === 'models'
		? renderModelsTab(p)
		: p.activeTab === 'features'
			? renderFeaturesTab(p)
			: p.activeTab === 'runtime'
				? renderRuntimeTab(p)
				: renderAccountsTab(p);
	return h('div', { style: { display: 'flex', flexDirection: 'column' } }, bar, body);
}
