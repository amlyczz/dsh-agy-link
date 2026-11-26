import '../helpers/client-render.ts';
import { React, renderToStaticMarkup } from '../helpers/client-render.ts';

import assert from 'node:assert/strict';
import test from 'node:test';

import type { SessionView } from '../../src/common/session-view.ts';
import { GLOBAL_CSS } from '../../src/client/global-css.ts';
import { MODAL_CSS } from '../../src/client/modal-css.ts';
import { agyIcon } from '../../src/client/icons.ts';
import { isSessionViewEqual } from '../../src/client/session-view.ts';
import {
	disposeScrollListener,
	ensureScrollListener,
	isScrollActive,
	onScrollIdle,
	setScrollActiveForTest,
} from '../../src/client/scroll-guard.ts';
import { S } from '../../src/client/styles.ts';
import { Modal } from '../../src/client/ui/Modal.ts';
import { createSessionStatus } from '../../src/client/sections/SessionStatus.ts';
import { disposeStatusPolling, publishStatusSnapshot } from '../../src/client/status.ts';

const createElement = (React as { createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown }).createElement;

function cssRule(cssSrc: string, selector: string): string {
	const start = cssSrc.indexOf(selector + ' {');
	assert.notEqual(start, -1, `missing CSS rule for ${selector}`);
	const end = cssSrc.indexOf('}', start);
	return cssSrc.slice(start, end + 1);
}

test('embedded .agy-console and modal body share anti-flicker CSS safeguards', () => {
	const modalScrollPause = cssRule(MODAL_CSS, 'html.agy-scrolling :is(.agy-modal-panel, .agy-modal-panel *)');
	assert.match(modalScrollPause, /animation-play-state:\s*paused\s*!important/);
	assert.match(modalScrollPause, /transition:\s*none\s*!important/);

	const consoleScrollPause = cssRule(MODAL_CSS, 'html.agy-scrolling :is(.agy-console, .agy-console *)');
	assert.match(consoleScrollPause, /animation-play-state:\s*paused\s*!important/);
	assert.match(consoleScrollPause, /transition:\s*none\s*!important/);

	const modalBodyRule = cssRule(MODAL_CSS, '.agy-modal-body');
	assert.match(modalBodyRule, /overflow-anchor:\s*none/);

	const consoleRule = cssRule(GLOBAL_CSS, '.agy-console');
	assert.match(consoleRule, /overflow-x:\s*clip/);
	assert.doesNotMatch(consoleRule, /overflow-x:\s*hidden/);
	assert.match(consoleRule, /overflow-anchor:\s*none/);

	const shimmerAfter = cssRule(GLOBAL_CSS, '.agy-shimmer-track::after');
	assert.match(shimmerAfter, /background-size:/);
	assert.doesNotMatch(shimmerAfter, /transform:/);
});

test('card styles and Modal body avoid hover box-shadow transitions and scroll anchoring', () => {
	assert.doesNotMatch(String(S.card?.transition ?? ''), /box-shadow|opacity/);
	assert.doesNotMatch(String(S.cardPrimary?.transition ?? ''), /box-shadow|opacity/);

	const modalHtml = renderToStaticMarkup(createElement(Modal, {
		heading: 'Console',
		closeLabel: 'Close',
		onClose: () => {},
		children: createElement('div', null, 'body'),
	}));
	assert.match(modalHtml, /class="agy-modal-body"[^>]*overflow-anchor:\s*none/);
});

test('agyIcon emits deterministic SVG gradient IDs across consecutive renders', () => {
	const first = renderToStaticMarkup(agyIcon(18));
	const second = renderToStaticMarkup(agyIcon(18));
	assert.equal(first, second);
	assert.match(first, /id="agy-logo-18-orb"/);
});

test('isSessionViewEqual compares all session view fields structurally', () => {
	const base: SessionView = {
		model: 'gemini-3-pro',
		family: 'google',
		accountId: 'acc_1',
		alias: 'primary',
		email: 'u@example.com',
		defaultAlias: false,
		systemHome: false,
		source: 'session',
		percent: 80,
		window: 'five-hour',
		stale: false,
		cooling: false,
		eligible: true,
	};
	assert.equal(isSessionViewEqual(null, null), true);
	assert.equal(isSessionViewEqual(base, null), false);
	assert.equal(isSessionViewEqual(base, { ...base }), true);
	assert.equal(isSessionViewEqual(base, { ...base, percent: 79 }), false);
	assert.equal(isSessionViewEqual(base, { ...base, cooling: true }), false);
	assert.equal(isSessionViewEqual(base, { ...base, accountId: 'acc_2' }), false);
});

test('scroll-guard attaches wheel/scroll/touchmove listeners passively and runs idle callbacks after settle', async () => {
	const added: Array<{ type: string; fn: () => void; options: unknown }> = [];
	const removed: string[] = [];
	const origWin = globalThis.window;
	let settled = false;
	const unsub = onScrollIdle(() => { settled = true; });
	try {
		disposeScrollListener();
		(globalThis as unknown as { window: Record<string, unknown> }).window = {
			addEventListener: (type: string, fn: () => void, options: unknown) => { added.push({ type, fn, options }); },
			removeEventListener: (type: string) => { removed.push(type); },
		};
		ensureScrollListener();
		assert.deepEqual(
			added.map((e) => e.type),
			['scroll', 'wheel', 'touchmove'],
		);
		for (const item of added) {
			assert.deepEqual(item.options, { passive: true, capture: true });
		}
		const wheelHandler = added.find((e) => e.type === 'wheel')?.fn;
		assert.ok(wheelHandler);
		wheelHandler();
		assert.equal(isScrollActive(), true);
		assert.equal(settled, false);
		await new Promise((r) => setTimeout(r, 290));
		assert.equal(isScrollActive(), false);
		assert.equal(settled, true);
		disposeScrollListener();
		assert.deepEqual(removed, ['scroll', 'wheel', 'touchmove']);
	} finally {
		unsub();
		setScrollActiveForTest(false);
		(globalThis as unknown as { window: unknown }).window = origWin;
	}
});

test('createSessionStatus renders HeaderBadge cleanly without leaking hidden badge markup', () => {
	const locale = {
		subscribe: () => () => {},
		bind: () => (key: string) => key,
	};
	const StatusBadge = createSessionStatus(locale, () => null);
	const emptyPool = {
		version: 1 as const,
		mode: 'sequential' as const,
		defaultCooldownMs: 60_000,
		maxCooldownMs: 3_600_000,
		accounts: [],
	};
	try {
		publishStatusSnapshot({ showHeaderBadge: true, pool: emptyPool });
		const visibleHtml = renderToStaticMarkup(createElement(StatusBadge, { sessionId: 's1' }));
		assert.match(visibleHtml, /agy-session-status-btn/);

		publishStatusSnapshot({ showHeaderBadge: false, pool: emptyPool });
		const hiddenHtml = renderToStaticMarkup(createElement(StatusBadge, { sessionId: 's1' }));
		assert.doesNotMatch(hiddenHtml, /agy-session-status-btn/);
	} finally {
		publishStatusSnapshot({ showHeaderBadge: true });
		disposeStatusPolling();
	}
});
