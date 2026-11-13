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
