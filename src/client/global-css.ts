// Global stylesheet for the Antigravity console and plugins-page dashboard.
// Kept as one template literal: the theme tokens, keyframes, modal-isolation
// rules and the phone-web overrides all target the same `agy-*` class names.

export const GLOBAL_CSS = `
@keyframes agy-spin {
	0% { transform: rotate(0deg); }
	100% { transform: rotate(360deg); }
}

:root, body {
	--agy-font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif);
	--agy-bg-panel: var(--dsw-alias-bg-layer-2, #ffffff);
	--agy-bg-card: var(--dsw-alias-bg-layer-2, #ffffff);
	--agy-bg-card-primary: #f0f7ff;
	--agy-bg-header: var(--dsw-alias-bg-layer-1, #f8fafc);
	--agy-bg-box: var(--dsw-alias-bg-layer-1, #f8fafc);
	--agy-bg-subbox: var(--dsw-alias-bg-layer-3, #f1f5f9);
	--agy-bg-input: var(--dsw-alias-bg-layer-1, #ffffff);
	--agy-bg-btn: var(--dsw-alias-bg-layer-3, #f1f5f9);
	--agy-bg-btn-hover: var(--dsw-alias-interactive-bg-hover, #e2e8f0);
	--agy-bg-btn-primary: var(--dsw-alias-state-business-primary, #2563eb);
	--agy-bg-progress-track: #e2e8f0;

	--agy-border-card: var(--dsw-alias-border-l2, #e2e8f0);
	--agy-border-card-primary: #3b82f6;
	--agy-border-box: var(--dsw-alias-border-l1, #e2e8f0);
	--agy-border-subbox: var(--dsw-alias-border-l2, #cbd5e1);
	--agy-border-input: var(--dsw-alias-border-l2, #cbd5e1);
	--agy-border-input-focus: var(--dsw-alias-state-business-primary, #2563eb);
	--agy-border-btn: var(--dsw-alias-border-l2, #cbd5e1);
	--agy-border-btn-primary: #2563eb;
	--agy-border-divider: var(--dsw-alias-border-l2, #e2e8f0);

	--agy-text-primary: var(--dsw-alias-label-primary, #0f172a);
	--agy-text-secondary: var(--dsw-alias-label-secondary, #334155);
	--agy-text-tertiary: var(--dsw-alias-label-tertiary, #64748b);
	--agy-text-muted: var(--dsw-alias-label-caption, #94a3b8);
	--agy-text-btn: var(--dsw-alias-label-primary, #0f172a);
	--agy-text-btn-primary: #ffffff;
	--agy-text-window-label: #2563eb;

	--agy-shadow-card: 0 1px 3px rgba(0, 0, 0, 0.05);
	--agy-shadow-card-hover: 0 4px 12px rgba(0, 0, 0, 0.08);
	--agy-shadow-card-primary: 0 0 0 1px #3b82f6, 0 4px 14px rgba(37, 99, 235, 0.12);
	--agy-shadow-modal: 0 20px 50px rgba(0, 0, 0, 0.18);
	--agy-modal-backdrop: rgba(15, 23, 42, 0.5);

	/* Badges */
	--agy-badge-primary-bg: #dbeafe;
	--agy-badge-primary-text: #1e40af;
	--agy-badge-primary-border: #60a5fa;

	--agy-badge-tag-bg: #f1f5f9;
	--agy-badge-tag-text: #334155;
	--agy-badge-tag-border: #cbd5e1;

	--agy-badge-email-bg: #eff6ff;
	--agy-badge-email-text: #1d4ed8;
	--agy-badge-email-border: #bfdbfe;

	--agy-badge-proxy-bg: #ecfdf5;
	--agy-badge-proxy-text: #047857;
	--agy-badge-proxy-border: #a7f3d0;

	--agy-badge-ready-bg: #ecfdf5;
	--agy-badge-ready-text: #047857;
	--agy-badge-ready-border: #a7f3d0;

	--agy-badge-unready-bg: #eff6ff;
	--agy-badge-unready-text: #1d4ed8;
	--agy-badge-unready-border: #bfdbfe;

	/* Quota status pills */
	--agy-quota-high-bg: #ecfdf5;
	--agy-quota-high-text: #047857;
	--agy-quota-high-border: #a7f3d0;
	--agy-quota-med-bg: #fffbeb;
	--agy-quota-med-text: #b45309;
	--agy-quota-med-border: #fde68a;
	--agy-quota-low-bg: #fef2f2;
	--agy-quota-low-text: #b91c1c;
	--agy-quota-low-border: #fecaca;
	--agy-quota-none-bg: #f1f5f9;
	--agy-quota-none-text: #64748b;
	--agy-quota-none-border: #cbd5e1;

	/* Danger button */
	--agy-danger-bg: #fef2f2;
	--agy-danger-text: #b91c1c;
	--agy-danger-border: #fecaca;
	--agy-danger-hover-bg: #fee2e2;

	/* Warning banner */
	--agy-warn-bg: #fffbeb;
	--agy-warn-text: #92400e;
	--agy-warn-border: #fcd34d;
	--agy-warn-btn-bg: #fef3c7;
	--agy-warn-btn-text: #92400e;
	--agy-warn-btn-border: #f59e0b;

	/* Toast notices */
	--agy-toast-success-bg: #ecfdf5;
	--agy-toast-success-text: #065f46;
	--agy-toast-success-border: #6ee7b7;
	--agy-toast-info-bg: #eff6ff;
	--agy-toast-info-text: #1e40af;
	--agy-toast-info-border: #93c5fd;
	--agy-toast-warn-bg: #fffbeb;
	--agy-toast-warn-text: #92400e;
	--agy-toast-warn-border: #fcd34d;
	--agy-toast-error-bg: #fef2f2;
	--agy-toast-error-text: #991b1b;
	--agy-toast-error-border: #fca5a5;

	/* Auth Modal / Box */
	--agy-auth-box-bg: #f0f7ff;
	--agy-auth-box-border: #3b82f6;

	/* Segment control */
	--agy-seg-group-bg: #e2e8f0;
	--agy-seg-group-border: #cbd5e1;
	--agy-seg-btn-text: #475569;
	--agy-seg-btn-active-bg: var(--dsw-alias-state-business-primary, #2563eb);
	--agy-seg-btn-active-text: #ffffff;
	--agy-seg-danger-bg: #dc2626;
	--agy-seg-danger-text: #ffffff;
	--agy-seg-danger-border: #b91c1c;
}

body[data-ds-dark-theme],
body.dark,
[data-theme="dark"] {
	--agy-bg-panel: var(--dsw-alias-bg-layer-2, #0f172a);
	--agy-bg-card: var(--dsw-alias-bg-layer-2, #1e293b);
	--agy-bg-card-primary: #111d33;
	--agy-bg-header: var(--dsw-alias-bg-layer-1, #1e293b);
	--agy-bg-box: var(--dsw-alias-bg-layer-1, #0f172a);
	--agy-bg-subbox: var(--dsw-alias-bg-layer-3, #090d16);
	--agy-bg-input: var(--dsw-alias-bg-layer-3, #090d16);
	--agy-bg-btn: var(--dsw-alias-bg-layer-3, #334155);
	--agy-bg-btn-hover: var(--dsw-alias-interactive-bg-hover, #475569);
	--agy-bg-btn-primary: var(--dsw-alias-state-business-primary, #2563eb);
	--agy-bg-progress-track: #1e293b;

	--agy-border-card: var(--dsw-alias-border-l2, #334155);
	--agy-border-card-primary: #3b82f6;
	--agy-border-box: var(--dsw-alias-border-l1, #1e293b);
	--agy-border-subbox: var(--dsw-alias-border-l2, #334155);
	--agy-border-input: var(--dsw-alias-border-l2, #334155);
	--agy-border-input-focus: #3b82f6;
	--agy-border-btn: var(--dsw-alias-border-l2, #475569);
	--agy-border-btn-primary: #3b82f6;
	--agy-border-divider: var(--dsw-alias-border-l2, #334155);

	--agy-text-primary: var(--dsw-alias-label-primary, #f8fafc);
	--agy-text-secondary: var(--dsw-alias-label-secondary, #cbd5e1);
	--agy-text-tertiary: var(--dsw-alias-label-tertiary, #94a3b8);
	--agy-text-muted: var(--dsw-alias-label-caption, #64748b);
	--agy-text-btn: var(--dsw-alias-label-primary, #ffffff);
	--agy-text-btn-primary: #ffffff;
	--agy-text-window-label: #93c5fd;

	--agy-shadow-card: 0 2px 8px rgba(0, 0, 0, 0.3);
	--agy-shadow-card-hover: 0 6px 16px rgba(0, 0, 0, 0.4);
	--agy-shadow-card-primary: 0 0 16px rgba(59, 130, 246, 0.25);
	--agy-shadow-modal: 0 25px 60px rgba(0, 0, 0, 0.8);
	--agy-modal-backdrop: rgba(0, 0, 0, 0.75);

	/* Badges */
	--agy-badge-primary-bg: #1e3a8a;
	--agy-badge-primary-text: #93c5fd;
	--agy-badge-primary-border: #3b82f6;

	--agy-badge-tag-bg: #0f172a;
	--agy-badge-tag-text: #cbd5e1;
	--agy-badge-tag-border: #334155;

	--agy-badge-email-bg: #1e293b;
	--agy-badge-email-text: #93c5fd;
	--agy-badge-email-border: #3b82f6;

	--agy-badge-proxy-bg: #064e3b;
	--agy-badge-proxy-text: #6ee7b7;
	--agy-badge-proxy-border: #059669;

	--agy-badge-ready-bg: rgba(16, 185, 129, 0.15);
	--agy-badge-ready-text: #34d399;
	--agy-badge-ready-border: rgba(16, 185, 129, 0.35);

	--agy-badge-unready-bg: rgba(59, 130, 246, 0.15);
	--agy-badge-unready-text: #93c5fd;
	--agy-badge-unready-border: rgba(59, 130, 246, 0.35);

	/* Quota status pills */
	--agy-quota-high-bg: #064e3b;
	--agy-quota-high-text: #6ee7b7;
	--agy-quota-high-border: #059669;
	--agy-quota-med-bg: #451a03;
	--agy-quota-med-text: #fde68a;
	--agy-quota-med-border: #d97706;
	--agy-quota-low-bg: #450a0a;
	--agy-quota-low-text: #fca5a5;
	--agy-quota-low-border: #dc2626;
	--agy-quota-none-bg: #1e293b;
	--agy-quota-none-text: #94a3b8;
	--agy-quota-none-border: #475569;

	/* Danger button */
	--agy-danger-bg: #450a0a;
	--agy-danger-text: #fca5a5;
	--agy-danger-border: #ef4444;
	--agy-danger-hover-bg: #5f1313;

	/* Warning banner */
	--agy-warn-bg: #451a03;
	--agy-warn-text: #fde68a;
	--agy-warn-border: #d97706;
	--agy-warn-btn-bg: #78350f;
	--agy-warn-btn-text: #fde68a;
	--agy-warn-btn-border: #d97706;

	/* Toast notices */
	--agy-toast-success-bg: #064e3b;
	--agy-toast-success-text: #6ee7b7;
	--agy-toast-success-border: #059669;
	--agy-toast-info-bg: #1e3a8a;
	--agy-toast-info-text: #93c5fd;
	--agy-toast-info-border: #3b82f6;
	--agy-toast-warn-bg: #451a03;
	--agy-toast-warn-text: #fde68a;
	--agy-toast-warn-border: #d97706;
	--agy-toast-error-bg: #450a0a;
	--agy-toast-error-text: #fca5a5;
	--agy-toast-error-border: #dc2626;

	/* Auth Modal / Box */
	--agy-auth-box-bg: #0f223a;
	--agy-auth-box-border: #3b82f6;

	/* Segment control */
	--agy-seg-group-bg: #090d16;
	--agy-seg-group-border: #334155;
	--agy-seg-btn-text: #94a3b8;
	--agy-seg-btn-active-bg: var(--dsw-alias-state-business-primary, #2563eb);
	--agy-seg-btn-active-text: #ffffff;
	--agy-seg-danger-bg: #7f1d1d;
	--agy-seg-danger-text: #fca5a5;
	--agy-seg-danger-border: #ef4444;
}

.agy-spinner {
	display: inline-block;
	width: 12px;
	height: 12px;
	border: 2px solid currentColor;
	border-top-color: transparent;
	border-radius: 50%;
	animation: agy-spin 0.75s linear infinite;
	vertical-align: -2px;
	margin-right: 5px;
}
.agy-pulse-dot {
	display: inline-block;
	width: 8px;
	height: 8px;
	border-radius: 50%;
}
.agy-card-hover {
	transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.18s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
}
.agy-card-hover:hover {
	border-color: var(--agy-border-card-primary, #3b82f6) !important;
	box-shadow: var(--agy-shadow-card-hover) !important;
}

.agy-btn {
	transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, filter 0.15s ease, transform 0.15s ease;
	user-select: none;
}
.agy-btn:hover:not(:disabled) {
	filter: brightness(1.08);
	transform: translateY(-0.5px);
}
.agy-btn:active:not(:disabled) {
	transform: translateY(0.5px);
}

/* Standalone enable/disable toggle (rows without a segment group). Class-based
   so both states carry a real border, a hover affordance and a visible
   clickable area — the old inline segBtn left the OFF state invisible. */
.agy-toggle {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	min-width: 58px;
	padding: 4px 12px;
	border-radius: 999px;
	border: 1px solid var(--dsw-alias-border-l3, #94a3b8);
	background: var(--dsw-alias-bg-layer-1, #f8fafc);
	color: var(--dsw-alias-label-primary, #0f172a);
	font-size: 11.5px;
	font-weight: 600;
	line-height: 1.5;
	cursor: pointer;
	transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, filter 0.15s ease;
}
.agy-toggle:hover:not(:disabled) {
	border-color: var(--dsw-alias-border-l4, #64748b);
	background: var(--dsw-alias-interactive-bg-hover-solid, #e2e8f0);
}
.agy-toggle:disabled {
	opacity: 0.55;
	cursor: default;
}
.agy-toggle[data-on="true"] {
	border-color: var(--dsw-alias-state-business-primary, #2563eb);
	background: var(--dsw-alias-state-business-primary, #2563eb);
	color: #ffffff;
}
.agy-toggle[data-on="true"]:hover:not(:disabled) {
	filter: brightness(1.08);
}
.agy-progress-fill {
	transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes agy-shimmer {
	0% { transform: translateX(-100%); }
	100% { transform: translateX(100%); }
}
.agy-shimmer-track {
	position: relative;
	overflow: hidden;
	contain: paint;
	transform: translateZ(0);
	isolation: isolate;
}
.agy-shimmer-track::after {
	content: '';
	position: absolute;
	top: 0; left: 0; right: 0; bottom: 0;
	background: linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.22) 50%, transparent 100%);
	transform: translateX(-100%);
	/* No will-change: transform: it pins a compositing layer for a decorative
	   loop even while it is idle, and inside the overlay that layer is another
	   thing the compositor can drop mid-scroll. */
	animation: agy-shimmer 1.8s infinite ease-in-out;
	pointer-events: none;
}
.agy-modal-backdrop {
	position: fixed;
	inset: 0;
	z-index: 9999;
	background: var(--agy-modal-backdrop);
	/* NO full-screen backdrop blur here. Filtering the whole viewport forces
	   Chromium/Electron to re-sample the page every frame while anything behind
	   it moves (scroll, streaming, animations) — the recurring "打开控制台后滚动
	   闪屏" root cause. The rgba dim below is stable and flicker-free. */
	overscroll-behavior: contain;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 16px;
	box-sizing: border-box;
}
/* While the console is open, freeze the conversation scroller behind it so
   nothing moves/reflows under the fixed overlay. scrollbar-gutter:stable on the
   host scroller keeps the width from jumping when overflow flips to hidden. */
html.agy-modal-open [data-conversation-scroll] {
	overflow: hidden !important;
	overscroll-behavior: contain;
}
/* Belt for the shell itself: if the host page (or a shell wrapper) is the thing
   that scrolls, locking only the conversation scroller leaves a scroller free
   behind the overlay. The wheel/touch blocker in the dialog is the primary fix;
   this makes the intent explicit for any element that follows the document. */
html.agy-modal-open,
html.agy-modal-open body {
	overflow: hidden !important;
	overscroll-behavior: none;
}
.agy-modal-panel {
	position: relative;
	width: 100%;
	max-width: 640px;
	max-height: min(820px, calc(100vh - 48px));
	background: var(--agy-bg-panel);
	border: 1px solid var(--agy-border-card);
	border-radius: 14px;
	box-shadow: var(--agy-shadow-modal);
	display: flex;
	flex-direction: column;
	overflow: hidden;
	color: var(--agy-text-primary);
	font-family: var(--agy-font-family);
	/* NO compositing hints here (2026-11-04, "滚动还是频繁闪屏"):
	   contain: content implies PAINT containment, and paint containment on an
	   ancestor of a scrolling subtree is the classic Chromium flicker trap — the
	   backing layer is dropped and rebuilt while the body scrolls, so the panel
	   blinks over the translucent backdrop. A forced translateZ(0) layer makes
	   it worse (big fixed layer + shadow re-composited per frame). A 640px panel
	   needs neither hint; plain overflow: hidden already clips it. */
}
.agy-submodel-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 4px 8px;
	font-size: 11px;
	border-radius: 5px;
	background: var(--agy-bg-subbox);
	border: 1px solid var(--agy-border-box);
	margin: 2px 0;
	color: var(--agy-text-primary);
}

/* Native dropdowns: the closed control carries inline colours, but the popup
   list follows color-scheme, so mirror the shell theme here too. */
select.agy-select { color-scheme: light; }
body[data-ds-dark-theme] select.agy-select { color-scheme: dark; }

/* ------------------------------------------------------------------
   Phone web. Below 680px the console becomes a full-height sheet and
   every inline flex row is allowed to wrap: the layout is written with
   style attributes, and only an !important rule can beat those, so the
   overrides here are deliberately blunt.
   ------------------------------------------------------------------ */
@media (max-width: 680px) {
	.agy-session-status-label {
		display: none !important;
	}
	.agy-session-status-btn {
		padding: 4px 6px !important;
		min-width: 0 !important;
	}
	.agy-modal-backdrop {
		padding: 0 !important;
		align-items: stretch !important;
		justify-content: stretch !important;
	}
	.agy-modal-panel {
		width: 100% !important;
		max-width: none !important;
		height: 100dvh !important;
		max-height: 100dvh !important;
		border: 0 !important;
		border-radius: 0 !important;
	}
	.agy-modal-head {
		padding: 12px 14px !important;
		padding-top: max(12px, env(safe-area-inset-top)) !important;
	}
	.agy-modal-body {
		padding: 14px 12px calc(18px + env(safe-area-inset-bottom)) !important;
		-webkit-overflow-scrolling: touch;
	}

	/* A flex row may wrap instead of pushing the panel sideways. */
	.agy-console [style*="display: flex"] { flex-wrap: wrap !important; }
	/* Label on its own line, the control underneath it. */
	.agy-console [style*="justify-content: space-between"] {
		flex-direction: column !important;
		align-items: stretch !important;
		gap: 8px !important;
	}
	/* Segmented controls fill the row; every segment shares the width. */
	.agy-console [style*="agy-seg-group-border"] {
		display: flex !important;
		width: 100% !important;
		box-sizing: border-box !important;
	}
	.agy-console [style*="agy-seg-group-border"] > button {
		flex: 1 1 0 !important;
		min-width: 0 !important;
		padding-left: 6px !important;
		padding-right: 6px !important;
	}
	/* Inputs shrink; buttons keep a comfortable tap area. */
	.agy-console input { min-width: 0 !important; flex: 1 1 140px !important; }
	/* Settings dropdowns share their row and stretch on a phone. */
	.agy-console .agy-select { flex: 1 1 0 !important; min-width: 0 !important; max-width: none !important; height: 34px !important; }
	.agy-console .agy-btn { min-height: 34px; }
	/* The family label no longer reserves 140px of a 360px screen. */
	.agy-console [style*="min-width: 140px"] { min-width: 0 !important; }
	/* Per-model rows may wrap their value under the name. */
	.agy-console .agy-submodel-row { flex-wrap: wrap; gap: 4px 8px; }

	/* Quota line: window name, percentage badge, and reset info share the first row,
	   the bar takes the second one — on narrow screens this keeps all info legible
	   and avoids horizontal collision. */
	.agy-quota-line {
		display: grid !important;
		grid-template-columns: auto 1fr auto auto !important;
		grid-template-areas:
			"label . pct reset"
			"bar bar bar bar" !important;
		align-items: center !important;
		gap: 4px 6px !important;
	}
	.agy-quota-line > span:first-child {
		grid-area: label;
		width: auto !important;
		white-space: nowrap !important;
	}
	.agy-quota-line > div:nth-child(2) {
		grid-area: bar;
		margin: 0 !important;
		width: 100% !important;
	}
	.agy-quota-line > span:nth-child(3) {
		grid-area: pct;
	}
	.agy-quota-line > div:nth-child(4) {
		grid-area: reset;
		width: auto !important;
		min-width: 0 !important;
		margin-left: 0 !important;
	}

	/* Header actions: the primary action keeps a full row, the two
	   secondary ones share the next. */
	.agy-header-actions {
		display: grid !important;
		grid-template-columns: 1fr 1fr;
		gap: 6px;
		width: 100%;
	}
	.agy-header-actions > button:first-child { grid-column: 1 / -1; }
	.agy-header-actions > button { width: 100%; justify-content: center; }

	/* Account actions: equal-width buttons instead of one ragged line. */
	.agy-card-head {
		display: contents !important;
	}
	.agy-card-title-cluster {
		order: 1 !important;
		margin-bottom: 2px !important;
	}
	.agy-card-meta {
		order: 2 !important;
		margin-bottom: 5px !important;
		gap: 4px !important;
	}
	.agy-card-actions {
		order: 3 !important;
		display: grid !important;
		grid-template-columns: repeat(auto-fit, minmax(68px, 1fr)) !important;
		gap: 4px !important;
		width: 100% !important;
		align-items: stretch !important;
	}
	.agy-card-actions > button {
		width: 100% !important;
		justify-content: center !important;
		min-height: 28px !important;
	}
	/* Micro move buttons stay compact on phone */
	.agy-card-title-cluster .agy-btn {
		min-height: 18px !important;
		height: 18px !important;
	}
}

@media (max-width: 420px) {
	.agy-console { font-size: 12.5px; }
	.agy-modal-head {
		padding: 10px 12px !important;
		padding-top: max(10px, env(safe-area-inset-top)) !important;
	}
	.agy-modal-body { padding: 12px 10px calc(16px + env(safe-area-inset-bottom)) !important; }
	.agy-console [style*="justify-content: space-between"] { gap: 6px !important; }
	.agy-card-actions {
		grid-template-columns: repeat(auto-fit, minmax(60px, 1fr)) !important;
		gap: 3px !important;
	}
	.agy-card-actions > button {
		padding: 2px 4px !important;
		font-size: 10.5px !important;
		min-height: 26px !important;
	}
	.agy-card-meta {
		gap: 3px !important;
	}
	.agy-quota-line {
		gap: 3px 6px !important;
	}
}
`;
