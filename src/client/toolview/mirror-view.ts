// Main mirror tool-card component: collapsed row + expandable body.

import { MIRROR_TOOL_RELOAD_NOTICE } from '../../common/mirror-error.ts';
import { isError, isSettled, isTransientMirrorToolNotFound, parseArgs } from './args.ts';
import { mirrorCardModel } from './card-model.ts';
import { CardBody } from './card-bodies.ts';
import { cls, diffStat, displaySummary, displayTitle, previewLine, tr } from './format.ts';
import { IconChevronDownOutline14, toolIconFor } from './icons.ts';
import { hx, react } from './runtime.ts';
import { subscribeToolSeats, toolSeatFor } from '../orchestration/seats.ts';
import { useToggle } from './toggle.ts';
import type { AgyToolViewProps } from './types.ts';

// The card's seat chip: subscribe to the host's (run, step) → seat table.
// Implemented on the lazy `react()` handle so this module stays importable
// without React (the SSR toolview tests load it under plain ESM).
function useSeat(run: string, step: number): ReturnType<typeof toolSeatFor> {
	const R2 = react();
	const [, setTick] = R2.useState<number>(0);
	const subscribe = R2.useEffect;
	if (subscribe !== undefined) {
		subscribe(() => {
			const unsubscribe = subscribeToolSeats(() => setTick((n) => n + 1));
			// First lookup may start the fetch that will notify us.
			toolSeatFor(run, step);
			return unsubscribe;
		}, [run]);
	}
	return toolSeatFor(run, step);
}

export function AgyMirrorToolView(props: AgyToolViewProps): unknown {
	const h = hx;
	const { block, cwd, home, openFile, inspect, t, callId } = props;
	const settle = isSettled(block);
	const transientMirrorMiss = isTransientMirrorToolNotFound(block);
	const err = !transientMirrorMiss && isError(block);
	const baseModel = mirrorCardModel(block, cwd, home);
	if (baseModel.kind === 'checklist' && !err) {
		return null;
	}
	const model = transientMirrorMiss
		? { ...baseModel, output: tr(t, 'tv.mirrorReloadSkipped', MIRROR_TOOL_RELOAD_NOTICE) }
		: baseModel;
	const cardKey = callId ? `call:${callId}` : `${model.kind}:${model.tool ?? ''}:${model.title}:${model.path ?? model.command ?? ''}`;
	const defaultOpen = model.kind === 'checklist';
	const [open, setOpen] = useToggle(defaultOpen, cardKey);
	const state: 'ok' | 'err' | 'run' = !settle ? 'run' : err ? 'err' : 'ok';
	const title = displayTitle(model, t);
	const summary = displaySummary(model, cwd, home, t);
	const stat = diffStat(model);
	const preview = !open && model.kind !== 'diff' ? previewLine(model, cwd, home) : undefined;
	const hasFileLink = (model.kind === 'diff' || model.kind === 'read') && model.path && openFile !== undefined;
	// Orchestrator sessions run two seats; the host attributes each step to the
	// model that drove it, and the badge says which one this card belongs to.
	const args = parseArgs(block);
	const seatRun = typeof args?.run === 'string' ? args.run : '';
	const seatStep = typeof args?.step === 'number' ? args.step : -1;
	const seat = useSeat(seatRun, seatStep);
	const seatBadge = seat === undefined || seat.seat === 'unknown'
		? null
		: h('span', {
			className: 'agy-tv-seat',
			title: (seat.seat === 'planner' ? 'planner' : 'executor') + (seat.model !== undefined ? ' · ' + seat.model : ''),
			style: {
				display: 'inline-flex',
				alignItems: 'center',
				height: '15px',
				padding: '0 5px',
				borderRadius: '7px',
				fontSize: '9.5px',
				fontWeight: 700,
				lineHeight: '15px',
				letterSpacing: '0.02em',
				flexShrink: 0,
				color: seat.seat === 'planner' ? '#8b5cf6' : '#10b981',
				border: '1px solid ' + (seat.seat === 'planner' ? '#8b5cf6' : '#10b981'),
				opacity: 0.9,
				whiteSpace: 'nowrap',
			},
		}, seat.seat === 'planner' ? 'PLN' : 'EXE');

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
		...(seatBadge !== null ? [h('span', { key: 'seat', style: { marginLeft: 'auto', display: 'inline-flex' } }, seatBadge)] : []),
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
