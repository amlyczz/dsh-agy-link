import { createHash } from 'node:crypto'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionBinding } from '../host/sessions.ts'
import { cloakPromptText } from './prompt-cloak.ts'
import { snapshotSource, textOf, utf8Bytes } from './prompt-text.ts'

export interface SystemWatermarks {
  nextSystemHash?: string
  nextSnapshotHashes?: Record<string, string>
  nextPrefixFilesExpireAt?: number
}

export function plannedWatermarks({ nextSystemHash, nextSnapshotHashes, nextPrefixFilesExpireAt }: SystemWatermarks): SystemWatermarks {
  return { nextSystemHash, nextSnapshotHashes, nextPrefixFilesExpireAt }
}

/** Interim and failed attempts can only retain receipts for the very same conversation. */
export function confirmedPrefix(binding: SessionBinding | undefined, conversationId: string) {
  if (binding?.conversationId !== conversationId) return {}
  const { sentSystemHash, sentSnapshotHashes, prefixFilesExpireAt } = binding
  return { sentSystemHash, sentSnapshotHashes, prefixFilesExpireAt }
}

export interface SystemDelta extends SystemWatermarks {
  system: string
  snapshots: string[]
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Only hashes of the latest snapshot per source are useful to the next turn. */
export function systemDelta(
  rawSystem: string | undefined, messages: readonly Message[], cloak: boolean,
  includeSnapshots: boolean, binding?: SessionBinding,
): SystemDelta {
  const fallback = rawSystem === undefined ? messages.findLast(m => m.role === 'system') : undefined
  const system = cloakPromptText(rawSystem ?? (fallback ? textOf(fallback) : ''), cloak)
  const nextSystemHash = hash(system)
  const latest = new Map<string, Message>()
  if (includeSnapshots) {
    for (const m of messages) {
      const key = snapshotSource(m)
      if (key) latest.set(key, m)
    }
  }
  const hashes: Array<[string, string]> = []
  const snapshots: string[] = []
  for (const [key, m] of latest) {
    const text = cloakPromptText(textOf(m), cloak)
    const digest = hash(text)
    hashes.push([key, digest])
    if (binding?.sentSnapshotHashes?.[key] !== digest) snapshots.push(text)
  }
  return {
    system: binding?.sentSystemHash === nextSystemHash ? '' : system,
    snapshots, nextSystemHash, nextSnapshotHashes: Object.fromEntries(hashes.slice(-32)),
  }
}

/** Reserve framing space for delimiters and an interruption notice added after planning. */
export function systemPrefixBudget(maxBytes: number, live: string, fixedBytes: number): number {
  return Math.max(0, maxBytes - utf8Bytes(live) - fixedBytes - 2_000)
}

export function systemPrefix(system: string, snapshots: string[]): string {
  return [
    system && 'System instructions:\n' + system,
    snapshots.length && 'Current DSH context (supersedes previous snapshots):\n' + snapshots.join('\n\n'),
  ].filter(Boolean).join('\n\n')
}

interface SdkBlock { text: string; index: string }

/** DSH emits a fenced SDK, with tool names on the first indentation level of
 * ToolArgsMap. Also accept standalone declarations from older assemblers. */
export function findSdkBlocks(system: string): SdkBlock[] {
  const blocks: SdkBlock[] = []
  const declaration = /^\s*(?:declare\s+(?:namespace\s+tools\b|const\s+tools\s*:)|interface\s+ToolArgsMap\b)/m
  const fence = /^(\x60{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*\r?$/
  const bare = /^declare\s+(?:namespace\s+tools\s*|const\s+tools\s*:\s*)\{(?:[^\n]*\};?[ \t]*\r?$|[^\n]*\n[\s\S]*?^\};?[ \t]*\r?$)/
  const catalog = /^#{1,6} (?:Available tools|Tool list|tools:sdk)[ \t]*\r?\n(?:[ \t]*\r?\n)*(?:(?:[-*] |[ \t]+)\S[^\n]*(?:\r?\n|$))+/
  const pattern = new RegExp([fence.source, bare.source, catalog.source].join('|'), 'gmi')
  for (const match of system.matchAll(pattern)) {
    const text = match[0]
    const list = text.startsWith('#')
    if (!list && !declaration.test(text)) continue
    const names = new Set<string>()
    const members = list ? /^[-*] \x60?([\w$.-]+)/gm
      : /^(?: {2}|\t)(?:(?:export )?(?:function|const) )?(?:"([^"\n]+)"|([\w$-]+))\s*[:(]/gm
    for (const m of text.matchAll(members)) {
      names.add((m[1] ?? m[2])!)
      if (names.size === 32) break
    }
    blocks.push({ text, index: [...names].join(', ').slice(0, 600) })
  }
  return blocks.sort((a, b) => utf8Bytes(b.text) - utf8Bytes(a.text))
}
