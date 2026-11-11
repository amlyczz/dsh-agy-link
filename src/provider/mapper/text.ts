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
