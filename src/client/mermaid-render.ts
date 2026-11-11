// Mermaid overlay renderer: fence detection helpers, source repair, the
// serialize-one-render chain, the render-into-mount pass, and the DOM scanner.
//
// Split out of mermaid.ts (behavior-preserving). Mermaid's render() is not
// reentrant, so every diagram goes through one chain; failed/streaming blocks
// are retried via source signatures.

import { isInteractionLocked } from './scroll-guard.ts'
import { isMermaidBlock, isMermaidLang } from './mermaid-config.ts'
import { loadMermaid } from './mermaid-loader.ts'

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

let renderSeq = 0

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
	// A streaming message can rewrite this block while the render was in flight.
	// The next pass compares signatures and re-renders the settled final text.
	scheduleScan()
}

// Streaming conversations mutate the DOM at high frequency; the scan itself
// walks every code block, so coalesce mutation bursts into one pass.
let scanTimer: ReturnType<typeof setTimeout> | null = null
export function scheduleScan(): void {
	if (isInteractionLocked()) return
	if (scanTimer !== null) return
	scanTimer = setTimeout(() => {
		scanTimer = null
		if (isInteractionLocked()) return
		scan()
	}, 150)
}

/**
 * Cheap content signature for a block's current source.
 *
 * Streaming rewrites the block in place (React keeps the same element and only
 * replaces the text), so the `data-agy-mermaid` state survives every chunk.
 * Without a signature, a block first scanned mid-stream parsed as incomplete
 * source, fell back to "not a diagram", and was never retried — the finished
 * diagram stayed a plain code block forever. The signature lets the scanner
 * notice that the source changed and try again.
 */
export function sourceSignature(source: string): string {
	let h = 5381
	for (let i = 0; i < source.length; i++) h = ((h << 5) + h + source.charCodeAt(i)) | 0
	return source.length + ':' + (h >>> 0).toString(36)
}

export type MermaidScanAction = 'skip' | 'wait' | 'render'

/**
 * Decide what the scanner should do with one block.
 *
 * - `skip`: already rendered this exact source, or a render is in flight.
 * - `wait`: the source changed since the last attempt; require one quiet pass
 *   so a streaming block is not rendered for every intermediate prefix.
 * - `render`: first attempt (no signature yet), or the source settled after a
 *   previous attempt.
 */
export function mermaidScanAction(
	state: string | null,
	renderedSig: string | null,
	pendingSig: string | null,
	sig: string,
): MermaidScanAction {
	if (state === 'busy') return 'skip'
	if (renderedSig === sig) return 'skip'
	// Never attempted: render immediately (non-streaming blocks keep zero delay).
	if (renderedSig === null) return 'render'
	return pendingSig === sig ? 'render' : 'wait'
}

export function scan(): void {
	if (typeof document === 'undefined') return
	if (isInteractionLocked()) return
	cleanupTempElements()
	const blocks = document.querySelectorAll<HTMLElement>('.md-code-block')
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i]
		if (!block) continue
		const lang = fenceLang(block)
		const source = readSource(block)
		if (source === '') continue
		if (!isMermaidBlock(lang, source)) continue
		const state = block.getAttribute('data-agy-mermaid')
		const sig = sourceSignature(source)
		const action = mermaidScanAction(
			state,
			block.getAttribute('data-agy-mermaid-sig'),
			block.getAttribute('data-agy-mermaid-pending'),
			sig,
		)
		if (action === 'skip') continue
		if (action === 'wait') {
			block.setAttribute('data-agy-mermaid-pending', sig)
			// Re-check shortly: the next quiet pass confirms the text settled.
			scheduleScan()
			continue
		}
		block.removeAttribute('data-agy-mermaid-pending')
		block.setAttribute('data-agy-mermaid-sig', sig)
		block.setAttribute('data-agy-mermaid', 'busy')
		void renderInto(block, source, lang)
	}
}

/** Cancel a pending coalesced scan (used by dispose). */
export function cancelScheduledScan(): void {
	if (scanTimer !== null) {
		clearTimeout(scanTimer)
		scanTimer = null
	}
}
