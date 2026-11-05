import test from 'node:test';
import assert from 'node:assert/strict';
import {
	tryExpandThinkRow,
	clearHandledTurnsForTest,
} from '../src/client/reasoning.ts';
import { setScrollActiveForTest } from '../src/client/scroll-guard.ts';

type MockEl = {
	tagName: string;
	className: string;
	textContent: string;
	dataset: Record<string, string | undefined>;
	style: Record<string, string>;
	children: MockEl[];
	parentNode: MockEl | null;
	clickCount: number;
	clientHeight: number;
	clickListeners: Array<() => void>;
	querySelector: (sel: string) => MockEl | null;
	querySelectorAll: (sel: string) => MockEl[];
	closest: (sel: string) => MockEl | null;
	getAttribute: (name: string) => string | null;
	setAttribute: (name: string, val: string) => void;
	addEventListener: (type: string, fn: () => void) => void;
	click: () => void;
};

function createEl(tagName: string, className = ''): MockEl {
	const el: MockEl = {
		tagName: tagName.toUpperCase(),
		className,
		textContent: '',
		dataset: {},
		style: {},
		children: [],
		parentNode: null,
		clickCount: 0,
		clientHeight: 0,
		clickListeners: [],
		querySelector(sel: string): MockEl | null {
			for (const child of el.children) {
				if (matchSel(child, sel)) return child;
				const sub = child.querySelector(sel);
				if (sub) return sub;
			}
			return null;
		},
		querySelectorAll(sel: string): MockEl[] {
			const res: MockEl[] = [];
			for (const child of el.children) {
				if (matchSel(child, sel)) res.push(child);
				res.push(...child.querySelectorAll(sel));
			}
			return res;
		},
		closest(sel: string): MockEl | null {
			let cur: MockEl | null = el;
			while (cur) {
				if (matchSel(cur, sel)) return cur;
				cur = cur.parentNode;
			}
			return null;
		},
		getAttribute(name: string): string | null {
			return el.dataset[name.replace(/^data-/, '')] ?? null;
		},
		setAttribute(name: string, val: string): void {
			el.dataset[name.replace(/^data-/, '')] = val;
		},
		addEventListener(type: string, fn: () => void): void {
			if (type === 'click') el.clickListeners.push(fn);
		},
		click(): void {
			el.clickCount++;
			for (const l of el.clickListeners) l();
		},
	};
	return el;
}

function matchSel(el: MockEl, sel: string): boolean {
	if (sel === '[data-disclosure-row]' && el.dataset.disclosureRow !== undefined) return true;
	if (sel === 'button' && el.tagName === 'BUTTON') return true;
	if (sel.includes('thinkBody') && el.className.includes('thinkBody')) return true;
	if (sel.includes('data-message-id') && el.dataset.messageId !== undefined) return true;
	if (sel === 'div[data-variant="think"]' && el.tagName === 'DIV' && el.dataset.variant === 'think') return true;
	return false;
}

function makeThinkRow(msgId: string, proseText: string): { root: MockEl; toggle: MockEl; body: MockEl } {
	const msgContainer = createEl('DIV');
	msgContainer.dataset.messageId = msgId;

	const root = createEl('DIV');
	root.dataset.variant = 'think';
	root.parentNode = msgContainer;
	msgContainer.children.push(root);

	const toggle = createEl('BUTTON');
	toggle.dataset.disclosureRow = 'true';
	toggle.parentNode = root;
	root.children.push(toggle);

	const body = createEl('DIV', 'custom_thinkBody_123');
	body.textContent = proseText;
	body.clientHeight = 0; // Collapsed by default in React
	body.parentNode = root;
	root.children.push(body);

	return { root, toggle, body };
}

test('tryExpandThinkRow expands a new thinking turn with prose exactly once', () => {
	clearHandledTurnsForTest();
	setScrollActiveForTest(false);

	const { root, toggle } = makeThinkRow('msg_1', 'I need to check the file list first.');
	tryExpandThinkRow(root as unknown as HTMLElement);

	assert.equal(toggle.clickCount, 1, 'toggle.click() should be called once to auto-expand prose');
	assert.equal(root.dataset.agyExpanded, 'true', 'root marked as expanded');

	// Second pass on same element does nothing
	tryExpandThinkRow(root as unknown as HTMLElement);
	assert.equal(toggle.clickCount, 1, 'repeated pass should not trigger a second click');
});

test('REGRESSION: TanStack Virtualizer remount does NOT trigger toggle.click() or flashing flywheel', () => {
	clearHandledTurnsForTest();
	setScrollActiveForTest(false);

	// Initial render
	const first = makeThinkRow('msg_1', 'I need to check the file list first.');
	tryExpandThinkRow(first.root as unknown as HTMLElement);
	assert.equal(first.toggle.clickCount, 1);

	// User scrolls -> item unmounts -> item remounts with BRAND NEW DOM nodes!
	// In the old buggy code, a new DOM node lacked dataset.agyExpanded and WeakSet membership,
	// so tryExpandThinkRow clicked toggle.click() on EVERY scroll pass.
	for (let i = 0; i < 5; i++) {
		const remounted = makeThinkRow('msg_1', 'I need to check the file list first.');
		tryExpandThinkRow(remounted.root as unknown as HTMLElement);
		assert.equal(
			remounted.toggle.clickCount,
			0,
			`remount #${i + 1} must NOT call toggle.click() (would cause 3-flash virtualizer height jump)`,
		);
		assert.equal(remounted.root.dataset.agyExpanded, 'true');
	}
});

test('tryExpandThinkRow skips bare banner chips without auto-expanding', () => {
	clearHandledTurnsForTest();
	setScrollActiveForTest(false);

	const { root, toggle } = makeThinkRow('msg_2', '[agy · 450 tokens]');
	tryExpandThinkRow(root as unknown as HTMLElement);

	assert.equal(toggle.clickCount, 0, 'bare banner should stay collapsed');
	assert.equal(root.dataset.agyExpanded, undefined, 'banner-only is not permanently claimed');
});

test('tryExpandThinkRow suppresses click synthesis while scrolling is active', () => {
	clearHandledTurnsForTest();
	setScrollActiveForTest(true); // User is scrolling

	const { root, toggle } = makeThinkRow('msg_3', 'Some new thoughts arriving while user scrolls.');
	tryExpandThinkRow(root as unknown as HTMLElement);

	assert.equal(toggle.clickCount, 0, 'must not simulate click while scrolling is active');

	// Scrolling settles
	setScrollActiveForTest(false);
	tryExpandThinkRow(root as unknown as HTMLElement);
	assert.equal(toggle.clickCount, 1, 'expands after scrolling has settled');
});

test('manual user toggle permanently marks the turn so scanner never reverses it', () => {
	clearHandledTurnsForTest();
	setScrollActiveForTest(false);

	const { root, toggle } = makeThinkRow('msg_4', 'Prose content that user manually controls.');
	// Setup listener
	tryExpandThinkRow(root as unknown as HTMLElement);
	assert.equal(toggle.clickCount, 1);

	// User manually clicks toggle to collapse it
	toggle.click();
	assert.equal(toggle.clickCount, 2);

	// Scanner passes again on remount: must NOT re-expand
	const remounted = makeThinkRow('msg_4', 'Prose content that user manually controls.');
	tryExpandThinkRow(remounted.root as unknown as HTMLElement);
	assert.equal(remounted.toggle.clickCount, 0, 'scanner must not undo user manual collapse');
});

test('tryExpandThinkRow recognizes aria-expanded="true" without clicking or reading clientHeight', () => {
	clearHandledTurnsForTest();
	setScrollActiveForTest(false);

	const { root, toggle, body } = makeThinkRow('msg_5', 'Some thought prose already expanded by host.');
	toggle.setAttribute('aria-expanded', 'true');
	body.clientHeight = 0; // Even if clientHeight measurement is 0, attribute check avoids forced reflow

	tryExpandThinkRow(root as unknown as HTMLElement);
	assert.equal(toggle.clickCount, 0, 'must not click if aria-expanded is already true');
	assert.equal(root.dataset.agyExpanded, 'true', 'marks root as expanded');
});
