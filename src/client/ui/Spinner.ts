// Inline spinner used inside busy buttons and the loading state.

import { h } from '../react.ts';

export function Spinner(): unknown {
	return h('span', { className: 'agy-spinner' });
}
