// Parent conversation 429 retry-loop & Stop-hook deadlock detector.
// Tails `<brainDir>/.system_generated/logs/transcript_full.jsonl` (falling back
// to `transcript.jsonl` until the full log appears) and breaks infinite
// RESOURCE_EXHAUSTED retry loops (including `/goal` Stop-hook continuations).
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  extractQuotaErrorModel,
  isTransientBurstRateLimit,
  looksLikeHardRateLimit,
  looksLikeTosViolation,
  parseResetDurationMs,
} from '../../common/types.ts'

export interface SubagentQuotaExhaustedInfo {
  source: 'subagent-transcript' | 'parent-system-message' | 'tool-step' | 'parent-retry-loop'
  errorText: string
  model?: string
  resetMs?: number
  role?: string
  conversationId?: string
}

const GENERIC_RETRY_THRESHOLD = 3
const AUTHORITATIVE_RETRY_THRESHOLD = 2

interface LogCursor {
  path: string
  offset: number
  decoder: StringDecoder
  rest: string
}

function createLogCursor(path: string, offset = 0): LogCursor {
  return { path, offset, decoder: new StringDecoder('utf8'), rest: '' }
}

function resolveTranscriptPath(brainDir: string): { path: string; isFull: boolean } | null {
  const logsDir = join(brainDir, '.system_generated', 'logs')
  const full = join(logsDir, 'transcript_full.jsonl')
  if (existsSync(full)) return { path: full, isFull: true }
  const compact = join(logsDir, 'transcript.jsonl')
  if (existsSync(compact)) return { path: compact, isFull: false }
  return null
}

function fileSizeOrZero(filePath: string): number {
  try {
    const st = statSync(filePath)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  }
}

function readLogDelta(cursor: LogCursor): string[] {
  let size: number
  try {
    const st = statSync(cursor.path)
    if (!st.isFile()) return []
    size = st.size
  } catch {
    return []
  }
  if (size < cursor.offset) {
    cursor.offset = 0
    cursor.decoder = new StringDecoder('utf8')
    cursor.rest = ''
  }
  if (size === cursor.offset) return []

  const length = size - cursor.offset
  const buffer = Buffer.allocUnsafe(length)
  let bytesRead = 0
  try {
    const fd = openSync(cursor.path, 'r')
    try {
      bytesRead = readSync(fd, buffer, 0, length, cursor.offset)
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
  if (bytesRead <= 0) return []
  cursor.offset += bytesRead

  const chunk = cursor.rest + cursor.decoder.write(buffer.subarray(0, bytesRead))
  const parts = chunk.split('\n')
  cursor.rest = parts.pop() ?? ''
  return parts.filter((line) => line.trim() !== '')
}

function isAuthoritativeParentQuota(text: string): boolean {
  if (/\bQUOTA_EXHAUSTED\b|individual quota reached/i.test(text)) return true
  const resetMs = parseResetDurationMs(text)
  return resetMs !== undefined && resetMs > 30_000
}

export class ParentQuotaMonitor {
  private cursor: LogCursor | null = null
  private usingFull = false
  private lastStepIndex = -1
  private hardQuotaStreak = 0
  private lastHardQuotaError = ''
  private fired = false

  reset(): void {
    this.cursor = null
    this.usingFull = false
    this.lastStepIndex = -1
    this.hardQuotaStreak = 0
    this.lastHardQuotaError = ''
    this.fired = false
  }

  baseline(brainDir: string): void {
    const resolved = resolveTranscriptPath(brainDir)
    if (!resolved) {
      this.cursor = null
      this.usingFull = false
      return
    }
    this.usingFull = resolved.isFull
    this.cursor = createLogCursor(resolved.path, fileSizeOrZero(resolved.path))
    this.hardQuotaStreak = 0
    this.lastHardQuotaError = ''
    this.fired = false
  }

  poll(brainDir: string, onHit: (info: SubagentQuotaExhaustedInfo) => void): void {
    const resolved = resolveTranscriptPath(brainDir)
    if (!resolved) return
    if (!this.cursor || (resolved.isFull && !this.usingFull) || this.cursor.path !== resolved.path) {
      this.usingFull = resolved.isFull
      this.cursor = createLogCursor(resolved.path, 0)
    }
    for (const line of readLogDelta(this.cursor)) {
      let row: {
        step_index?: unknown
        source?: unknown
        type?: unknown
        status?: unknown
        error?: unknown
        content?: unknown
      }
      try {
        row = JSON.parse(line) as typeof row
      } catch {
        continue
      }
      if (typeof row.step_index === 'number') {
        if (row.step_index <= this.lastStepIndex) continue
        this.lastStepIndex = row.step_index
      }
      this.inspectRow(row, onHit)
    }
  }

  private inspectRow(
    row: { source?: unknown; type?: unknown; status?: unknown; error?: unknown; content?: unknown },
    onHit: (info: SubagentQuotaExhaustedInfo) => void,
  ): void {
    if (row.source === 'SYSTEM' && row.type === 'ERROR_MESSAGE') {
      const errText = (
        typeof row.error === 'string' && row.error !== ''
          ? row.error
          : typeof row.content === 'string'
            ? row.content
            : ''
      ).trim()
      if (errText === '') return
      if (!looksLikeHardRateLimit(errText) || isTransientBurstRateLimit(errText) || looksLikeTosViolation(errText)) {
        return
      }
      this.hardQuotaStreak += 1
      this.lastHardQuotaError = errText
      const threshold = isAuthoritativeParentQuota(errText) ? AUTHORITATIVE_RETRY_THRESHOLD : GENERIC_RETRY_THRESHOLD
      if (!this.fired && this.hardQuotaStreak >= threshold) {
        this.emitHit(errText, onHit)
      }
      return
    }

    if (
      row.source === 'SYSTEM' &&
      row.type === 'SYSTEM_MESSAGE' &&
      typeof row.content === 'string' &&
      /Stop hook blocked termination/i.test(row.content)
    ) {
      if (!this.fired && this.hardQuotaStreak > 0 && this.lastHardQuotaError !== '') {
        this.emitHit(this.lastHardQuotaError, onHit)
      }
      return
    }

    const status = typeof row.status === 'string' ? row.status.trim().toUpperCase() : ''
    const isFailed = status === 'ERROR' || status === 'FAILED' || status === 'CANCELED' || status === 'CANCELLED'
    if ((row.type === 'PLANNER_RESPONSE' && !isFailed) || (row.type === 'GENERIC' && status === 'DONE')) {
      this.hardQuotaStreak = 0
      this.lastHardQuotaError = ''
      this.fired = false
    }
  }

  private emitHit(errorText: string, onHit: (info: SubagentQuotaExhaustedInfo) => void): void {
    this.fired = true
    const model = extractQuotaErrorModel(errorText)
    const resetMs = parseResetDurationMs(errorText)
    onHit({
      source: 'parent-retry-loop',
      errorText,
      ...(model ? { model } : {}),
      ...(resetMs !== undefined ? { resetMs } : {}),
    })
  }
}
