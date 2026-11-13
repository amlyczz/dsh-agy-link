// Option builders for the console's settings dropdowns. Kept free of React and
// DOM so they can be unit-tested directly (see test/config-options.test.ts).
//
// Two rules matter here and are both regression-driven:
//   * the empty value always means "let the host decide", and it is the FIRST
//     option, because `translateModel`/`translateEffort` default to '' in the
//     config file and the dropdown must not look like an explicit choice;
//   * the advisory catalog is not the source of truth — a value configured by
//     hand (env var, older settings file, model dropped from the plan) stays
//     selectable, otherwise the control would silently misreport the state.

import { isGeminiFamilyModel } from '../common/model-lineup.ts'

export interface SelectOption {
	value: string
	label: string
}

export interface CatalogModelLike {
	id?: unknown
	name?: unknown
	/** Effort ids the model supports (absent/empty = fixed-thinking). */
	efforts?: unknown
}

export interface EffortLabels {
	auto: string
	/** Localised display name per effort id; unknown ids fall back to the id. */
	level: (id: string) => string
}

/** Effort ids carried by a catalog entry (order preserved, deduped). */
export function modelEfforts(model: CatalogModelLike | undefined): string[] {
	if (model === undefined || model === null) return []
	const raw = model.efforts
	if (!Array.isArray(raw)) return []
	const out: string[] = []
	for (const item of raw) {
		if (typeof item !== 'string') continue
		const id = item.trim().toLowerCase()
		if (id !== '' && !out.includes(id)) out.push(id)
	}
	return out
}

/** Effort ids supported anywhere in the catalog (fallback when no model is chosen). */
export function catalogEfforts(models: ReadonlyArray<CatalogModelLike>): string[] {
	const out: string[] = []
	for (const model of models) {
		for (const id of modelEfforts(model)) if (!out.includes(id)) out.push(id)
	}
	return out
}

function findCatalogModel(modelId: string, models: ReadonlyArray<CatalogModelLike>): CatalogModelLike | undefined {
	const wanted = typeof modelId === 'string' ? modelId.trim() : ''
	if (wanted === '') return undefined
	return models.find((model) => typeof model?.id === 'string' && model.id.trim() === wanted)
}

/**
 * Translation-model dropdown: `''` (host fallback chain: gemini-3.8-flash →
 * newest gemini-*-flash → conversation default) plus every catalog model.
 */
export function translateModelOptions(
	current: string,
	models: ReadonlyArray<CatalogModelLike>,
	autoLabel: string,
): SelectOption[] {
	const options: SelectOption[] = [{ value: '', label: autoLabel }]
	const seen = new Set<string>([''])
	for (const model of models) {
		const id = typeof model?.id === 'string' ? model.id.trim() : ''
		if (id === '' || seen.has(id)) continue
		seen.add(id)
		const name = typeof model?.name === 'string' ? model.name.trim() : ''
		options.push({ value: id, label: name === '' ? id : name })
	}
	const wanted = typeof current === 'string' ? current.trim() : ''
	if (wanted !== '' && !seen.has(wanted)) options.push({ value: wanted, label: wanted })
	return options
}

/**
 * The dropdown offers the Gemini family only: the card is branded "Gemini 译文",
 * so picking e.g. Claude there would make the label a lie. A model configured by
 * hand is still appended by `translateModelOptions`, so the state stays honest.
 */
export function geminiCatalogModels(models: ReadonlyArray<CatalogModelLike>): CatalogModelLike[] {
	return models.filter((model) => typeof model?.id === 'string' && isGeminiFamilyModel(model.id))
}

/**
 * Thinking-effort dropdown for a specific model: `''` (follow the model's
 * default) plus exactly the levels THAT model supports, in the catalog's own
 * order.
 *
 * Deriving from the catalog instead of a local low/medium/high list is what
 * keeps this control honest: a model with no `--effort` support gets no levels
 * at all, and a model with an extra level (agy 1.5.7's `xhigh` → "Extra") gets
 * it without any code change. An unrecognised configured level is still
 * appended verbatim so the select can display the real state.
 */
export function translateEffortOptions(
	current: string,
	labels: EffortLabels,
	modelId = '',
	models: ReadonlyArray<CatalogModelLike> = [],
): SelectOption[] {
	const options: SelectOption[] = [{ value: '', label: labels.auto }]
	const chosen = findCatalogModel(modelId, models)
	// A chosen model with no effort support offers nothing but "auto".
	const supported = chosen === undefined ? catalogEfforts(models) : modelEfforts(chosen)
	for (const level of supported) options.push({ value: level, label: labels.level(level) })
	const wanted = typeof current === 'string' ? current.trim().toLowerCase() : ''
	if (wanted !== '' && !options.some((option) => option.value === wanted)) {
		options.push({ value: wanted, label: labels.level(wanted) })
	}
	return options
}
