// Thinking/thought mapping: the agy token banner and the banner+prose line
// composition that lets DSH's collapsed summary render
//   [agy · *** tokens] [Chain-of-Thought body]
export function thinkingBanner(thoughtTokens: number): string {
  return thoughtTokens > 0
    ? '[agy · ' + thoughtTokens + ' tokens]'
    : '[agy]'
}

/**
 * Compose the reasoning text for one thinking step.
 *
 * When real thought prose is present it shares the banner's initial line so the
 * collapsed summary renders it. A step whose banner-only chip already streamed
 * (desktop hosts with no sqlite reader, issue #43) appends the later prose
 * WITHOUT the banner, so the banner is never printed twice.
 */
export function composeThinkingText(
  thoughtTokens: number,
  text: string | undefined,
  bannerAlreadyShown: boolean,
): string {
  const banner = thinkingBanner(thoughtTokens)
  const hasText = text !== undefined && text.trim() !== ''
  if (!hasText) return `${banner}\n`
  return bannerAlreadyShown
    ? `${text!.trim()}\n`
    : `${banner} ${text!.trim()}\n`
}
