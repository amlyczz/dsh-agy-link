// Model selection panel: one chip per model, ticked = that model appears in
// DSH's model picker.
//
// Semantics that matter:
//   - An EMPTY selection means "no restriction" (every model shows). That is the
//     shipped default, and unticking the last model must not blank the picker,
//     so the panel renders every chip as ticked in that state.
//   - The list is the full selectable universe (never pre-filtered), otherwise
//     an unticked model could never be ticked again.
//   - A model can still be denied outright by the `hiddenModels` deny-list
//     (config/env escape hatch). Such a chip shows as dimmed and explains why,
//     so a ticked-but-invisible model is never a silent mystery.

import { h } from '../react.ts';
import { S } from '../styles.ts';
import { Button } from '../ui/Button.ts';
import type { Translator } from '../hooks/useTranslation.ts';
import { effortLabel } from '../../common/reasoning.ts';
import { modelMatches } from '../../common/pool-types.ts';
import type { CatalogModelView } from '../status.ts';

export interface ModelsPanelProps {
	t: Translator;
	catalogModels: ReadonlyArray<CatalogModelView>;
	hiddenModelSet: Set<string>;
	/** Empty set = no allow-list, i.e. everything is shown. */
	selectedModelSet: Set<string>;
	loadingAction: string | null;
	setSelectedModels: (ids: ReadonlyArray<string>) => Promise<void>;
	/** Rewrite the legacy `hiddenModels` deny-list (used to un-deny a chip). */
	setHiddenModels?: (ids: ReadonlyArray<string>) => Promise<void>;
}

/** What one chip click writes: a new allow-list, a new deny-list, or both. */
export interface ChipClickPlan {
	selected?: string[];
	hidden?: string[];
}

/**
 * Pure click planner for one model chip.
 *
 * Clicking a chip denied by a legacy `hiddenModels` entry un-denies it (and its
 * effort variants) and ticks it when the allow-list is restrictive.
 */
export function planChipClick(params: {
	id: string;
	catalogIds: ReadonlyArray<string>;
	hidden: ReadonlyArray<string>;
	selected: ReadonlyArray<string>;
}): ChipClickPlan {
	const { id, catalogIds, hidden, selected } = params;
	const unrestricted = selected.length === 0;
	const isTicked = (x: string): boolean => unrestricted || selected.some((want) => modelMatches(want, x));
	const hiddenSet = new Set(hidden);

	if (hidden.some((h) => modelMatches(h, id))) {
		const plan: ChipClickPlan = { hidden: hidden.filter((h) => !modelMatches(h, id)) };
		if (!isTicked(id)) plan.selected = [...selected, id];
		return plan;
	}
	if (!unrestricted) {
		const next = new Set(selected.filter((want) => !modelMatches(want, id)));
		if (!isTicked(id)) next.add(id);
		return { selected: Array.from(next) };
	}
	return { selected: catalogIds.filter((m) => !hiddenSet.has(m) && m !== id) };
}

export function ModelsPanel({ t, catalogModels, hiddenModelSet, selectedModelSet, loadingAction, setSelectedModels, setHiddenModels }: ModelsPanelProps): unknown {
	const unrestricted = selectedModelSet.size === 0;
	// Match the host's rule, not a plain set lookup: a stored selection can name
	// an effort variant (`gemini-4-hydrogen-tiered`) that has since folded into
	// its base row. The host still treats that row as ticked via modelMatches, so
	// the chip has to agree - otherwise the panel renders a model as unticked
	// while the picker keeps showing it.
	const selected = Array.from(selectedModelSet);
	const isTicked = (id: string): boolean => unrestricted || selected.some((want) => modelMatches(want, id));
	const isVisible = (id: string): boolean => !hiddenModelSet.has(id) && isTicked(id);
	const visibleCount = catalogModels.filter((m) => isVisible(m.id)).length;
	const busy = loadingAction === 'config:selectedModels' || loadingAction === 'config:hiddenModels';

	const onChipClick = (id: string): void => {
		const plan = planChipClick({
			id,
			catalogIds: catalogModels.map((m) => m.id),
			hidden: Array.from(hiddenModelSet),
			selected,
		});
		void (async () => {
			if (plan.hidden !== undefined && setHiddenModels !== undefined) await setHiddenModels(plan.hidden);
			if (plan.selected !== undefined) await setSelectedModels(plan.selected);
		})();
	};

	return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
		h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px' } },
			t('models.label', { selected: visibleCount, total: catalogModels.length })),
		catalogModels.length === 0
			? h('span', { style: S.muted }, t('models.empty'))
			: h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
				catalogModels.map((m) => {
					const denied = hiddenModelSet.has(m.id);
					const ticked = isVisible(m.id);
					// One chip per MODEL. Its effort levels are folded into the
					// model (agy lists them as separate slugs); the tooltip names
					// them so a single chip never looks like a missing entry.
					const efforts = (m.efforts ?? []).map((id) => effortLabel(id));
					const title = (efforts.length > 0 ? m.id + ' · ' + efforts.join(' / ') : m.id)
						+ (denied ? '\n' + t('models.deniedHint') : '');
					return h(Button, {
						key: m.id,
						variant: ticked ? 'segActive' : 'seg',
						title,
						disabled: busy,
						style: ticked ? undefined : { opacity: 0.45, textDecoration: 'line-through' },
						onClick: () => onChipClick(m.id),
					}, m.name);
				}),
			),
		h('span', { style: S.muted }, t('models.hint')),
	);
}
