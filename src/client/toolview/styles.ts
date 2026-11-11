// Tool-card stylesheet. Injected once on module load, exactly as before.

const ROW_CSS = `
/* Container */
.agy-tv-root {
	display: flex;
	flex-direction: column;
	width: 100%;
	min-width: 0;
	position: relative;
	font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif);
	margin: 2px 0;
}

/* Collapsed Header Row */
.agy-tv-row {
	display: flex;
	align-items: center;
	height: calc(24px + var(--dsh-content-font-delta, 0px));
	min-width: 0;
	position: relative;
	overflow: hidden;
	cursor: pointer;
	user-select: none;
	background: transparent;
	border: none;
	padding: 0;
	width: 100%;
	text-align: left;
	color: var(--dsw-alias-label-primary, #0f172a);
}

/* Running sweep shimmer animation */
.agy-tv-root[data-state="run"] .agy-tv-row:after {
	content: "";
	position: absolute;
	top: 0;
	bottom: 0;
	left: 0;
	width: 300px;
	background: linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--dsw-alias-bg-base, #ffffff) 60%, transparent) 55%, transparent 100%);
	pointer-events: none;
	animation: 2.6s ease-out infinite agy-tv-sweep;
}
@keyframes agy-tv-sweep {
	0% { left: -300px; }
	90%, 100% { left: 100%; }
}

/* Leading Icon with Hover-to-Arrow transition */
.agy-tv-leading {
	position: relative;
	flex: none;
	width: calc(16px + var(--dsh-content-font-delta, 0px));
	height: calc(16px + var(--dsh-content-font-delta, 0px));
	display: inline-flex;
	align-items: center;
	justify-content: center;
	margin-right: 6px;
	color: var(--dsw-alias-label-tertiary, #64748b);
}
.agy-tv-leading svg {
	width: calc(14px + var(--dsh-content-font-delta, 0px));
	height: calc(14px + var(--dsh-content-font-delta, 0px));
}
.agy-tv-icon-idle {
	display: inline-flex;
	opacity: 1;
	transition: opacity 0.1s ease;
}
.agy-tv-chevron-hover {
	position: absolute;
	inset: 0;
	margin: auto;
	opacity: 0;
	transition: opacity 0.1s ease;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	color: var(--dsw-alias-label-secondary, #334155);
}
.agy-tv-row:hover .agy-tv-icon-idle {
	opacity: 0;
}
.agy-tv-row:hover .agy-tv-chevron-hover {
	opacity: 1;
}
.agy-tv-chevron-open {
	position: relative;
	flex: none;
	width: calc(16px + var(--dsh-content-font-delta, 0px));
	height: calc(16px + var(--dsh-content-font-delta, 0px));
	display: inline-flex;
	align-items: center;
	justify-content: center;
	margin-right: 6px;
	color: var(--dsw-alias-label-secondary, #334155);
}
.agy-tv-chevron-open svg {
	width: calc(14px + var(--dsh-content-font-delta, 0px));
	height: calc(14px + var(--dsh-content-font-delta, 0px));
}

/* Title */
.agy-tv-title {
	flex: none;
	font-size: var(--dsh-content-font-size-secondary, 13px);
	line-height: calc(24px + var(--dsh-content-font-delta, 0px));
	color: var(--dsw-alias-label-secondary, #334155);
	font-weight: 400;
}

/* Dot separator */
.agy-tv-sep {
	background: var(--dsw-alias-label-caption, #94a3b8);
	border-radius: 1px;
	flex: none;
	width: 2px;
	height: 2px;
	margin: 0 8px;
}

/* Summary */
.agy-tv-summary {
	text-overflow: ellipsis;
	white-space: nowrap;
	min-width: 0;
	font-size: var(--dsh-content-font-size-secondary, 13px);
	line-height: calc(24px + var(--dsh-content-font-delta, 0px));
	color: var(--dsw-alias-label-tertiary, #64748b);
	flex: auto;
	overflow: hidden;
}
.agy-tv-summary-err {
	color: var(--dsw-alias-state-error-primary, #dc2626);
}

/* File link button */
.agy-tv-file-link {
	text-overflow: ellipsis;
	white-space: nowrap;
	min-width: 0;
	font: inherit;
	text-align: left;
	font-size: var(--dsh-content-font-size-secondary, 13px);
	line-height: calc(24px + var(--dsh-content-font-delta, 0px));
	color: var(--dsw-alias-label-secondary, #334155);
	text-decoration: underline dotted;
	text-decoration-color: var(--dsw-alias-label-tertiary, #64748b);
	text-underline-offset: 3px;
	cursor: pointer;
	background: none;
	border: none;
	flex: 0 auto;
	margin: 0;
	padding: 0;
	text-decoration-thickness: 1px;
	overflow: hidden;
}
.agy-tv-file-link:hover {
	color: var(--dsw-alias-label-primary, #0f172a);
	text-decoration-color: currentColor;
}

/* Diff stat badge (+10 -2) */
.agy-tv-diff-stat {
	font-family: var(--ds-font-family-code, ui-monospace, monospace);
	font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 2px);
	color: var(--dsw-alias-label-caption, #94a3b8);
	margin-left: 10px;
	flex: none;
}

/* Preview text */
.agy-tv-preview {
	font-family: var(--ds-font-family-code, ui-monospace, monospace);
	font-size: 11px;
	color: var(--dsw-alias-label-caption, #94a3b8);
	margin-left: 8px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	max-width: 35%;
	flex: none;
}

/* Body wrap */
.agy-tv-body-wrap {
	display: flex;
	flex-direction: column;
}

/* Card container */
.agy-tv-card {
	border: 0.5px solid var(--dsw-alias-border-l1, #e2e8f0);
	background: var(--dsw-alias-markdown-code-block, #f8fafc);
	font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
	font-size: 12px;
	line-height: 1.55;
	border-radius: 12px;
	margin: 4px 0 4px 4px;
	display: flex;
	flex-direction: column;
	overflow: hidden;
}

/* Card Header */
.agy-tv-card-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 8px 12px;
	background: var(--dsw-alias-markdown-code-block-banner, rgba(0, 0, 0, 0.02));
	border-bottom: 0.5px solid var(--dsw-alias-border-l2, #e2e8f0);
}
.agy-tv-card-header-left {
	display: flex;
	align-items: baseline;
	gap: 8px;
	min-width: 0;
	flex: 1;
	overflow: hidden;
}
.agy-tv-prompt-glyph {
	color: var(--dsw-alias-label-caption, #94a3b8);
	flex: none;
	font-weight: 700;
}
.agy-tv-card-cwd {
	color: var(--dsw-alias-label-tertiary, #64748b);
	flex: none;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.agy-tv-card-cmd {
	color: var(--dsw-alias-label-primary, #0f172a);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: pre;
	font-weight: 600;
}
.agy-tv-card-path {
	color: var(--dsw-alias-label-primary, #0f172a);
	font-weight: 600;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

/* Copy button */
.agy-tv-copy-btn {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	background: transparent;
	border: none;
	padding: 2px 6px;
	margin: 0;
	color: var(--dsw-alias-label-secondary, #334155);
	cursor: pointer;
	font-size: 11px;
	line-height: 16px;
	border-radius: 4px;
	transition: background-color 0.1s ease, color 0.1s ease;
	flex: none;
}
.agy-tv-copy-btn:hover {
	background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
	color: var(--dsw-alias-label-primary, #0f172a);
}

/* Card scrollable content */
.agy-tv-card-content {
	max-height: 260px;
	overflow-y: auto;
	overflow-x: auto;
	padding: 10px 14px;
	white-space: pre-wrap;
	word-break: break-word;
	color: var(--dsw-alias-label-secondary, #334155);
	scrollbar-width: thin;
	scrollbar-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.2)) transparent;
}
.agy-tv-card-content::-webkit-scrollbar {
	width: 6px;
	height: 6px;
}
.agy-tv-card-content::-webkit-scrollbar-thumb {
	background: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.18));
	border-radius: 6px;
	background-clip: padding-box;
}
.agy-tv-card-content::-webkit-scrollbar-track {
	background: transparent;
	margin: 6px 0;
}

/* Diff lines */
.agy-tv-diff-list {
	display: flex;
	flex-direction: column;
	padding: 6px 0;
	max-height: 280px;
	overflow-y: auto;
	overflow-x: auto;
	scrollbar-width: thin;
	scrollbar-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.2)) transparent;
}
.agy-tv-diff-list::-webkit-scrollbar {
	width: 6px;
	height: 6px;
}
.agy-tv-diff-list::-webkit-scrollbar-thumb {
	background: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.18));
	border-radius: 6px;
}
.agy-tv-diff-list::-webkit-scrollbar-track {
	background: transparent;
	margin: 4px 0;
}
.agy-tv-diff-line {
	display: flex;
	gap: 8px;
	padding: 0 12px;
	min-height: 20px;
	line-height: 20px;
	white-space: pre-wrap;
	word-break: break-word;
}
.agy-tv-diff-del {
	background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #dc2626) 10%, transparent);
	color: var(--dsw-alias-state-error-primary, #dc2626);
}
.agy-tv-diff-add {
	background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #059669) 10%, transparent);
	color: var(--dsw-alias-state-success-primary, #059669);
}
.agy-tv-diff-marker {
	flex: none;
	width: 14px;
	font-weight: 700;
	user-select: none;
}

/* Inspect button */
.agy-tv-inspect-btn {
	border: 0.5px solid var(--dsw-alias-border-l3, #cbd5e1);
	background: var(--dsw-alias-bg-base, #ffffff);
	color: var(--dsw-alias-label-secondary, #334155);
	cursor: pointer;
	opacity: 0;
	border-radius: 999px;
	align-self: flex-start;
	align-items: center;
	gap: 4px;
	margin: 4px 0 2px 4px;
	padding: 2px 8px;
	font-size: 11px;
	line-height: 16px;
	transition: opacity 0.1s;
	display: inline-flex;
}
.agy-tv-root:hover .agy-tv-inspect-btn,
.agy-tv-inspect-btn:focus-visible {
	opacity: 1;
}
.agy-tv-inspect-btn:hover {
	background: var(--dsw-alias-interactive-bg-hover-solid, #f1f5f9);
	color: var(--dsw-alias-label-primary, #0f172a);
}

/* Question Card Styles */
.agy-tv-question-wrap {
	padding: 10px 14px;
	display: flex;
	flex-direction: column;
	gap: 10px;
	font-family: inherit;
}
.agy-tv-q-item {
	display: flex;
	flex-direction: column;
	gap: 6px;
}
.agy-tv-q-prompt {
	font-size: 13px;
	font-weight: 600;
	color: var(--dsw-alias-label-primary, #0f172a);
}
.agy-tv-q-opts {
	display: flex;
	flex-direction: column;
	gap: 6px;
}
.agy-tv-q-opt {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 6px 10px;
	border-radius: 6px;
	background: var(--dsw-alias-bg-l2, rgba(127, 127, 127, 0.08));
	border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2));
	color: var(--dsw-alias-label-primary, #334155);
	cursor: pointer;
	text-align: left;
	font-size: 12.5px;
	transition: all 0.15s ease;
}
.agy-tv-q-opt:hover {
	background: var(--dsw-alias-bg-hover, rgba(127, 127, 127, 0.15));
	border-color: var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.35));
}
.agy-tv-q-opt.selected {
	background: rgba(16, 185, 129, 0.12);
	border-color: #10b981;
	color: #10b981;
}
.agy-tv-q-check {
	width: 14px;
	height: 14px;
	border: 1.5px solid currentColor;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
}
.agy-tv-q-check.radio {
	border-radius: 50%;
}
.agy-tv-q-check.checkbox {
	border-radius: 3px;
}
.agy-tv-q-check.checked:after {
	content: "";
	width: 6px;
	height: 6px;
	background: currentColor;
	border-radius: inherit;
}
.agy-tv-q-footer {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding-top: 6px;
	border-top: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.15));
}
.agy-tv-q-insert-btn {
	padding: 5px 12px;
	border-radius: 6px;
	font-size: 12px;
	font-weight: 600;
	background: rgba(16, 185, 129, 0.15);
	border: 1px solid #10b981;
	color: #10b981;
	cursor: pointer;
	transition: all 0.15s ease;
}
.agy-tv-q-insert-btn:disabled {
	opacity: 0.4;
	cursor: not-allowed;
}
.agy-tv-q-insert-btn:not(:disabled):hover {
	background: #10b981;
	color: #fff;
}
.agy-tv-q-answered {
	font-size: 11px;
	color: var(--dsw-alias-label-tertiary, #888);
}

/* Image Card Styles */
.agy-tv-img-wrap {
	padding: 10px 14px;
	display: flex;
	flex-direction: column;
	gap: 8px;
}
.agy-tv-img-meta {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}
.agy-tv-img-prompt {
	font-size: 12.5px;
	color: var(--dsw-alias-label-primary, #334155);
	font-style: italic;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.agy-tv-img-badges {
	display: flex;
	gap: 4px;
	flex-shrink: 0;
}
.agy-tv-img-badge {
	font-size: 11px;
	padding: 1px 6px;
	border-radius: 4px;
	background: var(--dsw-alias-bg-l2, rgba(127, 127, 127, 0.1));
	border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2));
	color: var(--dsw-alias-label-secondary, #888);
}
.agy-tv-img-preview-box {
	max-height: 320px;
	overflow: hidden;
	border-radius: 6px;
	border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2));
	display: flex;
	align-items: center;
	justify-content: center;
	background: repeating-conic-gradient(rgba(127,127,127,0.08) 0% 25%, transparent 0% 50%) 50% / 16px 16px;
	cursor: zoom-in;
}
.agy-tv-img-thumb {
	max-width: 100%;
	max-height: 320px;
	object-fit: contain;
}
`;

// Insert toolview stylesheet into document
const gDoc = (globalThis as unknown as {
	document?: {
		getElementById(id: string): unknown;
		createElement(tag: string): { id?: string; textContent?: string };
		head?: unknown;
		documentElement?: { appendChild(n: unknown): void };
	};
}).document;

if (gDoc !== undefined && gDoc !== null) {
	const styleId = 'dsh-agy-link-toolview-css';
	if (gDoc.getElementById(styleId) === null) {
		const st = gDoc.createElement('style');
		st.id = styleId;
		st.textContent = ROW_CSS;
		const host = (gDoc.head ?? gDoc.documentElement) as unknown as { appendChild(n: unknown): void };
		if (host) host.appendChild(st);
	}
}
