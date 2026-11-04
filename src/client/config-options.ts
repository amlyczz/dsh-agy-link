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

export interface SelectOption {
	value: string
	label: string
}

export interface CatalogModelLike {
	id?: unknown
	name?: unknown
}

export interface EffortLabels {
	auto: string
	low: string
	medium: string
	high: string
}

/** Thinking levels the translation call accepts, in ascending order. */
const EFFORT_LEVELS = ['low', 'medium', 'high'] as const

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
	return models.filter((model) => typeof model?.id === 'string' && /gemini/i.test(model.id))
}

/**
 * Thinking-effort dropdown: `''` (follow the default effort) plus the levels
 * agy understands; an unrecognised configured level is appended verbatim so the
 * select can display it rather than pretending the value is unset.
 */
export function translateEffortOptions(current: string, labels: EffortLabels): SelectOption[] {
	const options: SelectOption[] = [{ value: '', label: labels.auto }]
	for (const level of EFFORT_LEVELS) options.push({ value: level, label: labels[level] })
	const wanted = typeof current === 'string' ? current.trim().toLowerCase() : ''
	if (wanted !== '' && !options.some((option) => option.value === wanted)) {
		options.push({ value: wanted, label: wanted })
	}
	return options
}
