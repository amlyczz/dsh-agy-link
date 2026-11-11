// Register the mirror + run_code toolviews into the host slot.

import { NS } from '../locales.ts';
import { AgyMirrorToolView } from './mirror-view.ts';
import { AgyRunCodeToolView } from './run-code-view.ts';

export function installAgyToolView(ctx: {
	slots: {
		inject(name: string, register: () => () => void): void;
		register(opts: { name: string; key?: string; id: string; order?: number; label?: string | (() => string); locale?: string }, C: (p: unknown) => unknown): () => void;
	};
}): void {
	try {
		ctx.slots?.inject?.('tool.call.toolview', () => {
		const d1 = ctx.slots.register(
			// locale: NS seats `t` so mirror cards localize titles/buttons like
			// the run_code view does (they used to hard-code 中文 + English).
			{ name: 'tool.call.toolview', key: 'agy_tool', id: 'agy-tool-view', label: 'Antigravity tool', locale: NS },
			AgyMirrorToolView as (p: unknown) => unknown,
		);
		// Code Mode wraps the mirror in run_code. This keyed registration REPLACES
		// the host's built-in code row (a keyed slot is a takeover, not an
		// addition), so AgyRunCodeToolView also owns the presentation of ordinary
		// non-mirror programs — hence the locale namespace for its title/copy labels.
		const d2 = ctx.slots.register(
			{ name: 'tool.call.toolview', key: 'run_code', id: 'agy-run-code-view', label: 'Antigravity (code mode)', locale: NS },
			AgyRunCodeToolView as (p: unknown) => unknown,
		);
		return () => { d2(); d1(); };
		});
	} catch (err) {
		console.warn('[dsh-agy-link] agy tool view slot registration failed:', err);
	}
}
