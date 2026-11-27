// Decode what a bridged (or third-party MCP) tool actually hands back.
//
// agy forwards an MCP `CallToolResult` verbatim, so a reverse-bridged DSH tool
// arrives as `{"content":[{"type":"text","text":"…"}]}` — sometimes nested
// again as `{"content":[{"type":"content","content":{…}}]}`. The card used to
// print that envelope as the tool's answer, and every non-text block (images,
// resource links, diffs) was flattened to a placeholder. This module turns the
// envelope back into "what the tool said" plus inline images, so the card
// renderers can show the payload instead of the JSON that carries it.

/** One decoded tool result: human text, inline image sources, and provenance. */
export interface ToolPayload {
	/** The tool's answer with MCP envelopes stripped. */
	text: string
	/** `data:` URLs for image blocks, already size-capped. */
	images: readonly string[]
	/** True when the input text was a JSON envelope we actually unwrapped. */
	unwrapped: boolean
}

const MAX_DEPTH = 5
const MAX_IMAGES = 6
/** Base64 characters kept across all images (≈3 MB of encoded payload). */
const MAX_IMAGE_CHARS = 3_000_000
/** Envelopes are pretty-printed only while they stay readable inline. */
const MAX_PRETTY_CHARS = 20_000

interface Collector {
	texts: string[]
	images: string[]
	imageChars: number
}

function addImage(out: Collector, src: string): void {
	if (out.images.length >= MAX_IMAGES) return
	if (out.imageChars + src.length > MAX_IMAGE_CHARS) return
	out.images.push(src)
	out.imageChars += src.length
}

function dataUrl(data: unknown, mime: unknown): string | null {
	if (typeof data !== 'string' || data === '') return null
	const type = typeof mime === 'string' && mime !== '' ? mime : 'image/png'
	return data.startsWith('data:') ? data : `data:${type};base64,${data}`
}

/** ACP/MCP image blocks come as either `data`+`mimeType` or a plain URL. */
function imageSource(node: Record<string, unknown>): string | null {
	const direct = dataUrl(node.data ?? node.Data, node.mimeType ?? node.mime_type ?? node.MimeType)
	if (direct !== null) return direct
	const uri = node.uri ?? node.url ?? node.Uri ?? node.Url
	return typeof uri === 'string' && /^(data:|https?:\/\/)/.test(uri) ? uri : null
}

function collect(node: unknown, depth: number, out: Collector): void {
	if (depth > MAX_DEPTH || node === null || node === undefined) return
	if (Array.isArray(node)) {
		for (const item of node) collect(item, depth + 1, out)
		return
	}
	if (typeof node === 'string') {
		if (node !== '') out.texts.push(node)
		return
	}
	if (typeof node !== 'object') return
	const rec = node as Record<string, unknown>
	const type = typeof rec.type === 'string' ? rec.type : (typeof rec.Type === 'string' ? rec.Type : '')

	// Image-ish blocks first: they carry no text and must not print as JSON.
	if (type === 'image' || type === 'Image') {
		const src = imageSource(rec)
		if (src !== null) addImage(out, src)
		else out.texts.push('[image]')
		return
	}
	if (type === 'resource_link' || type === 'resource' || type === 'ResourceLink') {
		const name = rec.name ?? rec.Name ?? rec.title ?? rec.Title
		const uri = rec.uri ?? rec.Uri ?? rec.resource
		const label = typeof name === 'string' && name !== '' ? name : undefined
		const href = typeof uri === 'string' && uri !== '' ? uri : undefined
		if (label !== undefined || href !== undefined) out.texts.push(`[${label ?? 'resource'}] ${href ?? ''}`.trim())
		return
	}
	if (type === 'terminal' || type === 'terminal_output') {
		const exit = rec.exitCode ?? rec.exit_code
		if (typeof exit === 'number' && exit !== 0) out.texts.push(`[exit code ${exit}]`)
		const body = rec.output ?? rec.text ?? rec.content
		if (body !== undefined) collect(body, depth + 1, out)
		return
	}

	// Envelope shapes: MCP CallToolResult, nested ACP content, DSH batches.
	const content = rec.content ?? rec.Content
	if (content !== undefined && Array.isArray(content)) {
		collect(content, depth + 1, out)
		return
	}
	const results = rec.results ?? rec.Results
	if (Array.isArray(results)) {
		for (const entry of results) {
			const inner = (entry as { result?: unknown } | null)?.result
			collect(inner ?? entry, depth + 1, out)
		}
		return
	}
	// A single nested block: `{ content: { type: 'text', text: '…' } }`.
	if (content !== undefined && typeof content === 'object') {
		collect(content, depth + 1, out)
		return
	}
	if (type === 'text' || type === 'Text') {
		const text = rec.text ?? rec.Text
		if (typeof text === 'string' && text !== '') out.texts.push(text)
		return
	}
	// Anything else that still carries a `text` field is plainly text-like.
	const text = rec.text ?? rec.Text
	if (typeof text === 'string' && text !== '') {
		out.texts.push(text)
		return
	}
	// Opaque data: keep it visible, but pretty-printed rather than minified.
	out.texts.push(JSON.stringify(rec, null, 2))
}

/** Pretty-print a minified JSON document so JSON answers stop being one long line. */
function prettyJson(text: string): string | null {
	const trimmed = text.trim()
	if (!/^[[{]/.test(trimmed) || trimmed.length > MAX_PRETTY_CHARS) return null
	const newlines = trimmed.split('\n').length - 1
	try {
		const value = JSON.parse(trimmed) as unknown
		if (value === null || typeof value !== 'object') return null
		const pretty = JSON.stringify(value, null, 2)
		// Only when pretty-printing actually helps: one-liners and near-one-liners.
		if (newlines > 3 || pretty.length > MAX_PRETTY_CHARS) return null
		return pretty === trimmed ? null : pretty
	} catch {
		return null
	}
}

/**
 * Decode one tool result text into its payload.
 *
 * Plain text passes through untouched; a JSON envelope is unwrapped; a
 * minified JSON answer becomes readable JSON.
 */
export function unwrapToolPayload(text: string): ToolPayload {
	if (text === '') return { text, images: [], unwrapped: false }
	const trimmed = text.trim()
	if (!/^[[{]/.test(trimmed)) return { text, images: [], unwrapped: false }
	let value: unknown
	try {
		value = JSON.parse(trimmed) as unknown
	} catch {
		return { text, images: [], unwrapped: false }
	}
	const out: Collector = { texts: [], images: [], imageChars: 0 }
	collect(value, 0, out)
	const joined = out.texts.join('\n').trim()
	const envelope = value !== null && typeof value === 'object'
		&& (Array.isArray((value as { content?: unknown }).content) || Array.isArray((value as { results?: unknown }).results))
	if (joined === '' && out.images.length === 0) {
		// An empty result envelope means the tool said nothing — printing the
		// JSON that proves it is noise, and the card has its own empty state.
		if (envelope) return { text: '', images: [], unwrapped: true }
		const pretty = prettyJson(text)
		return { text: pretty ?? text, images: [], unwrapped: pretty !== null }
	}
	return { text: joined, images: out.images, unwrapped: true }
}
