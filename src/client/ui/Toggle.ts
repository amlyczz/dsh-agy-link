// Standalone enable/disable pill toggle (class-based, so both states carry a
// real border and a visible clickable area).

import { h } from '../react.ts';

export interface ToggleProps {
	on: boolean;
	disabled?: boolean;
	title?: string;
	onClick: () => void;
	children?: unknown;
}

export function Toggle({ on, disabled, title, onClick, children }: ToggleProps): unknown {
	return h('button', {
		type: 'button',
		className: 'agy-toggle',
		'data-on': on ? 'true' : 'false',
		...(title !== undefined ? { title } : {}),
		disabled,
		onClick,
	}, children);
}
