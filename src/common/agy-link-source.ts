/**
 * Producer-owned source for dsh-agy-link's background wake notice.
 *
 * Session format v4 refuses the retired bare `kind: 'plugin'` + `plugin` pair —
 * the durable append throws `format v4 message requires a producer-owned source
 * kind` and the whole batch is dropped. A producer instead names itself with
 * its own kind, which `MessageSourceMap` exists to let plugins extend.
 */
import type { ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm/message'

declare module '@deepseek-ai/dsh-llm/message' {
  interface MessageSourceMap {
    'plugin:agy-link': { readonly kind: 'plugin:agy-link' } & ContextFormed
  }
}

/** Kind every dsh-agy-link background notice carries. */
export const AGY_LINK_NOTICE_KIND = 'plugin:agy-link'

/** A wake notice source: a one-off account, so it must record its summary. */
export type AgyLinkNoticeSource = Extract<MessageSource, { kind: 'plugin:agy-link', form: 'notice' }>

/**
 * Build the source for one wake notice.
 * @param summary - bounded one-line account shown on the collapsed row.
 * @returns the producer-owned source record.
 */
export function agyLinkNoticeSource(summary: string): AgyLinkNoticeSource {
  return { kind: AGY_LINK_NOTICE_KIND, form: 'notice', summary }
}

/**
 * True when a source record belongs to a dsh-agy-link wake notice.
 * @param source - untrusted source field of a message.
 * @returns whether this message is the plugin's own background wake.
 */
export function isAgyLinkNoticeSource(source: { kind?: unknown; form?: unknown } | undefined): boolean {
  return source?.kind === AGY_LINK_NOTICE_KIND && source?.form === 'notice'
}
