// Chronological staging of historical multimodal attachments for context digests.
//
// When a session switches accounts (`first`) or catches up after foreign turns
// (`foreign`), historical attachments belong inside the digest at their real
// chronological user turn (staged on disk + objective path note) rather than
// being ripped out of history and presented as brand-new current-turn inline
// images. Current-turn attachments (`trailingUser`) still travel live as usual.
import type { Message } from '@deepseek-ai/dsh-llm'
import { stateDir } from '../common/config.ts'
import type { PluginConfig } from '../common/types.ts'
import { defaultMediaDir, stageMedia, type ImageRefLike, type MediaRefLike } from '../host/media.ts'
import type { SessionBinding } from '../host/sessions.ts'
import { collectMediaRefs, collectUnsentMediaRefs, isToolResultMessage } from './prompt-text.ts'

export interface StageHistoricalMediaInput {
  cfg: PluginConfig
  sessionKey: string
  messages: readonly Message[]
  alreadySentIds: readonly string[]
  readImage?: (ref: ImageRefLike) => Promise<Uint8Array | null>
}

export interface StageHistoricalMediaResult {
  attachmentsByMessage: Map<Message, string[]>
  stagedDir: string | null
  stagedIds: string[]
}

/**
 * Stage unseen user attachments belonging to historical digest messages and
 * return per-message path annotations so `buildDigest` places them in-place.
 */
export async function stageHistoricalAttachments(
  input: StageHistoricalMediaInput,
): Promise<StageHistoricalMediaResult> {
  const { cfg, sessionKey, messages, alreadySentIds, readImage } = input
  const sent = new Set(alreadySentIds)
  const seen = new Set<string>()
  const historicalImages = new Set<string>()
  const refs: MediaRefLike[] = []
  const ownerById = new Map<string, Message[]>()

  for (const m of messages) {
    if (m === undefined || m.role !== 'user' || isToolResultMessage(m)) continue
    const msgRefs: MediaRefLike[] = []
    collectMediaRefs(m, msgRefs)
    for (const r of msgRefs) {
      const id = r.attachmentId
      if (typeof id !== 'string' || id === '' || sent.has(id)) continue
      if (r.mediaType.startsWith('image/')) {
        historicalImages.add(id)
        continue
      }
      const owners = ownerById.get(id)
      if (owners === undefined) ownerById.set(id, [m])
      else if (!owners.includes(m)) owners.push(m)
      if (!seen.has(id)) {
        seen.add(id)
        refs.push(r)
      }
    }
  }

  const attachmentsByMessage = new Map<Message, string[]>()
  if (refs.length === 0) return { attachmentsByMessage, stagedDir: null, stagedIds: [...historicalImages] }
  if (!readImage && refs.every((r) => r.data === undefined && r.path === undefined)) {
    return { attachmentsByMessage, stagedDir: null, stagedIds: [...historicalImages] }
  }

  const dir = cfg.mediaDir !== '' ? cfg.mediaDir : defaultMediaDir(stateDir())
  const key = sessionKey !== '' ? sessionKey.replace(/[^a-zA-Z0-9_-]+/g, '_') : 'anon'
  const res = await stageMedia({
    dir,
    key,
    items: refs,
    ...(readImage ? { readMedia: (ref) => readImage(ref as ImageRefLike) } : {}),
    maxItems: cfg.mediaMaxImages,
    maxImageBytes: cfg.mediaMaxBytes,
    maxFileBytes: cfg.mediaMaxFileBytes,
  })

  for (const item of res.staged) {
    const kind = item.kind ?? 'image'
    const line = `[earlier ${kind} attachment: "${item.name}" (${item.mediaType ?? kind}, ${item.bytes} bytes) — staged at ${item.path}. Inspect with read_file if needed.]`
    for (const owner of ownerById.get(item.attachmentId) ?? []) {
      const list = attachmentsByMessage.get(owner)
      if (list === undefined) attachmentsByMessage.set(owner, [line])
      else list.push(line)
    }
  }

  return {
    attachmentsByMessage,
    stagedDir: res.staged.length > 0 ? dir : null,
    stagedIds: [...historicalImages, ...res.stagedIds],
  }
}

export interface StageLiveMediaInput {
  cfg: PluginConfig
  sessionKey: string
  messages: readonly Message[]
  trailingUser: readonly Message[]
  lastAssistantIdx: number
  binding: SessionBinding | undefined
  coveredHistory: boolean
  extraSentIds: readonly string[]
  prompt: string
  readImage?: (ref: ImageRefLike) => Promise<Uint8Array | null>
}

export interface StageLiveMediaResult {
  prompt: string
  stagedDir: string | null
  stagedIds: string[]
  stagedImages: Array<{ path: string; mediaType: string }>
}

/**
 * Stage unseen current-turn attachments to disk and append their references to
 * the live prompt (plus inline image paths for ACP). When a `first` or `foreign`
 * digest already placed historical attachments in-place in the timeline, scan
 * only the live trailing span (`lastAssistantIdx + 1` onward) so earlier images
 * are not re-presented as brand-new current-turn attachments.
 */
export async function stageLivePromptMedia(input: StageLiveMediaInput): Promise<StageLiveMediaResult> {
  const { cfg, sessionKey, messages, trailingUser, lastAssistantIdx, binding, extraSentIds, readImage } = input
  let prompt = input.prompt
  const sentIds = extraSentIds.length > 0
    ? [...(binding?.sentImageIds ?? []), ...extraSentIds]
    : (binding?.sentImageIds ?? [])
  const fromIdx = Math.max(binding?.lastMessageCount ?? 0, lastAssistantIdx + 1)
  const mediaRefs = collectUnsentMediaRefs(messages, trailingUser, fromIdx, sentIds)
  if (mediaRefs.length === 0) return { prompt, stagedDir: null, stagedIds: [], stagedImages: [] }
  if (!readImage && mediaRefs.every((r) => r.data === undefined && r.path === undefined)) {
    return { prompt, stagedDir: null, stagedIds: [], stagedImages: [] }
  }

  const dir = cfg.mediaDir !== '' ? cfg.mediaDir : defaultMediaDir(stateDir())
  const key = sessionKey !== '' ? sessionKey.replace(/[^a-zA-Z0-9_-]+/g, '_') : 'anon'
  const res = await stageMedia({
    dir,
    key,
    items: mediaRefs,
    ...(readImage ? { readMedia: (ref) => readImage(ref as ImageRefLike) } : {}),
    maxItems: cfg.mediaMaxImages,
    maxImageBytes: cfg.mediaMaxBytes,
    maxFileBytes: cfg.mediaMaxFileBytes,
  })
  if (res.promptSuffix !== '') {
    const hasNonImage = res.staged.some((s) => s.kind !== undefined && s.kind !== 'image')
    const onlyAttachmentsHint = hasNonImage
      ? '[Please inspect the attached file(s) using view_file / read_file and assist the user.]'
      : '[Please inspect the attached image(s) using view_file and assist the user.]'
    prompt = prompt === '' ? (res.promptSuffix + '\n\n' + onlyAttachmentsHint) : (prompt + '\n\n' + res.promptSuffix)
  }
  return {
    prompt,
    stagedDir: res.staged.length > 0 ? dir : null,
    stagedIds: res.stagedIds,
    stagedImages: res.staged
      .filter((s) => (s.kind ?? 'image') === 'image')
      .map((s) => ({ path: s.path, mediaType: s.mediaType ?? 'image/png' })),
  }
}
