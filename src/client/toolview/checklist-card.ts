// Visual step-checklist card body for Antigravity's `update_steps` / `todo_write` tool.
import type { ChecklistStepItem, ChecklistStepStatus } from '../../common/checklist.ts';
import { translateOr } from '../i18n-bridge.ts';
import { ensureExtendedToolStyles } from './extended-styles.ts';
import { tr, type Translate } from './format.ts';
import { hx } from './runtime.ts';
import type { MirrorCardModel } from './types.ts';

function stepStatusIcon(status: ChecklistStepStatus): unknown {
	const common = {
		width: 16,
		height: 16,
		viewBox: '0 0 16 16',
		fill: 'none',
		stroke: 'currentColor',
		strokeWidth: 1.5,
		strokeLinecap: 'round',
		strokeLinejoin: 'round',
		style: { display: 'block', flexShrink: 0 },
		'aria-hidden': true,
	};
	switch (status) {
		case 'done':
			return hx('svg', common,
				hx('circle', { cx: 8, cy: 8, r: 6 }),
				hx('path', { d: 'M5.4 8.2l1.8 1.8 3.5-3.7' }),
			);
		case 'in_progress':
			return hx('svg', common,
				hx('circle', { cx: 8, cy: 8, r: 6 }),
				hx('circle', { cx: 8, cy: 8, r: 2.3, fill: 'currentColor', stroke: 'none' }),
			);
		case 'skipped':
			return hx('svg', common,
				hx('circle', { cx: 8, cy: 8, r: 6 }),
				hx('path', { d: 'M5.5 8h5' }),
			);
		case 'failed':
			return hx('svg', common,
				hx('circle', { cx: 8, cy: 8, r: 6 }),
				hx('path', { d: 'M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4' }),
			);
		default:
			return hx('svg', common,
				hx('circle', { cx: 8, cy: 8, r: 6 }),
			);
	}
}

export function ChecklistCardBody({ model, t }: { model: MirrorCardModel; t?: Translate }): unknown {
	ensureExtendedToolStyles();
	const h = hx;
	const steps: readonly ChecklistStepItem[] = model.checklist ?? [];
	const badges = model.badges ?? [];

	if (steps.length === 0) {
		const fallback = model.output && model.output !== ''
			? model.output
			: (t ? tr(t, 'tv.noDetail', '(no detail)') : translateOr('tv.noDetail', '(no detail)'));
		return h('div', { className: 'agy-tv-checklist-wrap' },
			h('div', { className: 'agy-tv-checklist-empty' }, fallback),
		);
	}

	return h('div', { className: 'agy-tv-checklist-wrap' },
		badges.length > 1
			? h('div', { className: 'agy-tv-ext-badges' },
				...badges.map((b, i) => h('span', {
					key: 'cb-' + i,
					className: 'agy-tv-ext-badge',
					'data-tone': b.tone ?? 'neutral',
				}, b.label)),
			)
			: null,
		h('div', { className: 'agy-tv-checklist-list', role: 'list' },
			...steps.map((step, i) => h('div', {
				key: 'cs-' + i,
				className: 'agy-tv-checklist-row',
				'data-status': step.status,
				role: 'listitem',
			},
				h('span', { className: 'agy-tv-checklist-icon' }, stepStatusIcon(step.status)),
				h('span', { className: 'agy-tv-checklist-title' }, step.title),
			)),
		),
	);
}
