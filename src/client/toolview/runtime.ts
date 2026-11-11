// Shared React access for the mirror tool cards. The bundle keeps react
// external; the host injects it through the module loader at render time.

export type ReactApi = {
	createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
	useState: <S>(initial: S) => [S, (next: S | ((prev: S) => S)) => void];
};

export function react(): ReactApi {
	const mod = require('react') as unknown;
	if (mod === undefined || mod === null) {
		throw new Error('dsh-agy-link toolview requires react at render time (browser host)');
	}
	return mod as ReactApi;
}

export function hx(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown {
	return react().createElement(type, props, ...children);
}
