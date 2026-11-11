// Main mirror tool-card component: collapsed row + expandable body.

import { isError, isSettled } from './args.ts';
import { mirrorCardModel } from './card-model.ts';
import { CardBody } from './card-bodies.ts';
import { cls, diffStat, displaySummary, displayTitle, previewLine, tr } from './format.ts';
import { IconChevronDownOutline14, toolIconFor } from './icons.ts';
import { hx } from './runtime.ts';
import { useToggle } from './toggle.ts';
import type { AgyToolViewProps } from './types.ts';

export function AgyMirrorToolView(props: AgyToolViewProps): unknown {
	const h = hx;
	const { block, cwd, home, openFile, inspect, t, callId } = props;
	const settle = isSettled(block);
	const err = isError(block);
	const model = mirrorCardModel(block, cwd, home);
	const cardKey = callId ? `call:${callId}` : `${model.kind}:${model.tool ?? ''}:${model.title}:${model.path ?? model.command ?? ''}`;
	const [open, setOpen] = useToggle(false, cardKey);
	const state: 'ok' | 'err' | 'run' = !settle ? 'run' : err ? 'err' : 'ok';
	const title = displayTitle(model, t);
	const summary = displaySummary(model, cwd, home);
	const stat = diffStat(model);
	const preview = !open && model.kind !== 'diff' ? previewLine(model, cwd, home) : undefined;
	const hasFileLink = (model.kind === 'diff' || model.kind === 'read') && model.path && openFile !== undefined;

	const onFileClick = (e: { stopPropagation: () => void }) => {
		e.stopPropagation();
		if (model.path && openFile) {
			if (model.location?.line !== undefined) openFile(model.path, { line: model.location.line });
			else openFile(model.path);
		}
	};

	const leading = open
		? h('span', { className: 'agy-tv-chevron-open' }, IconChevronDownOutline14(14))
		: h('span', { className: 'agy-tv-leading' },
			h('span', { className: 'agy-tv-icon-idle' }, toolIconFor(model.kind, 14)),
			h('span', { className: 'agy-tv-chevron-hover' }, IconChevronDownOutline14(14)),
		);

	const summaryNode = hasFileLink
		? h('button', {
			type: 'button',
			className: 'agy-tv-file-link',
			onClick: onFileClick,
			title: model.path,
		}, summary)
		: h('span', {
			className: cls('agy-tv-summary', err && 'agy-tv-summary-err'),
			title: summary,
		}, summary);

	const header = h('div', {
		className: 'agy-tv-row',
		role: 'button',
		tabIndex: 0,
		'aria-expanded': open,
		onClick: (e: { stopPropagation: () => void }) => {
			e.stopPropagation();
			setOpen();
		},
		onKeyDown: (e: { key: string; preventDefault: () => void }) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				setOpen();
			}
		},
		title: inspect !== undefined
			? (open ? tr(t, 'tv.hint.collapseInspect', 'Click to collapse · right-click to inspect') : tr(t, 'tv.hint.expandInspect', 'Click to expand · right-click to inspect'))
			: (open ? tr(t, 'tv.hint.collapse', 'Click to collapse') : tr(t, 'tv.hint.expand', 'Click to expand')),
		onContextMenu: inspect !== undefined ? (e: { preventDefault: () => void }) => { e.preventDefault(); inspect(); } : undefined,
	},
		leading,
		h('span', { className: 'agy-tv-title' }, title),
		h('span', { className: 'agy-tv-sep', 'aria-hidden': true }),
		summaryNode,
		...(stat !== null ? [h('span', { key: 'stat', className: 'agy-tv-diff-stat' }, stat)] : []),
		...(preview !== undefined ? [h('span', { key: 'prev', className: 'agy-tv-preview', title: preview }, preview)] : []),
	);

	return h('div', {
		className: cls('agy-tv-root', open && 'agy-tv-open'),
		'data-state': state,
		'data-kind': model.kind,
	},
		header,
		...(open ? [h('div', { key: 'wrap', className: 'agy-tv-body-wrap' },
			h(CardBody, { model, openFile, cwd, home, inspect, t })
		)] : [])
	);
}
