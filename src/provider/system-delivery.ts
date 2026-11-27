import { dirname } from 'node:path'
import { defaultContextTransferDir } from './context-delivery.ts'
import { CONTEXT_FILE_TTL_MS, writeContextTransferFile } from './context-transfer-file.ts'
import { trimToUtf8Bytes, utf8Bytes } from './prompt-text.ts'
import { findSdkBlocks, systemPrefix, systemPrefixBudget, type SystemDelta } from './system-budget.ts'

/** Keep both ends on UTF-8 boundaries, including introductory and closing policy. */
function previewWithReference(text: string, pointer: string, room: number): string {
  const half = Math.floor(Math.max(0, room) / 2)
  if (!half) return pointer
  const tail = Buffer.from(text).subarray(-half)
  let start = 0
  while (start < tail.length && (tail[start]! & 0xc0) === 0x80) start++
  return trimToUtf8Bytes(text, half, false) + pointer + tail.toString('utf8', start)
}

export async function deliverSystemPrompt(
  delta: SystemDelta, live: string, routing: string, sessionKey: string, stagedDirs: string[], slashBytes: number,
  maxBytes: number, latestUserText?: string,
): Promise<{ prompt: string; expiresAt?: number }> {
  let expiresAt = delta.nextPrefixFilesExpireAt
  if (expiresAt && !stagedDirs.includes(defaultContextTransferDir())) stagedDirs.push(defaultContextTransferDir())
  async function archive(body: string): Promise<string> {
    expiresAt ??= Date.now() + CONTEXT_FILE_TTL_MS
    const path = await writeContextTransferFile(sessionKey, body)
    if (!path) throw new Error('Unable to stage the full prompt for agy. Retry after checking the context-transfer directory.')
    const dir = dirname(path)
    if (!stagedDirs.includes(dir)) stagedDirs.push(dir)
    return path
  }

  let { system, snapshots } = delta
  const fixedBytes = utf8Bytes(routing) + slashBytes
  const archiveLive = async () => 'Read and answer the complete current request in this file:\n' + await archive(live)
  if (utf8Bytes(live) + fixedBytes > maxBytes && latestUserText && latestUserText !== live && live.endsWith(latestUserText)) {
    const preceding = live.slice(0, -latestUserText.length)
    live = 'Earlier context for this request: ' + await archive(preceding) + '\n\n' + latestUserText
  }
  if (utf8Bytes(live) + fixedBytes > maxBytes) live = await archiveLive()
  const budget = systemPrefixBudget(maxBytes, live, fixedBytes)
  const size = () => utf8Bytes(systemPrefix(system, snapshots))
  if (size() > budget) {
    for (const block of findSdkBlocks(system)) {
      if (utf8Bytes(block.text) < 1024) break
      const path = await archive(block.text)
      const pointer = '[PTC SDK' + (block.index ? ' — ' + block.index : '') + '; read declarations at ' + path + ']'
      system = system.replace(block.text, () => pointer)
      if (size() <= budget) break
    }
  }
  if (size() > budget && snapshots.length) {
    snapshots = ['Read the full current snapshots at ' + await archive(snapshots.join('\n\n'))]
  }
  if (size() > budget && system) {
    // Keep short paragraphs (typically role policy and SDK pointers) in place
    // when a long static section on either side is what consumes the budget.
    const paragraphs = system.split(/(\n[ \t]*\r?\n)/)
    const large = paragraphs.map((text, index) => ({ text, index, bytes: utf8Bytes(text) }))
      .filter(p => p.bytes > 4096).sort((a, b) => b.bytes - a.bytes)
    for (const p of large.slice(0, 8)) {
      const pointer = '\n[Read the complete system instructions at ' + await archive(p.text) + ']\n'
      const available = Math.max(0, budget - size() + p.bytes - utf8Bytes(pointer))
      paragraphs[p.index] = previewWithReference(p.text, pointer, available)
      system = paragraphs.join('')
      if (size() <= budget) break
    }
    if (size() > budget) {
      const pointer = '\n[Read the complete system instructions at ' + await archive(system) + ']\n'
      system = previewWithReference(system, pointer, budget - utf8Bytes(systemPrefix(pointer, snapshots)))
    }
  }
  const compose = () => routing + [systemPrefix(system, snapshots), live].filter(Boolean).join('\n\n')
  if (utf8Bytes(compose()) + slashBytes > maxBytes) {
    // Even the minimal prefix and the verbatim user text cannot share a single message.
    live = await archiveLive()
  }
  const prompt = compose()
  if (utf8Bytes(prompt) + slashBytes > maxBytes) {
    throw new Error('agy prompt framing exceeds the single-message limit')
  }
  return { prompt, expiresAt }
}
