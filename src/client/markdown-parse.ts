// The pure half of the Markdown renderer: parsing only, no React.
//
// Keeping it separate means the parser is testable in Node (the renderer
// imports the browser's react handle), and both halves stay dependency-free.

// ---- Inline -----------------------------------------------------------------

export type MdInline =
	| { type: 'text'; text: string }
	| { type: 'code'; text: string }
	| { type: 'strong'; text: string }
	| { type: 'em'; text: string }
	| { type: 'del'; text: string }
	| { type: 'link'; text: string; href: string };

// Emphasis needs non-space right inside both markers: `2 * 3 * 4` is
// multiplication, not italics.
const INLINE_TOKEN = /`[^`\n]+`|\*\*(?=\S)[^*\n]*?(?<=\S)\*\*|__(?=\S)[^_\n]*?(?<=\S)__|~~(?=\S)[^~\n]*?(?<=\S)~~|\*(?=\S)[^*\n]*?(?<=\S)\*|_(?=\S)[^_\n]*?(?<=\S)_|\[[^\]\n]*\]\([^)\s]*\)/;

/** Split one line of Markdown into inline tokens. */
export function parseInline(text: string): MdInline[] {
	const out: MdInline[] = [];
	let rest = text;
	let guard = 0;
	while (rest !== '' && guard++ < 4000) {
		const match = INLINE_TOKEN.exec(rest);
		if (match === null) {
			out.push({ type: 'text', text: rest });
			break;
		}
		const token = match[0];
		if (match.index > 0) out.push({ type: 'text', text: rest.slice(0, match.index) });
		if (token.startsWith('`')) {
			out.push({ type: 'code', text: token.slice(1, -1) });
		} else if (token.startsWith('**') || token.startsWith('__')) {
			out.push({ type: 'strong', text: token.slice(2, -2) });
		} else if (token.startsWith('~~')) {
			out.push({ type: 'del', text: token.slice(2, -2) });
		} else if (token.startsWith('*') || token.startsWith('_')) {
			out.push({ type: 'em', text: token.slice(1, -1) });
		} else {
			// [label](href)
			const link = /^\[([^\]]*)\]\(([^)\s]*)\)$/.exec(token);
			out.push({ type: 'link', text: link?.[1] ?? token, href: link?.[2] ?? '' });
		}
		rest = rest.slice(match.index + token.length);
	}
	return out;
}

// ---- Blocks -----------------------------------------------------------------

export type MdListItem = {
	/** Inline content of the item's first paragraph. */
	inline: MdInline[];
	/** `null` when the item is not a task item. */
	checked: boolean | null;
	/** Nested blocks (sub-items, code, paragraphs). */
	children: MdBlock[];
};

export type MdBlock =
	| { type: 'paragraph'; inline: MdInline[] }
	| { type: 'heading'; level: number; inline: MdInline[] }
	| { type: 'code'; lang: string; text: string }
	| { type: 'list'; ordered: boolean; start: number; items: MdListItem[] }
	| { type: 'quote'; blocks: MdBlock[] }
	| { type: 'rule' }
	| { type: 'table'; header: MdInline[][]; rows: MdInline[][][] };

const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*\|?\s*$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

/** Visual indent of a line, counting a tab as four columns. */
function indentOf(line: string): number {
	let width = 0;
	for (const ch of line) {
		if (ch === ' ') width += 1;
		else if (ch === '\t') width += 4;
		else break;
	}
	return width;
}

/** Split a table row on unescaped pipes. */
function tableCells(line: string): string[] {
	const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
	const cells: string[] = [];
	let cur = '';
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (ch === '\\' && trimmed[i + 1] === '|') {
			cur += '|';
			i++;
		} else if (ch === '|') {
			cells.push(cur.trim());
			cur = '';
		} else {
			cur += ch;
		}
	}
	cells.push(cur.trim());
	return cells;
}

function isBlockStart(line: string): boolean {
	return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);
}

/**
 * Parse a whole Markdown document into blocks.
 *
 * `baseIndent` lets the list parser recurse on the dedented body of one item
 * without copying strings around.
 */
export function parseMarkdown(text: string, baseIndent = 0): MdBlock[] {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	const blocks: MdBlock[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? '';
		if (line.trim() === '') {
			i++;
			continue;
		}

		const fence = FENCE.exec(line);
		if (fence !== null) {
			const marker = fence[1] ?? '```';
			const lang = fence[2] ?? '';
			const body: string[] = [];
			i++;
			while (i < lines.length && !(lines[i] ?? '').trim().startsWith(marker)) {
				body.push(lines[i] ?? '');
				i++;
			}
			i++;
			blocks.push({ type: 'code', lang, text: body.join('\n') });
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading !== null) {
			const level = Math.min(6, (heading[1] ?? '#').length);
			blocks.push({ type: 'heading', level, inline: parseInline((heading[2] ?? '').trim()) });
			i++;
			continue;
		}

		if (RULE.test(line)) {
			blocks.push({ type: 'rule' });
			i++;
			continue;
		}

		// A pipe table needs the divider row right under the header row.
		if (line.includes('|') && TABLE_DIVIDER.test(lines[i + 1] ?? '')) {
			const header = tableCells(line).map(parseInline);
			const rows: MdInline[][][] = [];
			i += 2;
			while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') {
				rows.push(tableCells(lines[i] ?? '').map(parseInline));
				i++;
			}
			blocks.push({ type: 'table', header, rows });
			continue;
		}

		const quote = QUOTE.exec(line);
		if (quote !== null) {
			const body: string[] = [];
			while (i < lines.length) {
				const inner = QUOTE.exec(lines[i] ?? '');
				if (inner === null) break;
				body.push(inner[1] ?? '');
				i++;
			}
			blocks.push({ type: 'quote', blocks: parseMarkdown(body.join('\n'), baseIndent) });
			continue;
		}

		const item = LIST_ITEM.exec(line);
		if (item !== null) {
			const listIndent = indentOf(item[1] ?? '') + baseIndent;
			const ordered = /^\d/.test(item[2] ?? '');
			const start = ordered ? Number.parseInt(item[2] ?? '1', 10) || 1 : 1;
			const items: MdListItem[] = [];
			while (i < lines.length) {
				const cur = lines[i] ?? '';
				const hit = LIST_ITEM.exec(cur);
				const curIndent = indentOf(cur);
				if (hit !== null && curIndent + baseIndent === listIndent && /^\d/.test(hit[2] ?? '') === ordered) {
					let rest = hit[3] ?? '';
					let checked: boolean | null = null;
					const task = TASK.exec(rest);
					if (task !== null) {
						checked = (task[1] ?? ' ').toLowerCase() === 'x';
						rest = task[2] ?? '';
					}
					const body: string[] = [rest];
					i++;
					// Continuation lines and nested items belong to this item.
					while (i < lines.length) {
						const next = lines[i] ?? '';
						if (next.trim() === '') {
							// A blank line ends the item unless the list continues.
							const after = lines[i + 1] ?? '';
							if (LIST_ITEM.test(after) || indentOf(after) + baseIndent > listIndent) {
								body.push('');
								i++;
								continue;
							}
							break;
						}
						if (indentOf(next) + baseIndent <= listIndent && (LIST_ITEM.test(next) || isBlockStart(next))) break;
						if (indentOf(next) + baseIndent <= listIndent) break;
						body.push(next.slice(Math.min(next.length, listIndent + 2)));
						i++;
					}
					const [first, ...restLines] = body;
					const inline = parseInline(first ?? '');
					const children = restLines.length > 0 && restLines.some((l) => l.trim() !== '')
						? parseMarkdown(restLines.join('\n'))
						: [];
					items.push({ inline, checked, children });
					continue;
				}
				break;
			}
			blocks.push({ type: 'list', ordered, start, items });
			continue;
		}

		// Paragraph: consume until a blank line or the next block start.
		const para: string[] = [];
		while (i < lines.length) {
			const cur = lines[i] ?? '';
			if (cur.trim() === '' || isBlockStart(cur)) break;
			para.push(cur.trim());
			i++;
		}
		blocks.push({ type: 'paragraph', inline: parseInline(para.join('\n')) });
	}
	return blocks;
}
