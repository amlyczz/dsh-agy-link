// Bridged tools hand their answer back wrapped in MCP JSON. The card must show
// the answer, so these cases pin the envelope shapes agy actually forwards.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { unwrapToolPayload } from '../../src/client/toolview/payload.ts';

describe('unwrapToolPayload', () => {
	it('leaves plain text untouched', () => {
		const p = unwrapToolPayload('line one\nline two');
		assert.equal(p.text, 'line one\nline two');
		assert.deepEqual(p.images, []);
		assert.equal(p.unwrapped, false);
	});

	it('unwraps a bare MCP CallToolResult text block', () => {
		const raw = JSON.stringify({ content: [{ type: 'text', text: 'total 12\ndrwxr-xr-x  foo' }] });
		const p = unwrapToolPayload(raw);
		assert.equal(p.text, 'total 12\ndrwxr-xr-x  foo');
		assert.equal(p.unwrapped, true);
	});

	it('unwraps nested ACP content wrappers', () => {
		const raw = JSON.stringify({ content: [{ type: 'content', content: { type: 'text', text: 'disk full' } }] });
		assert.equal(unwrapToolPayload(raw).text, 'disk full');
	});

	it('joins multiple text blocks in order', () => {
		const raw = JSON.stringify({ content: [
			{ type: 'text', text: 'first' },
			{ type: 'text', text: 'second' },
		] });
		assert.equal(unwrapToolPayload(raw).text, 'first\nsecond');
	});

	it('turns an image block into a data URL', () => {
		const raw = JSON.stringify({ content: [
			{ type: 'text', text: 'captured screenshot' },
			{ type: 'image', data: 'QUJD', mimeType: 'image/png' },
		] });
		const p = unwrapToolPayload(raw);
		assert.equal(p.text, 'captured screenshot');
		assert.deepEqual(p.images, ['data:image/png;base64,QUJD']);
	});

	it('keeps an image block that carries only a URL', () => {
		const raw = JSON.stringify({ content: [{ type: 'image', uri: 'https://example.test/a.png' }] });
		assert.deepEqual(unwrapToolPayload(raw).images, ['https://example.test/a.png']);
	});

	it('renders a terminal block with its exit code', () => {
		const raw = JSON.stringify({ content: [{ type: 'terminal', exitCode: 3, output: 'boom' }] });
		assert.equal(unwrapToolPayload(raw).text, '[exit code 3]\nboom');
	});

	it('unwraps a DSH tool batch envelope', () => {
		const raw = JSON.stringify({ results: [{ callId: 'c1', result: { content: [{ type: 'text', text: 'ok' }] } }] });
		assert.equal(unwrapToolPayload(raw).text, 'ok');
	});

	it('pretty-prints a minified JSON answer', () => {
		const p = unwrapToolPayload('{"ok":true,"path":"a.txt"}');
		assert.equal(p.text, '{\n  "ok": true,\n  "path": "a.txt"\n}');
		assert.equal(p.unwrapped, true);
	});

	it('keeps already-readable JSON as-is', () => {
		const pretty = '{\n  "ok": true\n}';
		assert.equal(unwrapToolPayload(pretty).text, pretty);
	});

	it('collapses an empty result envelope to nothing', () => {
		const p = unwrapToolPayload('{"content":[]}');
		assert.equal(p.text, '');
		assert.equal(p.unwrapped, true);
	});

	it('ignores malformed JSON', () => {
		const raw = '{not json';
		assert.equal(unwrapToolPayload(raw).text, raw);
	});

	it('caps how many images one payload contributes', () => {
		const content = Array.from({ length: 12 }, (_, i) => ({ type: 'image', data: 'A' + i, mimeType: 'image/png' }));
		assert.equal(unwrapToolPayload(JSON.stringify({ content })).images.length, 6);
	});
});
