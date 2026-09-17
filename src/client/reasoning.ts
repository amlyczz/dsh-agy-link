// Client-side reasoning presentation enhancements (dsh-agy-link).
//
// In DSH web, assistant reasoning rows (<div data-variant="think">) default to
// collapsed (useState(false)), matching the official native DSH experience.
//
// - Collapsed state:
//   - Small thinking icon (IconThinkOutline14)
//   - Mouse hover over icon or row automatically shows the chevron down arrow
//   - Title + separator dot + single-line summary with ellipsis
//
// - Expanded state (when clicked by the user):
//   - Leading icon is the chevron down arrow
//   - If the thought prose is long, it provides smooth scrollable browsing
//     (max-height: 360px, overflow-y: auto) with native-looking scrollbars
//   - Any [agy thinking turn · X thinking tokens] metadata banner is styled
//     cleanly as an inline metadata chip

const REASONING_CSS = `
/* Ensure thinking disclosure row hover effect works reliably across all builds */
div[data-variant="think"] [data-disclosure-row]:hover [class*="iconIdle"],
div[data-variant="think"] [class*="row"]:hover [class*="iconIdle"] {
	opacity: 0 !important;
}
div[data-variant="think"] [data-disclosure-row]:hover [class*="chevronHover"],
div[data-variant="think"] [class*="row"]:hover [class*="chevronHover"] {
	opacity: 1 !important;
}

/* Scrollable thinking body when content is long */
div[data-variant="think"] [class*="thinkBody"] {
	max-height: 360px;
	overflow-y: auto;
	overflow-x: hidden;
	white-space: pre-wrap;
	word-break: break-word;
	padding-right: 8px;
	scrollbar-width: thin;
	scrollbar-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.2)) transparent;
}
div[data-variant="think"] [class*="thinkBody"]::-webkit-scrollbar {
	width: 6px;
	height: 6px;
}
div[data-variant="think"] [class*="thinkBody"]::-webkit-scrollbar-thumb {
	background: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.18));
	border-radius: 6px;
	background-clip: padding-box;
}
div[data-variant="think"] [class*="thinkBody"]::-webkit-scrollbar-track {
	background: transparent;
	margin: 4px 0;
}

/* Tasteful metadata chip for [agy thinking turn · ...] banner */
.agy-thought-banner {
	display: inline-block;
	font-size: 11px;
	line-height: 16px;
	padding: 1px 7px;
	margin-bottom: 6px;
	border-radius: 4px;
	color: var(--dsw-alias-label-tertiary, #64748b);
	background: var(--dsw-alias-bg-layer-3, rgba(0, 0, 0, 0.04));
	border: 0.5px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
	font-family: var(--dsw-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
	font-weight: 500;
	user-select: none;
}
`;

function injectStyles(): void {
	if (typeof document === 'undefined') return;
	const styleId = 'dsh-agy-link-reasoning-css';
	if (document.getElementById(styleId) === null) {
		const st = document.createElement('style');
		st.id = styleId;
		st.textContent = REASONING_CSS;
		const host = document.head ?? document.documentElement;
		if (host) host.appendChild(st);
	}
}

/**
 * Cleanly format any `[agy thinking turn ...]` banner in `thinkBody`
 * into a styled metadata chip so the prose displays cleanly.
 */
function formatThinkingBody(thinkBodyEl: HTMLElement): void {
	if (thinkBodyEl.dataset.agyFormatted === 'true') return;
	const text = thinkBodyEl.textContent ?? '';
	const match = text.match(/^\[agy thinking turn(?: · \d+ thinking tokens)?\]\s*/);
	if (!match) return;

	const bannerText = match[0].trim();
	const restText = text.slice(match[0].length);

	// Mark as formatted to prevent re-entrancy
	thinkBodyEl.dataset.agyFormatted = 'true';
	thinkBodyEl.textContent = '';

	const bannerSpan = document.createElement('span');
	bannerSpan.className = 'agy-thought-banner';
	bannerSpan.textContent = bannerText;

	thinkBodyEl.appendChild(bannerSpan);
	if (restText.length > 0) {
		thinkBodyEl.appendChild(document.createTextNode('\n' + restText));
	}
}

function scanThinkingBlocks(): void {
	if (typeof document === 'undefined') return;
	const thinkBodies = document.querySelectorAll<HTMLElement>('div[data-variant="think"] [class*="thinkBody"]');
	for (let i = 0; i < thinkBodies.length; i++) {
		const body = thinkBodies[i];
		if (body) formatThinkingBody(body);
	}
}

export function installAutoExpandReasoning(): void {
	if (typeof window === 'undefined' || typeof document === 'undefined') return;

	injectStyles();

	// Observe DOM mutations to format thinking body banners when expanded
	const observer = new MutationObserver(() => {
		scanThinkingBlocks();
	});

	const setupObserver = () => {
		if (document.body) {
			observer.observe(document.body, {
				childList: true,
				subtree: true,
			});
			scanThinkingBlocks();
		}
	};

	if (document.readyState === 'loading') {
		window.addEventListener('DOMContentLoaded', setupObserver, { once: true });
	} else {
		setupObserver();
	}
}
