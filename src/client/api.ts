// HTTP plumbing shared by the whole console.
//
// Every read/write the UI performs goes through these two helpers so a server
// refusal surfaces as `ok:false` (callers can tell "saved" from "refused")
// instead of an unconditional success toast.

export const win = globalThis as unknown as {
	location?: { origin?: string };
	fetch?: (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
	open?: (url: string, target?: string) => void;
	document?: { body?: unknown } | null;
	localStorage?: {
		getItem(key: string): string | null;
		setItem(key: string, value: string): void;
		removeItem(key: string): void;
	};
	addEventListener?: (type: string, listener: (ev: any) => void, useCapture?: boolean) => void;
	removeEventListener?: (type: string, listener: (ev: any) => void, useCapture?: boolean) => void;
	navigator?: { clipboard?: { writeText(text: string): Promise<void> } };
};

export const base = win.location?.origin ?? '';

const PLUGIN_BASE = '/plugins/agy-link';

export async function postJson(path: string, body: Record<string, unknown>): Promise<any> {
	try {
		const res = await win.fetch?.(base + path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (!res) return null;
		try {
			const payload = await res.json();
			// Surface HTTP failure as ok:false so callers can distinguish
			// "saved" from "server refused" instead of always toasting success.
			if (!res.ok && payload !== null && typeof payload === 'object') {
				return { ok: false, ...(payload as Record<string, unknown>) };
			}
			return payload;
		} catch {
			return { ok: res.ok };
		}
	} catch {
		return null;
	}
}

export async function getJson<T = any>(path: string): Promise<T | null> {
	try {
		const res = await win.fetch?.(base + path);
		if (!res || !res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

/** Small typed endpoint helper for the account-pool actions. */
export function postPool(action: string, body: Record<string, unknown> = {}): Promise<any> {
	return postJson(`${PLUGIN_BASE}/pool/${action}`, body);
}

/** The shared config-write helper (same /config endpoint the toggles use). */
export function postConfig(key: string, value: unknown): Promise<any> {
	return postJson(`${PLUGIN_BASE}/config`, { key, value });
}
