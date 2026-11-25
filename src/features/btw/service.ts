// BtwService — non-blocking, read-only, streaming side-question orchestrator.
//
// Mirrors agy's native `/btw`:
//  - Runs in read-only isolation (`mode: 'default'` + `--disable-slash-commands`
//    + explicit read-only `permissions.allow`/`deny` via `--settings`, because
//    `--mode plan` is implemented via `/plan` slash expansion and is ignored when
//    slash commands are disabled) without touching the main session's
//    `sessions.json` binding or model-visible log.
//  - Feeds `<session_context>` + `<live_run_progress>` on initial ask, and
//    chains follow-up questions onto the side thread's own `conversationId`.
//  - Streams text fragments, thinking status, and read-only tool steps live to
//    subscribers (SSE / polling), supporting immediate cancellation and history
//    navigation per DSH session.
import { randomUUID } from 'node:crypto'
import type { BtwAskOptions, BtwEntry, BtwSessionView, BtwToolStep } from '../../common/btw-types.ts'
import { isGeminiFamilyModel, PREFERRED_GEMINI_FLASH, PREFERRED_GEMINI_HYDROGEN } from '../../common/model-lineup.ts'
import type { AgyEvent, PluginConfig } from '../../common/types.ts'

export const MAX_BTW_SESSIONS = 100
export const MAX_ENTRIES_PER_SESSION = 20

/**
 * Explicit read-only tool permissions passed via `--settings` for `/atw`.
 *
 * `agy` implements `--mode plan` as `/plan` slash-command expansion, which has
 * no effect when `--disable-slash-commands` is enabled — falling back to
 * `request-review` and auto-denying `read_file` in headless `-p` mode.
 */
export const BTW_READ_ONLY_PERMISSIONS: { allow: readonly string[]; deny: readonly string[] } = {
  allow: [
    'read_file(*)',
    'view_file(*)',
    'view_file_outline(*)',
    'view_code_item(*)',
    'grep_search(*)',
    'find_by_name(*)',
    'list_dir(*)',
    'search_web(*)',
    'read_url_content(*)',
    'list_resources(*)',
    'read_resource(*)',
  ],
  deny: [
    'run_command(*)',
    'write_file(*)',
    'write_to_file(*)',
    'edit_file(*)',
    'replace_file_content(*)',
    'multi_replace_file_content(*)',
    'sed_file(*)',
    'notebook_edit(*)',
    'notebook_execution(*)',
    'delete_knowledge(*)',
    'generate_image(*)',
    'invoke_subagent(*)',
    'run_workflow(*)',
    'schedule(*)',
    'send_command_input(*)',
  ],
}

const DENIED_TOOL_PREFIXES = new Set(
  BTW_READ_ONLY_PERMISSIONS.deny.map((rule) => rule.split('(')[0]!.trim().toLowerCase()),
)

function ruleToolPrefix(rule: string): string {
  return rule.split('(')[0]!.trim().toLowerCase()
}

/**
 * Build `--settings` JSON for `/atw` preserving safe non-permission keys from
 * `baseSettings` (when inline JSON) and enforcing read-only `permissions`.
 */
export function buildBtwAgySettings(baseSettings?: string): string {
  let parsedBase: Record<string, unknown> = {}
  const trimmed = baseSettings?.trim() ?? ''
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedBase = { ...(parsed as Record<string, unknown>) }
      }
    } catch {
      // ignore malformed baseSettings
    }
  }
  const basePerms = parsedBase.permissions && typeof parsedBase.permissions === 'object' && !Array.isArray(parsedBase.permissions)
    ? (parsedBase.permissions as Record<string, unknown>)
    : {}
  const rawAllow = Array.isArray(basePerms.allow) ? basePerms.allow : []
  const rawDeny = Array.isArray(basePerms.deny) ? basePerms.deny : []
  const allowSet = new Set<string>(BTW_READ_ONLY_PERMISSIONS.allow)
  for (const r of rawAllow) {
    if (typeof r === 'string' && r.trim() !== '' && !DENIED_TOOL_PREFIXES.has(ruleToolPrefix(r))) {
      allowSet.add(r.trim())
    }
  }
  const denySet = new Set<string>(BTW_READ_ONLY_PERMISSIONS.deny)
  for (const r of rawDeny) {
    if (typeof r === 'string' && r.trim() !== '') {
      denySet.add(r.trim())
    }
  }
  return JSON.stringify({
    ...parsedBase,
    permissions: {
      ...basePerms,
      allow: [...allowSet],
      deny: [...denySet],
    },
  })
}

export interface BtwOneShotRequest {
  prompt: string
  model?: string
  effort?: string
  mode?: string
  cwd?: string
  disableSlashCommands?: boolean
  agySettings?: string
  timeoutMs?: number
  signal?: AbortSignal
  conversationId?: string
  onEvent?: (ev: AgyEvent) => void
  onAttemptStart?: () => void
}

export interface BtwOneShotResult {
  ok: boolean
  text: string
  conversationId: string | null
  accountId?: string
  error?: string
  durationMs: number
}

export interface BtwContextSnapshot {
  workspaceRoot: string
  historyText: string
  liveProgress: string
}

export interface BtwServiceDeps {
  cfg: () => PluginConfig
  catalog: () => { get(): { source: string; models: ReadonlyArray<{ id: string }> } } | undefined
  runOnce: (req: BtwOneShotRequest) => Promise<BtwOneShotResult>
  resolveContext: (sessionId: string) => BtwContextSnapshot
  now?: () => number
}

interface SessionBucket {
  open: boolean
  activeIndex: number
  entries: BtwEntry[]
  revision: number
  activeAbort: AbortController | null
  activeEntryId: string | null
  listeners: Set<(view: BtwSessionView) => void>
}

function summarizeToolTarget(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const a = args as Record<string, unknown>
  for (const key of [
    'Path', 'TargetFile', 'File', 'AbsolutePath', 'SearchPath', 'DirectoryPath',
    'CommandLine', 'Pattern', 'Query', 'Url', 'path', 'file', 'command', 'pattern', 'query',
  ]) {
    const v = a[key]
    if (typeof v === 'string' && v.trim() !== '') {
      const flat = v.trim().replace(/\s+/g, ' ')
      return flat.length > 80 ? flat.slice(0, 80) + '…' : flat
    }
  }
  return undefined
}

function mapToolState(ev: Extract<AgyEvent, { kind: 'step' }>): 'running' | 'done' | 'error' {
  if (ev.tool?.error) return 'error'
  const st = (ev.state ?? '').toUpperCase()
  if (st === 'ERROR' || st === 'CANCELED' || st === 'CANCELLED') return 'error'
  if (st === 'DONE' || ev.tool?.output !== undefined) return 'done'
  return 'running'
}

function resolveSideModel(deps: BtwServiceDeps, explicitOverride?: string): string {
  const explicit = (explicitOverride ?? '').trim()
  if (explicit !== '') return explicit
  const btwModel = (deps.cfg().btwModel ?? '').trim()
  if (btwModel !== '') return btwModel
  const cfgModel = deps.cfg().defaultModel.trim()
  if (cfgModel !== '') return cfgModel
  const cat = deps.catalog()?.get()
  if (cat?.source === 'discovered' && cat.models.length > 0) {
    if (cat.models.some((m) => m.id === PREFERRED_GEMINI_HYDROGEN)) return PREFERRED_GEMINI_HYDROGEN
    if (cat.models.some((m) => m.id === PREFERRED_GEMINI_FLASH)) return PREFERRED_GEMINI_FLASH
    const gemini = cat.models.find((m) => isGeminiFamilyModel(m.id))
    if (gemini) return gemini.id
    return cat.models[0]!.id
  }
  return PREFERRED_GEMINI_HYDROGEN
}

function buildInitialPrompt(question: string, ctx: BtwContextSnapshot): string {
  return [
    'Answer this quick side question (/btw) directly and concisely based on the session context and live progress below.',
    'You are in read-only mode: you may use read-only inspection tools (read_file, grep, find, list) only if needed, but do NOT modify files, do NOT run shell commands, do NOT continue any active /goal, and do NOT take over the main task.',
    ...(ctx.historyText ? ['<session_context>', ctx.historyText, '</session_context>'] : []),
    ...(ctx.liveProgress ? ['<live_run_progress>', ctx.liveProgress, '</live_run_progress>'] : []),
    '<side_question>',
    question,
    '</side_question>',
  ].join('\n\n')
}

function buildFollowUpPrompt(question: string, liveProgress: string): string {
  return [
    'Continue answering this side question (/btw) thread concisely in read-only mode. Do NOT modify files, run shell commands, or take over the main task.',
    ...(liveProgress ? ['<live_run_progress>', liveProgress, '</live_run_progress>'] : []),
    '<side_follow_up>',
    question,
    '</side_follow_up>',
  ].join('\n\n')
}

function cloneEntry(e: BtwEntry): BtwEntry {
  return {
    ...e,
    tools: e.tools.map((t) => ({ ...t })),
  }
}

export class BtwService {
  private readonly buckets = new Map<string, SessionBucket>()

  constructor(private readonly deps: BtwServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private getOrCreateBucket(sessionId: string): SessionBucket {
    let bucket = this.buckets.get(sessionId)
    if (bucket) {
      // Refresh LRU order.
      this.buckets.delete(sessionId)
      this.buckets.set(sessionId, bucket)
      return bucket
    }
    bucket = {
      open: false,
      activeIndex: 0,
      entries: [],
      revision: 0,
      activeAbort: null,
      activeEntryId: null,
      listeners: new Set(),
    }
    this.buckets.set(sessionId, bucket)
    this.evictOldSessions()
    return bucket
  }

  private evictOldSessions(): void {
    while (this.buckets.size > MAX_BTW_SESSIONS) {
      let victim: string | undefined
      for (const [sid, b] of this.buckets) {
        if (b.activeAbort === null && b.listeners.size === 0) {
          victim = sid
          break
        }
      }
      if (victim === undefined) break
      this.buckets.delete(victim)
    }
  }

  private snapshot(sessionId: string, bucket: SessionBucket | undefined): BtwSessionView {
    if (!bucket) {
      return { sessionId, open: false, activeIndex: 0, entries: [], revision: 0 }
    }
    const maxIdx = Math.max(0, bucket.entries.length - 1)
    const clampedIdx = Math.max(0, Math.min(bucket.activeIndex, maxIdx))
    return {
      sessionId,
      open: bucket.open,
      activeIndex: clampedIdx,
      entries: bucket.entries.map(cloneEntry),
      revision: bucket.revision,
    }
  }

  private notify(sessionId: string, bucket: SessionBucket): void {
    bucket.revision += 1
    if (bucket.listeners.size === 0) return
    const view = this.snapshot(sessionId, bucket)
    for (const listener of [...bucket.listeners]) {
      try {
        listener(view)
      } catch {
        // contained: a closed SSE/subscriber cannot fail the service
      }
    }
  }

  view(sessionId: string): BtwSessionView {
    return this.snapshot(sessionId, this.buckets.get(sessionId))
  }

  subscribe(sessionId: string, listener: (view: BtwSessionView) => void): () => void {
    const bucket = this.getOrCreateBucket(sessionId)
    bucket.listeners.add(listener)
    return () => {
      bucket.listeners.delete(listener)
    }
  }

  cancel(sessionId: string): boolean {
    const bucket = this.buckets.get(sessionId)
    if (!bucket || !bucket.activeAbort) return false
    const ac = bucket.activeAbort
    const activeEntry = bucket.entries.find((e) => e.id === bucket.activeEntryId)
    bucket.activeAbort = null
    bucket.activeEntryId = null
    if (activeEntry && activeEntry.status === 'running') {
      activeEntry.status = 'aborted'
      activeEntry.finishedAt = this.now()
      activeEntry.durationMs = Math.max(0, activeEntry.finishedAt - activeEntry.startedAt)
    }
    ac.abort()
    this.notify(sessionId, bucket)
    return true
  }

  dismiss(sessionId: string, open: boolean, activeIndex?: number): BtwSessionView {
    const bucket = this.getOrCreateBucket(sessionId)
    bucket.open = open
    if (typeof activeIndex === 'number' && Number.isFinite(activeIndex) && bucket.entries.length > 0) {
      bucket.activeIndex = Math.max(0, Math.min(Math.trunc(activeIndex), bucket.entries.length - 1))
    }
    this.notify(sessionId, bucket)
    return this.snapshot(sessionId, bucket)
  }

  clear(sessionId: string): BtwSessionView {
    const bucket = this.buckets.get(sessionId)
    if (!bucket) return { sessionId, open: false, activeIndex: 0, entries: [], revision: 0 }
    if (bucket.activeAbort) {
      const ac = bucket.activeAbort
      bucket.activeAbort = null
      bucket.activeEntryId = null
      ac.abort()
    }
    bucket.entries = []
    bucket.activeIndex = 0
    bucket.open = false
    this.notify(sessionId, bucket)
    return this.snapshot(sessionId, bucket)
  }

  start(opts: BtwAskOptions): { entryId: string; promise: Promise<BtwEntry>; view: BtwSessionView } {
    const sessionId = opts.sessionId.trim()
    const question = opts.question.trim()
    const bucket = this.getOrCreateBucket(sessionId)

    // Cancel any previous in-flight btw in this session before launching the new one.
    if (bucket.activeAbort) {
      this.cancel(sessionId)
    }

    const prevEntry = bucket.entries[bucket.activeIndex] ?? bucket.entries[bucket.entries.length - 1]
    const followUpCid =
      opts.followUp === true && opts.newThread !== true && prevEntry?.conversationId
        ? prevEntry.conversationId
        : undefined

    const model = resolveSideModel(this.deps, opts.model)
    const effort = (opts.effort ?? '').trim() || (this.deps.cfg().btwEffort ?? '').trim() || 'medium'
    const ctxSnap = this.deps.resolveContext(sessionId)
    const prompt = followUpCid
      ? buildFollowUpPrompt(question, ctxSnap.liveProgress)
      : buildInitialPrompt(question, ctxSnap)

    const entryId = `btw-${randomUUID().slice(0, 8)}`
    const entry: BtwEntry = {
      id: entryId,
      question,
      answer: '',
      thinking: '',
      tools: [],
      status: 'running',
      model,
      effort,
      conversationId: followUpCid ?? null,
      startedAt: this.now(),
      durationMs: 0,
    }

    bucket.entries.push(entry)
    if (bucket.entries.length > MAX_ENTRIES_PER_SESSION) {
      bucket.entries.splice(0, bucket.entries.length - MAX_ENTRIES_PER_SESSION)
    }
    bucket.activeIndex = bucket.entries.length - 1
    bucket.open = true

    const ac = new AbortController()
    bucket.activeAbort = ac
    bucket.activeEntryId = entryId
    this.notify(sessionId, bucket)

    const promise = this.runEntry(sessionId, bucket, entry, prompt, ctxSnap.workspaceRoot, followUpCid, ac)
    return { entryId, promise, view: this.snapshot(sessionId, bucket) }
  }

  async ask(opts: BtwAskOptions): Promise<BtwEntry> {
    return this.start(opts).promise
  }

  private async runEntry(
    sessionId: string,
    bucket: SessionBucket,
    entry: BtwEntry,
    prompt: string,
    cwd: string,
    followUpCid: string | undefined,
    ac: AbortController,
  ): Promise<BtwEntry> {
    let prevWasStepText = false
    const resetPartial = () => {
      entry.answer = ''
      entry.thinking = ''
      entry.tools = []
      prevWasStepText = false
    }

    const onEvent = (ev: AgyEvent): void => {
      if (ac.signal.aborted || entry.status !== 'running') return
      if (ev.kind === 'init' && ev.conversationId) {
        entry.conversationId = ev.conversationId
        this.notify(sessionId, bucket)
        return
      }
      if (ev.kind === 'step') {
        if (ev.stepKind === 'thinking') {
          if (ev.text.trim() !== '') {
            entry.thinking = ev.fragment ? entry.thinking + ev.text : ev.text
            this.notify(sessionId, bucket)
          }
          return
        }
        if (ev.stepKind === 'text' && ev.text !== '') {
          if (ev.fragment) {
            entry.answer += ev.text
            prevWasStepText = false
          } else {
            if (entry.answer !== '' && prevWasStepText && !entry.answer.endsWith('\n')) {
              entry.answer += '\n'
            }
            entry.answer += ev.text
            prevWasStepText = true
          }
          this.notify(sessionId, bucket)
          return
        }
        if (ev.stepKind === 'tool' && ev.tool) {
          const target = summarizeToolTarget(ev.tool.args)
          const state = mapToolState(ev)
          const existing = entry.tools.find((t) => t.stepKey === ev.stepKey)
          const step: BtwToolStep = {
            stepKey: ev.stepKey,
            name: ev.tool.name,
            ...(target !== undefined ? { target } : {}),
            state,
            ...(ev.tool.error ? { error: ev.tool.error } : {}),
          }
          if (existing) Object.assign(existing, step)
          else entry.tools.push(step)
          this.notify(sessionId, bucket)
        }
        return
      }
      if (ev.kind === 'result' && ev.conversationId) {
        entry.conversationId = ev.conversationId
      }
    }

    try {
      const res = await this.deps.runOnce({
        prompt,
        mode: 'default',
        disableSlashCommands: true,
        agySettings: buildBtwAgySettings(this.deps.cfg().agySettings),
        cwd,
        model: entry.model,
        effort: entry.effort,
        signal: ac.signal,
        ...(followUpCid !== undefined ? { conversationId: followUpCid } : {}),
        onAttemptStart: () => {
          if (entry.answer !== '' || entry.tools.length > 0 || entry.thinking !== '') {
            resetPartial()
            this.notify(sessionId, bucket)
          }
        },
        onEvent,
      })

      if (bucket.activeAbort === ac) {
        bucket.activeAbort = null
        bucket.activeEntryId = null
      }
      entry.finishedAt = this.now()
      entry.durationMs = res.durationMs > 0 ? res.durationMs : Math.max(0, entry.finishedAt - entry.startedAt)
      if (res.conversationId) entry.conversationId = res.conversationId
      if (res.accountId) entry.accountId = res.accountId

      if (ac.signal.aborted || entry.status === 'aborted') {
        entry.status = 'aborted'
      } else if (res.ok) {
        if (entry.answer.trim() === '' && res.text.trim() !== '') {
          entry.answer = res.text
        }
        entry.status = 'done'
      } else {
        entry.status = 'error'
        entry.error = res.error ?? 'unknown error'
      }
      this.notify(sessionId, bucket)
      return cloneEntry(entry)
    } catch (err) {
      if (bucket.activeAbort === ac) {
        bucket.activeAbort = null
        bucket.activeEntryId = null
      }
      entry.finishedAt = this.now()
      entry.durationMs = Math.max(0, entry.finishedAt - entry.startedAt)
      if (ac.signal.aborted || entry.status === 'aborted') {
        entry.status = 'aborted'
      } else {
        entry.status = 'error'
        entry.error = err instanceof Error ? err.message : String(err)
      }
      this.notify(sessionId, bucket)
      return cloneEntry(entry)
    }
  }

  dispose(): void {
    for (const [sid, bucket] of this.buckets) {
      if (bucket.activeAbort) {
        const ac = bucket.activeAbort
        bucket.activeAbort = null
        bucket.activeEntryId = null
        ac.abort()
      }
      bucket.listeners.clear()
      void sid
    }
    this.buckets.clear()
  }
}
