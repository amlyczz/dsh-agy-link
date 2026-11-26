// Runtime controls exposed in SettingsSection: permission mode (skip/auto/accept-edits/plan),
// OS terminal sandbox (--sandbox), execution transport (cli/acp), in-chat agy_image tool,
// multi-account customization sync, and default custom agent (--agent).
import { h, useEffect, useState } from '../react.ts';
import { S } from '../styles.ts';
import type { Translator } from '../hooks/useTranslation.ts';
import type { StatusPayload } from '../status.ts';
import { Button } from '../ui/Button.ts';
import { Row, rowCaption } from '../ui/Row.ts';
import { segGroup } from '../ui/SegGroup.ts';

export interface RuntimeControlsProps {
	t: Translator;
	status: StatusPayload;
	loadingAction: string | null;
	setCfg: (key: string, value: unknown) => Promise<void>;
	exclude?: {
		imageTool?: boolean;
		syncCustomizations?: boolean;
	};
}

function boolRow(opts: {
	t: Translator;
	title: string;
	desc: string;
	cfgKey: string;
	value: boolean;
	loadingAction: string | null;
	setCfg: (key: string, value: unknown) => Promise<void>;
}): unknown {
	return h(Row, {
		left: rowCaption(opts.title, opts.desc),
		right: segGroup([
			h(Button, {
				key: 'on',
				variant: opts.value ? 'segActive' : 'seg',
				disabled: opts.loadingAction === 'config:' + opts.cfgKey,
				onClick: () => void opts.setCfg(opts.cfgKey, true),
			}, opts.t('config.on')),
			h(Button, {
				key: 'off',
				variant: !opts.value ? 'segActive' : 'seg',
				disabled: opts.loadingAction === 'config:' + opts.cfgKey,
				onClick: () => void opts.setCfg(opts.cfgKey, false),
			}, opts.t('config.off')),
		]),
	});
}

function renderPermissionModeRow(props: RuntimeControlsProps): unknown {
	const { t, status, loadingAction, setCfg } = props;
	const cur = status.permissionMode || 'skip';
	const modes: Array<{ id: string; label: string }> = [
		{ id: 'skip', label: t('config.modeSkip') },
		{ id: 'auto', label: t('config.modeAuto') },
		{ id: 'accept-edits', label: t('config.modeAcceptEdits') },
		{ id: 'plan', label: t('config.modePlan') },
	];
	return h(Row, {
		style: { gap: '10px', flexWrap: 'wrap' },
		left: rowCaption(t('config.permissionMode'), t('config.permissionModeDesc')),
		right: segGroup(
			modes.map((m) => h(Button, {
				key: m.id,
				variant: cur === m.id ? 'segActive' : 'seg',
				disabled: loadingAction === 'config:permissionMode',
				onClick: () => void setCfg('permissionMode', m.id),
			}, m.label)),
		),
	});
}

function renderTransportRow(props: RuntimeControlsProps): unknown {
	const { t, status, loadingAction, setCfg } = props;
	const transport = status.transport === 'acp' ? 'acp' : 'cli';
	const acpInfo = status.acpStatus;
	// The badge must describe the REAL machine, not just the pool's own map:
	// `activeProcesses` excludes draining children and any stray `agy acp` the
	// pool lost track of, which is how "1 进程" was shown while two servers ran.
	const procTotal = acpInfo
		? (acpInfo.activeProcesses ?? 0) + (acpInfo.drainingProcesses ?? 0) + (acpInfo.strayProcesses ?? 0)
		: 0;
	const notes: string[] = [];
	if (acpInfo && (acpInfo.drainingProcesses ?? 0) > 0) {
		notes.push(t('config.acpStatsDraining', { draining: acpInfo.drainingProcesses }));
	}
	if (acpInfo && (acpInfo.strayProcesses ?? 0) > 0) {
		notes.push(t('config.acpStatsStray', { stray: acpInfo.strayProcesses }));
	}
	const statsLabel = acpInfo === undefined || acpInfo === null
		? ''
		: t('config.acpStats', { procs: procTotal, sessions: acpInfo.sessions }) + (notes.length > 0 ? ' ' + notes.join(' ') : '');
	return h(Row, {
		style: { gap: '10px', flexWrap: 'wrap' },
		left: rowCaption(t('config.transport'), t('config.transportDesc')),
		right: h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
			transport === 'acp' && acpInfo
				? h('span', { style: S.badgeTag, title: t('config.acpStatsHint') }, statsLabel)
				: null,
			segGroup([
				h(Button, {
					key: 'cli',
					variant: transport === 'cli' ? 'segActive' : 'seg',
					disabled: loadingAction === 'config:transport',
					onClick: () => void setCfg('transport', 'cli'),
				}, t('config.transportCli')),
				h(Button, {
					key: 'acp',
					variant: transport === 'acp' ? 'segActive' : 'seg',
					disabled: loadingAction === 'config:transport',
					onClick: () => void setCfg('transport', 'acp'),
				}, t('config.transportAcp')),
			]),
		),
	});
}

function renderAgentRow(props: RuntimeControlsProps & {
	draft: string;
	setDraft: (v: string) => void;
}): unknown {
	const { t, status, loadingAction, setCfg, draft, setDraft } = props;
	const saved = (status.agent ?? '').trim();
	const busy = loadingAction === 'config:agent';
	return h(Row, {
		left: rowCaption(t('config.agent'), t('config.agentDesc')),
		right: h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', maxWidth: '100%' } },
			h('input', {
				style: { ...S.input, width: '165px', maxWidth: '100%', padding: '3px 8px', fontSize: '11.5px' },
				value: draft,
				placeholder: t('config.agentPlaceholder'),
				'aria-label': t('config.agent'),
				onChange: (e: { target?: { value?: string } }) => setDraft(e?.target?.value ?? ''),
			}),
			h(Button, {
				variant: 'default',
				size: 'sm',
				className: 'agy-btn',
				disabled: busy || draft.trim() === saved,
				onClick: () => void setCfg('agent', draft.trim()),
			}, t('config.save')),
			saved !== ''
				? h(Button, {
					variant: 'default',
					size: 'sm',
					className: 'agy-btn',
					disabled: busy,
					onClick: () => void setCfg('agent', ''),
				}, t('config.clear'))
				: null,
		),
	});
}

export function renderImageToolRow(props: RuntimeControlsProps): unknown {
	return boolRow({
		t: props.t,
		title: props.t('config.imageTool'),
		desc: props.t('config.imageToolDesc'),
		cfgKey: 'imageTool',
		value: props.status.imageTool !== false,
		loadingAction: props.loadingAction,
		setCfg: props.setCfg,
	});
}

export function renderSyncCustomizationsRow(props: RuntimeControlsProps): unknown {
	return boolRow({
		t: props.t,
		title: props.t('config.syncCustomizations'),
		desc: props.t('config.syncCustomizationsDesc'),
		cfgKey: 'syncAccountCustomizations',
		value: props.status.syncAccountCustomizations !== false,
		loadingAction: props.loadingAction,
		setCfg: props.setCfg,
	});
}

export function RuntimeControlsSection(props: RuntimeControlsProps): unknown {
	const { t, status, loadingAction, setCfg, exclude } = props;
	const [agentDraft, setAgentDraft] = useState(status.agent ?? '');
	useEffect(() => {
		setAgentDraft(status.agent ?? '');
	}, [status.agent]);

	return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
		renderPermissionModeRow(props),
		boolRow({
			t,
			title: t('config.sandbox'),
			desc: t('config.sandboxDesc'),
			cfgKey: 'sandbox',
			value: status.sandbox === true,
			loadingAction,
			setCfg,
		}),
		renderTransportRow(props),
		exclude?.imageTool ? null : renderImageToolRow(props),
		exclude?.syncCustomizations ? null : renderSyncCustomizationsRow(props),
		// Opt-in: an absent field means "off", so the switch must not claim to be
		// on when the host never reported a value.
		boolRow({
			t,
			title: t('config.backgroundWakeup'),
			desc: t('config.backgroundWakeupDesc'),
			cfgKey: 'backgroundWakeup',
			value: status.backgroundWakeup === true,
			loadingAction,
			setCfg,
		}),
		// Reverse MCP bridge: experimental and off by default, but it MUST be
		// reachable from the panel — it used to have no UI, no settable HTTP key,
		// and a hand-edited runtime-overrides.json that never took effect (#196).
		boolRow({
			t,
			title: t('config.mcpBridge'),
			desc: t('config.mcpBridgeDesc'),
			cfgKey: 'mcpBridge',
			value: status.mcpBridge === true,
			loadingAction,
			setCfg,
		}),
		h(Row, {
			left: rowCaption(t('config.mcpBridgeScope'), t('config.mcpBridgeScopeDesc')),
			right: segGroup((['all', 'host-only'] as const).map(scope => h(Button, {
				key: scope,
				variant: (status.mcpBridgeScope ?? 'all') === scope ? 'segActive' : 'seg',
				disabled: loadingAction === 'config:mcpBridgeScope',
				onClick: () => void setCfg('mcpBridgeScope', scope),
			}, t(scope === 'all' ? 'config.mcpScopeAll' : 'config.mcpScopeHostOnly')))),
		}),
		// Issue #201: a user with a dedicated /btw plugin may not want this one
		// registered. Off needs a restart (commands are registered at startup).
		boolRow({
			t,
			title: t('config.btwEnabled'),
			desc: t('config.btwEnabledDesc'),
			cfgKey: 'btwEnabled',
			value: status.btwEnabled !== false,
			loadingAction,
			setCfg,
		}),
		renderAgentRow({ ...props, draft: agentDraft, setDraft: setAgentDraft }),
	);
}
