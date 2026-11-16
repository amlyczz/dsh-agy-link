/** Public structural attachment API: no dependency on a particular DSH preset. */
export interface ImageAttachmentRef {
  attachmentId: string
  mediaType?: string
  bytes?: number
  [key: string]: unknown
}
export interface McpAttachments {
  readImage(ref: ImageAttachmentRef, signal: AbortSignal): Promise<{ ref: ImageAttachmentRef; data: Uint8Array | string }>
}
export type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** Shared by all conversions on one bridge, including simultaneous tool calls. */
export function createImageLimiter(): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const queue: Array<() => void> = []
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= 2) await new Promise<void>((resolve) => queue.push(resolve))
    else active++
    try { return await fn() } finally {
      const next = queue.shift()
      if (next) next()
      else active--
    }
  }
}

export async function toMcpContent(
  result: unknown,
  attachments: McpAttachments | undefined,
  signal: AbortSignal,
  limit = createImageLimiter(),
): Promise<McpContent[]> {
  const content: McpContent[] = []
  let total = 0
  const append = (data: unknown, mime: unknown): void => {
    if (typeof mime !== 'string' || !new RegExp('^image/[a-z0-9.+-]+$', 'i').test(mime)) throw new Error('invalid image MIME type')
    if (typeof data !== 'string' && !(data instanceof Uint8Array)) throw new Error('invalid image data')
    if (typeof data === 'string' && (data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))) throw new Error('invalid or excessive base64 image')
    const bytes = typeof data === 'string' ? Buffer.byteLength(data, 'base64') : data.byteLength
    if (bytes <= 0 || bytes > MAX_IMAGE_BYTES || total + bytes > MAX_IMAGE_BYTES) throw new Error('image byte limit exceeded')
    total += bytes
    content.push({ type: 'image', data: typeof data === 'string' ? data : Buffer.from(data).toString('base64'), mimeType: mime })
  }
  const r = result as { content?: unknown; text?: unknown; output?: unknown } | null
  if (Array.isArray(r?.content)) for (const block of r.content) {
    signal.throwIfAborted()
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') { content.push({ type: 'text', text: b.text }); continue }
    if (b.type !== 'image') continue
    try {
      if (typeof b.data === 'string' || b.data instanceof Uint8Array) append(b.data, b.mimeType ?? b.mediaType)
      else {
        const ref = b.attachment as ImageAttachmentRef | undefined
        if (!ref || typeof ref.attachmentId !== 'string' || !attachments) throw new Error('image attachment service or reference unavailable')
        if (typeof ref.bytes === 'number' && (ref.bytes > MAX_IMAGE_BYTES || total + ref.bytes > MAX_IMAGE_BYTES)) throw new Error('image byte limit exceeded')
        const stored = await limit(async () => { signal.throwIfAborted(); return attachments.readImage(ref, signal) })
        signal.throwIfAborted()
        append(stored.data, stored.ref.mediaType ?? ref.mediaType)
      }
    } catch (error) {
      if (signal.aborted) throw error
      content.push({ type: 'text', text: '[image could not be converted: ' + String(error) + ']' })
    }
  }
  if (content.length) return content
  const text = typeof r?.text === 'string' ? r.text : typeof r?.output === 'string' ? r.output : JSON.stringify(result, null, 2) ?? ''
  return [{ type: 'text', text }]
}
