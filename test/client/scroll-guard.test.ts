import test from 'node:test';
import assert from 'node:assert/strict';
import {
	isScrollActive,
	setScrollActiveForTest,
	onScrollSettle,
	onScrollIdle,
	settleScrollForTest,
	ensureScrollListener,
	disposeScrollListener,
	setOverlaySuspended,
	isOverlaySuspended,
	isInteractionLocked,
} from '../../src/client/scroll-guard.ts';

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

test('scroll activity toggles the html.agy-scrolling class for CSS-side pausing', () => {
	const classes = new Set<string>()
	const fakeDocument = {
		documentElement: {
			classList: {
				toggle: (name: string, on?: boolean) => {
					if (on === true) classes.add(name)
					else if (on === false) classes.delete(name)
				},
			},
		},
	}
	const globals = globalThis as { document?: unknown }
	const previous = globals.document
	globals.document = fakeDocument
	try {
		setScrollActiveForTest(true)
		assert.equal(classes.has('agy-scrolling'), true, 'a scroll gesture must pause decorative animation via CSS')
		setScrollActiveForTest(false)
		assert.equal(classes.has('agy-scrolling'), false, 'settling must resume the paused effects')
	} finally {
		globals.document = previous as unknown
		disposeScrollListener()
	}
});

test('overlay-safe idle callbacks fire during a scroll inside the console; scanners stay parked', () => {
	disposeScrollListener();
	setScrollActiveForTest(false);
	setOverlaySuspended(false);
	let idle = 0;
	let settle = 0;
	const unbindIdle = onScrollIdle(() => { idle++; });
	const unbindSettle = onScrollSettle(() => { settle++; });
	try {
		// Console open: the gesture happens inside the overlay's own scroller.
		setOverlaySuspended(true);
		settleScrollForTest();
		assert.equal(idle, 1, 'the overlay must receive its deferred update when the gesture ends')
		assert.equal(settle, 0, 'conversation scanners must stay parked while an overlay owns the screen')

		// Closing the overlay itself fires one catch-up settle pass; count from there.
		setOverlaySuspended(false);
		const settleAfterClose = settle;
		settleScrollForTest();
		assert.equal(idle, 2);
		assert.equal(settle, settleAfterClose + 1, 'with no overlay, a settled scroll wakes the scanners again')
	} finally {
		unbindIdle();
		unbindSettle();
		disposeScrollListener();
	}
});
