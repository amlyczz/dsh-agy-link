// Card headers/bodies for the mirror tool cards: the copy button, diff body,
// and one body renderer per card kind. Each helper returns the same DOM the
// original single switch produced.

import {
	IconBrowseOutline16,
	IconCheckOutline14,
	IconCodeOutline16,
	IconCopyOutline16,
	IconEditOutline16,
	IconImageOutline16,
	IconInspectOutline12,
	IconQuestionOutline16,
	IconSearchOutline16,
} from './icons.ts';
import { clip, diffStat, relativize, tr, trimTrailingBlankLines, type Translate } from './format.ts';
import { hx, react } from './runtime.ts';
import type { MirrorCardModel } from './types.ts';
import { ImageCardBody } from './image-card.ts';
import { QuestionCardBody } from './question-card.ts';

// ---- Copy button component ------------------------------------------------

export function CopyButton({ text, labels, t }: { text: string; labels?: readonly [string, string]; t?: Translate }): unknown {
	const [copied, setCopied] = react().useState(false);
	const copyLabel = labels?.[0] ?? tr(t, 'code.copy', 'Copy');
	const copiedLabel = labels?.[1] ?? tr(t, 'code.copied', 'Copied');
	const onCopy = (e: { stopPropagation: () => void }) => {
		e.stopPropagation();
		if (typeof navigator !== 'undefined' && navigator.clipboard) {
			navigator.clipboard.writeText(text).then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			}).catch(() => {
				// Clipboard unavailable (insecure context): show the failure on
				// the button instead of silently doing nothing.
				setCopied(false);
			});
		}
	};
	return hx('button', {
		type: 'button',
		className: 'agy-tv-copy-btn',
		onClick: onCopy,
		title: copied ? copiedLabel : copyLabel,
	},
		copied ? IconCheckOutline14(11) : IconCopyOutline16(11),
		hx('span', null, copied ? copiedLabel : copyLabel)
	);
}

// ---- Diff body renderer ---------------------------------------------------

/** Per-side render cap: a 5000-line write_to_file used to build 10k DOM rows
 *  inside a max-height:280px pane (99% of them invisible). */
const DIFF_MAX_LINES = 400;

export function DiffBody({ model, t }: { model: MirrorCardModel; openFile?: (p: string, o?: unknown) => void; cwd?: string; home?: string; t?: Translate }): unknown {
	const h = hx;
	const oldText = model.oldText ?? '';
	const newText = model.newText ?? '';
	const rows: unknown[] = [];
	const moreRow = (count: number, key: string): unknown =>
		h('div', { key, className: 'agy-tv-diff-line', style: { color: 'var(--dsw-alias-label-tertiary)' } },
			tr(t, 'tv.diffMore', '… {count} more lines not rendered', { count }));
	if (oldText !== '') {
		const lines = oldText.split('\n');
		const shown = Math.min(lines.length, DIFF_MAX_LINES);
		for (let i = 0; i < shown; i++) {
			const line = lines[i];
			rows.push(h('div', { key: 'del-' + i, className: 'agy-tv-diff-line agy-tv-diff-del' },
				h('span', { className: 'agy-tv-diff-marker' }, '-'),
				h('span', { style: { flex: 1 } }, line === '' ? ' ' : line)
			));
		}
		if (lines.length > shown) rows.push(moreRow(lines.length - shown, 'del-more'));
	}
	if (newText !== '') {
		const lines = newText.split('\n');
		const shown = Math.min(lines.length, DIFF_MAX_LINES);
		for (let i = 0; i < shown; i++) {
			const line = lines[i];
			rows.push(h('div', { key: 'add-' + i, className: 'agy-tv-diff-line agy-tv-diff-add' },
				h('span', { className: 'agy-tv-diff-marker' }, '+'),
				h('span', { style: { flex: 1 } }, line === '' ? ' ' : line)
			));
		}
		if (lines.length > shown) rows.push(moreRow(lines.length - shown, 'add-more'));
	}
	if (rows.length === 0) {
		rows.push(h('div', { key: 'empty', className: 'agy-tv-diff-line', style: { color: 'var(--dsw-alias-label-tertiary)' } }, tr(t, 'tv.noChanges', '(no textual changes)')));
	}
	return h('div', { className: 'agy-tv-diff-list' }, ...rows);
}

// ---- Card body renderer ---------------------------------------------------

/** The shared card shell: header row (left cluster + copy action), content, inspect. */
function cardShell(headerLeft: unknown[], copyNode: unknown, content: unknown, inspectNode: unknown): unknown {
	return hx('div', { className: 'agy-tv-card' },
		hx('div', { className: 'agy-tv-card-header' },
			hx('div', { className: 'agy-tv-card-header-left' }, ...headerLeft),
			copyNode
		),
		content,
		inspectNode
	);
}

function inspectButton(inspect: (() => void) | undefined, t?: Translate): unknown {
	return inspect !== undefined
		? hx('div', { key: 'ins', style: { padding: '4px 8px 6px' } },
			hx('button', {
				type: 'button',
				className: 'agy-tv-inspect-btn',
				onClick: inspect,
			}, IconInspectOutline12(12), tr(t, 'code.inspect', 'Inspect'))
		)
		: null;
}

function terminalBody(model: MirrorCardModel, t: Translate | undefined, inspectNode: unknown): unknown {
	const rawBody = model.output !== undefined && model.output !== '' ? trimTrailingBlankLines(model.output) : tr(t, 'tv.noOutput', '(no output)');
	const copyText = model.output !== undefined && model.output !== '' ? model.output : (model.command ?? '');
	return cardShell([
		hx('span', { className: 'agy-tv-prompt-glyph' }, '❯'),
		...(model.cwd ? [hx('span', { key: 'cwd', className: 'agy-tv-card-cwd' }, model.cwd)] : []),
		hx('span', { className: 'agy-tv-card-cmd', title: model.command }, model.command ?? ''),
	], hx(CopyButton, { text: copyText, t }), hx('pre', { className: 'agy-tv-card-content' }, clip(rawBody, 16000)), inspectNode);
}

function diffCard(
	model: MirrorCardModel,
	openFile: ((p: string, o?: unknown) => void) | undefined,
	cwd: string | undefined,
	home: string | undefined,
	t: Translate | undefined,
	inspectNode: unknown,
): unknown {
	const path = model.path ?? 'file';
	const pathLabel = relativize(path, cwd, home);
	const stat = diffStat(model);
	const copyText = model.newText ?? '';
	return cardShell([
		IconEditOutline16(13),
		hx('span', { className: 'agy-tv-card-path' }, pathLabel),
		...(stat ? [hx('span', { key: 's', className: 'agy-tv-diff-stat' }, stat)] : []),
	], hx(CopyButton, { text: copyText }), hx(DiffBody, { model, openFile, cwd, home, t }), inspectNode);
}

function readCard(model: MirrorCardModel, cwd: string | undefined, home: string | undefined, t: Translate | undefined, inspectNode: unknown): unknown {
	const path = model.path ?? 'file';
	const pathLabel = relativize(path, cwd, home);
	const rawBody = model.output !== undefined && model.output !== '' ? trimTrailingBlankLines(model.output) : tr(t, 'tv.noOutput', '(no output)');
	return cardShell([
		IconBrowseOutline16(13),
		hx('span', { className: 'agy-tv-card-path' }, pathLabel),
	], hx(CopyButton, { text: model.output ?? '', t }), hx('pre', { className: 'agy-tv-card-content' }, clip(rawBody, 16000)), inspectNode);
}

function searchCard(model: MirrorCardModel, t: Translate | undefined, inspectNode: unknown): unknown {
	const rawBody = model.output !== undefined && model.output !== '' ? trimTrailingBlankLines(model.output) : tr(t, 'tv.noMatches', '(no matches)');
	return cardShell([
		IconSearchOutline16(13),
		hx('span', { className: 'agy-tv-card-path' }, model.title),
	], hx(CopyButton, { text: model.output ?? '', t }), hx('pre', { className: 'agy-tv-card-content' }, clip(rawBody, 16000)), inspectNode);
}

function listCard(model: MirrorCardModel, t: Translate | undefined, inspectNode: unknown): unknown {
	const rawBody = model.output !== undefined && model.output !== '' ? trimTrailingBlankLines(model.output) : tr(t, 'tv.emptyDir', '(empty directory)');
	return cardShell([
		IconBrowseOutline16(13),
		hx('span', { className: 'agy-tv-card-path' }, model.title),
	], hx(CopyButton, { text: model.output ?? '', t }), hx('pre', { className: 'agy-tv-card-content' }, clip(rawBody, 16000)), inspectNode);
}

function questionCard(model: MirrorCardModel, inspectNode: unknown): unknown {
	return cardShell([
		IconQuestionOutline16(13),
		hx('span', { className: 'agy-tv-card-path' }, model.title),
	], hx(CopyButton, { text: model.output ?? (model.raw ?? '') }), hx(QuestionCardBody, { model }), inspectNode);
}

function imageCard(model: MirrorCardModel, inspectNode: unknown): unknown {
	return cardShell([
		IconImageOutline16(13),
		hx('span', { className: 'agy-tv-card-path' }, model.imageName || 'Image'),
	], hx(CopyButton, { text: model.prompt || (model.raw ?? '') }), hx(ImageCardBody, { model }), inspectNode);
}

function genericCard(model: MirrorCardModel, t: Translate | undefined, inspectNode: unknown): unknown {
	const copyText = model.output !== undefined && model.output !== '' ? model.output : (model.raw ?? '');
	const rawBody = model.output !== undefined && model.output !== ''
		? trimTrailingBlankLines(model.output)
		: (model.raw !== undefined && model.raw !== '' ? clip(model.raw, 4000) : tr(t, 'tv.noDetail', '(no detail)'));
	return cardShell([
		IconCodeOutline16(13),
		hx('span', { className: 'agy-tv-card-path' }, model.server ? `${model.server}: ${model.tool}` : (model.title || model.tool || 'Tool')),
	], hx(CopyButton, { text: copyText, t }), hx('pre', { className: 'agy-tv-card-content' }, clip(rawBody, 16000)), inspectNode);
}

export function CardBody({ model, openFile, cwd, home, inspect, t }: {
	model: MirrorCardModel;
	openFile?: (p: string, o?: unknown) => void;
	cwd?: string;
	home?: string;
	inspect?: () => void;
	t?: Translate;
}): unknown {
	const inspectNode = inspectButton(inspect, t);
	switch (model.kind) {
		case 'terminal':
			return terminalBody(model, t, inspectNode);
		case 'diff':
			return diffCard(model, openFile, cwd, home, t, inspectNode);
		case 'read':
			return readCard(model, cwd, home, t, inspectNode);
		case 'search':
			return searchCard(model, t, inspectNode);
		case 'list':
			return listCard(model, t, inspectNode);
		case 'question':
			return questionCard(model, inspectNode);
		case 'image':
			return imageCard(model, inspectNode);
		default:
			return genericCard(model, t, inspectNode);
	}
}

