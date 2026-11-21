// Config action handlers: the /config writer and the derived model-visibility
// merge (which must read the PENDING set, not the last rendered snapshot, so two
// rapid clicks never lose one another).

import { postConfig, postPool } from '../api.ts';
import { useRef } from '../react.ts';
import type { StatusPayload } from '../status.ts';
import type { ShowToast } from '../ui/Toast.ts';
import type { Translator } from './useTranslation.ts';

export interface ConfigDeps {
	status: StatusPayload | null;
	refresh: () => Promise<void>;
	showToast: ShowToast;
	setLoadingAction: (value: string | null) => void;
	t: Translator;
}

export interface ConfigActions {
	setCfg: (key: string, value: unknown) => Promise<void>;
	toggleModelHidden: (id: string, hide: boolean) => Promise<void>;
	/** Replace the whole picker-facing allow-list in one write. */
	setSelectedModels: (ids: ReadonlyArray<string>) => Promise<void>;
	setMode: (mode: string) => Promise<void>;
}

export function useConfig({ status, refresh, showToast, setLoadingAction, t }: ConfigDeps): ConfigActions {
	const hiddenPendingRef = useRef<Set<string> | null>(null);
	const selectedPendingRef = useRef<ReadonlyArray<string> | null>(null);

	const actionFailed = (): void => {
		showToast(t('api.genericError'), 'error');
	};

	const setCfg = async (key: string, value: unknown): Promise<void> => {
		setLoadingAction(`config:${key}`);
		const res = await postConfig(key, value);
		if (res === null || res?.ok === false) {
			setLoadingAction(null);
			actionFailed();
			return;
		}
		await refresh();
		setLoadingAction(null);
	};

	const toggleModelHidden = async (id: string, hide: boolean): Promise<void> => {
		// Merge against the PENDING set, not the last-rendered snapshot:
		// two rapid clicks used to read the same stale status and the
		// second silently overwrote the first (lost update).
		const next = new Set(hiddenPendingRef.current ?? status?.hiddenModels ?? []);
		if (hide) next.add(id); else next.delete(id);
		hiddenPendingRef.current = next;
		try {
			await setCfg('hiddenModels', Array.from(next));
		} finally {
			if (hiddenPendingRef.current === next) hiddenPendingRef.current = null;
		}
	};

	/**
	 * Replace the picker-facing allow-list in ONE write.
	 *
	 * An EMPTY list means "no restriction" (every model shows) — that is the
	 * shipped default, and it is also why the panel computes the whole next set
	 * itself instead of toggling one id at a time: leaving "no restriction"
	 * state requires knowing what was implicitly visible.
	 *
	 * The PENDING array is written before the request and read by rapid
	 * follow-up clicks, so two fast clicks compose instead of the second
	 * overwriting the first with a stale snapshot.
	 */
	const setSelectedModels = async (ids: ReadonlyArray<string>): Promise<void> => {
		const next = [...ids];
		selectedPendingRef.current = next;
		try {
			await setCfg('selectedModels', next);
		} finally {
			if (selectedPendingRef.current === next) selectedPendingRef.current = null;
		}
	};

	const setMode = async (mode: string): Promise<void> => {
		setLoadingAction(`mode:${mode}`);
		const res = await postPool('mode', { mode });
		if (res === null || res?.ok === false) {
			setLoadingAction(null);
			actionFailed();
			return;
		}
		await refresh();
		setLoadingAction(null);
	};

	return { setCfg, toggleModelHidden, setSelectedModels, setMode };
}
