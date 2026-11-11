// Presentation helpers: paths, clipping, previews, titles and diff stats.

import type { MirrorCardModel } from './types.ts';

export function relativize(p: string, cwd?: string, home?: string): string {
	if (cwd && p.startsWith(cwd)) {
		const rel = p.slice(cwd.length).replace(/^[/\\]+/, '');
		return rel !== '' ? rel : p;
	}
	if (home && p.startsWith(home)) return '~' + p.slice(home.length);
	return p;
}

export function clip(s: string, max: number): string {
	return s.length > max ? s.slice(0, max) + '\n… (+' + (s.length - max) + ' chars)' : s;
}

export function trimTrailingBlankLines(s: string): string {
	return s.replace(/[\t ]*\r?\n[\t ]*(\r?\n[\t ]*)*$/, '\n');
}

export function previewLine(model: MirrorCardModel, cwd?: string, home?: string): string | undefined {
	if (model.kind === 'diff') {
		const raw = model.path ?? 'file';
		const rel = relativize(raw, cwd, home);
		const display = rel.length > 40 ? '…' + rel.slice(-40) : rel;
		return model.oldText != null ? `± ${display}` : `+ ${display}`;
	}
	const out = model.output;
	if (out !== undefined && out !== '') {
		const first = out.split('\n').find((l) => l.trim() !== '');
		if (first !== undefined && first.trim() !== '') return first.trim().slice(0, 80);
	}
	return undefined;
}

export function cls(...names: Array<string | false | null | undefined>): string {
	return names.filter((n): n is string => typeof n === 'string' && n !== '').join(' ');
}

export type Translate = (key: string, params?: Record<string, unknown>) => string;

/**
 * Locale lookup with an English fallback: the mirror card renders through
 * host-provided `t` when the registration declares the namespace, but tests
 * and hosts without the seat call it bare. The old literals were mixed
 * 中文 and English as BOTH fallback and primary, so non-Chinese users saw
 * Chinese buttons on mirror cards.
 */
export function tr(t: Translate | undefined, key: string, fallback: string, params?: Record<string, unknown>): string {
	if (typeof t === 'function') {
		try {
			const v = t(key, params);
			if (typeof v === 'string' && v !== '' && v !== key) return v;
		} catch {
			// unbound namespace — fall through
		}
	}
	if (params !== undefined && params.count !== undefined && fallback.includes('{count}')) {
		return fallback.replace('{count}', String(params.count));
	}
	return fallback;
}

export function displayTitle(model: MirrorCardModel, t?: Translate): string {
	switch (model.kind) {
		case 'terminal':
			return tr(t, 'tv.command', 'Command');
		case 'diff':
			return (model.tool === 'write_to_file' || model.tool === 'write_file' || model.tool === 'create_file') ? tr(t, 'tv.write', 'Write') : tr(t, 'tv.edit', 'Edit');
		case 'read':
			return tr(t, 'tv.read', 'Read');
		case 'search':
			return (model.tool === 'search_web' || model.tool === 'web_search') ? tr(t, 'tv.webSearch', 'Web Search') : tr(t, 'tv.search', 'Search');
		case 'list':
			return tr(t, 'tv.list', 'List');
		case 'delete':
			return tr(t, 'tv.delete', 'Delete');
		case 'question':
			return tr(t, 'tv.question', 'Question');
		case 'image':
			return tr(t, 'tv.image', 'Image');
		default:
			if (model.tool && model.tool !== 'agy_tool') {
				return model.server ? `${model.server}: ${model.tool}` : model.tool.replace(/_/g, ' ');
			}
			return tr(t, 'tv.tool', 'Tool');
	}
}

export function displaySummary(model: MirrorCardModel, cwd?: string, home?: string): string {
	if (model.kind === 'terminal') {
		return model.command ?? model.title;
	}
	if (model.kind === 'diff') {
		const rawPath = model.path ?? 'file';
		return relativize(rawPath, cwd, home);
	}
	if (model.kind === 'read') {
		const rawPath = model.path ?? '';
		return rawPath !== '' ? relativize(rawPath, cwd, home) : model.title;
	}
	if (model.kind === 'search') {
		return model.title.replace(/^(Web search|Search)\s*/i, '') || model.title;
	}
	if (model.kind === 'list') {
		return model.title.replace(/^List\s*(directory\s*)?/i, '') || model.title;
	}
	if (model.kind === 'question') {
		return model.title;
	}
	if (model.kind === 'image') {
		return model.prompt || model.title;
	}
	if (model.server && model.title.startsWith(`${model.server}: `)) {
		return model.title.slice(model.server.length + 2);
	}
	return model.title;
}

export function diffStat(model: MirrorCardModel): string | null {
	if (model.kind !== 'diff') return null;
	const oldText = model.oldText ?? '';
	const newText = model.newText ?? '';
	const oldLines = oldText === '' ? 0 : oldText.split('\n').length;
	const newLines = newText === '' ? 0 : newText.split('\n').length;
	if (oldLines === 0 && newLines === 0) return null;
	if (oldLines === 0) return `+${newLines}`;
	return `+${newLines} -${oldLines}`;
}
