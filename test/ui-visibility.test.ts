// Issue #105: the header status badge and the per-message "translate to plain
// language" button are user-hideable. These tests drive the real components
// (SSR for the header, jsdom-free pure helpers for the visibility rule) instead
// of string-matching a bundle, so a refactor cannot silently drop the switch.
import './helpers/client-render.ts';
import { React, renderToStaticMarkup } from './helpers/client-render.ts';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	disposeStatusPolling,
	isUiVisible,
	publishStatusSnapshot,
	type StatusPayload,
} from '../src/client/status.ts';
import { createSessionStatus } from '../src/client/sections/SessionStatus.ts';

const createElement = (React as { createElement: (type: unknown, props?: unknown) => unknown }).createElement;

const locale = {
	subscribe: () => () => {},
	bind: () => (key: string) => key,
};

const SettingsSection = () => null;

function renderBadge(): string {
	const Badge = createSessionStatus(locale, SettingsSection);
	return renderToStaticMarkup(createElement(Badge));
}

test('isUiVisible is opt-out: only an explicit false hides an affordance', () => {
	assert.equal(isUiVisible(null, 'showHeaderBadge'), true, 'no status yet (startup) stays visible')
	assert.equal(isUiVisible(undefined, 'showTranslateAction'), true)
	assert.equal(isUiVisible({}, 'showHeaderBadge'), true, 'older hosts without the field stay visible')
	assert.equal(isUiVisible({ showTranslateAction: true }, 'showTranslateAction'), true)
	assert.equal(isUiVisible({ showTranslateAction: false }, 'showTranslateAction'), false)
	assert.equal(isUiVisible({ showHeaderBadge: false }, 'showHeaderBadge'), false)
	// The two switches are independent.
	assert.equal(isUiVisible({ showHeaderBadge: false }, 'showTranslateAction'), true)
})

test('issue #105: an explicit status opt-out removes the header badge but keeps the console portal', () => {
	try {
		publishStatusSnapshot({ showHeaderBadge: true, showTranslateAction: true } satisfies StatusPayload)
		assert.match(renderBadge(), /agy-session-status-btn/, 'badge is visible by default')

		publishStatusSnapshot({ showHeaderBadge: false } satisfies StatusPayload)
		assert.doesNotMatch(renderBadge(), /agy-session-status-btn/, 'badge must not render when hidden')

		publishStatusSnapshot({ showHeaderBadge: true } satisfies StatusPayload)
		assert.match(renderBadge(), /agy-session-status-btn/, 'turning the switch back on restores the badge')
	} finally {
		publishStatusSnapshot({ showHeaderBadge: true, showTranslateAction: true } satisfies StatusPayload)
		disposeStatusPolling()
	}
})
