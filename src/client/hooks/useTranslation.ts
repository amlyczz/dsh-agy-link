// Locale binding hook shared by the console, the modal and the header badge.
// Re-renders the mounted component whenever the host locale revision changes.

import { NS, type AgyLocaleKey } from '../locales.ts';
import { useEffect, useState } from '../react.ts';

export interface LocaleLike {
	subscribe(listener: () => void): () => void;
	bind(namespace: string): (key: any, params?: Record<string, unknown>) => string;
}

export type Translator = (key: AgyLocaleKey, params?: Record<string, unknown>) => string;

export function useAgyTranslation(locale: LocaleLike): Translator {
	const [, rerender] = useState(0);
	useEffect(() => locale.subscribe(() => rerender((revision) => revision + 1)), []);
	return locale.bind(NS) as Translator;
}
