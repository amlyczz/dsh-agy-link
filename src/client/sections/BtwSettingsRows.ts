// `/btw` side-question model and effort selector row for SettingsSection -> Features tab.
import {
	modelEfforts,
	orchestratorRoleModels,
	translateEffortOptions,
	translateModelOptions,
	type EffortLabels,
} from '../config-options.ts';
import type { Translator } from '../hooks/useTranslation.ts';
import { h } from '../react.ts';
import type { CatalogModelView, StatusPayload } from '../status.ts';
import { S } from '../styles.ts';
import { Row, rowCaption } from '../ui/Row.ts';
import { Select } from '../ui/Select.ts';

export function renderBtwRow(
	t: Translator,
	status: StatusPayload,
	catalogModels: ReadonlyArray<CatalogModelView>,
	loadingAction: string | null,
	setCfg: (key: string, value: unknown) => Promise<void>,
	labels: EffortLabels,
): unknown {
	const selectableModels = orchestratorRoleModels(catalogModels);
	const currentModel = status.btwModel ?? '';
	const currentEffort = status.btwEffort ?? '';

	async function onModelChange(nextModel: string): Promise<void> {
		await setCfg('btwModel', nextModel);
		if (currentEffort.trim() === '') return;
		const trimmed = nextModel.trim();
		const entry = trimmed === '' ? undefined : selectableModels.find((m) => m.id === trimmed);
		const supported = trimmed === '' ? undefined : entry ? modelEfforts(entry) : undefined;
		if (supported !== undefined && !supported.includes(currentEffort.trim().toLowerCase())) {
			await setCfg('btwEffort', '');
		}
	}

	return h(Row, {
		key: 'btw-model-row',
		style: { gap: '8px 10px' },
		left: rowCaption(t('config.btw'), t('config.btwDesc')),
		right: h('div', { style: S.cfgRowRight },
			h(Select, {
				value: currentModel,
				ariaLabel: t('config.btwModel'),
				title: t('config.btwModelDesc'),
				disabled: loadingAction === 'config:btwModel',
				onChange: (e: { target?: { value?: string } }) => void onModelChange(e?.target?.value ?? ''),
				options: translateModelOptions(currentModel, selectableModels, t('config.translateModelAuto')),
			}),
			h(Select, {
				value: currentEffort,
				ariaLabel: t('config.btwEffort'),
				title: t('config.btwEffortDesc'),
				style: { minWidth: '78px', maxWidth: '110px' },
				disabled: loadingAction === 'config:btwEffort',
				onChange: (e: { target?: { value?: string } }) => void setCfg('btwEffort', e?.target?.value ?? ''),
				options: translateEffortOptions(currentEffort, labels, currentModel, selectableModels),
			}),
		),
	});
}
