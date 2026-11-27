// A small, dependency-free Markdown renderer for text that arrives from agy.
//
// DSH's own Markdown component lives inside the chat bundle and is not exposed
// to plugin bundles (the client module table only resolves packages that have
// their own client entry), so plugin surfaces that need to show agent-authored
// Markdown — the translation card, the orchestration page's plan and checklist —
// share this one instead.
//
// Two rules keep it safe and predictable:
//   * parsing is pure (`parseMarkdown`) and testable without React;
//   * rendering builds React elements only, never innerHTML, so model output
//     cannot inject markup.
//
// Coverage is the subset agent plans and checklists actually use: paragraphs,
// ATX headings, nested ordered/unordered lists (with task markers), fenced
// code, blockquotes, horizontal rules and GFM pipe tables, plus inline bold,
// italic, strikethrough, code and links.

import { h } from './react.ts';
import {
	parseInline,
	parseMarkdown,
	type MdBlock,
	type MdInline,
	type MdListItem,
} from './markdown-parse.ts';

export { parseInline, parseMarkdown };
export type { MdBlock, MdInline, MdListItem };


// ---- Rendering --------------------------------------------------------------

function renderInlineTokens(tokens: readonly MdInline[], keyPrefix: string): unknown[] {
	return tokens.map((token, index) => {
		const key = keyPrefix + '-' + index;
		switch (token.type) {
			case 'code':
				return h('code', { key }, token.text);
			case 'strong':
				return h('strong', { key }, token.text);
			case 'em':
				return h('em', { key }, token.text);
			case 'del':
				return h('del', { key }, token.text);
			case 'link':
				// A link out of a plan is dead weight inside a sidebar: keep the
				// label, keep the target as a tooltip, never navigate the shell.
				return h('span', { key, className: 'agy-md-link', title: token.href }, token.text);
			default:
				return token.text;
		}
	});
}

function renderItem(item: MdListItem, key: string): unknown {
	return h(
		'li',
		{ key, className: item.checked === null ? undefined : 'agy-md-task' },
		item.checked === null
			? null
			: h('span', { className: 'agy-md-check', 'data-checked': item.checked ? 'true' : 'false' }, item.checked ? '✓' : '○'),
		...renderInlineTokens(item.inline, key + '-i'),
		item.children.length > 0 ? renderBlocks(item.children, key + '-c') : null,
	);
}

function renderBlock(block: MdBlock, key: string): unknown {
	switch (block.type) {
		case 'heading':
			return h('h' + block.level, { key }, ...renderInlineTokens(block.inline, key));
		case 'code':
			return h(
				'pre',
				{ key, className: 'agy-md-code' },
				block.lang === '' ? null : h('span', { className: 'agy-md-lang' }, block.lang),
				h('code', null, block.text),
			);
		case 'list':
			return h(
				block.ordered ? 'ol' : 'ul',
				{ key, start: block.ordered && block.start !== 1 ? block.start : undefined },
				...block.items.map((item, index) => renderItem(item, key + '-' + index)),
			);
		case 'quote':
			return h('blockquote', { key }, ...renderBlocks(block.blocks, key));
		case 'rule':
			return h('hr', { key });
		case 'table':
			return h(
				'table',
				{ key, className: 'agy-md-table' },
				h('thead', null, h('tr', null, ...block.header.map((cell, index) => h('th', { key: 'h' + index }, ...renderInlineTokens(cell, key + 'h' + index))))),
				h(
					'tbody',
					null,
					...block.rows.map((row, rowIndex) =>
						h('tr', { key: 'r' + rowIndex }, ...row.map((cell, cellIndex) => h('td', { key: 'c' + cellIndex }, ...renderInlineTokens(cell, key + 'r' + rowIndex + 'c' + cellIndex)))),
					),
				),
			);
		default:
			return h('p', { key }, ...renderInlineTokens(block.inline, key));
	}
}

function renderBlocks(blocks: readonly MdBlock[], keyPrefix: string): unknown[] {
	return blocks.map((block, index) => renderBlock(block, keyPrefix + '-' + index));
}

/** Render one Markdown document as React elements inside `.agy-md`. */
export function renderMarkdown(text: string): unknown {
	return h('div', { className: 'agy-md' }, ...renderBlocks(parseMarkdown(text), 'md'));
}

/** Render a single line of inline Markdown (checklist rows, captions). */
export function renderInline(text: string): unknown {
	return h('span', { className: 'agy-md agy-md-inline' }, ...renderInlineTokens(parseInline(text), 'in'));
}

// ---- Styles -----------------------------------------------------------------

/**
 * Markdown styles. Every colour is a DSH token so light and dark come from the
 * host theme; the type scale mirrors DSH's own Markdown surface.
 */
export const MARKDOWN_CSS = `
.agy-md {
  font-size: var(--dsw-font-markdown-base-font-size, 13.5px);
  line-height: var(--dsw-font-markdown-base-line-height, 22px);
  color: var(--dsw-alias-label-primary, #1a1c21);
  overflow-wrap: break-word;
}
.agy-md-inline { display: inline; font-size: inherit; line-height: inherit; }
.agy-md > :first-child { margin-top: 0; }
.agy-md > :last-child { margin-bottom: 0; }
.agy-md p { margin: 0 0 8px 0; white-space: pre-wrap; }
.agy-md h1, .agy-md h2, .agy-md h3, .agy-md h4, .agy-md h5, .agy-md h6 {
  margin: 14px 0 6px 0; font-weight: 600; line-height: 1.4;
  color: var(--dsw-alias-label-primary, #1a1c21);
}
.agy-md h1 { font-size: 1.3em; }
.agy-md h2 { font-size: 1.2em; }
.agy-md h3 { font-size: 1.1em; }
.agy-md h4, .agy-md h5, .agy-md h6 { font-size: 1em; }
.agy-md ul, .agy-md ol { margin: 0 0 8px 0; padding-left: 20px; }
.agy-md li { margin: 2px 0; }
.agy-md li > ul, .agy-md li > ol { margin: 2px 0 0 0; }
.agy-md li.agy-md-task { list-style: none; margin-left: -16px; }
.agy-md .agy-md-check {
  display: inline-block; width: 14px; margin-right: 4px;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
}
.agy-md .agy-md-check[data-checked="true"] { color: var(--dsw-alias-state-success-primary, #22c55e); }
.agy-md code {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: .9em; padding: 1px 4px; border-radius: 4px;
  background: var(--dsw-alias-markdown-inline-code, rgba(127,127,127,.16));
}
.agy-md pre {
  position: relative; margin: 0 0 8px 0; padding: 8px 10px; overflow-x: auto;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2));
  border-radius: 6px;
  background: var(--dsw-alias-markdown-code-block, rgba(127,127,127,.06));
}
.agy-md pre code { background: transparent; padding: 0; font-size: 12.5px; }
.agy-md .agy-md-lang {
  display: block; margin-bottom: 4px; font-size: 10px; letter-spacing: .06em;
  text-transform: uppercase; color: var(--dsw-alias-label-tertiary, #8a8f98);
}
.agy-md blockquote {
  margin: 0 0 8px 0; padding: 2px 0 2px 10px;
  border-left: 2px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28));
  color: var(--dsw-alias-label-secondary, #4a4c55);
}
.agy-md hr {
  margin: 10px 0; border: 0; border-top: 0.5px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.28));
}
.agy-md table { margin: 0 0 8px 0; border-collapse: collapse; font-size: 12.5px; }
.agy-md th, .agy-md td {
  padding: 4px 8px; text-align: left; vertical-align: top;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2));
}
.agy-md th { background: var(--dsw-alias-markdown-code-block-banner, rgba(127,127,127,.05)); font-weight: 600; }
.agy-md .agy-md-link {
  color: var(--dsw-alias-state-business-primary, #2563eb);
  text-decoration: underline; text-underline-offset: 2px; cursor: help;
}
`;

const STYLE_ID = 'dsh-agy-link-markdown-css';

/** Install the Markdown stylesheet once per document. */
export function injectMarkdownStyles(): void {
	const doc = (globalThis as { document?: { getElementById(id: string): unknown; createElement(tag: string): { id: string; textContent: string }; head?: { appendChild(node: unknown): void } | null; documentElement?: { appendChild(node: unknown): void } | null } }).document;
	if (doc === undefined || doc === null) return;
	const existing = doc.getElementById(STYLE_ID) as { textContent?: string } | null | undefined;
	if (existing !== null && existing !== undefined) {
		if (existing.textContent !== MARKDOWN_CSS) existing.textContent = MARKDOWN_CSS;
		return;
	}
	const style = doc.createElement('style');
	style.id = STYLE_ID;
	style.textContent = MARKDOWN_CSS;
	const parent = doc.head ?? doc.documentElement;
	if (parent !== null && parent !== undefined) parent.appendChild(style);
}

injectMarkdownStyles();