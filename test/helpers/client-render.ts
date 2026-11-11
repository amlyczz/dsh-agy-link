// Shared SSR harness for the client-render tests.
//
// The browser client calls `require('react')` as a free variable — the DSH host
// injects that shim at runtime. Node ESM has no global `require`, so install one
// that resolves the real React / React-DOM instances BEFORE any client module is
// evaluated (the test imports this helper first). This is also why the app
// modules can keep their existing zero-build-import shape.
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const React = nodeRequire('react') as Record<string, unknown>;

(globalThis as unknown as { require: (id: string) => unknown }).require = (id: string) =>
  id === 'react' ? React : nodeRequire(id);

const server = nodeRequire('react-dom/server') as { renderToStaticMarkup(node: unknown): string };

/** Render a React element to static markup. Effects never run (SSR). */
export function renderToStaticMarkup(node: unknown): string {
  return server.renderToStaticMarkup(node);
}

export { React };
