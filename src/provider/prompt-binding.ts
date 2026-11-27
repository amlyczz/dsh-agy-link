// Session-binding resolution for one prompt plan: WHICH agy conversation this
// hop continues, and when that binding is dropped (model switch, compaction).
//
// Split out of prompt.ts: a binding's lifecycle is a responsibility of its own,
// separate from assembling prompt text, and prompt.ts sits at the 600-line
// budget. The dependency points one way only — prompt.ts imports this module —
// so the plan's dependency contract (`PromptPlanDeps`) lives here as well and
// is re-exported from prompt.ts for its existing importers.
import type { Message } from '@deepseek-ai/dsh-llm'
import type { CompactionNotice } from '../common/compaction.ts'
import type { ManagedAccount } from '../common/pool-types.ts'
import type { PluginConfig } from '../common/types.ts'
import type { SessionBinding, SessionStore } from '../host/sessions.ts'
import type { ImageRefLike } from '../host/media.ts'
import { resolveModelSlug } from '../host/models.ts'
import type { CallContext } from './call-context.ts'
import type { DeliverContextOptions } from './context-delivery.ts'
import { textOf } from './prompt-text.ts'
import { clearStaleFamilyModelBindings } from './stale-model-bindings.ts'

/** Projection of a live AgyAdapter run needed for binding adoption. */
export interface ActiveRunView {
  isSettled: boolean
  conversationId: string | null
  accountHome?: string
}

export interface PromptPlanDeps {
  store: SessionStore
  /** Reads image bytes from DSH attachment storage (multimodal staging). */
  readImage?: (ref: ImageRefLike) => Promise<Uint8Array | null>
  /** Look up the live run owning a session (for conversation adoption). */
  getActiveRun: (sessionKey: string) => ActiveRunView | undefined
  /** Per-session "recently compacted" timestamps (mutated in place). */
  recentlyCompactedSessions: Map<string, number>
  /** Delivers a history digest: inline when small, tail-inline + archive file when large. */
  deliverContext: (
    digest: string,
    sessionKey: string,
    extraAddDirs: string[],
    opts?: DeliverContextOptions,
  ) => Promise<string>
}

/** What `resolvePromptBinding` hands back to prompt assembly. */
export interface ResolvedPromptBinding {
  binding: SessionBinding | undefined
  compactionNotice: CompactionNotice | undefined
}

export interface ResolveBindingInput {
  cfg: PluginConfig
  ctx: CallContext
  account: ManagedAccount | undefined
  activeModel: string
  currentModel: string
  persistBinding: boolean
  bindingKey: string
  sessionAccountKey: string
  messages: readonly Message[]
  lastAssistantIdx: number
  deps: PromptPlanDeps
}

/**
 * Look up (or adopt) the agy conversation binding for this session, then apply
 * model-switch and compaction invalidation. Returns the binding to use for
 * prompt assembly plus any compaction notice to surface downstream.
 */
export function resolvePromptBinding(input: ResolveBindingInput): ResolvedPromptBinding {
  const { cfg, ctx, account, activeModel, currentModel, persistBinding, bindingKey, sessionAccountKey, messages, lastAssistantIdx, deps } = input
  const { sessionKey, isAux } = ctx

  let binding = sessionAccountKey !== '' ? deps.store.get(sessionAccountKey) : undefined
  if (binding === undefined && bindingKey !== '') {
    binding = deps.store.get(bindingKey)
    if (binding === undefined && account === undefined) {
      for (const [k, b] of Object.entries(deps.store.all())) {
        if (k.startsWith(`${bindingKey}:`)) {
          binding = b
          break
        }
      }
    }
  }

  // If a live run already owns this session and has named an agy conversation,
  // adopt it before prompt assembly. A tool-cut or caller abort used to drop
  // that id entirely, so the next hop started a brand new conversation with a
  // digest-only prompt (issue #35). The live run must belong to the SAME
  // account: a conversation id from account A's isolated HOME does not exist
  // under account B, and adopting it there produced "conversation not found".
  if (binding === undefined && !isAux && sessionKey !== '') {
    const live = deps.getActiveRun(sessionKey)
    const liveCid = live !== undefined && !live.isSettled && (live.accountHome ?? '') === (account?.dir ?? '')
      ? live.conversationId
      : null
    if (liveCid) {
      binding = {
        conversationId: liveCid,
        lastMessageCount: Math.max(0, lastAssistantIdx + 1),
        updatedAt: Date.now(),
        model: activeModel === '' ? cfg.defaultModel : activeModel,
      }
    }
  }

  // Model switch detection: drop stale agy conversation binding only when the
  // normalized underlying model slug actually changed (avoids busting Google
  // prompt cache on effort-only or alias-only variations).
  if (
    persistBinding &&
    binding !== undefined &&
    binding.model &&
    resolveModelSlug(binding.model) !== resolveModelSlug(currentModel)
  ) {
    if (sessionAccountKey !== '') deps.store.delete(sessionAccountKey)
    clearStaleFamilyModelBindings(deps.store, bindingKey, currentModel, account)
    binding = undefined
  }

  // Compaction detection (ADR-013): If DSH compacted history or cleared earlier
  // turns, messages.length drops significantly below the recorded watermark.
  // Invalidate the stale agy conversation binding so a clean agy session is
  // started and seeded with the compacted summary. Minor fluctuations (e.g.
  // 1-2 messages removed by telemetry filtering) should NOT invalidate the
  // binding, but simply update the watermark.
  const lastCompactedAt = sessionKey ? deps.recentlyCompactedSessions.get(sessionKey) : undefined
  const now = Date.now()
  const isCompacted = binding !== undefined && (!lastCompactedAt || now - lastCompactedAt > 60_000) && (
    (messages.length <= 4 && binding.lastMessageCount >= 5) ||
    (binding.lastMessageCount > 10 && messages.length < Math.floor(binding.lastMessageCount * 0.8)) ||
    (binding.lastMessageCount <= 10 && messages.length < binding.lastMessageCount - 2)
  )
  let compactionNotice: CompactionNotice | undefined = undefined
  if (persistBinding && binding !== undefined && isCompacted) {
    const beforeTokens = typeof binding.lastInputTokens === 'number' && binding.lastInputTokens > 0
      ? binding.lastInputTokens
      : Math.round(binding.lastMessageCount * 750)
    const items = Math.max(1, binding.lastMessageCount - messages.length)
    let extractedSummary: string | undefined = undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (!msg) continue
      const txt = textOf(msg)
      const m = /<compacted-summary>([\s\S]*?)<\/compacted-summary>/i.exec(txt)
      if (m && m[1]) {
        extractedSummary = m[1].trim()
        break
      }
    }
    compactionNotice = {
      beforeTokens,
      afterTokens: 0,
      items,
      ...(extractedSummary ? { summary: extractedSummary } : {}),
    }
    if (sessionKey) {
      deps.recentlyCompactedSessions.set(sessionKey, now)
      if (deps.recentlyCompactedSessions.size > 200) {
        for (const [k, t] of deps.recentlyCompactedSessions) {
          if (now - t > 120_000) deps.recentlyCompactedSessions.delete(k)
        }
      }
      for (const k of Object.keys(deps.store.all())) {
        if (k === sessionKey || k.startsWith(sessionKey + ':')) {
          deps.store.delete(k)
        }
      }
    } else if (sessionAccountKey !== '') {
      deps.store.delete(sessionAccountKey)
    }
    binding = undefined
  } else if (binding !== undefined && messages.length < binding.lastMessageCount) {
    binding.lastMessageCount = messages.length
    if (sessionAccountKey !== '') deps.store.set(sessionAccountKey, binding)
  }

  return { binding, compactionNotice }
}
