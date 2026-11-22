// Text streaming helpers: suffix-delta accumulation and local-image URL rewrite.

/** Suffix-delta: emit only what grew; fall back to a newline + full text. */
export function suffixDelta(prev: string, next: string): string {
  if (next === prev) return ''
  if (prev === '') return next
  if (next.startsWith(prev)) return next.slice(prev.length)
  return '\n' + next
}

/** Rewrite local image paths and file:// URLs to point to the local media route. */
export function rewriteImageMarkdown(text: string, mediaBaseUrl?: string): string {
  if (!mediaBaseUrl || !text) return text
  return text.replace(
    /!\[(.*?)\]\((file:\/\/\/[^\s)]+|file:\/\/[^\s)]+|[A-Za-z]:[\\/][^\s)]+|\/home\/[^\s)]+|\/mnt\/[a-zA-Z]\/[^\s)]+|\\\\wsl\.localhost\\[^\s)]+)\)/g,
    (_match, alt, target) => {
      const cleanTarget = target.trim()
      const mediaUrl = `${mediaBaseUrl}?path=${encodeURIComponent(cleanTarget)}`
      return `![${alt}](${mediaUrl})`
    },
  )
}

/** Rewrite `<agent-embed src="...">` tags into embed widget links that the DSH client upgrades to sandboxed iframes. */
export function rewriteAgentEmbeds(text: string, embedBaseUrl?: string): string {
  if (!text || !/<agent-embed\b/i.test(text)) return text
  const base = embedBaseUrl || '/plugins/agy-link/embed'
  return text.replace(
    /<agent-embed\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>(?:\s*<\/agent-embed>)?/gi,
    (_match, rawSrc: string) => {
      const cleanSrc = rawSrc.trim()
      if (cleanSrc === '') return ''
      const withoutScheme = cleanSrc.replace(/^file:\/+/i, '')
      const label = withoutScheme.split(/[/\\?#]/).filter(Boolean).pop() || 'widget.html'
      const embedUrl = `${base}?path=${encodeURIComponent(cleanSrc)}&agy_embed=1`
      return `\n\n[Widget: ${label}](${embedUrl})\n\n`
    },
  )
}

/**
 * Split a streaming text chunk so an incomplete `<agent-embed ...>` tag
 * straddling chunk boundaries is held back in `pending` until completed or
 * flushed at block end.
 */
export function splitPendingEmbedFragment(text: string): { ready: string; pending: string } {
  const lastLt = text.lastIndexOf('<')
  if (lastLt < 0) return { ready: text, pending: '' }
  const tail = text.slice(lastLt)
  const lower = tail.toLowerCase()
  const openTag = '<agent-embed'
  if (lower.length < openTag.length) {
    if (openTag.startsWith(lower)) {
      return { ready: text.slice(0, lastLt), pending: tail }
    }
    return { ready: text, pending: '' }
  }
  if (/^<agent-embed(?=[\s>\/]|$)/i.test(tail)) {
    const gt = tail.indexOf('>')
    if (gt < 0) {
      return { ready: text.slice(0, lastLt), pending: tail }
    }
    if (tail[gt - 1] === '/') {
      return { ready: text, pending: '' }
    }
    const afterGt = tail.slice(gt + 1)
    if (!/<\/agent-embed>/i.test(afterGt) && '</agent-embed>'.startsWith(afterGt.trim().toLowerCase())) {
      return { ready: text.slice(0, lastLt), pending: tail }
    }
  }
  return { ready: text, pending: '' }
}

/** Normalize Markdown file links: strip file:/// prefix so DSH's native markdown compiler treats them as local files and opens them in the native right sidebar. */
export function normalizeFileLinks(text: string): string {
  if (!text) return text
  return text.replace(
    /(^|[^\!])\[([^\]]+)\]\((file:\/\/\/[^\s)]+|file:\/\/[^\s)]+)\)/g,
    (_, prefix, label, url) => {
      let target = url.trim()
      if (target.startsWith('file://')) {
        target = target.slice(7)
        if (/^\/[A-Za-z]:/.test(target)) {
          target = target.slice(1)
        }
      }
      target = target.replace(/\\/g, '/')
      return `${prefix}[${label}](${target})`
    },
  )
}

/**
 * Strip leaked `agy` internal retry / output-token-limit auto-continuation
 * notices that occasionally bleed into assistant text streams:
 *  - `⚠ API error (attempt N)...` / `⚠️ API error (attempt N)...`
 *  - 3-line output-token-limit continuation preamble (`Your previous response
 *    was cut off because it exceeded the output token limit...` + continuation
 *    directive + `Retries remaining: N`)
 */
export function stripAgyInternalNoise(text: string): string {
  if (!text) return text
  let out = text
  // 1. Leaked `⚠ API error (attempt N)...` retry banners
  out = out.replace(/(?:^|\r?\n)[ \t]*⚠\uFE0F?[ \t]*API error \(attempt \d+\)[^\r\n]*(?=\r?\n|$)/gi, '')
  // 2. Output-token-limit auto-continuation 3-line block (or single-line variants)
  out = out.replace(
    /(?:^|\r?\n)[ \t]*Your previous response was cut off because it exceeded the output token limit[^\r\n]*(?:\r?\n[ \t]*(?:Please continue|Continue directly|Resume directly|Continue from where you left off)[^\r\n]*)?(?:\r?\n[ \t]*Retries remaining:[ \t]*\d+[^\r\n]*)?(?=\r?\n|$)/gi,
    '',
  )
  out = out.replace(/(?:^|\r?\n)[ \t]*Retries remaining:[ \t]*\d+[ \t]*(?=\r?\n|$)/gi, '')
  if (out !== text) {
    out = out.replace(/^\r?\n+/, '').replace(/\n{3,}/g, '\n\n')
  }
  return out
}
