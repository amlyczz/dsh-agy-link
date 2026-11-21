// Extended toolview CSS (swarm, workflow, schedule, task, subagent, browser)
// kept separate from styles.ts so styles.ts stays well under the 600-line budget.

const EXT_CSS = `
.agy-tv-ext-wrap {
	display: flex;
	flex-direction: column;
}
.agy-tv-ext-badges {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 5px;
	padding: 8px 12px;
	border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.16));
}
.agy-tv-ext-badge {
	display: inline-flex;
	align-items: center;
	padding: 1px 7px;
	border-radius: 999px;
	font-size: 11px;
	line-height: 16px;
	font-weight: 500;
	background: var(--dsw-alias-bg-l2, rgba(127, 127, 127, 0.1));
	border: 0.5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.22));
	color: var(--dsw-alias-label-secondary, #475569);
}
.agy-tv-ext-badge[data-tone="accent"] {
	color: #3b82f6;
	background: rgba(59, 130, 246, 0.1);
	border-color: rgba(59, 130, 246, 0.28);
}
.agy-tv-ext-badge[data-tone="ok"] {
	color: #10b981;
	background: rgba(16, 185, 129, 0.1);
	border-color: rgba(16, 185, 129, 0.28);
}
.agy-tv-ext-badge[data-tone="warn"] {
	color: #f59e0b;
	background: rgba(245, 158, 11, 0.12);
	border-color: rgba(245, 158, 11, 0.3);
}
.agy-tv-ext-url {
	padding: 6px 12px;
	font-size: 11.5px;
	color: var(--dsw-alias-state-business-primary, #2563eb);
	word-break: break-all;
	border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.14));
}
.agy-tv-ext-brief {
	margin: 0;
	padding: 8px 12px;
	max-height: 180px;
	overflow: auto;
	white-space: pre-wrap;
	word-break: break-word;
	font-size: 11.5px;
	color: var(--dsw-alias-label-primary, #1e293b);
	background: var(--dsw-alias-bg-l1, rgba(127, 127, 127, 0.04));
	border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.14));
}
.agy-tv-ext-shot {
	padding: 8px 12px;
	border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.14));
}
`;

export function ensureExtendedToolStyles(): void {
	const doc = (globalThis as unknown as {
		document?: {
			getElementById(id: string): unknown;
			createElement(tag: string): { id?: string; textContent?: string };
			head?: { appendChild(n: unknown): void };
			documentElement?: { appendChild(n: unknown): void };
		};
	}).document;
	if (!doc) return;
	const styleId = 'dsh-agy-link-toolview-ext-css';
	if (doc.getElementById(styleId) === null) {
		const st = doc.createElement('style');
		st.id = styleId;
		st.textContent = EXT_CSS;
		const host = doc.head ?? doc.documentElement;
		if (host) host.appendChild(st);
	}
}
