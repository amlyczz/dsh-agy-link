// Expand/collapse state for tool cards, cached across virtualizer remounts.

import { react } from './runtime.ts';

export function makeToggle(setValue: (next: boolean | ((prev: boolean) => boolean)) => void): () => void {
	return () => setValue((prev: boolean) => !prev);
}

/** Cache user-expanded tool cards across TanStack Virtualizer remount cycles */
const expandedToolBlockKeys = new Set<string>();
/** Cache user-collapsed cards that default to expanded (e.g. step checklists). */
const collapsedToolBlockKeys = new Set<string>();

export function clearExpandedToolBlockKeysForTest(): void {
	expandedToolBlockKeys.clear();
	collapsedToolBlockKeys.clear();
}

/**
 * Test seam: seed one card key as expanded so an SSR render can exercise the
 * card body without a click. Production code only ever adds keys through the
 * toggle itself.
 */
export function expandToolBlockKeyForTest(key: string): void {
	expandedToolBlockKeys.add(key);
	collapsedToolBlockKeys.delete(key);
}

export function useToggle(initial: boolean = false, key?: string): [boolean, () => void] {
	const R2 = react();
	const init = key
		? (initial ? !collapsedToolBlockKeys.has(key) : expandedToolBlockKeys.has(key))
		: initial;
	const [value, setValue] = R2.useState<boolean>(init) as [boolean, (next: boolean | ((prev: boolean) => boolean)) => void];
	const toggle = () => {
		setValue((prev: boolean) => {
			const next = !prev;
			if (key) {
				if (next) {
					expandedToolBlockKeys.add(key);
					collapsedToolBlockKeys.delete(key);
				} else {
					expandedToolBlockKeys.delete(key);
					collapsedToolBlockKeys.add(key);
				}
			}
			return next;
		});
	};
	return [value, toggle];
}
