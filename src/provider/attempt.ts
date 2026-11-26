// Spawn/parse primitives for one agy attempt.
//
// This module owns the reusable, mostly-pure pieces extracted from
// AgyAdapter.streamAttempt:
//
//   - the argv/transport decision (buildAgyArgs / buildSpawnArgs),
//   - recording + parser + tool-watchdog state (createAttemptRecorder),
//   - the credential/concurrency slot handle (createAttemptSlot),
//   - the child spawn and first-event wiring (startAttemptProcess).
//
// The async outcome closure lives in ./attempt-outcome.ts (it also drives the
// credential-slot dispatch); the adapter calls runAgyAttempt from there.
import { LlmError, type Message } from '@deepseek-ai/dsh-llm'
import type { BackgroundTurnObserver } from '../common/background-types.ts'
import type { AgyEvent, AgyTransportMode, PluginConfig } from '../common/types.ts'
import type { AgyGenerateOptions } from '../common/protocol.ts'
import { createToolWatchdog, type ToolWatchdog } from './tool-watchdog.ts'
import { Err, looksLikeTosViolation } from '../common/types.ts'
import type { ManagedAccount, ModelFamily } from '../common/pool-types.ts'
import type { AccountPoolManager } from '../host/pool.ts'
import type { SessionBinding, SessionStore } from '../host/sessions.ts'
import { conversationsDirFor, diffConversations, snapshotConversations, type DirSnapshot } from '../host/discovery.ts'
import type { RunRecording, RunRegistry } from '../host/recording.ts'
import { StreamJsonParser } from '../host/parser.ts'
import type { RunningProcess } from '../host/runner.ts'
import {
  buildStreamInputLine,
  ensureIsolatedKeychain,
  shouldUsePromptStdin,
  startAgyProcess,
  stripNulBytes,
} from '../host/runner.ts'
import { agyHomeDirFor, snapshotAgyLogs, type AgyLogSnapshot } from '../host/agy-log.ts'
import { createAttemptSlot, type AttemptSlot } from './attempt-slot.ts'
export { createAttemptSlot, type AttemptSlot } from './attempt-slot.ts'
import { buildAgyEnv, pickProxy } from '../runtime/net/account-env.ts'
import type { SpawnLimiter } from './spawn-limiter.ts'
import { readFileSync } from 'node:fs'
import { buildOrchestratorSettingsObject, isOrchestratorModel, mergeOrchestratorIntoAgySettings } from '../common/orchestrator.ts'
import { resolveModelSlug } from '../host/models.ts'
import { warnWatermarkDrop, type RunTelemetry } from './finalize.ts'
import { SubagentTracker } from '../features/subagent/tracker.ts'
import {
  createLiveQuotaController,
  reportDirectToolQuota,
  type LiveQuotaFailoverState,
} from './quota-failover.ts'
import { AGY_PROMPT_SAFE_BYTES, trimToUtf8Bytes, utf8Bytes } from './prompt-text.ts'

export function brief(s: string): string {
  const flat = s.trim().replace(/\s+/g, ' ')
  return flat.length > 300 ? flat.slice(0, 300) + '...' : flat
}

/** What the attempt machinery needs from the adapter (nothing more). */
export interface AttemptDeps {
  /** Shared semaphore for cross-session concurrency (ADR-12). */
  acquire: (signal?: AbortSignal) => Promise<() => void>
  pool?: AccountPoolManager
  runs: RunRegistry
  store: SessionStore
  log?: (msg: string) => void
  /** Called with each run's parser so the host can keep the last stdout ring. */
  onParser?: (parser: StreamJsonParser) => void
  onRun?: (info: RunTelemetry) => void
  /** Fired after an attempt settles so the host can refresh THAT account's quota. */
  onAccountUsed?: (accountId: string, family: ModelFamily) => void
  /** Refresh an isolated account's token before an ACP spawn (see adapter deps). */
  ensureFreshToken?: (account: ManagedAccount) => Promise<boolean>
  /** Adapter-private state, injected as callbacks. */
  clearInFlightPrompt: (sessionKey: string, prompt: string) => void
  registerActiveRun: (sessionKey: string, rec: RunRecording) => void
  unregisterActiveRun: (sessionKey: string, rec: RunRecording) => void
  isSuperseded: (sessionKey: string, rec: RunRecording) => boolean
  noteNetworkFailure: (sessionKey: string) => number
  clearNetworkStreak: (sessionKey: string) => void
  dropFailoverBudget: (sessionKey: string) => void
  clearRateLimitFailover: (sessionKey: string) => void
  sharesSingleEgress: () => boolean
  /** Per-account burst spacing throttle state (adapter-owned). */
  lastAccountSpawnTime: Map<string, number>
  minSpawnIntervalMs: number
  spawnLimiter?: SpawnLimiter
  /** Optional persistent ACP attempt driver injected by host. */
  runAcp?: (deps: AttemptDeps, input: AttemptInput, slot: AttemptSlot) => Promise<RunRecording | null>
  /** Cached `agy --version` string (enables lock-free SSH_CONNECTION isolation on Windows agy >= 1.5). */
  agyVersion?: () => string | null
  /** Cross-turn background wake observer (tracks schedule timers & background tasks). */
  backgroundObserver?: BackgroundTurnObserver
  /**
   * Surface a user-visible ACP notice in the session (session reset, forced
   * session rebuild). Host-injected: the features layer cannot reach the
   * session service on its own.
   */
  appendAcpNotice?: (sessionKey: string, notice: AcpSessionNotice) => void
  /**
   * Note a report written straight into the transcript, with the record seq it
   * landed at. The same narration is also written by agy into the conversation's
   * .system_generated/messages, so the host needs this to avoid waking the model
   * over a sentence the user already has on screen.
   */
  noteAcpReport?: (sessionKey: string, text: string, seq: number) => void
  /**
   * Rewrite the Windows credential slot with the account this attempt must run
   * as. Host-injected: the features layer may not touch host credential code.
   * Returns false when the slot cannot be written (non-Windows, unreadable
   * credential), which turns an identity mismatch into a hard failure.
   */
  reinstallCredentialSlot?: (account: ManagedAccount) => boolean
}

/** One user-visible ACP channel notice. */
export interface AcpSessionNotice {
  /**
   * acp-reset: the persisted session vanished and was rebuilt from a digest.
   * acp-drain-aborted: a background task was cut short (account switch / eviction).
   */
  kind: 'acp-reset' | 'acp-drain-aborted'
  /** Markdown text shown in the conversation. */
  text: string
}

/** Everything one attempt needs. Values are produced by streamAttempt. */
export interface AttemptInput {
  bridgeRoute?: string
  cfg: PluginConfig
  bin: string
  permissionMode: PluginConfig['permissionMode']
  sessionKey: string
  workspaceRoot: string
  isAux: boolean
  isBackgroundAux?: boolean
  account: ManagedAccount | undefined
  prompt: string
  model: string
  activeModel: string
  effort: string | undefined
  addDirs: readonly string[]
  persistBinding: boolean
  binding: SessionBinding | undefined
  messages: readonly Message[]
  newlySentImageIds: readonly string[]
  stagedImages?: readonly { path: string; mediaType: string }[]
  /** Second model whose quota bucket must be clear (image: the image model). */
  quotaModel?: string
  /** Accounts this request must avoid (model-scoped rotation). */
  avoidAccountIds?: readonly string[]
  sessionAccountKey: string
  family: ModelFamily
  signal: AbortSignal | undefined
  agyOnEvent: ((ev: AgyEvent) => void) | undefined
  agent?: string
  agySettings?: string
  jsonSchema?: string
  sandbox?: boolean
  transport?: AgyTransportMode
}

function serializeOpt(v: string | Record<string, unknown> | undefined): string | undefined {
  if (typeof v === 'string') return v.trim() !== '' ? v.trim() : undefined
  if (v && typeof v === 'object') return JSON.stringify(v)
  return undefined
}

export function resolveAttemptOverrides(options: AgyGenerateOptions, cfg: PluginConfig): Pick<AttemptInput, 'agent' | 'agySettings' | 'jsonSchema' | 'sandbox' | 'transport'> {
  const agent = typeof options.agyAgent === 'string' ? options.agyAgent.trim() : cfg.agent.trim()
  const agySettings = serializeOpt(options.agySettings) ?? serializeOpt(cfg.agySettings)
  const jsonSchema = serializeOpt(options.agyJsonSchema)
  const sandbox = options.agySandbox ?? cfg.sandbox
  const transport = options.agyTransport ?? cfg.transport
  return {
    ...(agent !== '' ? { agent } : {}),
    ...(agySettings !== undefined ? { agySettings } : {}),
    ...(jsonSchema !== undefined ? { jsonSchema } : {}),
    sandbox,
    transport,
  }
}

/** Pure argv builder for one agy call (same body as AgyAdapter.buildArgs). */
export function buildAgyArgs(opts: {
  prompt: string
  model: string
  effort?: string
  conversationId?: string
  permissionMode: PluginConfig['permissionMode']
  timeoutMs: number
  extraArgs: readonly string[]
  addDirs?: readonly string[]
  printTimeoutMinutes?: number
  /** Omit `-p <prompt>` and add `--input-format stream-json` (prompt rides stdin). */
  promptViaStdin?: boolean
  sandbox?: boolean
  agent?: string
  agySettings?: string
  jsonSchema?: string
}): string[] {
  const ptMins = opts.printTimeoutMinutes ?? Math.max(1, Math.ceil(opts.timeoutMs / 60_000))
  const args: string[] = ['--output-format', 'stream-json', '--print-timeout', ptMins + 'm']
  if (opts.permissionMode === 'skip') args.push('--dangerously-skip-permissions')
  else args.push('--mode', opts.permissionMode)
  if (opts.sandbox === true) args.push('--sandbox')
  if (opts.agent && opts.agent.trim() !== '') args.push('--agent', opts.agent.trim())
  if (opts.agySettings && opts.agySettings.trim() !== '') args.push('--settings', opts.agySettings.trim())
  if (opts.jsonSchema && opts.jsonSchema.trim() !== '') args.push('--json-schema', opts.jsonSchema.trim())
  const effectiveModel = resolveModelSlug(opts.model)
  if (effectiveModel !== '') args.push('--model', effectiveModel)
  // Claude 5.5 accepts --effort on its base slug (verified against agy 1.5.3);
  // a tiered slug plus the flag is rejected upstream, so callers must pass the
  // base slug here — the catalog folds the tiers for exactly that reason.
  const effortModel = effectiveModel.toLowerCase()
  // Claude 5.5 only: 4.6 keeps its documented no-effort behaviour.
  const isEffortCapable = effectiveModel === '' || effortModel.startsWith('gemini') || effortModel.startsWith('argon') || /^claude-(?:sonnet|opus)-5-5$/.test(effortModel)
  if (isEffortCapable && opts.effort && opts.effort !== '') args.push('--effort', opts.effort)
  if (opts.conversationId) args.push('--conversation', opts.conversationId)
  for (const d of opts.addDirs ?? []) args.push('--add-dir', d)
  args.push(...opts.extraArgs)
  if (opts.promptViaStdin) {
    args.push('--input-format', 'stream-json')
  } else {
    args.push('-p', opts.prompt)
  }
  return args
}

export interface SpawnPlan {
  /** NUL-sanitized prompt (what the child receives and what in-flight keys). */
  prompt: string
  args: string[]
  stdinPayload: string | undefined
}

/**
 * Sanitize the prompt, build the argv, and pick the transport. NULs are removed
 * before `spawn` can see them; an over-budget prompt is tail-trimmed below
 * agy's single-message ceiling (the live request sits at the head).
 */
export function buildSpawnArgs(
  input: AttemptInput,
  printTimeoutMinutes: number,
  log: ((msg: string) => void) | undefined,
): SpawnPlan {
  let prompt = stripNulBytes(input.prompt)
  if (utf8Bytes(prompt) > AGY_PROMPT_SAFE_BYTES) {
    log?.('prompt is ' + utf8Bytes(prompt) + ' B (> agy single-message budget) — trimming the tail')
    prompt = trimToUtf8Bytes(prompt, AGY_PROMPT_SAFE_BYTES)
  }
  const activeModelForArgs = input.activeModel === '' ? input.cfg.defaultModel : input.activeModel
  const conversationId = input.persistBinding && input.binding !== undefined ? input.binding.conversationId : undefined
  const effectiveAgySettings = resolveEffectiveAgySettings(input)
  const base = {
    prompt,
    model: activeModelForArgs,
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(conversationId === undefined ? {} : { conversationId }),
    permissionMode: input.permissionMode,
    timeoutMs: input.cfg.timeoutMs,
    printTimeoutMinutes,
    extraArgs: input.cfg.extraArgs,
    addDirs: input.addDirs,
    sandbox: input.sandbox ?? input.cfg.sandbox,
    ...((input.agent ?? input.cfg.agent).trim() !== '' ? { agent: (input.agent ?? input.cfg.agent).trim() } : {}),
    ...(effectiveAgySettings !== undefined ? { agySettings: effectiveAgySettings } : {}),
    ...(input.jsonSchema && input.jsonSchema.trim() !== '' ? { jsonSchema: input.jsonSchema.trim() } : {}),
  }
  const argsBase = buildAgyArgs(base)
  // Decide transport: keep `-p <prompt>` for normal turns; switch to stdin
  // stream-json when the argv would approach the CreateProcess limit.
  const promptViaStdin = shouldUsePromptStdin(argsBase)
  const args = promptViaStdin ? buildAgyArgs({ ...base, promptViaStdin: true }) : argsBase
  const stdinPayload = promptViaStdin ? buildStreamInputLine(prompt) : undefined
  return { prompt, args, stdinPayload }
}

/**
 * Resolve effective `--settings` for an attempt: merges configured Orchestrator
 * planner/executor overrides when targeting an Orchestrator model.
 */
export function resolveEffectiveAgySettings(
  input: Pick<AttemptInput, 'activeModel' | 'agySettings' | 'cfg'>,
  effortsForModel?: (modelId: string) => readonly string[] | null | undefined,
): string | undefined {
  const baseSettings = (input.agySettings ?? input.cfg.agySettings).trim()
  const activeModel = input.activeModel === '' ? input.cfg.defaultModel : input.activeModel
  const effectiveModel = resolveModelSlug(activeModel)
  const orchestrator = isOrchestratorModel(effectiveModel)
    ? buildOrchestratorSettingsObject(input.cfg, effortsForModel)
    : undefined
  return mergeOrchestratorIntoAgySettings(
    baseSettings === '' ? undefined : baseSettings,
    orchestrator,
    (filePath) => readFileSync(filePath, 'utf8'),
  )
}

/**
 * True when the ONLY reason `resolveEffectiveAgySettings` returns a value is
 * the Orchestrator planner/executor payload — i.e. the user has no free-form
 * `agySettings` of their own (issue #204).
 *
 * ACP has no `--settings` flag but reads `settings.json` at startup, and the
 * flag accepts exactly the same "settings.json keys". So an orchestrator-only
 * payload is covered by writing that file, and routing does not need to force
 * the batch CLI. A user's own agySettings stay on the CLI path: persisting them
 * into every account's settings.json would silently outlive one call.
 */
export function orchestratorSettingsCoveredByAcp(
  input: Pick<AttemptInput, 'activeModel' | 'agySettings' | 'cfg'>,
): boolean {
  if ((input.agySettings ?? input.cfg.agySettings).trim() !== '') return false
  const activeModel = input.activeModel === '' ? input.cfg.defaultModel : input.activeModel
  if (!isOrchestratorModel(resolveModelSlug(activeModel))) return false
  return buildOrchestratorSettingsObject(input.cfg) !== undefined
}

export interface AttemptRecorder {
  rec: RunRecording
  parser: StreamJsonParser
  conversationsDir: string
  before: DirSnapshot
  streamCid: string | null
  printTimeoutMinutes: number
  maxTurnMs?: number | undefined
  attachProcess: (proc: RunningProcess) => void
  startTracker?: () => void
  /** Tell the subagent tracker which DSH session it belongs to (header badge scope). */
  setTrackerSession?: (sessionKey: string) => void
  feedLine: (line: string, onEvent: ((ev: AgyEvent) => void) | undefined, onFirstEvent: (() => void) | undefined) => void
  drain: (onEvent: ((ev: AgyEvent) => void) | undefined) => void
  flushTracker: () => void
  stop: () => void
  quotaFailover: () => LiveQuotaFailoverState | null
  cooledInLiveFamilies: () => ReadonlySet<ModelFamily>
  conversationId: () => string | null
}

/** Create the recording, parser, HOME snapshot and tool watchdog for one run. */
export function createAttemptRecorder(
  deps: AttemptDeps,
  cfg: PluginConfig,
  account: ManagedAccount | undefined,
  initialConversationId?: string,
  trackSubagents = true,
  quotaCtx?: { family: ModelFamily; activeModel: string },
  isBackgroundAux = false,
): AttemptRecorder {
  const rec = deps.runs.create()
  rec.accountHome = account && account.dir ? account.dir : undefined
  const conversationsDir = conversationsDirFor(rec.accountHome)
  const before = snapshotConversations(conversationsDir)
  const parser = new StreamJsonParser()
  deps.onParser?.(parser)
  const watchdog = createToolWatchdog(deps.log, cfg, isBackgroundAux ? { isBackgroundAux: true } : undefined)
  let attachedProc: RunningProcess | null = null
  let pendingQuotaKill = false
  const quotaCtrl = quotaCtx
    ? createLiveQuotaController({
        pool: deps.pool,
        account,
        inputFamily: quotaCtx.family,
        activeModel: quotaCtx.activeModel,
        emitNotice: (stepKey, text) => rec.append({ kind: 'step', stepKey, stepKind: 'subagent', text, raw: {} }),
        onTriggerKill: () => {
          if (attachedProc) attachedProc.kill('quota')
          else pendingQuotaKill = true
        },
      })
    : null
  const tracker = trackSubagents
    ? new SubagentTracker({
        conversationId: initialConversationId,
        resumed: Boolean(initialConversationId),
        accountHome: rec.accountHome,
        log: deps.log,
        onEvent: (ev) => rec.append(ev),
        ...(quotaCtrl ? { onQuotaExhausted: (info) => quotaCtrl.handleQuotaExhausted(info) } : {}),
        noteActivity: () => watchdog.markEvent(),
      })
    : undefined
  const state: AttemptRecorder = {
    rec,
    parser,
    conversationsDir,
    before,
    streamCid: initialConversationId ?? null,
    printTimeoutMinutes: watchdog.printTimeoutMinutes,
    maxTurnMs: watchdog.maxTurnMs,
    attachProcess: (proc) => {
      attachedProc = proc
      watchdog.attach(proc)
      tracker?.start()
      if (pendingQuotaKill) proc.kill('quota')
      void proc.outcome.finally(() => tracker?.stop())
    },
    startTracker: () => {
      tracker?.start()
    },
    setTrackerSession: (sessionKey) => { tracker?.setSessionKey(sessionKey) },
    feedLine: (line, onEvent, onFirstEvent) => {
      watchdog.markEvent()
      // First output = agy resolved its credential; give the machine-wide slot
      // back so other accounts' sessions can run concurrently.
      onFirstEvent?.()
      for (const ev of parser.feed(line + '\n')) {
        if (ev.kind === 'init' && ev.conversationId) {
          state.streamCid = ev.conversationId
          tracker?.setConversationId(ev.conversationId)
        }
        if (ev.kind === 'result' && ev.conversationId !== '') {
          state.streamCid = ev.conversationId
          tracker?.setConversationId(ev.conversationId)
        }
        watchdog.trackStep(ev)
        rec.append(ev)
        reportDirectToolQuota(quotaCtrl, ev)
        if (typeof onEvent === 'function') {
          try {
            onEvent(ev)
          } catch {
            // contained: a listener must never break the stream
          }
        }
      }
    },
    drain: (onEvent) => {
      for (const ev of parser.flush()) {
        if (ev.kind === 'result' && ev.conversationId !== '') {
          state.streamCid = ev.conversationId
          tracker?.setConversationId(ev.conversationId)
        }
        rec.append(ev)
        if (typeof onEvent === 'function') {
          try {
            onEvent(ev)
          } catch {
            // contained
          }
        }
      }
    },
    flushTracker: () => {
      tracker?.flush()
    },
    stop: () => {
      watchdog.stop()
      tracker?.stop()
    },
    quotaFailover: () => quotaCtrl?.failoverState() ?? null,
    cooledInLiveFamilies: () => quotaCtrl?.cooledFamilies() ?? new Set<ModelFamily>(),
    conversationId: () => state.streamCid ?? diffConversations(before, conversationsDir).conversationId,
  }
  return state
}

/** Abort-aware sleep: rejects with the same error text the call sites used. */
export function abortableDelay(ms: number, signal: AbortSignal | undefined, abortedMessage: string): Promise<void> {
  if (signal?.aborted) return Promise.reject(new LlmError(abortedMessage, Err.AGY_ERROR))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new LlmError(abortedMessage, Err.AGY_ERROR))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Bounded wait for an aborted run to settle, so a steer replacement never
 * overlaps the process it just killed on the same agy conversation.
 * Returns whether the run actually settled before the deadline.
 */
export async function waitForRunSettle(run: { isSettled: boolean }, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (run.isSettled) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return run.isSettled
}

export function persistBindingOnResult(
  deps: AttemptDeps,
  input: AttemptInput,
  recorder: AttemptRecorder,
  ev: AgyEvent,
): void {
  if (
    ev.kind !== 'result' ||
    !ev.ok ||
    looksLikeTosViolation(ev.response) ||
    !input.persistBinding ||
    input.sessionAccountKey === '' ||
    deps.isSuperseded(input.sessionKey, recorder.rec)
  ) {
    return
  }
  // Same precedence as finalize.writeSuccessBinding: the conversation this run
  // actually wrote to beats the binding we entered with.
  const finalId = ev.conversationId || recorder.streamCid || input.binding?.conversationId
  if (!finalId) return
  const prevCount = Math.max(
    input.binding?.lastMessageCount ?? 0,
    deps.store.get(input.sessionAccountKey)?.lastMessageCount ?? 0,
  )
  warnWatermarkDrop({
    ...(deps.log ? { log: deps.log } : {}),
    source: 'persistBindingOnResult',
    key: input.sessionAccountKey,
    conversationId: finalId,
    previousCount: prevCount,
    nextCount: input.messages.length,
    messages: input.messages,
  })
  const mergedImages =
    input.binding?.sentImageIds || input.newlySentImageIds.length > 0
      ? [...new Set([...(input.binding?.sentImageIds ?? []), ...input.newlySentImageIds])]
      : undefined
  const resolvedCwd = input.binding?.cwd || input.workspaceRoot
  deps.store.set(input.sessionAccountKey, {
    conversationId: finalId,
    lastMessageCount: input.messages.length,
    updatedAt: Date.now(),
    model: input.activeModel,
    ...(mergedImages && mergedImages.length > 0 ? { sentImageIds: mergedImages } : {}),
    ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
  })
}

