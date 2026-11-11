// Span driving — map one RunRecording span onto StreamChunks.
//
// A "span" is one DSH model call: it consumes a recording's events from a
// message-derived cursor and stops at the next cut point (a completed tool
// step), emitting native tool-call blocks + reasoning deltas. Extracted from
// AgyAdapter so the recording→chunk mapping can be tested and reasoned about
// without the spawn/parse/finalize machinery. Behavior is byte-for-byte the
// same as the former private methods on the adapter.
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { Err, type AgyEvent } from '../common/types.ts'
import type { CompactionNotice } from '../common/compaction.ts'
import type { RunRecording, RunRegistry } from '../host/recording.ts'
import { EventMapper } from '../host/mapper.ts'
import { readFullToolArgs, readStepThoughts } from '../host/agy-db.ts'
import { getGitHeadContent, unwrapMcpTool } from '../host/mirror-tool.ts'
import type { GoalContext } from '../host/dsh-goal.ts'

/** What the span driver needs from the adapter (nothing more). */
export interface SpanDeps {
  /** Recordings shared with the agy_tool mirror (native tool-card mirroring). */
  runs: RunRegistry
  /** Base URL of the media route, e.g. http://127.0.0.1:PORT/plugins/agy-link/media */
  getMediaBaseUrl?: () => string | null
}

class ChunkQueue {
  private chunks: StreamChunk[] = []
  private wake: (() => void) | null = null
  private closed = false

  push(ch: StreamChunk): void {
    this.chunks.push(ch)
    this.wake?.()
    this.wake = null
  }

  close(): void {
    this.closed = true
    this.wake?.()
    this.wake = null
  }

  async *drain(): AsyncIterable<StreamChunk> {
    for (;;) {
      while (this.chunks.length > 0) {
        const ch = this.chunks.shift()
        if (ch !== undefined) yield ch
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      });
    }
  }
}

function brief(s: string): string {
  const flat = s.trim().replace(/\s+/g, ' ')
  return flat.length > 300 ? flat.slice(0, 300) + '...' : flat
}

/**
 * The conversation id a recorded event belongs to: the recording's bound
 * conversation if any, else the event's own `conversation_id` (top level or in
 * `step_update`). Used to look the step's full args/thoughts up in agy's DB.
 */
function activeConversationId(rec: RunRecording, ev: AgyEvent): string | null {
  const rawObj = 'raw' in ev && ev.raw && typeof ev.raw === 'object' ? (ev.raw as Record<string, unknown>) : null
  const stepUpdate = rawObj?.step_update && typeof rawObj.step_update === 'object' ? (rawObj.step_update as Record<string, unknown>) : null
  return (
    rec.conversationId ??
    (typeof rawObj?.conversation_id === 'string' ? rawObj.conversation_id : null) ??
    (typeof stepUpdate?.conversation_id === 'string' ? stepUpdate.conversation_id : null)
  )
}

/**
 * Resolve this event's thought text from agy's conversation DB (print mode
 * strips thought text from the stream). A still-empty thinking step is queued
 * in `pendingThoughtSteps` and retried on a later event.
 */
async function resolveEventThought(
  rec: RunRecording,
  ev: AgyEvent,
  i: number,
  resolvedThoughts: Map<number, string>,
  pendingThoughtSteps: Map<number, string>,
): Promise<void> {
  const recordedThought = rec.getThoughts(i)
  if (recordedThought !== undefined) {
    resolvedThoughts.set(i, recordedThought)
    return
  }
  if (ev.kind !== 'step') return
  const activeConvId = activeConversationId(rec, ev)
  const stepIdx = parseInt(ev.stepKey, 10)
  if (activeConvId === null || !Number.isFinite(stepIdx)) return
  try {
    let th = await readStepThoughts(activeConvId, stepIdx, rec.accountHome)
    if (th === null && (ev.state === 'DONE' || (ev.usage?.thinking_tokens ?? 0) > 0 || ev.stepKind === 'thinking')) {
      await new Promise((r) => setTimeout(r, 60))
      th = await readStepThoughts(activeConvId, stepIdx, rec.accountHome)
      if (th === null) {
        await new Promise((r) => setTimeout(r, 100))
        th = await readStepThoughts(activeConvId, stepIdx, rec.accountHome)
      }
    }
    if (th !== null && th.trim() !== '') {
      resolvedThoughts.set(i, th)
      rec.setThoughts(i, th)
    } else if ((ev.usage?.thinking_tokens ?? 0) > 0 || ev.stepKind === 'thinking') {
      pendingThoughtSteps.set(i, ev.stepKey)
    }
  } catch {
    // DB read failure is non-fatal; fallback to token annotation.
  }
}

/** Retry thought steps that were still empty when first seen. */
async function resolvePendingThoughts(
  rec: RunRecording,
  ev: AgyEvent,
  resolvedThoughts: Map<number, string>,
  pendingThoughtSteps: Map<number, string>,
): Promise<void> {
  const activeConvId = activeConversationId(rec, ev)
  if (activeConvId === null) return
  for (const [prevI, prevStepKey] of Array.from(pendingThoughtSteps.entries())) {
    const prevStepIdx = parseInt(prevStepKey, 10)
    if (!Number.isFinite(prevStepIdx)) continue
    try {
      const th = await readStepThoughts(activeConvId, prevStepIdx, rec.accountHome)
      if (th !== null && th.trim() !== '') {
        resolvedThoughts.set(prevI, th)
        rec.setThoughts(prevI, th)
        pendingThoughtSteps.delete(prevI)
      }
    } catch {
      // non-fatal
    }
  }
}

/**
 * Resolve a tool step's FULL args from agy's DB (agy's stream output strips
 * CodeContent/TargetContent/ReplacementContent via filterToolParameters), and,
 * for write/create tools, seed old content from git HEAD so diff cards render.
 */
async function resolveEventToolArgs(
  rec: RunRecording,
  ev: AgyEvent,
  i: number,
  resolved: Map<number, Record<string, unknown>>,
): Promise<void> {
  if (!(ev.kind === 'step' && ev.stepKind === 'tool' && ev.tool)) return
  const activeConvId = activeConversationId(rec, ev)
  const stepIdx = parseInt(ev.stepKey, 10)
  if (activeConvId !== null && Number.isFinite(stepIdx)) {
    try {
      let full = await readFullToolArgs(activeConvId, stepIdx, rec.accountHome)
      if (full === null) {
        await new Promise((r) => setTimeout(r, 50))
        full = await readFullToolArgs(activeConvId, stepIdx, rec.accountHome)
      }
      if (full !== null && full.args !== undefined) {
        resolved.set(i, full.args)
        rec.setFullArgs(i, full.args)
      }
    } catch {
      // DB read failure is non-fatal; stream args still render.
    }
  }
  // For write_to_file / create_file: if old content is not already present, resolve from git HEAD
  const unwrapped = unwrapMcpTool(ev.tool.name, resolved.get(i) ?? ev.tool.args)
  const toolName = unwrapped.tool
  if (toolName === 'write_to_file' || toolName === 'write_file' || toolName === 'create_file') {
    const currentArgs = unwrapped.input
    const targetFile = (currentArgs.TargetFile ?? currentArgs.target_file ?? currentArgs.path ?? currentArgs.AbsolutePath) as string | undefined
    if (targetFile && typeof targetFile === 'string' && !currentArgs.oldText && !currentArgs.old_string && !currentArgs.TargetContent) {
      const head = getGitHeadContent(targetFile)
      if (head !== null) {
        const updated = { ...currentArgs, old_string: head }
        resolved.set(i, updated)
        rec.setFullArgs(i, updated)
      }
    }
  }
}

export async function* driveSpan(
  deps: SpanDeps,
  rec: RunRecording,
  from: number,
  cutOnTool: boolean,
  useCodeWrapper: boolean,
  goalContext?: GoalContext | null,
  supportsGoalUpdate?: boolean,
  supportsPlanExit?: boolean,
  signal?: AbortSignal,
  compactionNotice?: CompactionNotice,
): AsyncIterable<StreamChunk> {
  if (signal?.aborted) {
    rec.requestAbort?.()
    yield {
      type: 'finish',
      reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted by caller' } },
    }
    return
  }
  // A span can wait hours for a wedged agy tool step. Pin the recording for
  // its whole lifetime so the shared registry can never evict a run whose
  // mirror calls are still queued behind that cut, and refresh its recency
  // on the way out so the agy_tool dispatch that follows the final cut
  // still resolves (flash-blast incident, 2026-10-10).
  deps.runs.remember(rec)
  deps.runs.pin(rec.runId)
  try {
    yield* driveSpanBody(deps, rec, from, cutOnTool, useCodeWrapper, goalContext, supportsGoalUpdate, supportsPlanExit, signal, compactionNotice)
  } finally {
    deps.runs.unpin(rec.runId)
    deps.runs.remember(rec)
  }
}

/** Body of {@link driveSpan}: map recorded events until the span finishes. */
export async function* driveSpanBody(
  deps: SpanDeps,
  rec: RunRecording,
  from: number,
  cutOnTool: boolean,
  useCodeWrapper: boolean,
  goalContext?: GoalContext | null,
  supportsGoalUpdate?: boolean,
  supportsPlanExit?: boolean,
  signal?: AbortSignal,
  compactionNotice?: CompactionNotice,
): AsyncIterable<StreamChunk> {
  const queue = new ChunkQueue()
  let abortedLocally = false
  const onAbort = () => {
    abortedLocally = true
    rec.requestAbort?.()
    queue.push({
      type: 'finish',
      reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted by caller' } },
    })
    queue.close()
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  void (async () => {
    // Resolve FULL tool args and thoughts from the agy conversation DB (agy's
    // stream output strips CodeContent/TargetContent/ReplacementContent via
    // filterToolParameters, and strips thought text from print mode). We
    // pre-resolve them so diff cards and reasoning blocks render real content.
    const resolved = new Map<number, Record<string, unknown>>()
    const resolvedThoughts = new Map<number, string>()
    const mapper = new EventMapper({
      runId: rec.runId,
      cutOnTool,
      initialSawText: rec.sawTextBefore(from),
      useCodeWrapper,
      usage: rec,
      resolvedFullArgs: resolved,
      resolvedThoughts,
      mediaBaseUrl: deps.getMediaBaseUrl?.() ?? undefined,
      goalContext,
      supportsGoalUpdate,
      supportsPlanExit,
      compactionNotice: from === 0 ? compactionNotice : undefined,
    })
    let i = from
    const pendingThoughtSteps = new Map<number, string>()
    try {
      for await (const ev of rec.eventsFrom(from)) {
        if (abortedLocally || signal?.aborted) break
        await resolveEventThought(rec, ev, i, resolvedThoughts, pendingThoughtSteps)
        if (pendingThoughtSteps.size > 0) {
          await resolvePendingThoughts(rec, ev, resolvedThoughts, pendingThoughtSteps)
        }
        await resolveEventToolArgs(rec, ev, i, resolved)
        for (const ch of mapper.map(ev, i)) queue.push(ch)
        i++
        if (mapper.isFinished) {
          // Remember where the span stopped so a duplicate-debounce rescue
          // can re-drive this recording from exactly the cut point without
          // a parseable mirror callId (see RunRecording.lastCutIndex).
          rec.lastCutIndex = i - 1
          break
        }
      }
      if (!mapper.isFinished && !abortedLocally && !signal?.aborted) {
        const f = rec.failureInfo
        if (f !== null) {
          for (const ch of mapper.emitFailure(f.kind, f.code, f.message, f.retryAfterMs)) queue.push(ch)
        } else {
          for (const ch of mapper.emitFailure('error', Err.INVALID_OUTPUT, 'agy stream ended without a result event')) queue.push(ch)
        }
      }
    } catch (err) {
      if (!abortedLocally && !signal?.aborted) {
        for (const ch of mapper.emitFailure('error', Err.PROCESS_EXIT, 'internal error: ' + brief(String(err)))) queue.push(ch)
      }
    }
    queue.close()
  })()
  try {
    yield* queue.drain()
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
