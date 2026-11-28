// Assistant text post-processing for the stream, in order: agy's internal
// noise, embedded agent references, local image references, file links.
//
// A pure pipeline over one option (the media base URL), split out of
// EventMapper so the mapper reads as event handling and this reads as text.
import { normalizeFileLinks, rewriteAgentEmbeds, rewriteImageMarkdown, stripAgyInternalNoise } from './text.ts'

export function formatAssistantText(text: string, mediaBaseUrl: string | undefined): string {
  const clean = stripAgyInternalNoise(text)
  const embedBase = mediaBaseUrl ? mediaBaseUrl.replace(/\/media\/?$/, '/embed') : undefined
  const withEmbeds = rewriteAgentEmbeds(clean, embedBase)
  const withImages = mediaBaseUrl ? rewriteImageMarkdown(withEmbeds, mediaBaseUrl) : withEmbeds
  return normalizeFileLinks(withImages)
}
