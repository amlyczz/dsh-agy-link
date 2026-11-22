// Incremental tailer for `<brainDir>/.system_generated/logs/transcript.jsonl`
// in ACP mode (issue #158). `agy acp` sends `usage_update` with only
// `{ used, size }` (no cachedReadTokens / outputTokens), whereas `agy` writes
// exact per-step `PLANNER_RESPONSE` usage to `transcript.jsonl` as each step
// finishes. Tailing from the pre-turn byte offset keeps mid-turn tool cuts
// and cache-hit meters accurate without ever replaying older turns.
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RawUsage } from '../../common/types.ts'

export interface TranscriptUsageSample {
  stepKey: string
  usage: RawUsage
}

function resolveTranscriptPath(conversationId: string, accountHome?: string): string {
  const baseHome = accountHome && accountHome.trim() !== '' ? accountHome : homedir()
  return join(baseHome, '.gemini', 'antigravity-cli', 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl')
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function extractUsageFromRecord(rec: Record<string, unknown>): RawUsage | null {
  const raw =
    (rec.usage && typeof rec.usage === 'object' ? (rec.usage as Record<string, unknown>) : null) ??
    (rec.token_usage && typeof rec.token_usage === 'object' ? (rec.token_usage as Record<string, unknown>) : null) ??
    (rec.metadata && typeof rec.metadata === 'object' && (rec.metadata as Record<string, unknown>).usage && typeof (rec.metadata as Record<string, unknown>).usage === 'object'
      ? ((rec.metadata as Record<string, unknown>).usage as Record<string, unknown>)
      : null)
  if (!raw) return null
  const input = num(raw.input_tokens) ?? num(raw.inputTokens) ?? num(raw.prompt_tokens)
  const output = num(raw.output_tokens) ?? num(raw.outputTokens) ?? num(raw.completion_tokens)
  const cacheRead = num(raw.cache_read_tokens) ?? num(raw.cachedReadTokens) ?? num(raw.cached_content_token_count)
  const cacheWrite = num(raw.cache_write_tokens) ?? num(raw.cachedWriteTokens)
  const thinking = num(raw.thinking_tokens) ?? num(raw.thoughtTokens) ?? num(raw.thoughts_token_count)
  const total = num(raw.total_tokens) ?? num(raw.totalTokens)
  if (input === undefined && output === undefined && cacheRead === undefined && thinking === undefined) {
    return null
  }
  const out: RawUsage = {}
  if (input !== undefined) out.input_tokens = input
  if (output !== undefined) out.output_tokens = output
  if (cacheRead !== undefined) out.cache_read_tokens = cacheRead
  if (cacheWrite !== undefined) out.cache_write_tokens = cacheWrite
  if (thinking !== undefined) out.thinking_tokens = thinking
  if (total !== undefined) out.total_tokens = total
  return out
}

export class AcpTranscriptUsageTailer {
  private readonly filePath: string
  private offset = 0
  private remainder: Buffer = Buffer.alloc(0)
  private readonly seenSteps = new Set<string>()

  constructor(conversationId: string, accountHome?: string, explicitPath?: string) {
    this.filePath = explicitPath ?? resolveTranscriptPath(conversationId, accountHome)
    this.offset = this.initialOffset()
  }

  private initialOffset(): number {
    try {
      if (!existsSync(this.filePath)) return 0
      return statSync(this.filePath).size
    } catch {
      return 0
    }
  }

  /**
   * Read newly appended complete JSONL lines using Buffer newline splitting
   * (so multi-byte UTF-8 characters are never torn across reads) and return
   * any unseen `PLANNER_RESPONSE` (`DONE`) usage samples.
   */
  poll(): TranscriptUsageSample[] {
    let size = 0
    try {
      if (!existsSync(this.filePath)) return []
      size = statSync(this.filePath).size
    } catch {
      return []
    }
    if (size < this.offset) {
      // File truncated/recreated
      this.offset = 0
      this.remainder = Buffer.alloc(0)
    }
    if (size === this.offset) return []

    const toRead = Math.min(size - this.offset, 4 * 1024 * 1024)
    const buf = Buffer.allocUnsafe(toRead)
    let bytesRead = 0
    let fd: number | null = null
    try {
      fd = openSync(this.filePath, 'r')
      bytesRead = readSync(fd, buf, 0, toRead, this.offset)
    } catch {
      return []
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          // ignore
        }
      }
    }
    if (bytesRead <= 0) return []
    this.offset += bytesRead

    const combined = this.remainder.length > 0
      ? Buffer.concat([this.remainder, buf.subarray(0, bytesRead)])
      : buf.subarray(0, bytesRead)

    const samples: TranscriptUsageSample[] = []
    let lineStart = 0
    for (let i = 0; i < combined.length; i++) {
      if (combined[i] !== 0x0a) continue
      const line = combined.subarray(lineStart, i).toString('utf8').trim()
      lineStart = i + 1
      if (line === '') continue
      const sample = this.parseLine(line)
      if (sample !== null) samples.push(sample)
    }
    this.remainder = lineStart < combined.length ? Buffer.from(combined.subarray(lineStart)) : Buffer.alloc(0)
    return samples
  }

  private parseLine(line: string): TranscriptUsageSample | null {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const rec = parsed as Record<string, unknown>
    const type = typeof rec.type === 'string' ? rec.type.toUpperCase() : ''
    if (type !== 'PLANNER_RESPONSE') return null
    const status = typeof rec.status === 'string' ? rec.status.toUpperCase() : ''
    if (status !== '' && status !== 'DONE' && status !== 'COMPLETED') return null
    const usage = extractUsageFromRecord(rec)
    if (!usage) return null
    const rawIdx = rec.step_index ?? rec.stepIndex
    const stepKey = rawIdx !== undefined && rawIdx !== null ? `transcript-${String(rawIdx)}` : `transcript-${this.offset}-${this.seenSteps.size}`
    if (this.seenSteps.has(stepKey)) return null
    this.seenSteps.add(stepKey)
    return { stepKey, usage }
  }
}
