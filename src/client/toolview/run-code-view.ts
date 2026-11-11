// run_code toolview: an agy mirror wrapper renders the native Antigravity card,
// every other run_code program renders a code card.

import { isError, isSettled, parsedArgsRaw } from './args.ts';
import { CopyButton } from './card-bodies.ts';
import { clip, cls, tr } from './format.ts';
import { IconChevronDownOutline14, IconCodeOutline16, IconInspectOutline12 } from './icons.ts';
import { AgyMirrorToolView } from './mirror-view.ts';
import { hx } from './runtime.ts';
import { useToggle } from './toggle.ts';
import type { AgyToolViewProps, ToolBlock } from './types.ts';

/** Extract the agy mirror cursor (and tool name) from a run_code program. */
function parseAgyMirrorFromCode(argsRaw: string): { run: string; step: number; tool?: string } | null {
	try {
		const parsed = JSON.parse(argsRaw) as { code?: unknown };
		const code = typeof parsed?.code === 'string' ? parsed.code : '';
		const m = /tools\['agy_tool'\]\((\{.*?"step":\d+\})\)/.exec(code);
		if (!m) return null;
		const v = JSON.parse(m[1] as string) as { run?: unknown; step?: unknown };
		if (typeof v.run !== 'string' || typeof v.step !== 'number') return null;
		const tm = /replay recorded agy tool step \d+ \(([^)]+)\)/.exec(code);
		return { run: v.run, step: v.step, tool: tm?.[1] };
	} catch { /* not a mirror program */ }
	return null;
}

/** Project a run_code program into the fields the code card renders. */
export function runCodeModel(block?: ToolBlock): { code: string; title: string } {
	const raw = block !== undefined ? parsedArgsRaw(block) : '{}';
	let code = raw;
	let description: string | undefined;
	try {
		const parsed = JSON.parse(raw) as { code?: unknown; description?: unknown };
		if (typeof parsed?.code === 'string') code = parsed.code;
		if (typeof parsed?.description === 'string' && parsed.description !== '') description = parsed.description;
	} catch { /* raw args are not JSON — show them verbatim */ }
	const firstLine = code.split('\n').find((line) => line.trim() !== '');
	const title = description
		?? (firstLine !== undefined && firstLine.trim() !== '' ? firstLine.trim().slice(0, 120) : 'run_code');
	return { code, title };
}

/**
 * Ordinary run_code toolview.
 *
 * The keyed `tool.call.toolview` registration for `run_code` REPLACES the
 * host's built-in code row rather than adding to it, so this branch owns the
 * icon, title, summary and expandable body for every non-mirror program. It
 * reuses the same styled vocabulary as the mirror card (`agy-tv-row` and
 * friends) so an ordinary Code Mode call reads exactly like a native tool row.
 */
export function AgyCodeToolView(props?: AgyToolViewProps): unknown {
	const h = hx;
	const { block, inspect, t, callId } = props ?? ({} as AgyToolViewProps);
	const model = runCodeModel(block);
	const cardKey = callId ? `call:${callId}` : `code:${model.title}`;
	const [open, setOpen] = useToggle(false, cardKey);
	const settle = block !== undefined && isSettled(block);
	const err = block !== undefined && isError(block);
	const state: 'ok' | 'err' | 'run' = !settle ? 'run' : err ? 'err' : 'ok';
	const translate = (key: string): string => (typeof t === 'function' ? t(key) : key);

	const leading = open
		? h('span', { className: 'agy-tv-chevron-open' }, IconChevronDownOutline14(14))
		: h('span', { className: 'agy-tv-leading' },
			h('span', { className: 'agy-tv-icon-idle' }, IconCodeOutline16(14)),
			h('span', { className: 'agy-tv-chevron-hover' }, IconChevronDownOutline14(14)),
		);

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
		h('span', { className: 'agy-tv-title' }, translate('code.title')),
		h('span', { className: 'agy-tv-sep', 'aria-hidden': true }),
		h('span', { className: cls('agy-tv-summary', err && 'agy-tv-summary-err'), title: model.title }, model.title),
	);

	const inspectNode = inspect !== undefined
		? h('div', { key: 'ins', style: { padding: '4px 8px 6px' } },
			h('button', { type: 'button', className: 'agy-tv-inspect-btn', onClick: inspect },
				IconInspectOutline12(12), translate('code.inspect')))
		: null;

	const body = h('div', { className: 'agy-tv-card' },
		h('div', { className: 'agy-tv-card-header' },
			h('div', { className: 'agy-tv-card-header-left' },
				IconCodeOutline16(13),
				h('span', { className: 'agy-tv-card-path' }, model.title),
			),
			h(CopyButton, { text: model.code, labels: [translate('code.copy'), translate('code.copied')] }),
		),
		h('pre', { className: 'agy-tv-card-content' }, clip(model.code, 16_000)),
		inspectNode,
	);

	return h('div', {
		className: cls('agy-tv-root', open && 'agy-tv-open'),
		'data-state': state,
		'data-kind': 'code',
	},
		header,
		...(open ? [h('div', { key: 'wrap', className: 'agy-tv-body-wrap' }, body)] : [])
	);
}

/**
 * run_code toolview: when the program is an agy mirror wrapper, render the
 * native Antigravity card instead of a raw code row; every other run_code
 * program renders through {@link AgyCodeToolView}.
 */
export function AgyRunCodeToolView(props?: unknown): unknown {
	const typed = props as AgyToolViewProps | undefined;
	const block = typed?.block;
	const raw = block !== undefined ? parsedArgsRaw(block) : '{}';
	const mirror = parseAgyMirrorFromCode(raw);
	if (mirror === null) return AgyCodeToolView(typed);
	let description: string | undefined;
	try {
		const parsed = JSON.parse(raw) as { description?: unknown };
		if (typeof parsed?.description === 'string' && parsed.description !== '') description = parsed.description;
	} catch { /* ignore */ }
	const synthetic = {
		...block,
		call: {
			...((block as { call?: { name?: string; argsRaw?: string } } | undefined)?.call ?? {}),
			name: 'agy_tool',
			argsRaw: JSON.stringify({
				run: mirror.run,
				step: mirror.step,
				...(mirror.tool !== undefined ? { tool: mirror.tool } : {}),
				...(description !== undefined ? { input: { description } } : {}),
			}),
		},
	} as unknown as ToolBlock;
	return AgyMirrorToolView({ block: synthetic, t: typed?.t } as never);
}
