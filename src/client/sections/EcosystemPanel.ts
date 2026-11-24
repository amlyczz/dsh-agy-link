// Collapsible Antigravity ecosystem panel in Settings: lists primary/workspace
// plugins (with enable/disable toggle), MCP servers, custom agents, skills, and
// rules, and triggers on-demand multi-account sync.
import type { EcosystemSnapshot } from '../../common/ecosystem-types.ts';
import { getJson, postJson } from '../api.ts';
import type { Translator } from '../hooks/useTranslation.ts';
import { h, useEffect, useState } from '../react.ts';
import { S } from '../styles.ts';
import { uiIcon } from '../icons.ts';
import { Button } from '../ui/Button.ts';
import type { ToastType } from '../ui/Toast.ts';

export interface EcosystemPanelProps {
	t: Translator;
	currentAgent: string;
	loadingAction: string | null;
	setCfg: (key: string, value: unknown) => Promise<void>;
	showToast: (text: string, type?: ToastType) => void;
	defaultExpanded?: boolean;
}

function summaryBadge(key: string, text: string): unknown {
	return h('span', { key, style: S.badgeTag }, text);
}

/** One row shape for every ecosystem group, so lists read as one surface. */
const listRowStyle = {
	display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0,
	padding: '4px 8px', borderRadius: '6px',
	background: 'var(--agy-bg-subbox)', border: '1px solid var(--agy-border-subbox)',
};

function groupHeading(text: string): unknown {
	return h('div', { style: { fontWeight: 600, fontSize: '11.5px', color: 'var(--agy-text-secondary)' } }, text);
}

function renderPluginsGroup(
	t: Translator,
	snap: EcosystemSnapshot,
	busyId: string | null,
	onToggle: (id: string, enabled: boolean) => void,
): unknown {
	if (snap.plugins.length === 0) return null;
	return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
		groupHeading(t('eco.plugins', { count: snap.plugins.length })),
		...snap.plugins.map((p) =>
			h('div', {
				key: 'pl-' + p.id,
				style: { ...listRowStyle, alignItems: 'center', justifyContent: 'space-between' },
			},
				h('div', { style: { minWidth: 0, flex: '1 1 0' } },
					h('div', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--agy-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: `${p.name} (${p.source})` },
						`${p.name} (${p.source})`,
					),
					p.description
						? h('div', { style: { ...S.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.description)
						: null,
				),
				h(Button, {
					variant: p.enabled ? 'primary' : 'default',
					size: 'sm',
					className: 'agy-btn',
					disabled: busyId === p.id,
					onClick: () => onToggle(p.id, !p.enabled),
				}, p.enabled ? t('config.on') : t('config.off')),
			),
		),
	);
}

function renderAgentsGroup(
	t: Translator,
	snap: EcosystemSnapshot,
	currentAgent: string,
	loadingAction: string | null,
	setCfg: (key: string, value: unknown) => Promise<void>,
): unknown {
	if (snap.agents.length === 0) return null;
	return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
		groupHeading(t('eco.agents', { count: snap.agents.length })),
		...snap.agents.map((a) => {
			const active = currentAgent.trim() === a.name;
			return h('div', {
				key: 'ag-' + a.name + ':' + a.source,
				style: { ...listRowStyle, alignItems: 'center', justifyContent: 'space-between' },
			},
				h('div', { style: { minWidth: 0, flex: '1 1 0' } },
					h('div', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--agy-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: `${a.name} (${a.source})` }, `${a.name} (${a.source})`),
					a.description ? h('div', { style: S.mutedLine, title: a.description }, a.description) : null,
				),
				h(Button, {
					variant: active ? 'primary' : 'default',
					size: 'sm',
					className: 'agy-btn',
					disabled: loadingAction === 'config:agent',
					onClick: () => void setCfg('agent', active ? '' : a.name),
				}, active ? t('eco.activeAgent') : t('eco.useAgent')),
			);
		}),
	);
}

function renderCompactSummaryList(
	t: Translator,
	snap: EcosystemSnapshot,
): unknown {
	const items: unknown[] = [];
	const row = (key: string, label: string, names: readonly string[]): unknown =>
		h('div', { key, style: listRowStyle },
			h('span', { style: { fontSize: '11.5px', fontWeight: 600, color: 'var(--agy-text-primary)', flexShrink: 0 } }, label),
			h('span', { style: { ...S.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, names.join(', ')),
		);
	if (snap.mcpServers.length > 0) {
		items.push(row('mcp', t('eco.mcp', { count: snap.mcpServers.length }), snap.mcpServers.map((m) => m.name)));
	}
	if (snap.skills.length > 0) {
		items.push(row('skills', t('eco.skills', { count: snap.skills.length }), snap.skills.map((s) => s.name)));
	}
	if (snap.rules.length > 0) {
		items.push(row('rules', t('eco.rules', { count: snap.rules.length }), snap.rules.map((r) => r.name)));
	}
	if (items.length === 0 && snap.plugins.length === 0 && snap.agents.length === 0) {
		items.push(h('div', { key: 'empty', style: S.muted }, t('eco.empty')));
	}
	return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } }, ...items);
}

export function EcosystemPanel(props: EcosystemPanelProps): unknown {
	const { t, currentAgent, loadingAction, setCfg, showToast, defaultExpanded = false } = props;
	const [expanded, setExpanded] = useState(defaultExpanded);
	const [snap, setSnap] = useState<EcosystemSnapshot | null>(null);
	const [syncing, setSyncing] = useState(false);
	const [togglingPlugin, setTogglingPlugin] = useState<string | null>(null);

	const loadSnapshot = async (): Promise<void> => {
		const data = await getJson<EcosystemSnapshot & { ok?: boolean }>('/plugins/agy-link/ecosystem');
		if (data && Array.isArray(data.plugins)) {
			setSnap(data);
		}
	};

	useEffect(() => {
		void loadSnapshot();
	}, []);

	const handleSync = async (): Promise<void> => {
		setSyncing(true);
		try {
			const res = await postJson('/plugins/agy-link/ecosystem/sync', {});
			if (res && res.ok) {
				if (res.snapshot) setSnap(res.snapshot as EcosystemSnapshot);
				const r = res.report as { syncedAccounts?: unknown[]; copiedFiles?: number; removedFiles?: number } | undefined;
				showToast(t('eco.synced', {
					accounts: Array.isArray(r?.syncedAccounts) ? r!.syncedAccounts.length : 0,
					copied: r?.copiedFiles ?? 0,
					removed: r?.removedFiles ?? 0,
				}), 'success');
			} else {
				showToast(t('eco.syncFailed'), 'warn');
			}
		} finally {
			setSyncing(false);
		}
	};

	const handleTogglePlugin = async (id: string, enabled: boolean): Promise<void> => {
		setTogglingPlugin(id);
		try {
			const res = await postJson('/plugins/agy-link/ecosystem/plugin', { id, enabled });
			if (res && res.ok && res.snapshot) {
				setSnap(res.snapshot as EcosystemSnapshot);
				showToast(t('eco.pluginToggled', { id }), 'success');
			} else {
				showToast(t('eco.toggleFailed'), 'warn');
			}
		} finally {
			setTogglingPlugin(null);
		}
	};

	const badges = snap ? [
		summaryBadge('pl', t('eco.plugins', { count: snap.plugins.length })),
		summaryBadge('mcp', t('eco.mcp', { count: snap.mcpServers.length })),
		summaryBadge('ag', t('eco.agents', { count: snap.agents.length })),
		summaryBadge('sk', t('eco.skills', { count: snap.skills.length })),
		summaryBadge('rl', t('eco.rules', { count: snap.rules.length })),
	] : [];

	return h('div', { style: { ...S.card, marginTop: '4px', marginBottom: 0, display: 'flex', flexDirection: 'column', gap: '8px' } },
		h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap', minWidth: 0 } },
			h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 180px' } },
				h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px' } }, t('eco.heading')),
				h('span', { style: S.mutedLine, title: t('eco.desc') }, t('eco.desc')),
			),
			h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 } },
				h(Button, {
					variant: 'primary',
					size: 'sm',
					className: 'agy-btn',
					disabled: syncing,
					onClick: () => void handleSync(),
				}, syncing ? t('eco.syncing') : t('eco.syncNow')),
				// Same collapse affordance as the account cards: dashed row + chevron.
				h(Button, {
					variant: 'dashed',
					size: 'sm',
					style: {
						gap: '4px',
						color: expanded ? 'var(--dsw-alias-state-business-primary, #3b82f6)' : 'var(--agy-text-secondary)',
					},
					onClick: () => {
						const next = !expanded;
						setExpanded(next);
						if (next && !snap) void loadSnapshot();
					},
				},
					uiIcon(expanded ? 'chevronUp' : 'chevronDown', 10),
					h('span', null, expanded ? t('eco.collapse') : t('eco.expand')),
				),
			),
		),
		badges.length > 0 ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } }, ...badges) : null,
		expanded && snap
			? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '4px', borderTop: '1px solid var(--agy-border-divider)' } },
				renderPluginsGroup(t, snap, togglingPlugin, (id, en) => void handleTogglePlugin(id, en)),
				renderAgentsGroup(t, snap, currentAgent, loadingAction, setCfg),
				renderCompactSummaryList(t, snap),
			)
			: null,
	);
}
