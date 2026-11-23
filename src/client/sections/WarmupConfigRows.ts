// Warmup tuning rows (window mode, monitored models, per-run probe budget).
//
// Split out of SettingsSection so that file stays under the module budget and
// so the risk-control knobs live next to the behaviour they bound in
// src/features/warmup/. Every row is a normal config write through `setCfg`,
// which is what makes the scheduler see the change on the next tick.
import { h, useState } from '../react.ts';
import { S } from '../styles.ts';
import type { Translator } from '../hooks/useTranslation.ts';
import type { StatusPayload } from '../status.ts';
import { Button } from '../ui/Button.ts';
import { Row } from '../ui/Row.ts';
import { segGroup } from '../ui/SegGroup.ts';

export interface WarmupConfigProps {
	t: Translator;
	status: StatusPayload;
	loadingAction: string | null;
	setCfg: (key: string, value: unknown) => Promise<void>;
}

function caption(title: string, desc: string): unknown {
	return h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 0' } },
		h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px' } }, title),
		h('span', { style: S.muted }, desc),
	);
}

/** Comma/space separated model list -> string[]; empty string means "family defaults". */
export function parseWarmupModels(text: string): string[] {
	return text
		.split(/[,，\s]+/)
		.map((s) => s.trim())
		.filter((s) => s !== '');
}

function modelsRow(props: WarmupConfigProps): unknown {
	const { t, status, loadingAction, setCfg } = props;
	const saved = (status.warmupModels ?? []).join(', ');
	const [draft, setDraft] = useState<string | null>(null);
	const value = draft ?? saved;
	const parsed = parseWarmupModels(value);
	const dirty = parsed.join(',') !== (status.warmupModels ?? []).join(',');
	const busy = loadingAction === 'config:warmupModels';
	return h(Row, {
		style: { gap: '10px', flexWrap: 'wrap' },
		left: caption(t('config.warmupModelsLabel'), t('config.warmupModelsDesc')),
		right: h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
			h('input', {
				style: { ...S.input, width: '210px', padding: '3px 8px', fontSize: '11.5px' },
				value,
				placeholder: t('config.warmupModelsPlaceholder'),
				'aria-label': t('config.warmupModelsLabel'),
				onChange: (e: { target?: { value?: string } }) => setDraft(e?.target?.value ?? ''),
			}),
			h(Button, {
				variant: 'default',
				size: 'sm',
				className: 'agy-btn',
				disabled: busy || !dirty,
				onClick: () => void setCfg('warmupModels', parsed).then(() => setDraft(null)),
			}, t('config.save')),
		),
	});
}

function maxProbesRow(props: WarmupConfigProps): unknown {
	const { t, status, loadingAction, setCfg } = props;
	const saved = String(status.warmupMaxProbesPerRun ?? 0);
	const [draft, setDraft] = useState<string | null>(null);
	const value = draft ?? saved;
	const num = Number.parseInt(value, 10);
	const valid = Number.isFinite(num) && num >= 0 && num <= 200;
	const busy = loadingAction === 'config:warmupMaxProbesPerRun';
	return h(Row, {
		style: { gap: '10px', flexWrap: 'wrap' },
		left: caption(t('config.warmupMaxProbes'), t('config.warmupMaxProbesDesc')),
		right: h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
			h('input', {
				style: { ...S.input, width: '72px', padding: '3px 8px', fontSize: '11.5px' },
				value,
				inputMode: 'numeric',
				'aria-label': t('config.warmupMaxProbes'),
				onChange: (e: { target?: { value?: string } }) => setDraft(e?.target?.value ?? ''),
			}),
			h(Button, {
				variant: 'default',
				size: 'sm',
				className: 'agy-btn',
				disabled: busy || !valid || String(num) === saved,
				onClick: () => void setCfg('warmupMaxProbesPerRun', num).then(() => setDraft(null)),
			}, t('config.save')),
		),
	});
}

export function warmupConfigRows(props: WarmupConfigProps): unknown[] {
	const { t, status, loadingAction, setCfg } = props;
	const windows: Array<{ id: 'weekly' | '5h' | 'both'; label: string }> = [
		{ id: 'weekly', label: t('config.warmupWindowWeekly') },
		{ id: '5h', label: t('config.warmupWindow5h') },
		{ id: 'both', label: t('config.warmupWindowBoth') },
	];
	const current = status.warmupWindows ?? 'weekly';
	return [
		h(Row, {
			key: 'warmup-windows',
			style: { gap: '10px', flexWrap: 'wrap' },
			left: caption(t('config.warmupWindows'), t('config.warmupWindowsDesc')),
			right: segGroup(windows.map((w) => h(Button, {
				key: w.id,
				variant: current === w.id ? 'segActive' : 'seg',
				disabled: loadingAction === 'config:warmupWindows',
				onClick: () => void setCfg('warmupWindows', w.id),
			}, w.label))),
		}),
		h(modelsRow, { key: 'warmup-models', ...props }),
		h(maxProbesRow, { key: 'warmup-max-probes', ...props }),
	];
}
