// Issue #107: the pool-wide catalog settings row is a real, clickable control.
import './helpers/client-render.ts';
import { React, renderToStaticMarkup } from './helpers/client-render.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPoolWideCatalogRow } from '../src/client/sections/CatalogRows.ts';

const createElement = (React as { createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown }).createElement;

function row(on: boolean) {
	const written: Array<[string, unknown]> = [];
	const el = renderPoolWideCatalogRow({
		t: ((key: string) => key) as never,
		status: { poolWideCatalog: on },
		loadingAction: on ? 'config:poolWideCatalog' : null,
		setCfg: async (key, value) => { written.push([key, value]) },
	}) as { props: { right: { props: { children: Array<{ props: { onClick: () => void; disabled: boolean; variant: string } }> } } } };
	return { el, written };
}

test('pool-wide catalog row renders both states and writes the right key', () => {
	const off = row(false)
	const html = renderToStaticMarkup(createElement('div', null, off.el))
	assert.match(html, /config\.poolWideCatalog/)
	assert.match(html, /config\.poolWideCatalogDesc/)
	const onButtons = off.el.props.right.props.children
	assert.equal(onButtons[0]!.props.variant, 'seg')
	assert.equal(onButtons[1]!.props.variant, 'segActive')
	assert.equal(onButtons[0]!.props.disabled, false)
	onButtons[0]!.props.onClick()
	onButtons[1]!.props.onClick()
	assert.deepEqual(off.written, [['poolWideCatalog', true], ['poolWideCatalog', false]])

	const on = row(true)
	const onRow = on.el.props.right.props.children
	assert.equal(onRow[0]!.props.variant, 'segActive')
	assert.equal(onRow[0]!.props.disabled, true, 'a write in flight disables the control')
})
