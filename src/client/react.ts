// Shared React handle for the browser client.
//
// The client half is bundled into the DSH ModuleLoader closure-factory format
// (see tsdown.config.ts), so `react`/`react-dom` stay external and are resolved
// through the `require` shim the host injects. Every extracted module must use
// THIS handle instead of its own `require('react')` so hooks and `h()` share
// one runtime instance.

export type ReactApi = {
	createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
	useState: <S>(initial: S | (() => S)) => [S, (next: S | ((prev: S) => S)) => void];
	useEffect: (setup: () => (() => void) | void, deps?: unknown[]) => void;
	useRef: <S>(initial: S) => { current: S };
};

export const R = require('react') as ReactApi;
export const { createElement: h, useState, useEffect, useRef } = R;

export const reactDom = require('react-dom') as {
	createPortal?: (node: unknown, container: unknown) => unknown;
};
