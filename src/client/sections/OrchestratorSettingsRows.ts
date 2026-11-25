// Orchestrator Planner / Executor rows rendered inside SettingsSection -> Runtime Controls.

import {
	modelEfforts,
	orchestratorEffortOptions,
	orchestratorRoleModelsFor,
	translateModelOptions,
	type EffortLabels,
} from '../config-options.ts';
import type { Translator } from '../hooks/useTranslation.ts';
import { h } from '../react.ts';
import type { CatalogModelView, StatusPayload } from '../status.ts';
import { S } from '../styles.ts';
import { Row, rowCaption } from '../ui/Row.ts';
import { Select } from '../ui/Select.ts';

interface OrchestratorRoleSpec {
	role: 'planner' | 'executor';
	titleKey: 'config.orchestratorPlanner' | 'config.orchestratorExecutor';
	descKey: 'config.orchestratorPlannerDesc' | 'config.orchestratorExecutorDesc';
	modelAriaKey: 'config.orchestratorPlannerModel' | 'config.orchestratorExecutorModel';
	effortAriaKey: 'config.orchestratorPlannerEffort' | 'config.orchestratorExecutorEffort';
	modelKey: 'orchestratorPlannerModel' | 'orchestratorExecutorModel';
	effortKey: 'orchestratorPlannerEffort' | 'orchestratorExecutorEffort';
	currentModel: (status: StatusPayload) => string;
	currentEffort: (status: StatusPayload) => string;
}

const ROLE_SPECS: ReadonlyArray<OrchestratorRoleSpec> = [
	{
		role: 'planner',
		titleKey: 'config.orchestratorPlanner',
		descKey: 'config.orchestratorPlannerDesc',
		modelAriaKey: 'config.orchestratorPlannerModel',
		effortAriaKey: 'config.orchestratorPlannerEffort',
		modelKey: 'orchestratorPlannerModel',
		effortKey: 'orchestratorPlannerEffort',
		currentModel: (s) => s.orchestratorPlannerModel ?? '',
		currentEffort: (s) => s.orchestratorPlannerEffort ?? '',
	},
	{
		role: 'executor',
		titleKey: 'config.orchestratorExecutor',
		descKey: 'config.orchestratorExecutorDesc',
		modelAriaKey: 'config.orchestratorExecutorModel',
		effortAriaKey: 'config.orchestratorExecutorEffort',
		modelKey: 'orchestratorExecutorModel',
		effortKey: 'orchestratorExecutorEffort',
		currentModel: (s) => s.orchestratorExecutorModel ?? '',
		currentEffort: (s) => s.orchestratorExecutorEffort ?? '',
	},
];

export function renderOrchestratorRows(
	t: Translator,
	status: StatusPayload,
	catalogModels: ReadonlyArray<CatalogModelView>,
	loadingAction: string | null,
	setCfg: (key: string, value: unknown) => Promise<void>,
	labels: EffortLabels,
): unknown[] {
	const autoLabel = t('config.orchestratorModelAuto');

	async function onModelChange(spec: OrchestratorRoleSpec, nextModel: string, currentEffort: string): Promise<void> {
		await setCfg(spec.modelKey, nextModel);
		if (currentEffort.trim() === '') return;
		// Each seat has its own agy whitelist (issue #204), so the effort lookup
		// must use the SAME role-filtered catalog the select rendered from.
		const roleCatalog = orchestratorRoleModelsFor(spec.role, catalogModels);
		const trimmed = nextModel.trim();
		const entry = trimmed === '' ? undefined : roleCatalog.find((m) => m.id === trimmed);
		const supported = trimmed === '' ? [] : entry ? modelEfforts(entry) : undefined;
		if (supported !== undefined && !supported.includes(currentEffort.trim().toLowerCase())) {
			await setCfg(spec.effortKey, '');
		}
	}

	return ROLE_SPECS.map((spec) => {
		const busy = Boolean(loadingAction);
		const currentModel = spec.currentModel(status);
		const currentEffort = spec.currentEffort(status);
		const roleCatalog = orchestratorRoleModelsFor(spec.role, catalogModels);
		const effortOptions = orchestratorEffortOptions(currentEffort, labels, currentModel, roleCatalog);
		return h(Row, {
			key: spec.role,
			left: rowCaption(t(spec.titleKey), t(spec.descKey)),
			right: h('div', { style: S.cfgRowRight },
				h(Select, {
					ariaLabel: t(spec.modelAriaKey),
					disabled: busy,
					value: currentModel,
					options: translateModelOptions(currentModel, roleCatalog, autoLabel),
					style: { maxWidth: '100%' },
					onChange: (e: { target?: { value?: string } }) => void onModelChange(spec, e?.target?.value ?? '', currentEffort),
				}),
				h(Select, {
					ariaLabel: t(spec.effortAriaKey),
					disabled: busy || effortOptions.length <= 1,
					value: currentEffort,
					options: effortOptions,
					onChange: (e: { target?: { value?: string } }) => void setCfg(spec.effortKey, e?.target?.value ?? ''),
				}),
			),
		});
	});
}
