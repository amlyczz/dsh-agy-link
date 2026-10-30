import { isInteractionLocked, onScrollSettle } from './scroll-guard.ts';

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

type MermaidApi = {
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
const CDN_URLS = [
	'/plugins/agy-link/mermaid.min.js',
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
		let settled = false
		const done = (ok: boolean): void => {
			if (settled) return
			settled = true
			s.removeEventListener('load', onLoad)
			s.removeEventListener('error', onError)
			// A timed-out script tag used to stay in the DOM: a slow response
			// would still execute later and race the fallback load.
			if (!ok) s.remove()
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
					const isDark = typeof document !== 'undefined' && (
						document.documentElement.classList.contains('dark') ||
						document.body.classList.contains('dark') ||
						window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
					)
					window.mermaid.initialize({
						startOnLoad: false,
						securityLevel: 'strict',
						theme: isDark ? 'dark' : 'neutral',
						fontFamily: 'inherit',
						suppressErrorRendering: true,
						flowchart: {
							useMaxWidth: true,
							htmlLabels: false,
						},
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
	// 1. First check explicit language class on code/pre element: <code class="language-mermaid">
	const code = block.querySelector('[data-code-block-content] code')
		?? block.querySelector('[data-code-block-content] pre')
	const cls = code?.getAttribute('class') ?? ''
	const m = cls.match(/language-([\w-]+)/)
	if (m?.[1]) return m[1]!.toLowerCase()
	const dataLang = (code?.getAttribute('data-language') ?? block.getAttribute('data-language') ?? '').trim().toLowerCase()
	if (dataLang !== '') return dataLang

	// 2. Next check the banner infostring or language element
	const info = block.querySelector('[data-code-block-banner] [class*="infostring"]')
		?? block.querySelector('[data-code-block-banner] [class*="language"]')
	const text = (info?.textContent ?? '').trim().toLowerCase()
	if (text !== '' && text !== '代码块' && text !== 'code' && text !== 'code block') {
		return text.split(/\s+/)[0] ?? ''
	}

	// 3. Fallback: banner text ONLY if it is not a generic localized placeholder
	const banner = block.querySelector('[data-code-block-banner]')
	const bannerText = (banner?.textContent ?? '').trim().toLowerCase()
	if (bannerText !== '' && bannerText !== '代码块' && bannerText !== 'code' && bannerText !== 'code block') {
		return bannerText.split(/\s+/)[0] ?? ''
	}
	return ''
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

export function cleanupTempElements(id?: string): void {
	if (typeof document === 'undefined') return
	if (id) {
		const delD = document.getElementById('d' + id)
		if (delD && (typeof delD.closest !== 'function' || !delD.closest('[data-agy-mermaid-svg]'))) {
			delD.remove()
		}
		const delI = document.getElementById('i' + id)
		if (delI && (typeof delI.closest !== 'function' || !delI.closest('[data-agy-mermaid-svg]'))) {
			delI.remove()
		}
		const el = document.getElementById(id)
		if (el && (typeof el.closest !== 'function' || !el.closest('[data-agy-mermaid-svg]'))) {
			el.remove()
		}
	}
	const stray = document.querySelectorAll<HTMLElement>(
		'body > [id^="dagy-mmd"], body > [id^="iagy-mmd"], body > [id^="d_agy-mmd"], body > [id^="i_agy-mmd"], body > [id^="agy-mmd-"]'
	)
	for (let i = 0; i < stray.length; i++) {
		const s = stray[i]
		if (s && (typeof s.closest !== 'function' || !s.closest('[data-agy-mermaid-svg]'))) {
			s.remove()
		}
	}
}

export function repairMermaidSource(source: string): string {
	const isFlowchart = /^\s*(?:flowchart|graph)\b/i.test(source)
	if (!isFlowchart) return source

	const lines = source.split(/\r?\n/)
	const repairedLines = lines.map((line) => {
		let l = line
		// 1. Repair subgraph lines without quotes containing colons, spaces or Chinese punctuation
		const subMatch = l.match(/^(\s*subgraph\s+)([^"[\]\n]+)$/i)
		if (subMatch && (subMatch[2]!.includes(':') || subMatch[2]!.includes(' ') || subMatch[2]!.includes('：'))) {
			const title = subMatch[2]!.trim()
			l = `${subMatch[1]}"${title}"`
		}

		// 2. Repair node brackets [...] with unquoted special chars like >, <, :, (, )
		l = l.replace(/(\b[a-zA-Z0-9_\u4e00-\u9fa5]+)\[([^"\]\n]+)\]/g, (m, id, text) => {
			if (text.includes('>') || text.includes('<') || text.includes(':') || text.includes('：') || text.includes('(') || text.includes(')')) {
				return `${id}["${text.trim()}"]`
			}
			return m
		})

		// 3. Repair node parens (...) with unquoted special chars
		l = l.replace(/(\b[a-zA-Z0-9_\u4e00-\u9fa5]+)\(([^")\n]+)\)/g, (m, id, text) => {
			if (text.includes('>') || text.includes('<') || text.includes(':') || text.includes('：') || text.includes('[') || text.includes(']')) {
				return `${id}("${text.trim()}")`
			}
			return m
		})

		// 4. Repair + between nodes on lines containing arrows in flowcharts
		if (l.includes('-->') || l.includes('---') || l.includes('-.->') || l.includes('==>') || l.includes('<--')) {
			let inQuote = false
			let inBracket = 0
			let inPipe = false
			let out = ''
			for (let i = 0; i < l.length; i++) {
				const ch = l[i]!
				if (ch === '"' && (i === 0 || l[i - 1] !== '\\')) {
					inQuote = !inQuote
					out += ch
				} else if (!inQuote && ch === '|') {
					inPipe = !inPipe
					out += ch
				} else if (!inQuote && !inPipe && (ch === '[' || ch === '(' || ch === '{')) {
					inBracket++
					out += ch
				} else if (!inQuote && !inPipe && (ch === ']' || ch === ')' || ch === '}')) {
					if (inBracket > 0) inBracket--
					out += ch
				} else if (!inQuote && !inPipe && inBracket === 0 && ch === '+') {
					out += '&'
				} else {
					out += ch
				}
			}
			l = out
		}

		return l
	})
	return repairedLines.join('\n')
}

export function isInvalidOrCollapsedSvg(svg: string | null | undefined): boolean {
	if (!svg || svg.trim() === '') return true
	if (
		svg.includes('class="error-icon"') ||
		svg.includes('class="error-text"') ||
		svg.includes('aria-roledescription="error"')
	) {
		return true
	}
	// Detect collapsed 0x0 diagram artifacts generated when rendered inside zero-geometry containers
	if (
		svg.includes('viewBox="0 0 0 0"') ||
		svg.includes('viewBox="-8 -8 16 16"') ||
		svg.includes('max-width: 16px') ||
		svg.includes('max-width: 0px')
	) {
		return true
	}
	return false
}

// Mermaid's render() is not reentrant: it writes shared temporary nodes into
// document.body, and our post-render cleanup sweeps every one of them. When a
// single scan pass sees several diagrams at once — a long answer with two or
// three charts, or the first lazy load resolving for every already-pending
// block — the concurrent renders clobber each other's temp DOM. The losers
// throw, and auto-sniffed blocks then silently "fall back" to a plain code
// block that looks exactly like "the diagram just didn't render". Serialize
// every render through one chain so exactly one diagram is drawn at a time.
let renderChain: Promise<void> = Promise.resolve()

/** Queue a render task behind the previous one. Failures never break the chain. */
export function enqueueMermaidRender<T>(task: () => Promise<T>): Promise<T> {
	const run = renderChain.then(task, task)
	renderChain = run.then(
		() => undefined,
		() => undefined,
	)
	return run
}

async function renderInto(block: HTMLElement, source: string, lang = ''): Promise<void> {
	// Drop a previous overlay so a React rebuild can re-render cleanly.
	block.querySelector('[data-agy-mermaid-svg]')?.remove()
	const mount = document.createElement('div')
	mount.setAttribute('data-agy-mermaid-svg', '1')
	block.appendChild(mount)

	await enqueueMermaidRender(async () => {
		const api = await loadMermaid()
		if (api === null) {
			// Offline: keep the source visible and explain once.
			block.setAttribute('data-agy-mermaid', 'error')
			mount.setAttribute('data-agy-mermaid-error', '1')
			mount.textContent = 'Mermaid renderer unavailable (offline). Diagram source stays below.'
			return
		}
		renderSeq += 1
		const id = 'agy-mmd-' + renderSeq
		let targetSource = source
		try {
		// Pre-validate diagram syntax; try auto-repairing common LLM syntax errors if raw fails
		let parseValidated = false
		if (typeof api.parse === 'function') {
			try {
				await api.parse(targetSource)
				parseValidated = true
			} catch (parseErr) {
				const repaired = repairMermaidSource(targetSource)
				if (repaired !== targetSource) {
					try {
						await api.parse(repaired)
						targetSource = repaired
						parseValidated = true
					} catch {
						throw parseErr
					}
				} else {
					throw parseErr
				}
			}
		}
		if (!parseValidated && typeof api.parse !== 'function') {
			targetSource = repairMermaidSource(targetSource)
		}
		// Note: Do not pass mount as the container argument to api.render.
		// When mount is off-screen or inside virtualized/hidden lists, passing mount
		// causes Mermaid/Dagre to measure text bounding boxes as 0x0, resulting in
		// collapsed 16x16 SVG artifacts. Rendering without mount lets Mermaid use its
		// sandbox in document.body with proper viewport metrics.
		const { svg } = await api.render(id, targetSource)
		if (isInvalidOrCollapsedSvg(svg)) {
			throw new Error('Mermaid returned an empty or invalid diagram')
		}

		mount.innerHTML = ''
		const toolbar = document.createElement('div')
		toolbar.className = 'agy-mermaid-toolbar'
		const toggleBtn = document.createElement('button')
		toggleBtn.type = 'button'
		toggleBtn.className = 'agy-mermaid-toggle'
		toggleBtn.textContent = '查看源码'
		toggleBtn.title = '切换图表与原始代码'
		toggleBtn.addEventListener('click', (ev) => {
			ev.preventDefault()
			ev.stopPropagation()
			const isSrc = block.getAttribute('data-agy-mermaid-view') === 'source'
			if (isSrc) {
				block.removeAttribute('data-agy-mermaid-view')
				toggleBtn.textContent = '查看源码'
			} else {
				block.setAttribute('data-agy-mermaid-view', 'source')
				toggleBtn.textContent = '查看图表'
			}
		})
		toolbar.appendChild(toggleBtn)
		mount.appendChild(toolbar)

		const bodyDiv = document.createElement('div')
		bodyDiv.className = 'agy-mermaid-body'
		bodyDiv.innerHTML = svg
		mount.appendChild(bodyDiv)

		block.setAttribute('data-agy-mermaid', 'done')
	} catch (e) {
		const isExplicit = isMermaidLang(lang)
		if (!isExplicit) {
			// Auto-sniffed block (not explicitly tagged as ```mermaid).
			// If parsing/rendering fails, gracefully fall back to displaying
			// as a normal code block without injecting a distracting error banner.
			mount.remove()
			block.setAttribute('data-agy-mermaid', 'fallback')
		} else {
			// Explicit mermaid block: show clear warning without hiding the code block!
			block.setAttribute('data-agy-mermaid', 'error')
			mount.innerHTML = '<div class="agy-mermaid-warn">⚠️ Mermaid 图表解析失败，已保留原始代码呈现</div>'
		}
		} finally {
			cleanupTempElements(id)
		}
	})
}

// Streaming conversations mutate the DOM at high frequency; the scan itself
// walks every code block, so coalesce mutation bursts into one pass.
let scanTimer: ReturnType<typeof setTimeout> | null = null
function scheduleScan(): void {
	if (isInteractionLocked()) return
	if (scanTimer !== null) return
	scanTimer = setTimeout(() => {
		scanTimer = null
		if (isInteractionLocked()) return
		scan()
	}, 150)
}

function scan(): void {
	if (typeof document === 'undefined') return
	if (isInteractionLocked()) return
	cleanupTempElements()
	const blocks = document.querySelectorAll<HTMLElement>('.md-code-block')
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i]
		if (!block) continue
		const state = block.getAttribute('data-agy-mermaid')
		// Error blocks stay source-visible; they are retried only when React
		// genuinely rebuilds the block (which wipes the state attribute).
		if (state === 'done' || state === 'busy' || state === 'error' || state === 'fallback') continue
		const lang = fenceLang(block)
		const source = readSource(block)
		if (source === '') continue
		if (!isMermaidBlock(lang, source)) continue
		block.setAttribute('data-agy-mermaid', 'busy')
		void renderInto(block, source, lang)
	}
}

let activeObserver: MutationObserver | null = null
let domContentLoadedHandler: (() => void) | null = null
let unbindMermaidSettle: (() => void) | null = null

/**
 * Install the mermaid overlay. Returns a disposer that disconnects the
 * MutationObserver and cancels pending setup — wrap it in ctx.effect so a
 * plugin reload cannot stack observers over the same document.
 */
export function installMermaidRendering(): () => void {
	if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
	// A previous install (plugin reload) must not keep observing forever.
	disposeMermaidRendering()
	injectStyles()
	cleanupTempElements()
	const observer = new MutationObserver(() => {
		scheduleScan()
	})
	activeObserver = observer
	unbindMermaidSettle = onScrollSettle(() => {
		scheduleScan()
	})
	const setup = (): void => {
		if (document.body) {
			cleanupTempElements()
			observer.observe(document.body, { childList: true, subtree: true })
			scan()
		}
	}
	if (document.readyState === 'loading') {
		domContentLoadedHandler = setup
		window.addEventListener('DOMContentLoaded', setup, { once: true })
	} else {
		setup()
	}
	return disposeMermaidRendering
}

/** Disconnect the observer and cancel pending setup work. */
export function disposeMermaidRendering(): void {
	if (activeObserver !== null) {
		activeObserver.disconnect()
		activeObserver = null
	}
	if (unbindMermaidSettle !== null) {
		unbindMermaidSettle()
		unbindMermaidSettle = null
	}
	if (domContentLoadedHandler !== null) {
		window.removeEventListener('DOMContentLoaded', domContentLoadedHandler)
		domContentLoadedHandler = null
	}
	if (scanTimer !== null) {
		clearTimeout(scanTimer)
		scanTimer = null
	}
}

/** Test seam: classify a fence language the way the scanner does. */
export function isMermaidFence(lang: string): boolean {
	return isMermaidLang(lang.trim().toLowerCase())
}
