// Real client behavior tests (R1) — render the browser-facing components with
// React's server renderer instead of string-matching the source.
//
// IMPORTANT: `./helpers/client-render.ts` must be imported first. It installs the
// `require('react')` shim the client modules expect and exposes
// renderToStaticMarkup. Effects do not run under SSR, so no network/DOM is used.
import './helpers/client-render.ts';
import { React, renderToStaticMarkup } from './helpers/client-render.ts';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	cleanString,
	isError,
	isSettled,
	mirrorInfo,
	num,
	parseArgs,
	parseInnerArgs,
	parsedArgsRaw,
	pick,
	resultText,
} from '../src/client/toolview/args.ts';
import { mirrorCardModel } from '../src/client/toolview/card-model.ts';
import {
	clip,
	cls,
	diffStat,
	displaySummary,
	displayTitle,
	previewLine,
	relativize,
	tr,
	trimTrailingBlankLines,
} from '../src/client/toolview/format.ts';
import { AgyMirrorToolView } from '../src/client/toolview/index.ts';
import { AgyCodeToolView, AgyRunCodeToolView, runCodeModel } from '../src/client/toolview/run-code-view.ts';
import { clearExpandedToolBlockKeysForTest, expandToolBlockKeyForTest } from '../src/client/toolview/toggle.ts';
import { TranslationCard } from '../src/client/translate-card.ts';
import { actionStateOf, setActionState, TranslateAction } from '../src/client/translate-state.ts';
import {
	isMermaidBlock,
	isMermaidFence,
	isMermaidLang,
	looksLikeMermaidSource,
	preferredMermaidTheme,
} from '../src/client/mermaid-config.ts';
import {
	buildMediaUrl,
	getOrigin,
	isImageFile,
	isVideoFile,
	isAudioFile,
	isMediaFile,
	isLocalFilePath,
} from '../src/client/images/media.ts';

const createElement = (React as { createElement: (type: unknown, props?: unknown) => unknown }).createElement;

// ---------------------------------------------------------------------------
// Mirror toolview fixtures
// ---------------------------------------------------------------------------

type AnyBlock = Record<string, unknown>;

function settled(tool: string, input: Record<string, unknown>, text = 'OUTPUT'): AnyBlock {
	return {
		kind: 'tool-result',
		call: { name: 'agy_tool', argsRaw: JSON.stringify({ run: 'r1', step: 1, tool, input }) },
		content: [{ type: 'text', text }],
		isError: false,
	};
}

const BLOCKS: Record<string, { tool: string; input: Record<string, unknown>; kind: string }> = {
	terminal: { tool: 'run_command', input: { CommandLine: 'ls -la', WorkingDirectory: '/tmp' }, kind: 'terminal' },
	diff: { tool: 'replace_file_content', input: { TargetFile: '/tmp/a.ts', TargetContent: 'old line', ReplacementContent: 'new line' }, kind: 'diff' },
	read: { tool: 'view_file', input: { AbsolutePath: '/tmp/a.ts' }, kind: 'read' },
	search: { tool: 'grep_search', input: { query: 'needle' }, kind: 'search' },
	list: { tool: 'list_dir', input: { DirectoryPath: '/tmp' }, kind: 'list' },
	question: {
		tool: 'ask_question',
		input: { questions: [{ question: 'Pick one', options: ['A', 'B'], is_multi_select: false }] },
		kind: 'question',
	},
	image: { tool: 'generate_image', input: { Prompt: 'a cat', ImageName: 'cat', AspectRatio: '16:9' }, kind: 'image' },
	generic: { tool: 'weird_tool', input: { foo: 'bar' }, kind: 'generic' },
};

function renderView(props: Record<string, unknown>): string {
	return renderToStaticMarkup(createElement(AgyMirrorToolView, props));
}

// ---------------------------------------------------------------------------
// 1. AgyMirrorToolView: all kinds, collapsed + expanded
// ---------------------------------------------------------------------------

test('mirror view: collapsed row renders for every card kind without a body', () => {
	for (const [name, spec] of Object.entries(BLOCKS)) {
		const html = renderView({ block: settled(spec.tool, spec.input), callId: 'c-' + name, toolName: 'agy_tool' });
		assert.match(html, /class="agy-tv-root"/, `${name}: root`);
		assert.match(html, /class="agy-tv-row"/, `${name}: header row`);
		assert.ok(html.includes(`data-kind="${spec.kind}"`), `${name}: data-kind`);
		assert.ok(html.includes('data-state="ok"'), `${name}: settled state`);
		assert.equal(html.includes('agy-tv-body-wrap'), false, `${name}: no body while collapsed`);
		assert.equal(html.includes('agy-tv-card&#x27;') || html.includes('agy-tv-card"'), false, `${name}: no card while collapsed`);
	}
});

test('mirror view: expanded body renders card, header and copy button for every kind', () => {
	clearExpandedToolBlockKeysForTest();
	for (const [name, spec] of Object.entries(BLOCKS)) {
		expandToolBlockKeyForTest('call:e-' + name);
		const html = renderView({ block: settled(spec.tool, spec.input), callId: 'e-' + name, toolName: 'agy_tool' });
		assert.match(html, /class="agy-tv-root agy-tv-open"/, `${name}: open root`);
		assert.match(html, /class="agy-tv-body-wrap"/, `${name}: body wrap`);
		assert.match(html, /class="agy-tv-card"/, `${name}: card`);
		assert.match(html, /class="agy-tv-card-header"/, `${name}: card header`);
		assert.match(html, /class="agy-tv-card-header-left"/, `${name}: header left cluster`);
		assert.match(html, /class="agy-tv-copy-btn"/, `${name}: copy button`);
	}
});

test('mirror view: terminal expanded shows command, cwd and output', () => {
	clearExpandedToolBlockKeysForTest();
	expandToolBlockKeyForTest('call:t1');
	const html = renderView({ block: settled('run_command', { CommandLine: 'ls -la', WorkingDirectory: '/tmp' }, 'a.txt\nb.txt'), callId: 't1' });
	assert.match(html, /agy-tv-prompt-glyph/);
	assert.match(html, /agy-tv-card-cwd[^>]*>\/tmp</);
	assert.match(html, /agy-tv-card-cmd[^>]*>ls -la</);
	assert.match(html, /class="agy-tv-card-content"/);
	assert.ok(html.includes('a.txt'));
});

test('mirror view: diff expanded renders del/add lines and the stat badge', () => {
	clearExpandedToolBlockKeysForTest();
	expandToolBlockKeyForTest('call:d1');
	const html = renderView({ block: settled('replace_file_content', { TargetFile: '/tmp/a.ts', TargetContent: 'old line', ReplacementContent: 'new line' }), callId: 'd1' });
	assert.match(html, /class="agy-tv-diff-list"/);
	assert.match(html, /agy-tv-diff-del/);
	assert.match(html, /agy-tv-diff-add/);
	assert.ok(html.includes('old line'));
	assert.ok(html.includes('new line'));
	assert.ok(html.includes('agy-tv-diff-stat'));
	assert.ok(html.includes('+1 -1'));
});

test('mirror view: question expanded renders options and insert affordance', () => {
	clearExpandedToolBlockKeysForTest();
	expandToolBlockKeyForTest('call:q1');
	const html = renderView({
		block: settled('ask_question', { questions: [{ question: 'Pick one', options: ['A', 'B'], is_multi_select: true }] }),
		callId: 'q1',
	});
	assert.match(html, /class="agy-tv-question-wrap"/);
	assert.match(html, /class="agy-tv-q-prompt"/);
	assert.ok(html.includes('Pick one'));
	assert.equal((html.match(/agy-tv-q-opt"/g) ?? []).length >= 2, true, 'two option buttons');
	assert.ok(html.includes('A'));
	assert.ok(html.includes('B'));
	assert.match(html, /agy-tv-q-check checkbox/);
	assert.match(html, /class="agy-tv-q-insert-btn"/);
});

test('mirror view: image card renders prompt, ratio badge and preview when a path exists', () => {
	clearExpandedToolBlockKeysForTest();
	expandToolBlockKeyForTest('call:i1');
	const generated = renderView({ block: settled('generate_image', { Prompt: 'a cat', ImageName: 'cat', AspectRatio: '16:9' }), callId: 'i1' });
	assert.match(generated, /class="agy-tv-img-wrap"/);
	assert.match(generated, /class="agy-tv-img-badge"[^>]*>16:9</);
	assert.ok(generated.includes('&quot;a cat&quot;') || generated.includes('"a cat"'));

	clearExpandedToolBlockKeysForTest();
	expandToolBlockKeyForTest('call:i2');
	const preview = renderView({ block: settled('view_file', { AbsolutePath: '/tmp/pic.png' }), callId: 'i2' });
	assert.match(preview, /class="agy-tv-img-preview-box"/);
	assert.match(preview, /class="agy-tv-img-thumb"/);
	assert.ok(preview.includes('/plugins/agy-link/media?path='));
});

test('mirror view: generic card shows the tool title and output', () => {
	clearExpandedToolBlockKeysForTest();
	expandToolBlockKeyForTest('call:g1');
	const html = renderView({ block: settled('weird_tool', { foo: 'bar' }, 'generic-output'), callId: 'g1' });
	assert.ok(html.includes('weird tool'));
	assert.ok(html.includes('generic-output'));
	assert.match(html, /class="agy-tv-card-path"/);
});

test('mirror view: running block reports data-state="run"', () => {
	const html = renderView({
		block: { name: 'agy_tool', argsRaw: JSON.stringify({ tool: 'run_command', input: { CommandLine: 'sleep 1' } }), subCalls: [] },
		callId: 'run1',
	});
	assert.ok(html.includes('data-state="run"'));
	assert.ok(html.includes('data-kind="terminal"'));
});

test('mirror view: inspect and file-link affordances appear only when wired', () => {
	clearExpandedToolBlockKeysForTest();
	expandToolBlockKeyForTest('call:x1');
	const withInspect = renderView({
		block: settled('view_file', { AbsolutePath: '/tmp/a.ts' }),
		callId: 'x1',
		inspect: () => {},
		openFile: () => {},
	});
	assert.match(withInspect, /agy-tv-inspect-btn/);
	assert.ok(withInspect.includes('Inspect'));
	assert.match(withInspect, /class="agy-tv-file-link"/);

	clearExpandedToolBlockKeysForTest();
	expandToolBlockKeyForTest('call:x2');
	const without = renderView({ block: settled('view_file', { AbsolutePath: '/tmp/a.ts' }), callId: 'x2' });
	assert.equal(without.includes('agy-tv-inspect-btn'), false);
	assert.equal(without.includes('agy-tv-file-link'), false);
});

test('run_code view: ordinary program renders an expandable code card', () => {
	clearExpandedToolBlockKeysForTest();
	expandToolBlockKeyForTest('call:rc1');
	const block = { kind: 'tool-result', call: { name: 'run_code', argsRaw: JSON.stringify({ code: 'print(1)', description: 'demo' }) }, content: [], isError: false };
	const html = renderToStaticMarkup(createElement(AgyCodeToolView, { block, callId: 'rc1' }));
	assert.match(html, /data-kind="code"/);
	assert.match(html, /class="agy-tv-card"/);
	assert.match(html, /class="agy-tv-card-content"/);
	assert.ok(html.includes('print(1)'));
	assert.ok(html.includes('demo'));
});

test('run_code view: agy mirror wrapper renders the native Antigravity card', () => {
	const code = "// dsh-agy-link mirror: replay recorded agy tool step 4 (view_file)\nreturn await tools['agy_tool']({\"run\":\"r\",\"step\":4})";
	const block = { kind: 'tool-result', call: { name: 'run_code', argsRaw: JSON.stringify({ code, description: 'replay' }) }, content: [], isError: false };
	const html = renderToStaticMarkup(createElement(AgyRunCodeToolView, { block }));
	assert.match(html, /data-kind="read"/);
	assert.match(html, /class="agy-tv-root"/);
});

// ---------------------------------------------------------------------------
// 2. Translation card + action
// ---------------------------------------------------------------------------

const TSL_T: Record<string, string> = {
	'tsl.badge': 'Gemini 译文',
	'tsl.copy': '复制',
	'tsl.copied': '已复制',
	'tsl.collapse': '收起',
	'tsl.expand': '展开',
	'tsl.showOriginal': '显示原文',
	'tsl.hideOriginal': '隐藏原文',
	'tsl.actionTip': '用 Gemini 把这条回复译成人话',
	'tsl.translating': '翻译中…',
	'tsl.done': '已生成译文',
	'tsl.retry': '重试',
};
const tslT = (key: string): string => TSL_T[key] ?? key;

function renderCard(props: Record<string, unknown>): string {
	return renderToStaticMarkup(createElement(TranslationCard, props));
}

test('translation card: localized banner, meta, markdown body and action buttons', () => {
	const html = renderCard({
		node: { data: { text: '这是译文。', original: 'This is the original.', model: 'gemini-3.8-flash', effort: 'high', accountId: 'acc-1' } },
		t: tslT,
	});
	assert.match(html, /data-agy-translation="gemini"/);
	assert.match(html, /class="agy-tsl-card"/);
	assert.match(html, /class="agy-tsl-head"/);
	assert.match(html, /class="agy-tsl-mark"/);
	assert.ok(html.includes('Gemini 译文'), 'localized badge');
	assert.ok(html.includes('gemini-3.8-flash · high · acc-1'), 'model/effort/account meta');
	assert.match(html, /class="agy-tsl-body"/);
	assert.ok(html.includes('这是译文。'), 'translated body');
	assert.ok(html.includes('显示原文'), 'show-original button');
	assert.ok(html.includes('复制'), 'copy button');
	assert.ok(html.includes('收起'), 'collapse button');
	assert.ok(html.includes('title="gemini-3.8-flash · high · acc-1"'));
	assert.equal((html.match(/class="agy-tsl-btn"/g) ?? []).length, 3);
	// Original text starts hidden; the button toggles it.
	assert.equal(html.includes('agy-tsl-original'), false);
});

test('translation card: English fallbacks when the host supplies no locale', () => {
	const html = renderCard({ node: { data: { text: 'translated' } } });
	assert.ok(html.includes('Gemini translation'));
	assert.ok(html.includes('Copy'));
	assert.ok(html.includes('Collapse'));
	assert.equal(html.includes('Show original'), false, 'no original button without original text');
});

test('translation card: blank text renders nothing', () => {
	const html = renderCard({ node: { data: { text: '   ' } } });
	assert.equal(html, '');
});

function renderAction(props: Record<string, unknown>): string {
	return renderToStaticMarkup(createElement(TranslateAction, props));
}

const ACTION_KEY = 'sess-1\u0000msg-1';

test('translate action: idle state renders a Gemini icon button with tooltip', () => {
	setActionState(ACTION_KEY, 'idle');
	const html = renderAction({ messageId: 'msg-1', sessionId: 'sess-1', t: tslT });
	assert.match(html, /class="agy-tsl-wrap"/);
	assert.match(html, /class="agy-tsl-icon"/);
	assert.ok(html.includes('data-state="idle"'));
	assert.ok(html.includes('aria-label="用 Gemini 把这条回复译成人话"'));
	assert.equal(html.includes('disabled'), false);
	assert.match(html, /agy-tsl-mark/);
});

test('translate action: working state is disabled and shows the spinner glyph', () => {
	setActionState(ACTION_KEY, 'working');
	const html = renderAction({ messageId: 'msg-1', sessionId: 'sess-1', t: tslT });
	assert.ok(html.includes('data-state="working"'));
	assert.ok(html.includes('disabled=""'));
	assert.ok(html.includes('aria-label="翻译中…"'));
	assert.match(html, /agy-tsl-spinner/);
});

test('translate action: done and error states surface their own labels', () => {
	setActionState(ACTION_KEY, 'done');
	const done = renderAction({ messageId: 'msg-1', sessionId: 'sess-1', t: tslT });
	assert.ok(done.includes('data-state="done"'));
	assert.ok(done.includes('aria-label="已生成译文"'));

	setActionState(ACTION_KEY, 'error');
	const error = renderAction({ messageId: 'msg-1', sessionId: 'sess-1', t: tslT });
	assert.ok(error.includes('data-state="error"'));
	assert.ok(error.includes('aria-label="重试"'));
	setActionState(ACTION_KEY, 'idle');
});

test('translate action: missing ids render nothing (no session yet)', () => {
	assert.equal(renderAction({ messageId: 'msg-1' }), '');
	assert.equal(renderAction({ sessionId: 'sess-1' }), '');
});

// ---------------------------------------------------------------------------
// 3. Pure client helpers
// ---------------------------------------------------------------------------

test('args: parses settled and running blocks, rejects malformed JSON', () => {
	const settledBlock = settled('run_command', { CommandLine: 'ls' });
	assert.equal(parsedArgsRaw(settledBlock as never).includes('run_command'), true);
	const runningBlock = { name: 'agy_tool', argsRaw: '{"a":1}' };
	assert.equal(parsedArgsRaw(runningBlock as never), '{"a":1}');
	assert.deepEqual(parseArgs(settledBlock as never)?.tool, 'run_command');
	assert.equal(parseArgs({ name: 'agy_tool', argsRaw: '{bad json' } as never), null);
	assert.equal(parseArgs({ name: 'agy_tool', argsRaw: '[1,2]' } as never), null, 'arrays are not an args object');
});

test('args: cleanString / parseInnerArgs tolerate quoted and plain strings', () => {
	assert.equal(cleanString('  "hi"  '), 'hi');
	assert.equal(cleanString(" 'x' "), 'x');
	assert.equal(cleanString(42), '');
	assert.deepEqual(parseInnerArgs({ a: 1 }), { a: 1 });
	assert.deepEqual(parseInnerArgs('{"b":2}'), { b: 2 });
	assert.deepEqual(parseInnerArgs('"{\\"c\\":3}"'), { c: 3 });
	assert.deepEqual(parseInnerArgs('"just text"'), { value: '"just text"' });
	assert.deepEqual(parseInnerArgs('just text'), { value: 'just text' });
	assert.deepEqual(parseInnerArgs(null), {});
	assert.deepEqual(parseInnerArgs(7), { value: 7 });
});

test('args: mirrorInfo unwraps MCP meta-tools and mcp__server__tool names', () => {
	const wrapped = mirrorInfo({
		kind: 'tool-result',
		call: {
			name: 'agy_tool',
			argsRaw: JSON.stringify({ tool: 'call_mcp_tool', input: { ServerName: 'Srv', ToolName: 'ops_bash', Arguments: { CommandLine: 'ls' } } }),
		},
		isError: false,
		content: [],
	} as never);
	assert.deepEqual(wrapped, { tool: 'ops_bash', input: { CommandLine: 'ls' }, server: 'Srv' });

	const prefixed = mirrorInfo({
		kind: 'tool-result',
		call: { name: 'agy_tool', argsRaw: JSON.stringify({ tool: 'mcp__srv__grep_search', input: { query: 'x' } }) },
		isError: false,
		content: [],
	} as never);
	assert.deepEqual(prefixed, { tool: 'grep_search', input: { query: 'x' }, server: 'srv' });

	assert.equal(mirrorInfo({ name: 'agy_tool', argsRaw: '{}' } as never), null);
});

test('args: resultText unwraps JSON content envelopes; settled/error detection', () => {
	const part1 = { kind: 'tool-result', call: { name: 'agy_tool', argsRaw: '{}' }, content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], isError: false };
	assert.equal(resultText(part1 as never), 'one\ntwo');
	const envelope = {
		kind: 'tool-result',
		call: { name: 'agy_tool', argsRaw: '{}' },
		content: [{ type: 'text', text: JSON.stringify({ content: [{ type: 'text', text: 'inner' }] }) }],
		isError: false,
	};
	assert.equal(resultText(envelope as never), 'inner');
	assert.equal(isSettled(part1 as never), true);
	assert.equal(isSettled({ name: 'agy_tool', argsRaw: '{}' } as never), false);
	assert.equal(isError(part1 as never), false);
	assert.equal(isError({ kind: 'tool-result', call: null, content: [], isError: true } as never), true);
	assert.equal(isError({ kind: 'tool-result', call: null, content: [], isError: false, error: { code: 'x' } } as never), true);
});

test('args: pick/num scan synonyms', () => {
	assert.equal(pick({ a: '', B: 'v' }, 'a', 'b', 'B'), 'v');
	assert.equal(pick({ a: 1 }), undefined);
	assert.equal(num({ n: '2' }, 'n'), undefined);
	assert.equal(num({ n: 2 }, 'n'), 2);
});

test('format: path relativisation and clipping', () => {
	assert.equal(relativize('/repo/src/a.ts', '/repo'), 'src/a.ts');
	assert.equal(relativize('/repo', '/repo'), '/repo');
	assert.equal(relativize('/home/me/x', undefined, '/home/me'), '~/x');
	assert.equal(relativize('/other', '/repo'), '/other');
	assert.equal(clip('abcdef', 3), 'abc\n… (+3 chars)');
	assert.equal(clip('ab', 3), 'ab');
	assert.equal(trimTrailingBlankLines('a\n\n  \n'), 'a\n');
});

test('format: preview, class names and localized strings', () => {
	assert.equal(cls('a', false, 'b', null, undefined, ''), 'a b');
	assert.equal(tr(undefined, 'x', 'fallback'), 'fallback');
	assert.equal(tr((k) => k, 'x', 'fallback'), 'fallback');
	assert.equal(tr(() => 'localized', 'x', 'fallback'), 'localized');
	assert.equal(tr(undefined, 'x', '… {count} more', { count: 3 }), '… 3 more');
	const diff = { kind: 'diff', title: 'Edit a', path: '/repo/a', oldText: 'x', newText: 'y' };
	assert.equal(previewLine(diff as never, '/repo'), '± a');
	assert.equal(previewLine({ kind: 'diff', title: 'Write a', path: '/repo/a', oldText: null, newText: 'y' } as never, '/repo'), '+ a');
	assert.equal(previewLine({ kind: 'terminal', title: 't', output: '\n  first line  \nsecond' } as never), 'first line');
	assert.equal(previewLine({ kind: 'terminal', title: 't', output: '' } as never), undefined);
});

test('format: titles, summaries and diff stats per kind', () => {
	const T = (k: string) => 'L:' + k;
	assert.equal(displayTitle({ kind: 'terminal', title: 't' } as never, T), 'L:tv.command');
	assert.equal(displayTitle({ kind: 'diff', title: 't', tool: 'write_to_file' } as never, T), 'L:tv.write');
	assert.equal(displayTitle({ kind: 'diff', title: 't', tool: 'edit_file' } as never, T), 'L:tv.edit');
	assert.equal(displayTitle({ kind: 'search', title: 't', tool: 'web_search' } as never, T), 'L:tv.webSearch');
	assert.equal(displayTitle({ kind: 'generic', title: 't', tool: 'agy_tool' } as never, T), 'L:tv.tool');
	assert.equal(displayTitle({ kind: 'generic', title: 't', tool: 'my_tool' } as never, undefined), 'my tool');
	assert.equal(displaySummary({ kind: 'terminal', title: 't', command: 'ls' } as never), 'ls');
	assert.equal(displaySummary({ kind: 'diff', title: 't', path: '/repo/a' } as never, '/repo'), 'a');
	assert.equal(displaySummary({ kind: 'question', title: 'Q?' } as never), 'Q?');
	assert.equal(displaySummary({ kind: 'image', title: 'Img', prompt: 'prompt' } as never), 'prompt');
	assert.equal(displaySummary({ kind: 'generic', title: 'srv: tool', server: 'srv' } as never), 'tool');
	assert.equal(diffStat({ kind: 'diff', title: 't', oldText: '', newText: 'a\nb' } as never), '+2');
	assert.equal(diffStat({ kind: 'diff', title: 't', oldText: 'a', newText: 'a\nb' } as never), '+2 -1');
	assert.equal(diffStat({ kind: 'diff', title: 't' } as never), null);
	assert.equal(diffStat({ kind: 'terminal', title: 't' } as never), null);
});

test('card-model: classifies every representative tool', () => {
	const cases: Array<[string, Record<string, unknown>, string, (m: ReturnType<typeof mirrorCardModel>) => void]> = [
		['run_command', { CommandLine: 'ls -la', WorkingDirectory: '/tmp' }, 'terminal', (m) => {
			assert.equal(m.command, 'ls -la');
			assert.equal(m.cwd, '/tmp');
			assert.equal(m.title, 'ls -la');
		}],
		['replace_file_content', { TargetFile: '/tmp/a.ts', TargetContent: 'old', ReplacementContent: 'new' }, 'diff', (m) => {
			assert.equal(m.path, '/tmp/a.ts');
			assert.equal(m.oldText, 'old');
			assert.equal(m.newText, 'new');
			assert.equal(m.title, 'Edit /tmp/a.ts');
		}],
		['view_file', { AbsolutePath: '/tmp/a.ts', StartLine: 4 }, 'read', (m) => {
			assert.equal(m.location?.line, 4);
			assert.equal(m.title, 'Read /tmp/a.ts');
		}],
		['grep_search', { query: 'needle' }, 'search', (m) => assert.equal(m.title, 'Search needle')],
		['list_dir', { DirectoryPath: '/tmp' }, 'list', (m) => assert.equal(m.title, 'List /tmp')],
		['delete_file', { TargetFile: '/tmp/a.ts' }, 'delete', (m) => assert.equal(m.title, 'Delete /tmp/a.ts')],
		['ask_question', { questions: [{ question: 'Pick?', options: ['x'] }] }, 'question', (m) => {
			assert.equal(m.title, 'Pick?');
			assert.equal(m.questions?.length, 1);
		}],
		['generate_image', { Prompt: 'cat', ImageName: 'cat.png', AspectRatio: '16:9' }, 'image', (m) => {
			assert.equal(m.prompt, 'cat');
			assert.equal(m.imageName, 'cat.png');
			assert.equal(m.aspectRatio, '16:9');
		}],
		['weird_tool', { foo: 'bar' }, 'generic', (m) => {
			assert.equal(m.tool, 'weird_tool');
			assert.equal(m.raw !== undefined, true);
		}],
	];
	for (const [tool, input, kind, check] of cases) {
		const model = mirrorCardModel(settled(tool, input) as never);
		assert.equal(model.kind, kind, `${tool}: kind`);
		check(model);
	}
});

test('card-model: unknown tool, running block and MCP wrapper', () => {
	const unknown = mirrorCardModel(settled('totally_new_tool', { a: 1 }) as never);
	assert.equal(unknown.kind, 'generic');
	assert.equal(unknown.title, 'totally_new_tool');

	const running = mirrorCardModel({ name: 'agy_tool', argsRaw: JSON.stringify({ tool: 'run_command', input: { CommandLine: 'sleep 1' } }) } as never);
	assert.equal(running.kind, 'terminal');
	assert.equal(running.command, 'sleep 1');

	const mcp = mirrorCardModel(settled('call_mcp_tool', { ServerName: 's', ToolName: 'ops_glob', Arguments: { query: '*.ts' } }) as never);
	assert.equal(mcp.kind, 'search');
	assert.equal(mcp.server, 's');
});

// ---------------------------------------------------------------------------
// mermaid-config
// ---------------------------------------------------------------------------

test('mermaid-config: fence language and content classification', () => {
	assert.equal(isMermaidLang('mermaid'), true);
	assert.equal(isMermaidLang('mermaidjs'), true);
	assert.equal(isMermaidLang('typescript'), false);
	assert.equal(isMermaidFence('  Mermaid  '), true);
	assert.equal(isMermaidFence('ts'), false);

	assert.equal(looksLikeMermaidSource('flowchart TD\n  A-->B'), true);
	assert.equal(looksLikeMermaidSource('sequenceDiagram\n  A->>B: hi'), true);
	assert.equal(looksLikeMermaidSource('graph LR\n A-->B'), true);
	assert.equal(looksLikeMermaidSource('just some text'), false);
	assert.equal(looksLikeMermaidSource(''), false);

	assert.equal(isMermaidBlock('mermaid', 'anything'), true);
	assert.equal(isMermaidBlock('python', 'flowchart TD'), false, 'known non-mermaid language wins');
	assert.equal(isMermaidBlock('unknown', 'flowchart TD\n A-->B'), true, 'content sniff for unknown fences');
	assert.equal(isMermaidBlock('unknown', 'plain text'), false);
});

test('mermaid-config: theme follows the host light/dark state', () => {
	const g = globalThis as Record<string, unknown>;
	const hadDocument = 'document' in g;
	const hadWindow = 'window' in g;
	const prevDocument = g.document;
	const prevWindow = g.window;
	try {
		delete g.document;
		delete g.window;
		assert.equal(preferredMermaidTheme(), 'neutral', 'no DOM → neutral');

		g.document = { documentElement: { classList: { contains: (c: string) => c === 'dark' } }, body: { classList: { contains: () => false } } };
		assert.equal(preferredMermaidTheme(), 'dark');

		g.document = { documentElement: { classList: { contains: () => false } }, body: { classList: { contains: () => false } } };
		g.window = { matchMedia: () => ({ matches: true }) };
		assert.equal(preferredMermaidTheme(), 'dark', 'prefers-color-scheme dark');

		g.window = { matchMedia: () => ({ matches: false }) };
		assert.equal(preferredMermaidTheme(), 'neutral');
	} finally {
		if (hadDocument) g.document = prevDocument; else delete g.document;
		if (hadWindow) g.window = prevWindow; else delete g.window;
	}
});

// ---------------------------------------------------------------------------
// images/media
// ---------------------------------------------------------------------------

test('images/media: image detection ignores queries and fragments', () => {
	assert.equal(isImageFile('a.png'), true);
	assert.equal(isImageFile('a.JPG'), true);
	assert.equal(isImageFile('a.webp?v=1'), true);
	assert.equal(isImageFile('a.svg#x'), true);
	assert.equal(isImageFile('a.avif'), true);
	assert.equal(isImageFile('a.ts'), false);
	assert.equal(isImageFile(''), false);
	assert.equal(isImageFile(undefined as never), false);
});

test('images/media: video, audio and local file detection', () => {
	assert.equal(isVideoFile('movie.mp4'), true);
	assert.equal(isVideoFile('clip.WEBM?t=10'), true);
	assert.equal(isVideoFile('video.mov'), true);
	assert.equal(isVideoFile('doc.pdf'), false);

	assert.equal(isAudioFile('voice.mp3'), true);
	assert.equal(isAudioFile('sound.wav'), true);
	assert.equal(isAudioFile('music.ogg'), true);

	assert.equal(isMediaFile('movie.mp4'), true);
	assert.equal(isMediaFile('photo.png'), true);
	assert.equal(isMediaFile('audio.wav'), true);
	assert.equal(isMediaFile('notes.txt'), false);

	assert.equal(isLocalFilePath('file:///Users/zqy/doc.md'), true);
	assert.equal(isLocalFilePath('/Users/zqy/video.mp4'), true);
	assert.equal(isLocalFilePath('C:\\Users\\doc.pdf'), true);
	assert.equal(isLocalFilePath('master_continuous_delivery.md'), true);
	assert.equal(isLocalFilePath('https://example.com/file.md'), false);
});

test('images/media: buildMediaUrl encodes the path and keeps the origin', () => {
	const g = globalThis as Record<string, unknown>;
	const hadWindow = 'window' in g;
	const prevWindow = g.window;
	try {
		delete g.window;
		assert.equal(getOrigin(), '');
		assert.equal(buildMediaUrl(' /a b.png '), '/plugins/agy-link/media?path=%2Fa%20b.png');
		g.window = { location: { origin: 'http://127.0.0.1:9' } };
		assert.equal(getOrigin(), 'http://127.0.0.1:9');
		assert.equal(buildMediaUrl('/x.png'), 'http://127.0.0.1:9/plugins/agy-link/media?path=%2Fx.png');
	} finally {
		if (hadWindow) g.window = prevWindow; else delete g.window;
	}
});

// ---------------------------------------------------------------------------
// Guard: action-state map is observable (used by the strip button)
// ---------------------------------------------------------------------------

test('translate action state publishes and settles across instances', () => {
	setActionState(ACTION_KEY, 'working');
	assert.equal(actionStateOf(ACTION_KEY), 'working');
	setActionState(ACTION_KEY, 'done');
	assert.equal(actionStateOf(ACTION_KEY), 'done');
	setActionState(ACTION_KEY, 'idle');
	assert.equal(actionStateOf(ACTION_KEY), 'idle');
});

// ---------------------------------------------------------------------------
// run_code view branches (runCodeModel / AgyCodeToolView / mirror detection)
// ---------------------------------------------------------------------------

function runCodeBlock(argsRaw: string, extra: Record<string, unknown> = {}): AnyBlock {
	return { kind: 'tool-result', call: { name: 'run_code', argsRaw }, content: [], isError: false, ...extra };
}

function renderCode(props: Record<string, unknown>): string {
	return renderToStaticMarkup(createElement(AgyCodeToolView, props));
}

test('runCodeModel: raw fallback, description, empty and multiline code', () => {
	// Non-JSON raw args are shown verbatim; the first non-empty line titles it.
	assert.deepEqual(runCodeModel({ call: { name: 'run_code', argsRaw: 'not json at all' } } as never), {
		code: 'not json at all',
		title: 'not json at all',
	});
	// A description wins over the code as the title.
	assert.deepEqual(runCodeModel(runCodeBlock(JSON.stringify({ code: 'print(1)', description: 'demo' })) as never), {
		code: 'print(1)',
		title: 'demo',
	});
	// Empty description is ignored; a multiline program titles on its first non-empty line.
	const multi = runCodeModel(runCodeBlock(JSON.stringify({ code: '\n\n  first line  \nsecond', description: '' })) as never);
	assert.equal(multi.code, '\n\n  first line  \nsecond');
	assert.equal(multi.title, 'first line');
	// Missing block / empty program fall back to a literal / the run_code label.
	assert.deepEqual(runCodeModel(undefined), { code: '{}', title: '{}' });
	assert.deepEqual(runCodeModel({ call: { name: 'run_code', argsRaw: '' } } as never), { code: '', title: 'run_code' });
});

test('code view: collapsed settled-ok, expanded body, no inspect when unwired', () => {
	clearExpandedToolBlockKeysForTest();
	const block = runCodeBlock(JSON.stringify({ code: 'print(1)', description: 'demo' }));
	const collapsed = renderCode({ block, callId: 'cv1' });
	assert.match(collapsed, /data-kind="code"/);
	assert.ok(collapsed.includes('data-state="ok"'));
	assert.equal(collapsed.includes('agy-tv-body-wrap'), false);
	assert.equal(collapsed.includes('agy-tv-inspect-btn'), false);

	expandToolBlockKeyForTest('call:cv1');
	const open = renderCode({ block, callId: 'cv1' });
	assert.match(open, /agy-tv-root agy-tv-open/);
	assert.match(open, /agy-tv-body-wrap/);
	assert.match(open, /agy-tv-card-content/);
	assert.ok(open.includes('print(1)'));
	assert.equal(open.includes('agy-tv-inspect-btn'), false);
});

test('code view: settled error marks state/summary and running is not settled', () => {
	const err = renderCode({ block: runCodeBlock(JSON.stringify({ code: 'boom' }), { isError: true }), callId: 'cv-err' });
	assert.ok(err.includes('data-state="err"'));
	assert.match(err, /agy-tv-summary-err/);

	const running = renderCode({ block: { name: 'run_code', argsRaw: JSON.stringify({ code: 'sleep 1' }), subCalls: [] }, callId: 'cv-run' });
	assert.ok(running.includes('data-state="run"'));
	assert.match(running, /data-kind="code"/);

	// No props at all still renders (block undefined -> run state).
	assert.doesNotThrow(() => renderCode({}));
});

test('code view: inspect affordance and translation fallbacks', () => {
	clearExpandedToolBlockKeysForTest();
	expandToolBlockKeyForTest('call:cv-ins');
	const withInspect = renderCode({ block: runCodeBlock(JSON.stringify({ code: 'x' })), callId: 'cv-ins', inspect: () => undefined });
	assert.match(withInspect, /agy-tv-inspect-btn/);

	// Without a `t` function the translate() seam falls back to the raw keys.
	assert.ok(withInspect.includes('code.inspect'));
	assert.ok(withInspect.includes('code.title'));

	expandToolBlockKeyForTest('call:cv-t');
	const t = (k: string): string => ({ 'code.title': 'Code', 'code.copy': 'Copy', 'code.copied': 'Copied', 'code.inspect': 'Inspect' } as Record<string, string>)[k] ?? k;
	const withT = renderCode({ block: runCodeBlock(JSON.stringify({ code: 'y' })), callId: 'cv-t', t, inspect: () => undefined });
	assert.ok(withT.includes('Code'));
	assert.ok(withT.includes('Inspect'));
});

test('run_code view: mirror detection falls back to the code card on non-mirror input', () => {
	const renderRun = (block: AnyBlock): string => renderToStaticMarkup(createElement(AgyRunCodeToolView, { block }));

	// Invalid JSON argsRaw.
	assert.match(renderRun({ kind: 'tool-result', call: { name: 'run_code', argsRaw: '{not json' }, content: [], isError: false }), /data-kind="code"/);
	// Valid JSON but no mirror call.
	assert.match(renderRun(runCodeBlock(JSON.stringify({ code: 'print(1)' }))), /data-kind="code"/);
	// A non-string code member.
	assert.match(renderRun(runCodeBlock(JSON.stringify({ code: 42 }))), /data-kind="code"/);
	// Mirror envelope missing "step".
	assert.match(renderRun(runCodeBlock(JSON.stringify({ code: "return await tools['agy_tool']({\"run\":\"r\"})" }))), /data-kind="code"/);
	// Mirror envelope with a malformed inner JSON object.
	assert.match(renderRun(runCodeBlock(JSON.stringify({ code: 'return await tools[\'agy_tool\']({bad "step":1})' }))), /data-kind="code"/);
	// Inner JSON present but run/step have the wrong types.
	assert.match(renderRun(runCodeBlock(JSON.stringify({ code: "return await tools['agy_tool']({\"run\":1,\"step\":\"x\"})" }))), /data-kind="code"/);
});

test('run_code view: a valid mirror wrapper without a tool hint still renders the native card', () => {
	const code = "return await tools['agy_tool']({\"run\":\"r\",\"step\":2})";
	const block = runCodeBlock(JSON.stringify({ code, description: 'replay' }));
	const html = renderToStaticMarkup(createElement(AgyRunCodeToolView, { block }));
	assert.match(html, /class="agy-tv-root"/);
	assert.equal(html.includes('data-kind="code"'), false);
});

