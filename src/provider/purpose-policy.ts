// What a purpose is allowed to do. Keeping this as data (instead of five
// booleans spread through streamAttempt) is what makes a new purpose a
// one-line addition rather than a five-site edit.
import type { CallContext, CallPurpose } from './call-context.ts'

export interface PurposePolicy {
  readonly aux: boolean
  /** Aux background helpers pin effort to 'low'; user-invoked routes do not. */
  readonly pinLowEffort: boolean
  /** Mirror agy tool steps as native DSH tool cards. */
  readonly mirrorTools: boolean
  persistBinding(isTranslateSession: boolean): boolean
}

const BACKGROUND: PurposePolicy = {
  aux: true,
  pinLowEffort: true,
  mirrorTools: false,
  persistBinding: () => false,
}

const CHAT: PurposePolicy = {
  aux: false,
  pinLowEffort: false,
  mirrorTools: true,
  persistBinding: () => true,
}

const TRANSLATION: PurposePolicy = {
  aux: true,
  pinLowEffort: false,
  mirrorTools: false,
  persistBinding: (hasSession) => hasSession,
}

const IMAGE: PurposePolicy = {
  aux: true,
  pinLowEffort: false,
  mirrorTools: false,
  persistBinding: () => false,
}

const BY_PURPOSE: Record<CallPurpose, PurposePolicy> = {
  chat: CHAT,
  compaction: BACKGROUND,
  'session-title': BACKGROUND,
  translation: TRANSLATION,
  image: IMAGE,
}

export function purposePolicy(ctx: Pick<CallContext, 'purpose' | 'isReview'>): PurposePolicy {
  // A review call is a host system-prompt probe, not a chat turn: it must not
  // mirror tools or persist a conversation binding.
  return ctx.isReview ? BACKGROUND : BY_PURPOSE[ctx.purpose]
}
