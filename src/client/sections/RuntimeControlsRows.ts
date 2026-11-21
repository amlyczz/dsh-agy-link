// Runtime controls exposed in SettingsSection: permission mode (skip/auto/accept-edits/plan),
// OS terminal sandbox (--sandbox), execution transport (cli/acp), in-chat agy_image tool,
// multi-account customization sync, and default custom agent (--agent).
import { h, useEffect, useState } from '../react.ts';
import { S } from '../styles.ts';
import type { Translator } from '../hooks/useTranslation.ts';
import type { StatusPayload } from '../status.ts';
import { Button } from '../ui/Button.ts';
import { Row } from '../ui/Row.ts';
import { segGroup } from '../ui/SegGroup.ts';

export interface RuntimeControlsProps {
	t: Translator;
	status: StatusPayload;
	loadingAction: string | null;
	setCfg: (key: string, value: unknown) => Promise<void>;
}

function rowCaption(title: string, desc: string): unknown {
	return h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 0' } },
		h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px' } }, title),
		h('span', { style: S.muted }, desc),
	);
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
	return h(Row, {
		style: { gap: '10px', flexWrap: 'wrap' },
		left: rowCaption(t('config.transport'), t('config.transportDesc')),
		right: h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
			transport === 'acp' && acpInfo
				? h('span', { style: S.badgeTag }, t('config.acpStats', { procs: acpInfo.activeProcesses, sessions: acpInfo.sessions }))
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
		style: { gap: '10px', flexWrap: 'wrap' },
		left: rowCaption(t('config.agent'), t('config.agentDesc')),
		right: h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
			h('input', {
				style: { ...S.input, width: '165px', padding: '3px 8px', fontSize: '11.5px' },
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

export function RuntimeControlsSection(props: RuntimeControlsProps): unknown {
	const { t, status, loadingAction, setCfg } = props;
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
		boolRow({
			t,
			title: t('config.imageTool'),
			desc: t('config.imageToolDesc'),
			cfgKey: 'imageTool',
			value: status.imageTool !== false,
			loadingAction,
			setCfg,
		}),
		boolRow({
			t,
			title: t('config.syncCustomizations'),
			desc: t('config.syncCustomizationsDesc'),
			cfgKey: 'syncAccountCustomizations',
			value: status.syncAccountCustomizations !== false,
			loadingAction,
			setCfg,
		}),
		renderAgentRow({ ...props, draft: agentDraft, setDraft: setAgentDraft }),
	);
}
