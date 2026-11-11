// Native dropdown dressed in the console's own tokens. The closed control
// carries inline colours; color-scheme is set in the global CSS so the popup
// list follows the shell theme as well.

import { h } from '../react.ts';
import { S } from '../styles.ts';

export interface SelectOption {
	value: string;
	label: string;
}

export interface SelectProps {
	value: string;
	options: ReadonlyArray<SelectOption>;
	onChange: (e: { target?: { value?: string } }) => void;
	ariaLabel?: string;
	title?: string;
	disabled?: boolean;
	style?: Record<string, unknown>;
}

export function Select({ value, options, onChange, ariaLabel, title, disabled, style }: SelectProps): unknown {
	return h('select', {
		className: 'agy-select',
		...(ariaLabel !== undefined ? { 'aria-label': ariaLabel } : {}),
		...(title !== undefined ? { title } : {}),
		style: { ...S.select!, ...(style ?? {}) },
		value,
		disabled,
		onChange,
	}, options.map((option) => h('option', { key: option.value, value: option.value }, option.label)));
}
