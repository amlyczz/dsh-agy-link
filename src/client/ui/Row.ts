// Shared settings-row shell: the label/description block on the left and a
// control cluster on the right. Callers pass prebuilt nodes so the exact DOM
// (and every i18n key) stays with the section that owns the copy.

import { h } from '../react.ts';
import { S } from '../styles.ts';

export interface RowProps {
	left: unknown;
	right: unknown;
	style?: Record<string, unknown>;
}

/** Shared label + single-line ellipsized description block for settings rows. */
export function rowCaption(title: string, desc?: string): unknown {
	return h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 180px' } },
		h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px' } }, title),
		desc !== undefined ? h('span', { style: S.mutedLine, title: desc }, desc) : null,
	);
}

export function Row({ left, right, style }: RowProps): unknown {
	return h('div', {
		// The class is load-bearing: the phone rules in global-css target
		// `.agy-row`, NOT `.agy-console …`. The settings modal is portaled to
		// <body>, so console-scoped selectors never reached it.
		className: 'agy-row',
		style: {
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'space-between',
			flexWrap: 'wrap',
			gap: '8px 12px',
			minWidth: 0,
			...(style ?? {}),
		},
	}, left, right);
}
