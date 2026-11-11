// Model visibility panel: the catalog chip list where an enabled chip is
// visible and a struck-through, dimmed chip is hidden from the pickers.

import { h } from '../react.ts';
import { S } from '../styles.ts';
import { Button } from '../ui/Button.ts';
import type { Translator } from '../hooks/useTranslation.ts';

export interface ModelsPanelProps {
	t: Translator;
	catalogModels: ReadonlyArray<{ id: string; name: string }>;
	hiddenModelSet: Set<string>;
	loadingAction: string | null;
	toggleModelHidden: (id: string, hide: boolean) => Promise<void>;
}

export function ModelsPanel({ t, catalogModels, hiddenModelSet, loadingAction, toggleModelHidden }: ModelsPanelProps): unknown {
	return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
		h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px' } }, t('models.label')),
		catalogModels.length === 0
			? h('span', { style: S.muted }, t('models.empty'))
			: h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
				catalogModels.map((m) => {
					const isHidden = hiddenModelSet.has(m.id);
					return h(Button, {
						key: m.id,
						variant: isHidden ? 'seg' : 'segActive',
						title: m.id,
						disabled: loadingAction === 'config:hiddenModels',
						style: isHidden ? { opacity: 0.45, textDecoration: 'line-through' } : undefined,
						onClick: () => void toggleModelHidden(m.id, !isHidden),
					}, m.name);
				}),
			),
		h('span', { style: S.muted }, t('models.hint')),
	);
}
