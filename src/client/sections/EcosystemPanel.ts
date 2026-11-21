// Collapsible Antigravity ecosystem panel in Settings: lists primary/workspace
// plugins (with enable/disable toggle), MCP servers, custom agents, skills, and
// rules, and triggers on-demand multi-account sync.
import type { EcosystemSnapshot } from '../../common/ecosystem-types.ts';
import { getJson, postJson } from '../api.ts';
import type { Translator } from '../hooks/useTranslation.ts';
import { h, useEffect, useState } from '../react.ts';
import { S } from '../styles.ts';
import { Button } from '../ui/Button.ts';
import type { ToastType } from '../ui/Toast.ts';

export interface EcosystemPanelProps {
	t: Translator;
	currentAgent: string;
	loadingAction: string | null;
	setCfg: (key: string, value: unknown) => Promise<void>;
	showToast: (text: string, type?: ToastType) => void;
}

function summaryBadge(key: string, text: string): unknown {
	return h('span', { key, style: S.badgeTag }, text);
}

function renderPluginsGroup(
	t: Translator,
	snap: EcosystemSnapshot,
	busyId: string | null,
	onToggle: (id: string, enabled: boolean) => void,
): unknown {
	if (snap.plugins.length === 0) return null;
	return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
		h('div', { style: { fontWeight: 600, fontSize: '11.5px', color: 'var(--agy-text-secondary)' } },
			t('eco.plugins', { count: snap.plugins.length }),
		),
		...snap.plugins.map((p) =>
			h('div', {
				key: 'pl-' + p.id,
				style: {
					display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
					padding: '4px 8px', borderRadius: '6px',
					background: 'var(--agy-bg-subbox)', border: '1px solid var(--agy-border-subbox)',
				},
			},
				h('div', { style: { minWidth: 0, flex: '1 1 0' } },
					h('div', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--agy-text-primary)' } },
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
		h('div', { style: { fontWeight: 600, fontSize: '11.5px', color: 'var(--agy-text-secondary)' } },
			t('eco.agents', { count: snap.agents.length }),
		),
		...snap.agents.map((a) => {
			const active = currentAgent.trim() === a.name;
			return h('div', {
				key: 'ag-' + a.name + ':' + a.source,
				style: {
					display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
					padding: '4px 8px', borderRadius: '6px',
					background: 'var(--agy-bg-subbox)', border: '1px solid var(--agy-border-subbox)',
				},
			},
				h('div', { style: { minWidth: 0, flex: '1 1 0' } },
					h('div', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--agy-text-primary)' } }, `${a.name} (${a.source})`),
					a.description ? h('div', { style: S.muted }, a.description) : null,
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
	if (snap.mcpServers.length > 0) {
		items.push(h('div', { key: 'mcp', style: S.muted },
			`${t('eco.mcp', { count: snap.mcpServers.length })}: ${snap.mcpServers.map((m) => m.name).join(', ')}`,
		));
	}
	if (snap.skills.length > 0) {
		items.push(h('div', { key: 'skills', style: S.muted },
			`${t('eco.skills', { count: snap.skills.length })}: ${snap.skills.map((s) => s.name).join(', ')}`,
		));
	}
	if (snap.rules.length > 0) {
		items.push(h('div', { key: 'rules', style: S.muted },
			`${t('eco.rules', { count: snap.rules.length })}: ${snap.rules.map((r) => r.name).join(', ')}`,
		));
	}
	if (items.length === 0 && snap.plugins.length === 0 && snap.agents.length === 0) {
		items.push(h('div', { key: 'empty', style: S.muted }, t('eco.empty')));
	}
	return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } }, ...items);
}

export function EcosystemPanel(props: EcosystemPanelProps): unknown {
	const { t, currentAgent, loadingAction, setCfg, showToast } = props;
	const [expanded, setExpanded] = useState(false);
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
		h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' } },
			h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 0' } },
				h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px' } }, t('eco.heading')),
				h('span', { style: S.muted }, t('eco.desc')),
			),
			h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 } },
				h(Button, {
					variant: 'default',
					size: 'sm',
					className: 'agy-btn',
					disabled: syncing,
					onClick: () => void handleSync(),
				}, syncing ? t('eco.syncing') : t('eco.syncNow')),
				h(Button, {
					variant: 'default',
					size: 'sm',
					className: 'agy-btn',
					onClick: () => {
						const next = !expanded;
						setExpanded(next);
						if (next && !snap) void loadSnapshot();
					},
				}, expanded ? t('eco.collapse') : t('eco.expand')),
			),
		),
		badges.length > 0 ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '5px' } }, ...badges) : null,
		expanded && snap
			? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '4px', borderTop: '1px solid var(--agy-border-divider)' } },
				renderPluginsGroup(t, snap, togglingPlugin, (id, en) => void handleTogglePlugin(id, en)),
				renderAgentsGroup(t, snap, currentAgent, loadingAction, setCfg),
				renderCompactSummaryList(t, snap),
			)
			: null,
	);
}
