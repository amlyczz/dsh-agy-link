// Real DOM behavior tests (R2) — jsdom harness for the client's DOM scanners,
// lightbox, scroll coordinator, the translation action and the toolview cards.
//
// The client modules read `window`/`document`/`navigator` as free globals (the
// host injects them). Node ESM has none, so each test installs a fresh JSDOM and
// assigns the globals BEFORE the module functions run, then restores them.
import './helpers/client-render.ts';
import { React, renderToStaticMarkup } from './helpers/client-render.ts';

import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { JSDOM } = nodeRequire('jsdom') as { JSDOM: new (html?: string, options?: Record<string, unknown>) => any };
const ReactDOMClient = nodeRequire('react-dom/client') as any;
const testUtils = nodeRequire('react-dom/test-utils') as any;

import { openLightbox } from '../src/client/images/lightbox.ts';
import { installImageEnhancer, openInRightSidebar, scanAndEnhanceImages, setClientContext } from '../src/client/images/scanner.ts';
import { installDecisionChips, insertTextIntoChatComposer, scanAndEnhanceDecisions } from '../src/client/decisions.ts';
import {
	buildCompactionRow,
	installCompactionCard,
	scanAndEnhanceCompactionCards,
} from '../src/client/compaction.ts';
import {
	disposeScrollListener,
	ensureScrollListener,
	isInteractionLocked,
	isOverlaySuspended,
	isScrollActive,
	onScrollSettle,
	setOverlaySuspended,
	setScrollActiveForTest,
} from '../src/client/scroll-guard.ts';
import { actionStateOf, setActionState, TranslateAction } from '../src/client/translate-state.ts';
import { TranslationCard } from '../src/client/translate-card.ts';
import { QuestionCardBody } from '../src/client/toolview/question-card.ts';
import { clearExpandedToolBlockKeysForTest, expandToolBlockKeyForTest } from '../src/client/toolview/toggle.ts';
import { AgyCodeToolView, AgyRunCodeToolView, runCodeModel } from '../src/client/toolview/run-code-view.ts';

const createElement = (React as { createElement: (type: unknown, props?: unknown) => unknown }).createElement;
const GLOBAL_KEYS = [
	'window', 'document', 'navigator', 'MutationObserver',
	'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLAnchorElement', 'HTMLImageElement',
	'Node', 'Element', 'Event', 'InputEvent', 'KeyboardEvent', 'MouseEvent', 'WheelEvent', 'CustomEvent',
	'URL', 'URLSearchParams', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
	'IS_REACT_ACT_ENVIRONMENT',
] as const;

let dom: any;
let saved: Array<[string, PropertyDescriptor | undefined]> = [];
let clipboardWrites: string[] = [];
const disposers: Array<() => void> = [];
const trackedTimers = new Set<any>();
const origGlobalSetTimeout = globalThis.setTimeout;
const origGlobalClearTimeout = globalThis.clearTimeout;

function setGlobal(key: string, value: unknown): void {
	saved.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
	Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

function installDom(options: { url?: string; readyState?: string; html?: string } = {}): any {
	saved = [];
	clipboardWrites = [];
	dom = new JSDOM(
		options.html ?? '<!doctype html><html lang="zh"><body></body></html>',
		{ pretendToBeVisual: true, url: options.url ?? 'http://example.com/' },
	);
	const w = dom.window;
	globalThis.setTimeout = ((cb: any, ms?: number, ...args: any[]) => {
		const id = origGlobalSetTimeout((...cbArgs: any[]) => {
			trackedTimers.delete(id);
			cb(...cbArgs);
		}, ms, ...args);
		trackedTimers.add(id);
		return id;
	}) as typeof globalThis.setTimeout;
	globalThis.clearTimeout = ((id: any) => {
		trackedTimers.delete(id);
		origGlobalClearTimeout(id);
	}) as typeof globalThis.clearTimeout;
	w.setTimeout = globalThis.setTimeout;
	w.clearTimeout = globalThis.clearTimeout;
	for (const key of GLOBAL_KEYS) {
		if (key !== 'window' && key !== 'document' && key !== 'navigator' && key !== 'requestAnimationFrame' && key !== 'cancelAnimationFrame') {
			setGlobal(key, (w as any)[key]);
		}
	}
	setGlobal('window', w);
	setGlobal('document', w.document);
	setGlobal('navigator', w.navigator);
	setGlobal('requestAnimationFrame', (cb: (t: number) => void) => w.requestAnimationFrame(cb));
	setGlobal('cancelAnimationFrame', (id: number) => w.cancelAnimationFrame(id));
	setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
	Object.defineProperty(w.navigator, 'clipboard', {
		configurable: true,
		value: { writeText: async (text: string) => { clipboardWrites.push(text); } },
	});
	if (options.readyState !== undefined) {
		Object.defineProperty(w.document, 'readyState', { configurable: true, value: options.readyState });
	}
	return w;
}

function restoreDom(): void {
	for (const dispose of disposers.splice(0)) {
		try { dispose(); } catch { /* already torn down */ }
	}
	for (const id of trackedTimers) {
		try { origGlobalClearTimeout(id); } catch { /* ignore */ }
	}
	trackedTimers.clear();
	globalThis.setTimeout = origGlobalSetTimeout;
	globalThis.clearTimeout = origGlobalClearTimeout;
	try { disposeScrollListener(); } catch { /* window already gone */ }
	for (const [key, descriptor] of saved.reverse()) {
		if (descriptor !== undefined) Object.defineProperty(globalThis, key, descriptor);
		else delete (globalThis as unknown as Record<string, unknown>)[key];
	}
	saved = [];
	if (dom !== undefined) {
		try { dom.window.close(); } catch { /* ignore */ }
		dom = undefined;
	}
}

beforeEach(() => {
	setScrollActiveForTest(false);
	setOverlaySuspended(false);
	installDom();
});

afterEach(() => {
	restoreDom();
});

function track(dispose: () => void): void {
	disposers.push(dispose);
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function act(fn: () => void | Promise<void>): Promise<void> {
	await testUtils.act(async () => { await fn(); });
}

async function mount(element: unknown): Promise<{ container: HTMLElement; root: any }> {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = ReactDOMClient.createRoot(container);
	await act(() => { root.render(element); });
	return { container, root };
}

// ---------------------------------------------------------------------------
// 1. images/lightbox
// ---------------------------------------------------------------------------

test('lightbox: opens with title/alt, zoom controls and closes through the button', async () => {
	openLightbox('/plugins/agy-link/media?path=%2Ftmp%2Fa.png', 'My Image', '/tmp/a.png');
	const overlay = document.querySelector('.agy-lightbox-backdrop') as HTMLElement;
	assert.ok(overlay, 'overlay mounted');
	assert.equal(document.querySelectorAll('.agy-lightbox-backdrop').length, 1);
	assert.equal((document.querySelector('.agy-lightbox-title') as HTMLElement).textContent, 'My Image');
	const img = document.querySelector('.agy-lightbox-img') as HTMLImageElement;
	assert.equal(img.alt, 'My Image');
	assert.ok(img.src.includes('/plugins/agy-link/media'));
	assert.ok(document.querySelector('.agy-lightbox-btn-close'), 'close button');
	assert.ok(document.querySelector('.agy-lightbox-actions'), 'actions');
	// Copy-path button only exists when a raw path is supplied.
	const copyBtn = Array.from(document.querySelectorAll('.agy-lightbox-btn')).find((b) => (b.textContent ?? '').includes('复制路径')) as HTMLButtonElement;
	assert.ok(copyBtn, 'copy path button');
	await act(() => { copyBtn.click(); });
	await wait(0);
	assert.deepEqual(clipboardWrites, ['/tmp/a.png']);
	assert.ok(copyBtn.textContent?.includes('已复制'));

	// Zoom in / out / reset mutate the wrapper transform.
	const wrap = document.querySelector('.agy-lightbox-img-wrap') as HTMLElement;
	const btn = (label: string) => Array.from(document.querySelectorAll('.agy-lightbox-btn')).find((b) => (b.textContent ?? '').includes(label)) as HTMLButtonElement;
	await act(() => { btn('🔍+').click(); });
	assert.match(wrap.style.transform, /scale\(1\.3\)/);
	await act(() => { btn('🔍-').click(); });
	await act(() => { btn('1:1').click(); });
	assert.match(wrap.style.transform, /scale\(1\)/);

	// Wheel zoom (with preventDefault).
	await act(() => { wrap.parentElement!.dispatchEvent(new (window as any).WheelEvent('wheel', { deltaY: -10, bubbles: true, cancelable: true })); });

	await act(() => { (document.querySelector('.agy-lightbox-btn-close') as HTMLButtonElement).click(); });
	await wait(230);
	assert.equal(document.querySelector('.agy-lightbox-backdrop'), null, 'removed after close timer');
});

test('lightbox: default alt, backdrop click and Escape close it', async () => {
	openLightbox('/x.png');
	assert.equal((document.querySelector('.agy-lightbox-img') as HTMLImageElement).alt, 'Image Preview');
	assert.equal(
		Array.from(document.querySelectorAll('.agy-lightbox-btn')).some((b) => (b.textContent ?? '').includes('复制路径')),
		false,
		'no copy-path button without a raw path',
	);
	const overlay = document.querySelector('.agy-lightbox-backdrop') as HTMLElement;
	await act(() => { overlay.click(); });
	await wait(230);
	assert.equal(document.querySelector('.agy-lightbox-backdrop'), null);

	openLightbox('/y.png', 'Second');
	await act(() => { window.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Escape' })); });
	await wait(230);
	assert.equal(document.querySelector('.agy-lightbox-backdrop'), null);

	// Opening again replaces the previous overlay (no stacking).
	openLightbox('/z1.png');
	openLightbox('/z2.png');
	assert.equal(document.querySelectorAll('.agy-lightbox-backdrop').length, 1);
});

test('lightbox: drag/pan updates the transform', async () => {
	openLightbox('/drag.png');
	const body = document.querySelector('.agy-lightbox-body') as HTMLElement;
	const wrap = document.querySelector('.agy-lightbox-img-wrap') as HTMLElement;
	await act(() => {
		body.dispatchEvent(new (window as any).MouseEvent('mousedown', { clientX: 10, clientY: 10, bubbles: true }));
		window.dispatchEvent(new (window as any).MouseEvent('mousemove', { clientX: 40, clientY: 30, bubbles: true }));
	});
	assert.ok(body.classList.contains('grabbing'));
	await act(() => { window.dispatchEvent(new (window as any).MouseEvent('mouseup', { bubbles: true })); });
	assert.equal(body.classList.contains('grabbing'), false);
	assert.match(wrap.style.transform, /translate\(/);
});

// ---------------------------------------------------------------------------
// 2. images/scanner
// ---------------------------------------------------------------------------

function markdownWithImageSpan(md: string, altText: string): HTMLElement {
	const container = document.createElement('div');
	container.className = '_markdown_abc';
	(container as unknown as Record<string, unknown>).__reactProps$test = { text: md };
	const span = document.createElement('span');
	span.className = 'imageAlt_abc';
	span.textContent = altText;
	container.appendChild(span);
	document.body.appendChild(container);
	return container;
}

test('image scanner: rewrites markdown image spans into image cards (idempotent)', () => {
	const container = markdownWithImageSpan('![pic](/home/user/pic.png)', 'pic');
	scanAndEnhanceImages();
	const card = container.querySelector('.agy-image-card') as HTMLElement;
	assert.ok(card, 'image card injected');
	const img = card.querySelector('.agy-image-thumb') as HTMLImageElement;
	assert.ok(img.src.includes('/plugins/agy-link/media?path='));
	assert.equal(img.alt, 'pic');
	assert.equal((card.querySelector('.agy-image-caption') as HTMLElement).textContent, 'pic');
	assert.equal((container.querySelector('.imageAlt_abc') as HTMLElement).style.display, 'none');

	scanAndEnhanceImages();
	assert.equal(container.querySelectorAll('.agy-image-card').length, 1, 'idempotent');
});

test('image scanner: rewrites legacy 127.0.0.1 media srcs to the current origin', () => {
	const img = document.createElement('img');
	img.setAttribute('src', 'http://127.0.0.1:9/plugins/agy-link/media?path=%2Fx.png');
	document.body.appendChild(img);
	scanAndEnhanceImages();
	assert.ok((img.getAttribute('src') ?? '').startsWith('http://example.com/plugins/agy-link/media'));
});

test('image scanner: enhances file:// image links but ignores non-images', () => {
	const imgLink = document.createElement('a');
	imgLink.setAttribute('href', 'file:///tmp/pic.png');
	imgLink.textContent = 'pic';
	document.body.appendChild(imgLink);
	const txtLink = document.createElement('a');
	txtLink.setAttribute('href', 'file:///tmp/notes.txt');
	txtLink.textContent = 'notes';
	document.body.appendChild(txtLink);

	scanAndEnhanceImages();
	assert.equal(imgLink.dataset.agyLinkEnhanced, 'true');
	const chip = imgLink.querySelector('.agy-image-link-icon') as HTMLElement;
	assert.ok(chip, 'preview chip');
	assert.equal(typeof chip.onclick, 'function', 'chip has click handler for lightbox');
	assert.equal(imgLink.onclick, null, 'native link onclick is NOT hijacked');
	assert.equal(txtLink.dataset.agyLinkEnhanced, undefined, 'non-image link not marked as image enhanced');
	assert.equal(txtLink.querySelector('.agy-image-link-icon'), null);
	assert.equal(txtLink.dataset.agyFileEnhanced, 'true', 'marked as file enhanced');
	assert.equal(txtLink.querySelector('.agy-file-link-icon'), null, 'no badge is injected — the link text is the affordance');
	assert.equal(txtLink.textContent, 'notes', 'link text is left untouched');
	scanAndEnhanceImages();
	assert.equal(imgLink.querySelectorAll('.agy-image-link-icon').length, 1, 'idempotent chip');
});

test('image scanner: image load error restores the alt span', () => {
	const container = markdownWithImageSpan('![pic](/home/user/pic.png)', 'pic');
	scanAndEnhanceImages();
	const img = container.querySelector('.agy-image-thumb') as HTMLImageElement;
	awaitImageError(img);
	const card = container.querySelector('.agy-image-card') as HTMLElement;
	const span = container.querySelector('.imageAlt_abc') as HTMLElement;
	assert.equal(card.style.display, 'none');
	assert.equal(span.style.display, '');
});

function awaitImageError(img: HTMLImageElement): void {
	(img as unknown as { onerror: (() => void) | null }).onerror?.();
}

test('image scanner: is gated while scrolling or while an overlay owns the screen', () => {
	markdownWithImageSpan('![pic](/home/user/pic.png)', 'pic');
	setScrollActiveForTest(true);
	scanAndEnhanceImages();
	assert.equal(document.querySelector('.agy-image-card'), null, 'skipped while scrolling');
	setScrollActiveForTest(false);
	setOverlaySuspended(true);
	scanAndEnhanceImages();
	assert.equal(document.querySelector('.agy-image-card'), null, 'skipped while overlay open');
	setOverlaySuspended(false);
	scanAndEnhanceImages();
	assert.ok(document.querySelector('.agy-image-card'), 'runs once unlocked');
});

test('image scanner: install wires the observer and disposes cleanly (idempotent install)', async () => {
	Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
	markdownWithImageSpan('![pic](/home/user/pic.png)', 'pic');
	const dispose1 = installImageEnhancer();
	assert.equal(typeof dispose1, 'function');
	// A second install must replace, not stack.
	const dispose2 = installImageEnhancer();
	dispose1();
	// Mutations schedule a scan after the 100ms debounce.
	const container = document.createElement('div');
	container.className = '_markdown_abc';
	(container as unknown as Record<string, unknown>).__reactProps$late = { text: '![late](/home/user/late.png)' };
	const span = document.createElement('span');
	span.className = 'imageAlt_late';
	span.textContent = 'late';
	container.appendChild(span);
	document.body.appendChild(container);
	await wait(140);
	assert.ok(document.querySelector('.agy-image-card'), 'observer scan ran');
	dispose2();
});

test('image scanner: install early-returns without a window/document', () => {
	delete (globalThis as unknown as Record<string, unknown>).window;
	delete (globalThis as unknown as Record<string, unknown>).document;
	const dispose = installImageEnhancer();
	assert.equal(typeof dispose, 'function');
	dispose();
});

// ---------------------------------------------------------------------------
// 3a. decisions scanner
// ---------------------------------------------------------------------------

function decisionContainer(headingText = '请您拍板', options = ['方案A：先做后端', '方案B：先做前端']): HTMLElement {
	const container = document.createElement('div');
	container.className = '_markdown_dec';
	const heading = document.createElement('h3');
	heading.textContent = headingText;
	container.appendChild(heading);
	const list = document.createElement('ul');
	for (const option of options) {
		const li = document.createElement('li');
		li.textContent = option;
		list.appendChild(li);
	}
	container.appendChild(list);
	document.body.appendChild(container);
	return container;
}

test('decisions: injects a chip toolbar once per container', () => {
	const container = decisionContainer();
	scanAndEnhanceDecisions();
	const box = container.querySelector('.agy-decision-container') as HTMLElement;
	assert.ok(box, 'toolbar injected');
	assert.equal(container.querySelectorAll('.agy-decision-chip').length, 2);
	assert.equal(container.dataset.agyDecisionsScanned, 'true');
	assert.equal((container.querySelector('.agy-decision-chip-num') as HTMLElement).textContent?.trim(), '1.');

	scanAndEnhanceDecisions();
	assert.equal(container.querySelectorAll('.agy-decision-container').length, 1, 'idempotent');
});

test('decisions: skips locked DOM, non-matching headings and existing toolbars', () => {
	const locked = decisionContainer();
	setScrollActiveForTest(true);
	scanAndEnhanceDecisions();
	assert.equal(locked.querySelector('.agy-decision-container'), null, 'locked → skip');
	setScrollActiveForTest(false);

	const irrelevant = decisionContainer('random heading');
	scanAndEnhanceDecisions();
	assert.equal(irrelevant.querySelector('.agy-decision-container'), null, 'non-decision heading skipped');

	const existing = decisionContainer();
	const preexisting = document.createElement('div');
	preexisting.className = 'agy-decision-container';
	existing.appendChild(preexisting);
	scanAndEnhanceDecisions();
	assert.equal(existing.dataset.agyDecisionsScanned, 'true');
	assert.equal(existing.querySelectorAll('.agy-decision-container').length, 1, 'no duplicate toolbar');
});

test('decisions: chip click inserts the selected option and marks the chip', async () => {
	const ta = document.createElement('textarea');
	document.body.appendChild(ta);
	const container = decisionContainer();
	scanAndEnhanceDecisions();
	const chip = container.querySelector('.agy-decision-chip') as HTMLButtonElement;
	await act(() => { chip.click(); });
	assert.ok((ta as HTMLTextAreaElement).value.includes('我选择'));
	assert.ok(chip.classList.contains('selected'));
	await act(async () => { await wait(10); }); // flush after click
});

test('decisions: p>strong headings, option parsing and empty lists', () => {
	const container = document.createElement('div');
	container.className = '_markdown_dec';
	const p = document.createElement('p');
	const strong = document.createElement('strong');
	strong.textContent = '请选择下一步';
	p.appendChild(strong);
	container.appendChild(p);
	const ol = document.createElement('ol');
	const li = document.createElement('li');
	li.textContent = '1. 继续';
	ol.appendChild(li);
	container.appendChild(ol);
	document.body.appendChild(container);
	scanAndEnhanceDecisions();
	// A `p > strong` heading has no element sibling to attach a list to, so the
	// scanner correctly leaves it alone (covers the !targetList branch).
	assert.equal(container.querySelector('.agy-decision-container'), null);

	const empty = document.createElement('div');
	empty.className = '_markdown_dec';
	const h = document.createElement('h2');
	h.textContent = '请您决定';
	empty.appendChild(h);
	const ul = document.createElement('ul');
	empty.appendChild(ul);
	document.body.appendChild(empty);
	scanAndEnhanceDecisions();
	assert.equal(empty.querySelector('.agy-decision-container'), null, 'empty option list skipped');
});

test('decisions: installer observes (complete + loading paths) and disposes', async () => {
	Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
	const dispose1 = installDecisionChips();
	assert.equal(typeof dispose1, 'function');
	const dispose2 = installDecisionChips();
	dispose1();
	decisionContainer();
	await wait(140);
	assert.ok(document.querySelector('.agy-decision-container'), 'observer scan ran');
	dispose2();

	Object.defineProperty(document, 'readyState', { configurable: true, value: 'loading' });
	const dispose3 = installDecisionChips();
	document.dispatchEvent(new (window as any).Event('DOMContentLoaded'));
	assert.ok(document.querySelector('.agy-decision-container'));
	dispose3();
});

// ---------------------------------------------------------------------------
// 3b. compaction scanner + row
// ---------------------------------------------------------------------------

test('compaction: modern markdown anchor is replaced by an interactive card', async () => {
	const p = document.createElement('p');
	const a = document.createElement('a');
	a.setAttribute('href', '#agy-compaction?before=1000&after=250&items=3&summary=hello%20there');
	a.textContent = 'compacted';
	p.appendChild(a);
	document.body.appendChild(p);
	scanAndEnhanceCompactionCards(document);
	const card = document.querySelector('.agy-compaction-card') as HTMLElement;
	assert.ok(card, 'card injected');
	const row = card.querySelector('.agy-compaction-row') as HTMLElement;
	assert.ok(row, 'row built');
	const button = row.querySelector('.agy-compaction-button') as HTMLButtonElement;
	assert.equal(row.getAttribute('data-state'), 'collapsed');
	await act(() => { button.click(); });
	assert.equal(row.getAttribute('data-state'), 'expanded');
	assert.equal(button.getAttribute('aria-expanded'), 'true');
	await act(() => { button.click(); });
	assert.equal(row.getAttribute('data-state'), 'collapsed');

	scanAndEnhanceCompactionCards(document);
	assert.equal(document.querySelectorAll('.agy-compaction-card').length, 1, 'idempotent');
});

test('compaction: legacy card and escaped paragraph branches', () => {
	const legacy = document.createElement('div');
	legacy.className = 'agy-compaction-card';
	legacy.dataset.before = '500';
	legacy.dataset.after = '100';
	legacy.dataset.summary = 'x';
	document.body.appendChild(legacy);
	scanAndEnhanceCompactionCards(document);
	assert.ok(legacy.querySelector('.agy-compaction-row'), 'legacy card filled');
	assert.equal(legacy.getAttribute('data-agy-compaction-rendered'), 'true');

	const escaped = document.createElement('p');
	escaped.textContent = 'class="agy-compaction-card" data-before="500" data-after="100" data-summary="y"';
	document.body.appendChild(escaped);
	const quote = document.createElement('blockquote');
	quote.textContent = '</div>';
	document.body.appendChild(quote);
	scanAndEnhanceCompactionCards(document);
	assert.ok(document.querySelectorAll('.agy-compaction-card').length >= 2);
	assert.equal(document.body.contains(quote), false, 'trailing blockquote removed');
});

test('compaction: locked DOM is skipped; buildCompactionRow title follows lang', () => {
	const p = document.createElement('p');
	const a = document.createElement('a');
	a.setAttribute('href', '#agy-compaction?before=10&after=5');
	p.appendChild(a);
	document.body.appendChild(p);
	setScrollActiveForTest(true);
	scanAndEnhanceCompactionCards(document);
	assert.equal(document.querySelector('.agy-compaction-card'), null, 'locked → skip');
	setScrollActiveForTest(false);

	document.documentElement.lang = 'en';
	const en = buildCompactionRow({ beforeTokens: 100, afterTokens: 40 });
	assert.ok((en.querySelector('.agy-compaction-title') as HTMLElement).textContent?.includes('Context compacted'));
	document.documentElement.lang = 'zh';
	const zh = buildCompactionRow({ beforeTokens: 100, afterTokens: 40 });
	assert.ok((zh.querySelector('.agy-compaction-title') as HTMLElement).textContent?.includes('上下文已压缩'));
});

test('compaction: installer (complete + loading) and dispose', async () => {
	Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
	const dispose1 = installCompactionCard();
	const dispose2 = installCompactionCard();
	dispose1();
	const p = document.createElement('p');
	const a = document.createElement('a');
	a.setAttribute('href', '#agy-compaction?before=9&after=3');
	p.appendChild(a);
	document.body.appendChild(p);
	await wait(140);
	assert.ok(document.querySelector('.agy-compaction-card'), 'observer scan ran');
	dispose2();

	Object.defineProperty(document, 'readyState', { configurable: true, value: 'loading' });
	const dispose3 = installCompactionCard();
	document.dispatchEvent(new (window as any).Event('DOMContentLoaded'));
	assert.ok(document.querySelector('.agy-compaction-card'));
	dispose3();
});

// ---------------------------------------------------------------------------
// 4. scroll-guard
// ---------------------------------------------------------------------------

test('scroll guard: scroll activity arms a settle timer and fires listeners once', async () => {
	disposeScrollListener();
	setScrollActiveForTest(false);
	let settled = 0;
	const unbind = onScrollSettle(() => { settled++; });
	ensureScrollListener();
	assert.equal(isScrollActive(), false);
	window.dispatchEvent(new (window as any).Event('scroll'));
	assert.equal(isScrollActive(), true);
	await wait(190);
	assert.equal(isScrollActive(), false);
	assert.equal(settled, 1, 'settle listener fired once');
	window.dispatchEvent(new (window as any).Event('wheel'));
	await wait(190);
	assert.equal(settled, 2);
	unbind();
});

test('scroll guard: overlay suspend/resume locks interaction and fires catch-up once', () => {
	disposeScrollListener();
	setScrollActiveForTest(false);
	let settled = 0;
	const unbind = onScrollSettle(() => { settled++; });
	assert.equal(isInteractionLocked(), false);
	setOverlaySuspended(true);
	setOverlaySuspended(true); // no-op branch
	assert.equal(isOverlaySuspended(), true);
	assert.equal(isInteractionLocked(), true);
	assert.equal(settled, 0, 'suspend does not fire settle');
	setOverlaySuspended(false);
	assert.equal(isOverlaySuspended(), false);
	assert.equal(isInteractionLocked(), false);
	assert.equal(settled, 1, 'resume fires one catch-up');
	unbind();
});

test('scroll guard: dispose clears listener and timer; ensure is idempotent', async () => {
	disposeScrollListener();
	let settled = 0;
	onScrollSettle(() => { settled++; });
	ensureScrollListener();
	ensureScrollListener();
	window.dispatchEvent(new (window as any).Event('scroll'));
	disposeScrollListener();
	assert.equal(isScrollActive(), false);
	await wait(190);
	assert.equal(settled, 0, 'dispose cleared the pending settle timer');
	disposeScrollListener(); // second dispose is a no-op
	assert.equal(isScrollActive(), false);
});

test('scroll guard: no-window branches are safe', () => {
	delete (globalThis as unknown as Record<string, unknown>).window;
	ensureScrollListener();
	disposeScrollListener();
	assert.equal(isScrollActive(), false);
});

// ---------------------------------------------------------------------------
// 5. translate action + card (click / state transitions / copy / collapse)
// ---------------------------------------------------------------------------

const ACTION_KEY = 'sess-dom\u0000msg-dom';

test('translate action: click posts, transitions to done, and early-returns while working', async () => {
	let postCalls = 0;
	let stateCalls = 0;
	setGlobal('fetch', async (url: unknown) => {
		if (String(url).includes('/translate/state')) {
			stateCalls++;
			return { ok: true, status: 200, json: async () => ({ state: 'idle' }) };
		}
		postCalls++;
		return { ok: true, status: 200, json: async () => ({ ok: true }) };
	});
	setActionState(ACTION_KEY, 'idle');
	// Pre-create the singleton tooltip node: jsdom's `isConnected` is a getter,
	// so the module's fallback `created.isConnected = true` would throw. A real
	// connected node short-circuits that branch (browser behaviour is identical).
	const tip = document.createElement('div');
	tip.id = 'dsh-agy-link-tsl-tip';
	tip.setAttribute('role', 'tooltip');
	document.body.appendChild(tip);
	const { container, root } = await mount(createElement(TranslateAction, { messageId: 'msg-dom', sessionId: 'sess-dom' }));
	const btn = () => container.querySelector('.agy-tsl-icon') as HTMLButtonElement;
	assert.equal(btn().getAttribute('data-state'), 'idle');
	await act(async () => { btn().click(); await Promise.resolve(); });
	await wait(10);
	assert.equal(btn().getAttribute('data-state'), 'done');
	assert.equal(postCalls, 1, 'exactly one POST to /translate (no double submit)');
	assert.ok(stateCalls >= 1, 'at least one state probe on mount');
	assert.equal(actionStateOf(ACTION_KEY), 'done');

	// External state publication re-renders the action and disables it.
	await act(async () => { setActionState(ACTION_KEY, 'working'); await Promise.resolve(); });
	assert.equal(btn().getAttribute('data-state'), 'working');
	assert.equal(btn().disabled, true, 'working disables the button');
	assert.equal(postCalls, 1, 'no extra POST was issued');
	await act(() => { root.unmount(); });
	setActionState(ACTION_KEY, 'idle');
});

test('translate card: copy, collapse and show-original handlers', async () => {
	const { container, root } = await mount(createElement(TranslationCard, {
		node: { data: { text: '译文正文', original: 'source text' } },
		t: (key: string) => ({ 'tsl.copy': '复制', 'tsl.copied': '已复制', 'tsl.collapse': '收起', 'tsl.expand': '展开', 'tsl.showOriginal': '显示原文', 'tsl.hideOriginal': '隐藏原文', 'tsl.badge': 'Gemini 译文' } as Record<string, string>)[key] ?? key,
	}));
	const buttons = () => Array.from(container.querySelectorAll('.agy-tsl-btn')) as HTMLButtonElement[];
	const copy = buttons().find((b) => (b.textContent ?? '').includes('复制'))!;
	await act(async () => { copy.click(); await Promise.resolve(); });
	assert.deepEqual(clipboardWrites, ['译文正文']);
	assert.ok(copy.textContent?.includes('已复制'));

	const show = buttons().find((b) => (b.textContent ?? '').includes('显示原文'))!;
	await act(() => { show.click(); });
	assert.ok(container.querySelector('.agy-tsl-original'), 'original revealed');
	assert.equal((container.querySelector('.agy-tsl-original') as HTMLElement).textContent, 'source text');

	const collapse = buttons().find((b) => (b.textContent ?? '').includes('收起'))!;
	await act(() => { collapse.click(); });
	assert.equal(container.querySelector('.agy-tsl-body'), null, 'body collapsed');
	await act(async () => { await wait(10); }); // wait for react render
	await act(() => { root.unmount(); });
});

// ---------------------------------------------------------------------------
// 6. toolview question-card + run_code view branches
// ---------------------------------------------------------------------------

test('question card: options + insert button fill the composer', async () => {
	const ta = document.createElement('textarea');
	ta.setAttribute('data-composer-input', '');
	document.body.appendChild(ta);
	const model = {
		kind: 'question',
		title: 'Pick',
		questions: [{ question: 'Pick one', options: ['A', 'B'], is_multi_select: true }],
		output: '',
	};
	const { container, root } = await mount(createElement(QuestionCardBody, { model }));
	assert.equal(container.querySelectorAll('.agy-tv-q-opt').length, 2);
	const insert = container.querySelector('.agy-tv-q-insert-btn') as HTMLButtonElement;
	assert.equal(insert.disabled, true, 'disabled with no selection');
	await act(() => { (container.querySelectorAll('.agy-tv-q-opt')[0] as HTMLButtonElement).click(); });
	await act(() => { (container.querySelector('.agy-tv-q-insert-btn') as HTMLButtonElement).click(); });
	assert.ok((ta as HTMLTextAreaElement).value.includes('A'));
	assert.ok((container.querySelector('.agy-tv-q-insert-btn') as HTMLElement).textContent?.includes('已填入'));
	await act(async () => { await wait(10); }); // wait for react render
	await act(() => { root.unmount(); });
});

test('run_code view: SSR covers code-card fields and the mirror wrapper', () => {
	const codeBlock = { kind: 'tool-result', call: { name: 'run_code', argsRaw: JSON.stringify({ code: 'print(1)', description: 'demo' }) }, content: [], isError: false };
	assert.deepEqual(runCodeModel(codeBlock as never), { code: 'print(1)', title: 'demo' });

	clearExpandedToolBlockKeysForTest();
	expandToolBlockKeyForTest('call:rc-dom');
	const expanded = renderToStaticMarkup(createElement(AgyCodeToolView, { block: codeBlock, callId: 'rc-dom', inspect: () => {} }));
	assert.match(expanded, /data-kind="code"/);
	assert.match(expanded, /agy-tv-card-content/);
	assert.ok(expanded.includes('print(1)'));
	assert.match(expanded, /agy-tv-inspect-btn/);

	const mirrorCode = "// dsh-agy-link mirror: replay recorded agy tool step 4 (view_file)\nreturn await tools['agy_tool']({\"run\":\"r\",\"step\":4})";
	const mirrorBlock = { kind: 'tool-result', call: { name: 'run_code', argsRaw: JSON.stringify({ code: mirrorCode, description: 'replay' }) }, content: [], isError: false };
	const collapsed = renderToStaticMarkup(createElement(AgyRunCodeToolView, { block: mirrorBlock }));
	assert.match(collapsed, /data-kind="read"/);
	assert.match(collapsed, /agy-tv-root/);
});

test('decisions: insertTextIntoChatComposer handles textarea and contenteditable fallback', () => {
	const ta = document.createElement('textarea');
	document.body.appendChild(ta);
	assert.equal(insertTextIntoChatComposer('hello'), true);
	assert.ok((ta as HTMLTextAreaElement).value.includes('hello'));
	document.body.removeChild(ta);

	const editable = document.createElement('div');
	editable.setAttribute('role', 'textbox');
	editable.setAttribute('contenteditable', 'true');
	document.body.appendChild(editable);
	assert.equal(insertTextIntoChatComposer('world'), true);
	assert.ok((editable.textContent ?? '').includes('world'));
	assert.equal(insertTextIntoChatComposer(''), false);
});

test('openInRightSidebar: opens file in DSH native right sidebar with relativized path and line options', () => {
	// Without context, returns false
	setClientContext(null);
	assert.equal(openInRightSidebar('D:/proj/test.md'), false);

	const opened: Array<{ url: string; options?: any }> = [];
	const mockSidebarRight = {
		mounted: { getSnapshot: () => 'session-alpha-1' },
		openResource: (url: string, options?: any) => {
			opened.push({ url, options });
		},
	};
	const mockSessions = {
		list: {
			getSnapshot: () => ({
				byId: {
					'session-alpha-1': { cwd: 'D:/proj/zombie-madness' },
				},
			}),
		},
	};
	const mockTabs = {
		get: (id: string) => (id === '@deepseek-ai/dsh-client-ui-sidebar-documentpreview' ? { id } : undefined),
	};

	setClientContext({ sidebarRight: mockSidebarRight, sessions: mockSessions, sidebarRightTabs: mockTabs });

	// 1. File inside cwd is relativized
	opened.length = 0;
	assert.equal(openInRightSidebar('file:///D:/proj/zombie-madness/zombie_madness_reconstruction_masterplan.md'), true);
	assert.equal(opened.length, 1);
	assert.equal(opened[0]?.url, 'dsh-resource://file/session/session-alpha-1/zombie_madness_reconstruction_masterplan.md');
	assert.equal(opened[0]?.options, undefined);

	// 2. Line number hash is extracted into options.params.line
	opened.length = 0;
	assert.equal(openInRightSidebar('file:///D:/proj/zombie-madness/src/main.ts#L42'), true);
	assert.equal(opened.length, 1);
	assert.equal(opened[0]?.url, 'dsh-resource://file/session/session-alpha-1/src/main.ts');
	assert.deepEqual(opened[0]?.options, { params: { line: 42 } });

	// 3. File outside cwd retains full normalized path
	opened.length = 0;
	assert.equal(openInRightSidebar('C:/Users/zand/documents/notes.md'), true);
	assert.equal(opened.length, 1);
	assert.equal(opened[0]?.url, 'dsh-resource://file/session/session-alpha-1/C:/Users/zand/documents/notes.md');

	// 4. Backslash spellings and `file://` with one slash also normalize
	opened.length = 0;
	assert.equal(openInRightSidebar('file://D:\\proj\\zombie-madness\\docs\\plan.md'), true);
	assert.equal(opened[0]?.url, 'dsh-resource://file/session/session-alpha-1/docs/plan.md');

	// Clean up
	setClientContext(null);
});

test('openInRightSidebar: declines when no preview tab type can claim the address', () => {
	const opened: string[] = [];
	const sidebarRight = {
		mounted: { getSnapshot: () => 'session-gamma-3' },
		openResource: (url: string) => {
			opened.push(url);
		},
	};
	setClientContext({ sidebarRight, sidebarRightTabs: { get: () => undefined } });
	assert.equal(openInRightSidebar('D:/proj/plan.md'), false, 'no preview tab type → caller falls back');
	assert.equal(opened.length, 0, 'nothing was opened');
	setClientContext(null);
});

test('file links scanner: clicking a local file link opens the native sidebar (no badge injected)', () => {
	const opened: Array<{ url: string; options?: any }> = [];
	const mockSidebarRight = {
		mounted: { getSnapshot: () => 'session-beta-2' },
		openResource: (url: string, options?: any) => {
			opened.push({ url, options });
		},
	};
	const mockSessions = {
		list: {
			getSnapshot: () => ({
				byId: {
					'session-beta-2': { cwd: 'D:/workspace' },
				},
			}),
		},
	};
	setClientContext({
		sidebarRight: mockSidebarRight,
		sessions: mockSessions,
		sidebarRightTabs: {
			get: (id: string) => (id === '@deepseek-ai/dsh-client-ui-sidebar-documentpreview' ? { id } : undefined),
		},
	});

	const a = document.createElement('a');
	a.href = 'file:///D:/workspace/plan.md';
	a.textContent = 'plan.md';
	document.body.appendChild(a);

	scanAndEnhanceImages();

	assert.equal(a.querySelector('.agy-file-link-icon'), null, 'no badge is injected any more');
	assert.equal(a.textContent, 'plan.md', 'link text is left untouched');

	// Clicking the link text itself opens the native right Sidebar.
	opened.length = 0;
	a.click();
	assert.equal(opened.length, 1);
	assert.equal(opened[0]?.url, 'dsh-resource://file/session/session-beta-2/plan.md');

	// The click is consumed: no navigation and the address is not opened twice.
	assert.equal(a.dataset.agyFileEnhanced, 'true');
	opened.length = 0;
	a.click();
	assert.equal(opened.length, 1);

	document.body.removeChild(a);
	setClientContext(null);
});
