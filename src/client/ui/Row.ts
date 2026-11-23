// Shared settings-row shell: the label/description block on the left and a
// control cluster on the right. Callers pass prebuilt nodes so the exact DOM
// (and every i18n key) stays with the section that owns the copy.

import { h } from '../react.ts';

export interface RowProps {
	left: unknown;
	right: unknown;
	style?: Record<string, unknown>;
}

export function Row({ left, right, style }: RowProps): unknown {
	return h('div', {
		// The class is load-bearing: the phone rules in global-css target
		// `.agy-row`, NOT `.agy-console …`. The settings modal is portaled to
		// <body>, so console-scoped selectors never reached it.
		className: 'agy-row',
		style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', ...(style ?? {}) },
	}, left, right);
}
