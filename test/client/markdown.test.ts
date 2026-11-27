// The plan/checklist Markdown surface parses agent output. These cases pin the
// subset that agy's plans actually use, because a broken parse shows up as raw
// asterisks in the sidebar.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseInline, parseMarkdown } from '../../src/client/markdown-parse.ts';

describe('parseInline', () => {
	it('keeps plain text as one token', () => {
		assert.deepEqual(parseInline('just words'), [{ type: 'text', text: 'just words' }]);
	});

	it('recognises bold, italic, code, strike and links', () => {
		const tokens = parseInline('a **b** c *d* e `f` g ~~h~~ [i](https://x.test/y)');
		assert.deepEqual(tokens, [
			{ type: 'text', text: 'a ' },
			{ type: 'strong', text: 'b' },
			{ type: 'text', text: ' c ' },
			{ type: 'em', text: 'd' },
			{ type: 'text', text: ' e ' },
			{ type: 'code', text: 'f' },
			{ type: 'text', text: ' g ' },
			{ type: 'del', text: 'h' },
			{ type: 'text', text: ' ' },
			{ type: 'link', text: 'i', href: 'https://x.test/y' },
		]);
	});

	it('leaves an unmatched marker as text', () => {
		assert.deepEqual(parseInline('2 * 3 * 4'), [{ type: 'text', text: '2 * 3 * 4' }]);
	});
});

describe('parseMarkdown', () => {
	it('parses ATX headings and caps the level at six', () => {
		const blocks = parseMarkdown('# One\n\n###### Six\n\n####### Seven');
		assert.deepEqual(blocks[0], { type: 'heading', level: 1, inline: [{ type: 'text', text: 'One' }] });
		assert.equal(blocks[1]?.type, 'heading');
		assert.equal((blocks[1] as { level: number }).level, 6);
		// Seven hashes is not a heading.
		assert.equal(blocks[2]?.type, 'paragraph');
	});

	it('parses a fenced code block with its language', () => {
		const blocks = parseMarkdown('intro\n\n```ts\nconst a = 1\n```\n\noutro');
		assert.deepEqual(blocks[1], { type: 'code', lang: 'ts', text: 'const a = 1' });
	});

	it('parses nested list items into children', () => {
		const blocks = parseMarkdown('- one\n  - one.a\n- two');
		const list = blocks[0] as { type: string; items: Array<{ inline: unknown[]; children: unknown[] }> };
		assert.equal(list.type, 'list');
		assert.equal(list.items.length, 2);
		assert.equal(list.items[0]?.children.length, 1);
	});

	it('parses ordered lists and keeps the start number', () => {
		const blocks = parseMarkdown('3. three\n4. four');
		assert.deepEqual((blocks[0] as { ordered: boolean; start: number }).start, 3);
		assert.equal((blocks[0] as { ordered: boolean }).ordered, true);
	});

	it('marks task list items and their state', () => {
		const blocks = parseMarkdown('- [x] done\n- [ ] todo\n- plain');
		const items = (blocks[0] as { items: Array<{ checked: boolean | null }> }).items;
		assert.deepEqual(items.map((i) => i.checked), [true, false, null]);
	});

	it('parses GFM pipe tables', () => {
		const blocks = parseMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');
		const table = blocks[0] as { type: string; header: unknown[][]; rows: unknown[][][] };
		assert.equal(table.type, 'table');
		assert.equal(table.header.length, 2);
		assert.equal(table.rows.length, 1);
	});

	it('parses blockquotes and horizontal rules', () => {
		const blocks = parseMarkdown('> quoted\n\n---');
		assert.equal(blocks[0]?.type, 'quote');
		assert.equal(blocks[1]?.type, 'rule');
	});

	it('joins consecutive lines into one paragraph', () => {
		const blocks = parseMarkdown('one\ntwo\n\nthree');
		assert.equal(blocks.length, 2);
		assert.deepEqual((blocks[0] as { inline: unknown[] }).inline, [{ type: 'text', text: 'one\ntwo' }]);
	});

	it('parses a realistic agy plan', () => {
		const plan = [
			'## 目标',
			'修复论文目录渲染。',
			'',
			'## 步骤',
			'1. 读取 `06-论文与答辩/` 目录',
			'2. 更新 **index.md**',
			'   - [x] 备份',
			'   - [ ] 写入',
			'',
			'```bash',
			'ls -la',
			'```',
		].join('\n');
		const blocks = parseMarkdown(plan);
		assert.deepEqual(blocks.map((b) => b.type), ['heading', 'paragraph', 'heading', 'list', 'code']);
		const list = blocks[3] as { items: Array<{ inline: unknown[]; children: unknown[] }> };
		assert.equal(list.items.length, 2);
		assert.equal(list.items[1]?.children.length, 1);
	});
});