// Issue #131: the settings panel is a tick-list, not a show/hide toggle. These
// tests pin the semantics that are easy to get wrong:
//   - an empty selection means "show everything" (shipped default);
//   - unticking the FIRST model must not silently hide all the others;
//   - a hiddenModels entry always wins, and says so in the tooltip.
import '../helpers/client-render.ts';
import { React, renderToStaticMarkup } from '../helpers/client-render.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelsPanel } from '../../src/client/sections/ModelsPanel.ts';

const createElement = (React as { createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown }).createElement;

/** The label is rendered from `models.label` with `{selected}`/`{total}` filled in. */
function labelOf(html: string): string {
	const m = /models\.label[^<]*/.exec(html)
	return (m?.[0] ?? '').replace(/&quot;/g, '"')
}

const MODELS = [
	{ id: 'gemini-4-neon', name: 'Gemini 4 Neon', efforts: ['low', 'high'] },
	{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low'] },
	{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: [] },
]

type Chip = { props: { variant: string; title: string; disabled: boolean; style?: { opacity?: number; textDecoration?: string }; onClick: () => void; children?: unknown } }

function render(opts: {
	hidden?: string[]
	selected?: string[]
	loadingAction?: string | null
} = {}) {
	const writes: Array<ReadonlyArray<string>> = []
	const el = ModelsPanel({
		t: ((key: string, params?: Record<string, unknown>) => (params ? key + JSON.stringify(params) : key)) as never,
		catalogModels: MODELS,
		hiddenModelSet: new Set(opts.hidden ?? []),
		selectedModelSet: new Set(opts.selected ?? []),
		loadingAction: opts.loadingAction ?? null,
		setSelectedModels: async (ids) => { writes.push(ids) },
	}) as { props: { children: Array<{ props: { children?: Chip[] } }> } }
	const chips = el.props.children[1]!.props.children as Chip[]
	return { el, chips, writes }
}

test('an empty selection ticks every model and explains that nothing is restricted', () => {
	const { el, chips } = render()
	assert.deepEqual(chips.map((c) => c.props.variant), ['segActive', 'segActive', 'segActive'])
	assert.equal(chips[0]!.props.disabled, false)
	const html = renderToStaticMarkup(createElement('div', null, el))
	assert.match(labelOf(html), /"selected":3,"total":3/)
	assert.match(html, /models\.hint/)
})

test('unticking the first model materialises the visible set minus that model', () => {
	const { chips, writes } = render()
	chips[0]!.props.onClick()
	assert.deepEqual(writes, [['gemini-3.8-flash', 'claude-opus-5-5']], 'one click must not hide every other model')
})

test('a restricted selection ticks only the chosen models and toggles one id per click', () => {
	const { el, chips, writes } = render({ selected: ['gemini-4-neon'] })
	assert.deepEqual(chips.map((c) => c.props.variant), ['segActive', 'seg', 'seg'])
	assert.equal(chips[1]!.props.style?.opacity, 0.45, 'unticked chips are visibly dimmed')
	assert.equal(chips[1]!.props.style?.textDecoration, 'line-through')
	assert.match(labelOf(renderToStaticMarkup(createElement('div', null, el))), /"selected":1,"total":3/)

	chips[1]!.props.onClick()
	assert.deepEqual(writes.at(-1), ['gemini-4-neon', 'gemini-3.8-flash'], 'ticking appends without dropping the rest')
	chips[0]!.props.onClick()
	assert.deepEqual(writes.at(-1), [], 'unticking the last selected model clears the whitelist (back to "show all")')
})

test('hiddenModels wins over the whitelist and the tooltip says why', () => {
	const { chips } = render({ hidden: ['gemini-4-neon'], selected: ['gemini-4-neon'] })
	assert.equal(chips[0]!.props.variant, 'seg', 'a denied model is never shown as ticked')
	assert.match(chips[0]!.props.title, /models\.deniedHint/)
	assert.match(chips[0]!.props.title, /gemini-4-neon · Low \/ High/)
	assert.doesNotMatch(chips[1]!.props.title, /models\.deniedHint/)
})

test('an in-flight write disables every chip', () => {
	const { chips } = render({ loadingAction: 'config:selectedModels' })
	assert.equal(chips.every((c) => c.props.disabled), true)
	assert.equal(render().chips[0]!.props.disabled, false, 'an unrelated action does not lock the panel')
})

test('an empty catalog renders the empty-state hint instead of chips', () => {
	const el = ModelsPanel({
		t: ((key: string, params?: Record<string, unknown>) => (params ? key + JSON.stringify(params) : key)) as never,
		catalogModels: [],
		hiddenModelSet: new Set(),
		selectedModelSet: new Set(),
		loadingAction: null,
		setSelectedModels: async () => {},
	}) as { props: { children: Array<{ props: { children?: unknown } }> } }
	const html = renderToStaticMarkup(createElement('div', null, el))
	assert.match(html, /models\.empty/)
	assert.match(labelOf(html), /"selected":0,"total":0/)
	assert.equal(html.includes('models.deniedHint'), false)
})

test('clicking a chip denied by a legacy hiddenModels entry un-denies and ticks it', async () => {
	// Seen live: Claude Opus 5.5 selected AND hidden (+ effort variants) by an older build.
	const hiddenWrites: Array<ReadonlyArray<string>> = []
	const selectedWrites: Array<ReadonlyArray<string>> = []
	const hidden = ['claude-opus-5-5', 'claude-opus-5-5-high', 'gemini-3.5-flash']
	const el = ModelsPanel({
		t: ((key: string) => key) as never,
		catalogModels: MODELS,
		hiddenModelSet: new Set(hidden),
		selectedModelSet: new Set(['gemini-4-neon']),
		loadingAction: null,
		setSelectedModels: async (ids) => { selectedWrites.push(ids) },
		setHiddenModels: async (ids) => { hiddenWrites.push(ids) },
	}) as { props: { children: Array<{ props: { children?: Chip[] } }> } }
	const chips = el.props.children[1]!.props.children as Chip[]
	chips[2]!.props.onClick()
	await new Promise((r) => setImmediate(r))
	assert.deepEqual(hiddenWrites, [['gemini-3.5-flash']], 'the model and its effort variants leave the deny-list; others stay')
	assert.deepEqual(selectedWrites, [['gemini-4-neon', 'claude-opus-5-5']], 'and it is ticked in a restrictive allow-list')
})

test('planChipClick leaves the allow-list alone when the denied model is already ticked', async () => {
	const { planChipClick } = await import('../../src/client/sections/ModelsPanel.ts')
	assert.deepEqual(
		planChipClick({ id: 'claude-opus-5-5', catalogIds: MODELS.map((m) => m.id), hidden: ['claude-opus-5-5'], selected: ['claude-opus-5-5'] }),
		{ hidden: [] },
	)
})
