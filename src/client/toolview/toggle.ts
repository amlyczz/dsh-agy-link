// Expand/collapse state for tool cards, cached across virtualizer remounts.

import { react } from './runtime.ts';

export function makeToggle(setValue: (next: boolean | ((prev: boolean) => boolean)) => void): () => void {
	return () => setValue((prev: boolean) => !prev);
}

/** Cache user-expanded tool cards across TanStack Virtualizer remount cycles */
const expandedToolBlockKeys = new Set<string>();

export function clearExpandedToolBlockKeysForTest(): void {
	expandedToolBlockKeys.clear();
}

export function useToggle(initial: boolean = false, key?: string): [boolean, () => void] {
	const R2 = react();
	const init = key ? expandedToolBlockKeys.has(key) : initial;
	const [value, setValue] = R2.useState<boolean>(init) as [boolean, (next: boolean | ((prev: boolean) => boolean)) => void];
	const toggle = () => {
		setValue((prev: boolean) => {
			const next = !prev;
			if (key) {
				if (next) expandedToolBlockKeys.add(key);
				else expandedToolBlockKeys.delete(key);
			}
			return next;
		});
	};
	return [value, toggle];
}
