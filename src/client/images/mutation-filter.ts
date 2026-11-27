// Cheap DOM mutation pre-filter for the client image/link enhancer so
// unrelated UI ticks (timers, overlays, self-injected cards) never schedule a pass.

const IGNORED_ANCESTOR_SELECTOR =
  '.agy-image-card, .agy-image-link-chip, .agy-lightbox-backdrop, .agy-toast, .agy-modal-backdrop, script, style'

const TRACKED_MARKDOWN_SELECTOR = '[data-agy-alt-md], div[class*="_markdown_"], [data-markdown-variant]'

const RELEVANT_ELEMENT_SELECTOR =
  'a[href], img, span[class*="imageAlt"], span[class*="_imageAlt_"], div[class*="_markdown_"], [data-markdown-variant]'

function closestElement(node: Node | null | undefined): Element | null {
  if (!node) return null
  if (node.nodeType === 1) return node as Element
  return node.parentElement ?? null
}

/** Whether any DOM mutation in `mutations` could introduce or alter image/file/media targets. */
export function hasRelevantMutation(mutations: readonly MutationRecord[]): boolean {
  for (let i = 0; i < mutations.length; i++) {
    const m = mutations[i]
    if (!m) continue
    const targetEl = closestElement(m.target)
    if (targetEl?.closest?.(IGNORED_ANCESTOR_SELECTOR)) continue

    if (targetEl?.closest?.(TRACKED_MARKDOWN_SELECTOR)) {
      if (m.type === 'characterData' || m.addedNodes.length > 0 || m.removedNodes.length > 0) {
        return true
      }
    }

    for (let j = 0; j < m.addedNodes.length; j++) {
      const added = m.addedNodes[j]
      if (!added || added.nodeType !== 1) continue
      const el = added as Element
      if (el.closest?.(IGNORED_ANCESTOR_SELECTOR)) continue
      if (el.matches?.(RELEVANT_ELEMENT_SELECTOR) || el.querySelector?.(RELEVANT_ELEMENT_SELECTOR) !== null) {
        return true
      }
    }
  }
  return false
}
