// Mermaid theme + configuration: stylesheet, lazy-load asset list, API shape
// and fence classification.
//
// Split out of mermaid.ts (behavior-preserving). Nothing here touches the DOM
// until a caller does; the loader owns script injection and the renderer owns
// the overlay.

export const MERMAID_CSS = `
div.md-code-block[data-agy-mermaid="done"]:not([data-agy-mermaid-view="source"]) [data-code-block-content] {
	display: none !important;
}
div.md-code-block[data-agy-mermaid="done"][data-agy-mermaid-view="source"] [data-agy-mermaid-svg] > .agy-mermaid-body {
	display: none !important;
}
div.md-code-block[data-agy-mermaid="render"] {
	border-color: var(--dsw-alias-border-l2, #e2e8f0);
}
div[data-agy-mermaid-svg] {
	position: relative;
	padding: 8px 8px 12px 8px;
	overflow-x: auto;
	text-align: center;
	background: var(--dsw-alias-bg-base, #ffffff);
}
div[data-agy-mermaid-svg] svg {
	max-width: 100%;
	min-width: 280px;
	height: auto;
}
.agy-mermaid-body {
	display: flex;
	justify-content: center;
	width: 100%;
	overflow-x: auto;
}
.agy-mermaid-toolbar {
	display: flex;
	justify-content: flex-end;
	padding: 2px 4px 6px 4px;
	background: transparent;
}
.agy-mermaid-toggle {
	font-size: 11px;
	line-height: 1.4;
	padding: 2px 8px;
	border-radius: 4px;
	border: 1px solid var(--dsw-alias-border-l2, #e2e8f0);
	background: var(--dsw-alias-bg-surface, #f8fafc);
	color: var(--dsw-alias-label-secondary, #475569);
	cursor: pointer;
	user-select: none;
	transition: all 0.15s ease;
}
.agy-mermaid-toggle:hover {
	background: var(--dsw-alias-bg-hover, #f1f5f9);
	color: var(--dsw-alias-label-primary, #0f172a);
}
.agy-mermaid-warn {
	padding: 6px 10px;
	margin-bottom: 6px;
	font-size: 12px;
	color: #92400e;
	background: #fef3c7;
	border-radius: 4px;
	text-align: left;
}
div[data-agy-mermaid-svg][data-agy-mermaid-error] {
	text-align: left;
	color: var(--dsw-alias-label-tertiary, #64748b);
	font-size: 12px;
	white-space: pre-wrap;
	padding: 10px 12px;
}
/* Prevent Mermaid's internal error DOM or leaked temporary nodes from escaping into document.body.
   The generic .error-icon/.error-text classes are scoped to OUR mounts and the
   leaked-body id shapes only — unqualified, they hid host UI using the same
   class names. */
div[data-agy-mermaid-svg] .error-icon,
div[data-agy-mermaid-svg] .error-text,
body > [id^="dagy-mmd"] .error-icon,
body > [id^="iagy-mmd"] .error-icon {
	display: none !important;
}
`

export type MermaidApi = {
	initialize: (config: Record<string, unknown>) => void
	parse?: (text: string) => Promise<unknown>
	render: (id: string, text: string, container?: Element) => Promise<{ svg: string }>
}

declare global {
	interface Window {
		mermaid?: MermaidApi
	}
}

/**
 * The bundle ships mermaid.min.js and serves it from the plugin route. There
 * is deliberately NO public-CDN fallback: a floating-version, unsigned
 * script executing inside the DSH web origin (with reach into every local
 * HTTP API) is a supply-chain hazard that outweighs offline convenience.
 * When the local asset is missing the source block simply stays visible.
 */
export const CDN_URLS = [
	'/plugins/agy-link/mermaid.min.js',
]

// First-line shapes of the fence languages mermaid v11 can draw.
const MERMAID_FIRST_LINE = /^(?:flowchart(?:\s+\w+)?|graph\s+(?:TB|TD|LR|RL|BT)|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|sankey-beta|xychart-beta|block-beta|quadrantChart|requirementDiagram|radar-beta|C4(?:Context|Container|Component|Dynamic))\b/

/** Content sniff: unknown-language fences are the whole reason this module exists. */
export function looksLikeMermaidSource(source: string): boolean {
	const line = source.split(/\r?\n/).find((l) => l.trim() !== '')
	return line !== undefined && MERMAID_FIRST_LINE.test(line.trim())
}

export function isMermaidLang(lang: string): boolean {
	return lang === 'mermaid' || lang === 'mermaidjs' || lang.startsWith('mermaid')
}

const KNOWN_NON_MERMAID = new Set([
	'typescript', 'ts', 'javascript', 'js', 'jsx', 'tsx',
	'python', 'py', 'java', 'c', 'cpp', 'c++', 'csharp', 'cs',
	'go', 'golang', 'rust', 'rs', 'php', 'ruby', 'rb', 'swift',
	'kotlin', 'kt', 'scala', 'shell', 'bash', 'sh', 'zsh',
	'sql', 'html', 'css', 'scss', 'less', 'json', 'yaml', 'yml',
	'xml', 'graphql', 'toml', 'ini', 'dockerfile', 'makefile',
])

export function isMermaidBlock(lang: string, source: string): boolean {
	if (isMermaidLang(lang)) return true
	if (KNOWN_NON_MERMAID.has(lang)) return false
	return looksLikeMermaidSource(source)
}

/** Pick the mermaid theme from the host's current light/dark state. */
export function preferredMermaidTheme(): 'dark' | 'neutral' {
	const isDark = typeof document !== 'undefined' && (
		document.documentElement.classList.contains('dark') ||
		document.body.classList.contains('dark') ||
		window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
	)
	return isDark ? 'dark' : 'neutral'
}

/** Test seam: classify a fence language the way the scanner does. */
export function isMermaidFence(lang: string): boolean {
	return isMermaidLang(lang.trim().toLowerCase())
}
