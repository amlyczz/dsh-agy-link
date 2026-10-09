// Client-side mermaid rendering (dsh-agy-link).
//
// DSH's markdown pipeline (marked + shiki) has no mermaid grammar: a
// ```mermaid fence falls through `highlightToHtml` as unknown language and
// lands as a plain <pre> inside div.md-code-block, with the
// fence language printed in the banner infostring. So the diagram source is
// in the DOM — it just never gets drawn.
//
// Approach: non-destructive overlay. React owns the code-block subtree, so
// we never rewrite data-code-block-content; we insert a sibling render
// node and hide the source pre via a class. A MutationObserver re-tries
// whenever React rebuilds the block.
//
// mermaid.js is NOT bundled (it would 8x client.js). It is lazy-loaded on
// the first diagram; when that fails (offline / blocked CDN) the source
// block is left visible. Failed loads are retried after a cooldown.

const MERMAID_CSS = `
div.md-code-block[data-agy-mermaid="done"] [data-code-block-content] {
	display: none !important;
}
div.md-code-block[data-agy-mermaid="render"] {
	border-color: var(--dsw-alias-border-l2, #e2e8f0);
}
div[data-agy-mermaid-svg] {
	padding: 12px 8px;
	overflow-x: auto;
	text-align: center;
	background: var(--dsw-alias-bg-base, #ffffff);
}
div[data-agy-mermaid-svg] svg {
	max-width: 100%;
	height: auto;
}
div[data-agy-mermaid-svg][data-agy-mermaid-error] {
	text-align: left;
	color: var(--dsw-alias-label-tertiary, #64748b);
	font-size: 12px;
	white-space: pre-wrap;
	padding: 10px 12px;
}
`

type MermaidApi = {
	initialize: (config: Record<string, unknown>) => void
	render: (id: string, text: string) => Promise<{ svg: string }>
}

declare global {
	interface Window {
		mermaid?: MermaidApi
	}
}

const CDN_URLS = [
	'/plugins/agy-link/mermaid.min.js',
	'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js',
	'https://unpkg.com/mermaid@11/dist/mermaid.min.js',
]

let loadPromise: Promise<MermaidApi | null> | null = null
let loadFailedAt = 0
const LOAD_RETRY_MS = 60_000
let renderSeq = 0

function injectStyles(): void {
	if (typeof document === 'undefined') return
	if (document.getElementById('agy-mermaid-css')) return
	const st = document.createElement('style')
	st.id = 'agy-mermaid-css'
	st.textContent = MERMAID_CSS
	document.head.appendChild(st)
}

function loadScript(src: string): Promise<boolean> {
	return new Promise((resolve) => {
		const s = document.createElement('script')
		s.src = src
		s.async = true
		const done = (ok: boolean): void => {
			s.removeEventListener('load', onLoad)
			s.removeEventListener('error', onError)
			resolve(ok)
		}
		const onLoad = (): void => done(true)
		const onError = (): void => done(false)
		s.addEventListener('load', onLoad)
		s.addEventListener('error', onError)
		document.head.appendChild(s)
		// A hung CDN must not wedge the observer thread.
		setTimeout(() => done(false), 15_000)
	})
}

async function loadMermaid(): Promise<MermaidApi | null> {
	if (typeof window === 'undefined') return null
	if (window.mermaid !== undefined) return window.mermaid
	if (loadPromise !== null) return loadPromise
	// A failed CDN load is retried after a cooldown instead of never.
	if (Date.now() - loadFailedAt < LOAD_RETRY_MS) return null
	loadPromise = (async () => {
		for (const url of CDN_URLS) {
			const ok = await loadScript(url)
			if (ok && window.mermaid !== undefined) {
				try {
					window.mermaid.initialize({
						startOnLoad: false,
						securityLevel: 'strict',
						theme: 'neutral',
						fontFamily: 'inherit',
					})
				} catch {
					// initialize is idempotent enough; keep going
				}
				return window.mermaid
			}
		}
		loadFailedAt = Date.now()
		loadPromise = null
		return null
	})()
	return loadPromise
}

/** Banner infostring text ("mermaid") identifies the fence language. */
function fenceLang(block: HTMLElement): string {
	const info = block.querySelector('[data-code-block-banner] [class*="infostring"]')
		?? block.querySelector('[data-code-block-banner] [class*="language"]')
		?? block.querySelector('[data-code-block-banner]')
	const text = (info?.textContent ?? '').trim().toLowerCase()
	if (text !== '') {
		// The language is the FIRST token of the infostring; the banner may
		// carry UI text after it, so never return more than one token.
		return text.split(/\s+/)[0] ?? ''
	}
	// DSH renders UNKNOWN fence languages with a generic banner ("代码块")
	// and no infostring — the raw language then only survives on the code
	// element itself, if at all.
	const code = block.querySelector('[data-code-block-content] code')
	const cls = code?.getAttribute('class') ?? ''
	const m = cls.match(/language-([\w-]+)/)
	if (m?.[1]) return m[1]!.toLowerCase()
	return (code?.getAttribute('data-language') ?? block.getAttribute('data-language') ?? '').toLowerCase()
}

// First-line shapes of the fence languages mermaid v11 can draw.
const MERMAID_FIRST_LINE = /^(?:flowchart(?:\s+\w+)?|graph\s+(?:TB|TD|LR|RL|BT)|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|sankey-beta|xychart-beta|block-beta|quadrantChart|requirementDiagram|radar-beta|C4(?:Context|Container|Component|Dynamic))\b/

/** Content sniff: unknown-language fences are the whole reason this module exists. */
export function looksLikeMermaidSource(source: string): boolean {
	const line = source.split(/\r?\n/).find((l) => l.trim() !== '')
	return line !== undefined && MERMAID_FIRST_LINE.test(line.trim())
}

function isMermaidLang(lang: string): boolean {
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

function readSource(block: HTMLElement): string {
	const code = block.querySelector('[data-code-block-content] code')
		?? block.querySelector('[data-code-block-content] pre')
		?? block.querySelector('[data-code-block-content]')
	return (code?.textContent ?? '').trim()
}

async function renderInto(block: HTMLElement, source: string): Promise<void> {
	// Drop a previous overlay so a React rebuild can re-render cleanly.
	block.querySelector('[data-agy-mermaid-svg]')?.remove()
	const mount = document.createElement('div')
	mount.setAttribute('data-agy-mermaid-svg', '1')
	block.appendChild(mount)

	const api = await loadMermaid()
	if (api === null) {
		// Offline: keep the source visible and explain once.
		block.setAttribute('data-agy-mermaid', 'error')
		mount.setAttribute('data-agy-mermaid-error', '1')
		mount.textContent = 'Mermaid renderer unavailable (offline). Diagram source stays below.'
		return
	}
	try {
		renderSeq += 1
		const id = 'agy-mmd-' + renderSeq
		const { svg } = await api.render(id, source)
		mount.innerHTML = svg
		block.setAttribute('data-agy-mermaid', 'done')
	} catch (e) {
		block.setAttribute('data-agy-mermaid', 'error')
		mount.setAttribute('data-agy-mermaid-error', '1')
		mount.textContent = 'Mermaid render failed: ' + (e instanceof Error ? e.message : String(e))
	}
}

// Streaming conversations mutate the DOM at high frequency; the scan itself
// walks every code block, so coalesce mutation bursts into one pass.
let scanTimer: ReturnType<typeof setTimeout> | null = null
function scheduleScan(): void {
	if (scanTimer !== null) return
	scanTimer = setTimeout(() => {
		scanTimer = null
		scan()
	}, 150)
}

function scan(): void {
	if (typeof document === 'undefined') return
	const blocks = document.querySelectorAll<HTMLElement>('.md-code-block')
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i]
		if (!block) continue
		const state = block.getAttribute('data-agy-mermaid')
		// Error blocks stay source-visible; they are retried only when React
		// genuinely rebuilds the block (which wipes the state attribute).
		if (state === 'done' || state === 'busy' || state === 'error') continue
		const lang = fenceLang(block)
		const source = readSource(block)
		if (source === '') continue
		if (!isMermaidBlock(lang, source)) continue
		block.setAttribute('data-agy-mermaid', 'busy')
		void renderInto(block, source)
	}
}

export function installMermaidRendering(): void {
	if (typeof window === 'undefined' || typeof document === 'undefined') return
	injectStyles()
	const observer = new MutationObserver(() => {
		scheduleScan()
	})
	const setup = (): void => {
		if (document.body) {
			observer.observe(document.body, { childList: true, subtree: true })
			scan()
		}
	}
	if (document.readyState === 'loading') {
		window.addEventListener('DOMContentLoaded', setup, { once: true })
	} else {
		setup()
	}
}

/** Test seam: classify a fence language the way the scanner does. */
export function isMermaidFence(lang: string): boolean {
	return isMermaidLang(lang.trim().toLowerCase())
}
