import test from 'node:test';
import assert from 'node:assert/strict';
import {
	isScrollActive,
	setScrollActiveForTest,
	onScrollSettle,
	ensureScrollListener,
	disposeScrollListener,
	setOverlaySuspended,
	isOverlaySuspended,
	isInteractionLocked,
} from '../src/client/scroll-guard.ts';

test('isScrollActive returns false by default and accepts test override', () => {
	disposeScrollListener();
	assert.equal(isScrollActive(), false);
	setScrollActiveForTest(true);
	assert.equal(isScrollActive(), true);
	setScrollActiveForTest(false);
	assert.equal(isScrollActive(), false);
});

test('onScrollSettle unbinds cleanly', () => {
	let settled = 0;
	const unbind = onScrollSettle(() => {
		settled++;
	});
	unbind();
	disposeScrollListener();
	assert.equal(settled, 0);
});

test('overlay suspension locks interaction even when not scrolling', () => {
	disposeScrollListener();
	setScrollActiveForTest(false);
	assert.equal(isOverlaySuspended(), false);
	assert.equal(isInteractionLocked(), false);

	setOverlaySuspended(true);
	assert.equal(isOverlaySuspended(), true);
	assert.equal(isInteractionLocked(), true, 'an open overlay must lock interaction just like scrolling');

	setOverlaySuspended(false);
	assert.equal(isOverlaySuspended(), false);
	assert.equal(isInteractionLocked(), false);
});

test('isInteractionLocked is true while either scrolling or suspended', () => {
	disposeScrollListener();
	setScrollActiveForTest(true);
	setOverlaySuspended(false);
	assert.equal(isInteractionLocked(), true);

	setScrollActiveForTest(false);
	setOverlaySuspended(true);
	assert.equal(isInteractionLocked(), true);

	setOverlaySuspended(false);
	assert.equal(isInteractionLocked(), false);
});

test('resuming from suspension notifies settle listeners (catch-up scan)', () => {
	disposeScrollListener();
	setOverlaySuspended(false);
	let settled = 0;
	const unbind = onScrollSettle(() => {
		settled++;
	});
	setOverlaySuspended(true);
	assert.equal(settled, 0, 'suspending must not fire settle listeners');
	setOverlaySuspended(false);
	assert.equal(settled, 1, 'resuming must trigger one catch-up scan');
	unbind();
	disposeScrollListener();
	setOverlaySuspended(false);
});
