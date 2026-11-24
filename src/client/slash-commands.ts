// Client-side `conversation.chat.commandview` handler for `a`-prefix commands
// that dispatch directly into the conversation: suppress empty noise cards
// when a turn was queued, while keeping actionable status text & errors visible.
import { DIRECT_AGY_SLASH_COMMANDS } from '../common/agy-slash-list.ts'
import { translateOr } from './i18n-bridge.ts'
import { h } from './react.ts'
import type { ClientContextLike } from './translate-context.ts'

export function AgySlashCommandRow(props?: {
  node?: { outcome?: { kind?: string; text?: string } | null }
}): unknown {
  const outcome = props?.node?.outcome
  if (outcome?.kind === 'error') {
    const text = typeof outcome.text === 'string' && outcome.text !== ''
      ? outcome.text
      : translateOr('common.error', 'Command failed')
    return h('div', { className: 'agy-btw-error', role: 'alert' }, text)
  }
  if (typeof outcome?.text === 'string' && outcome.text.trim() !== '') {
    return h('div', {
      className: 'agy-slash-result',
      style: { whiteSpace: 'pre-wrap', fontSize: '13px', lineHeight: 1.5 },
    }, outcome.text)
  }
  return null
}

export function installAgySlashUi(ctx: ClientContextLike, localeNs: string): () => void {
  const disposers: Array<() => void> = []
  for (const key of DIRECT_AGY_SLASH_COMMANDS) {
    try {
      const off = ctx.slots.inject('conversation.chat.commandview', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.commandview',
            key,
            locale: localeNs,
          },
          AgySlashCommandRow as never,
        ),
      )
      if (typeof off === 'function') disposers.push(off)
    } catch {
      // contained
    }
  }
  return () => {
    for (const off of disposers) {
      try { off() } catch { /* ignore */ }
    }
  }
}
