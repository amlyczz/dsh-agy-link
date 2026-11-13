// Shared segmented control wrapper for the settings rows. Keeping it in ui/
// lets a row group live in its own module without duplicating the style token.
import { h } from '../react.ts';
import { S } from '../styles.ts';

export function segGroup(children: unknown[]): unknown {
	return h('div', { style: S.segGroup }, children);
}
