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
import type { AgyEvent, PluginConfig } from '../common/types.ts'
import { Err } from '../common/types.ts'
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
import { agyHomeDirFor, snapshotAgyLogs } from '../host/agy-log.ts'
import { acquireCredentialSlot, armSlotHandoff, type SlotHandoff } from '../host/credential-slot.ts'
import { buildAgyEnv } from '../runtime/net/account-env.ts'
import { resolveModelSlug } from '../host/models.ts'
import type { RunTelemetry } from './finalize.ts'
import { SubagentTracker } from '../features/subagent/tracker.ts'
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
}

/** Everything one attempt needs. Values are produced by streamAttempt. */
export interface AttemptInput {
  cfg: PluginConfig
  bin: string
  permissionMode: PluginConfig['permissionMode']
  sessionKey: string
  workspaceRoot: string
  isAux: boolean
  account: ManagedAccount | undefined
  /** Prompt BEFORE NUL sanitization (sanitized inside; used by argv/stdin). */
  prompt: string
  /** Resolved model slug (finalized telemetry / binding writes). */
  model: string
  activeModel: string
  effort: string | undefined
  addDirs: readonly string[]
  persistBinding: boolean
  binding: SessionBinding | undefined
  messages: readonly Message[]
  newlySentImageIds: readonly string[]
  sessionAccountKey: string
  family: ModelFamily
  signal: AbortSignal | undefined
  agyOnEvent: ((ev: AgyEvent) => void) | undefined
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
}): string[] {
  const ptMins = opts.printTimeoutMinutes ?? Math.max(1, Math.ceil(opts.timeoutMs / 60_000))
  const args: string[] = ['--output-format', 'stream-json', '--print-timeout', ptMins + 'm']
  if (opts.permissionMode === 'skip') args.push('--dangerously-skip-permissions')
  else args.push('--mode', opts.permissionMode)
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
  }
  const argsBase = buildAgyArgs(base)
  // Decide transport: keep `-p <prompt>` for normal turns; switch to stdin
  // stream-json when the argv would approach the CreateProcess limit.
  const promptViaStdin = shouldUsePromptStdin(argsBase)
  const args = promptViaStdin ? buildAgyArgs({ ...base, promptViaStdin: true }) : argsBase
  const stdinPayload = promptViaStdin ? buildStreamInputLine(prompt) : undefined
  return { prompt, args, stdinPayload }
}

export interface ToolWatchdog {
  printTimeoutMinutes: number
  attach: (proc: RunningProcess | null) => void
  markEvent: () => void
  trackStep: (ev: AgyEvent) => void
  stop: () => void
}

/**
 * Idle-budget + long-tool heartbeat state. While an agy tool step is ACTIVE the
 * child is legitimately silent on stdout (maven compile, language-server
 * build, …) — issue #33 — so the watchdog raises the idle budget; bare
 * generation gets a bounded floor so a hung SSE stream can fail and rotate.
 */
function createToolWatchdog(log: ((msg: string) => void) | undefined, cfg: PluginConfig): ToolWatchdog {
  const openToolKeys = new Set<string>()
  const openToolSince = new Map<string, number>()
  const longToolIdleMinutes = cfg.longToolIdleMinutes > 0 ? cfg.longToolIdleMinutes : 0
  const printTimeoutMinutes = Math.max(
    longToolIdleMinutes > 0 ? longToolIdleMinutes : 240,
    Math.ceil(cfg.timeoutMs / 60_000),
  )
  const longToolIdleMs = longToolIdleMinutes > 0 ? longToolIdleMinutes * 60_000 : cfg.timeoutMs
  const generationIdleMs = Math.max(cfg.timeoutMs, 15 * 60_000)
  let runningProc: RunningProcess | null = null
  let sawAnyEvent = false
  let lastOutputAt = 0
  const TOOL_HEARTBEAT_MS = 5 * 60_000
  let toolHeartbeat: NodeJS.Timeout | null = null
  const apply = (): void => {
    runningProc?.noteActivity(openToolKeys.size > 0 ? longToolIdleMs : generationIdleMs)
  }
  const stop = (): void => {
    if (toolHeartbeat !== null) {
      clearInterval(toolHeartbeat)
      toolHeartbeat = null
    }
  }
  const start = (): void => {
    if (toolHeartbeat !== null) return
    toolHeartbeat = setInterval(() => {
      if (openToolKeys.size === 0 && !sawAnyEvent) {
        stop()
        return
      }
      let oldest = Date.now()
      for (const startedAt of openToolSince.values()) {
        if (startedAt < oldest) oldest = startedAt
      }
      // With no tool step open the interesting number is time since the LAST
      // output, not since a tool start.
      if (openToolKeys.size === 0 && lastOutputAt > 0) oldest = lastOutputAt
      const mins = Math.max(1, Math.round((Date.now() - oldest) / 60_000))
      log?.(
        openToolKeys.size > 0
          ? 'agy tool step still running: ' + openToolKeys.size + ' open, oldest ' + mins +
            'm (idle budget ' + Math.round(longToolIdleMs / 60_000) + 'm) — the turn is waiting on agy'
          : 'agy run still working: no new output for ' + mins + 'm (idle budget ' +
            Math.round(longToolIdleMs / 60_000) + 'm) — the turn is waiting on agy; press Stop to cancel',
      )
    }, TOOL_HEARTBEAT_MS)
    toolHeartbeat.unref?.()
  }
  return {
    printTimeoutMinutes,
    attach: (proc) => {
      runningProc = proc
      apply()
    },
    markEvent: () => {
      sawAnyEvent = true
      lastOutputAt = Date.now()
      start()
      apply()
    },
    trackStep: (ev) => {
      if (ev.kind !== 'step' || ev.stepKind !== 'tool' || ev.tool === undefined) return
      // Mirror mapper's completion rule: DONE/ERROR state, or legacy events
      // that carry output/error without an explicit state.
      const completed =
        ev.state === 'DONE' ||
        ev.state === 'ERROR' ||
        (ev.state === undefined && (ev.tool.output !== undefined || ev.tool.error !== undefined))
      if (!completed) {
        if (!openToolKeys.has(ev.stepKey)) {
          openToolKeys.add(ev.stepKey)
          openToolSince.set(ev.stepKey, Date.now())
          apply()
          start()
        }
      } else if (openToolKeys.delete(ev.stepKey)) {
        openToolSince.delete(ev.stepKey)
        apply()
        if (openToolKeys.size === 0) stop()
      }
    },
    stop: () => {
      stop()
      openToolKeys.clear()
      openToolSince.clear()
    },
  }
}

export interface AttemptRecorder {
  rec: RunRecording
  parser: StreamJsonParser
  conversationsDir: string
  before: DirSnapshot
  streamCid: string | null
  printTimeoutMinutes: number
  attachProcess: (proc: RunningProcess) => void
  feedLine: (line: string, onEvent: ((ev: AgyEvent) => void) | undefined, onFirstEvent: (() => void) | undefined) => void
  drain: (onEvent: ((ev: AgyEvent) => void) | undefined) => void
  stop: () => void
  conversationId: () => string | null
}

/** Create the recording, parser, HOME snapshot and tool watchdog for one run. */
export function createAttemptRecorder(deps: AttemptDeps, cfg: PluginConfig, account: ManagedAccount | undefined, initialConversationId?: string): AttemptRecorder {
  const rec = deps.runs.create()
  rec.accountHome = account && account.dir ? account.dir : undefined
  // The fallback conversation-id discovery must watch the SAME HOME the child
  // runs under: an isolated pool account's conversation DB lives in its own
  // HOME and the system-HOME snapshot never sees it.
  const conversationsDir = conversationsDirFor(rec.accountHome)
  const before = snapshotConversations(conversationsDir)
  const parser = new StreamJsonParser()
  deps.onParser?.(parser)
  const watchdog = createToolWatchdog(deps.log, cfg)
  const tracker = new SubagentTracker({
    conversationId: initialConversationId,
    accountHome: rec.accountHome,
    log: deps.log,
    onEvent: (ev) => {
      rec.append(ev)
    },
    noteActivity: () => {
      watchdog.markEvent()
    },
  })
  const state: AttemptRecorder = {
    rec,
    parser,
    conversationsDir,
    before,
    streamCid: initialConversationId ?? null,
    printTimeoutMinutes: watchdog.printTimeoutMinutes,
    attachProcess: (proc) => {
      watchdog.attach(proc)
      tracker.start()
      void proc.outcome.finally(() => tracker.stop())
    },
    feedLine: (line, onEvent, onFirstEvent) => {
      watchdog.markEvent()
      // First output = agy resolved its credential; give the machine-wide slot
      // back so other accounts' sessions can run concurrently.
      onFirstEvent?.()
      for (const ev of parser.feed(line + '\n')) {
        if (ev.kind === 'init' && ev.conversationId) {
          state.streamCid = ev.conversationId
          tracker.setConversationId(ev.conversationId)
        }
        if (ev.kind === 'result' && ev.conversationId !== '') {
          state.streamCid = ev.conversationId
          tracker.setConversationId(ev.conversationId)
        }
        watchdog.trackStep(ev)
        rec.append(ev)
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
          tracker.setConversationId(ev.conversationId)
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
    stop: () => {
      watchdog.stop()
      tracker.stop()
    },
    conversationId: () => state.streamCid ?? diffConversations(before, conversationsDir).conversationId,
  }
  return state
}

export interface AttemptSlot {
  /** Release the concurrency slot + credential lease exactly once. */
  releaseOnce: () => void
  /** Arm the narrow credential hand-off (no-op without a lease). */
  armHandoff: () => SlotHandoff | null
}

export function createAttemptSlot(
  concurrencyRelease: (() => void) | null,
  credentialLease: Awaited<ReturnType<typeof acquireCredentialSlot>>,
  log: ((msg: string) => void) | undefined,
): AttemptSlot {
  let release = concurrencyRelease
  let released = false
  let handoff: SlotHandoff | null = null
  const releaseOnce = (): void => {
    if (released) return
    released = true
    if (handoff !== null) {
      handoff.dispose()
    } else {
      try {
        credentialLease?.release()
      } catch {
        // best-effort
      }
    }
    release?.()
    release = null
  }
  return {
    releaseOnce,
    armHandoff: () => {
      if (credentialLease === undefined) return null
      handoff = armSlotHandoff({
        release: () => {
          try {
            credentialLease?.release()
          } catch {
            // best-effort
          }
        },
        log,
      })
      return handoff
    },
  }
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

export interface SpawnedAttempt {
  proc: RunningProcess
  runLogHome: string
  runLogsBefore: Set<string>
}

/**
 * Spawn the child under the held slot. Installs the line callback (parser feed
 * + tool watchdog + first-event hand-off), registers the run for steer
 * preemption, and owns the "give the slot back" path for spawn failures.
 */
export async function startAttemptProcess(
  deps: AttemptDeps,
  input: AttemptInput,
  spawn: SpawnPlan,
  recorder: AttemptRecorder,
  slot: AttemptSlot,
): Promise<SpawnedAttempt> {
  const { cfg, account, sessionKey, workspaceRoot } = input
  const signal = input.signal
  // The acquire→spawn window can be arbitrarily long (all slots busy on long
  // tool runs). Re-check the signal here: addEventListener on an already-aborted
  // signal never fires, so the spawn below would run a full turn for a request
  // nobody is reading any more.
  if (signal?.aborted) {
    slot.releaseOnce()
    throw new LlmError('request aborted before the agy process was spawned', Err.AGY_ERROR)
  }
  // Only SECONDARY pool accounts get an isolated HOME. The primary account
  // rides the real system HOME (agy 1.1.15 keeps credentials in the macOS
  // Keychain); injecting HOME there signs agy out.
  if (account && account.dir) ensureIsolatedKeychain(account.dir)
  // Snapshot agy's per-run log set BEFORE spawning so evidence found after the
  // run can be attributed to THIS run (each invocation writes a fresh
  // cli-*.log). Only this log separates a genuine sign-out from a keyring
  // validation that died on the network.
  const runLogHome = agyHomeDirFor(account)
  const runLogsBefore = snapshotAgyLogs(runLogHome)
  // One shared precedence + env assembly (runtime/net/account-env.ts). The MCP
  // session id rides along so the bridge can resolve the calling agent
  // (issue #55); telemetry flags keep their historical behaviour here.
  const env = buildAgyEnv({
    ...(account === undefined ? {} : { account }),
    cfg,
    ...(sessionKey === '' ? {} : { sessionId: sessionKey }),
    telemetryFlags: cfg.disableTelemetry,
  })

  let proc: RunningProcess
  let spawned = false
  try {
    // Per-account burst spacing throttle with randomized jitter (prevents
    // high-frequency flood to Google endpoints). Suspension point INSIDE the
    // slot-owning window: a generator abandoned here must still give the slot
    // back — the finally below owns that.
    if (account) {
      const lastSpawn = deps.lastAccountSpawnTime.get(account.id) ?? 0
      const elapsed = Date.now() - lastSpawn
      const jitter = Math.floor(Math.random() * 300) // 100~400ms organic jitter
      const targetInterval = deps.minSpawnIntervalMs + jitter
      if (elapsed < targetInterval) {
        await abortableDelay(targetInterval - elapsed, signal, 'request aborted before the agy process was spawned')
      }
      deps.lastAccountSpawnTime.set(account.id, Date.now())
    }
    // Arm the narrow hand-off BEFORE the spawn: stdout can deliver the first
    // line before startAgyProcess() even returns, and that first line is the
    // proof that agy is past its credential read.
    const slotHandoff = slot.armHandoff()
    proc = startAgyProcess({
      bin: input.bin,
      args: spawn.args,
      cwd: workspaceRoot,
      timeoutMs: cfg.timeoutMs,
      // Wall-clock cap for the whole turn (issue #92): the idle watchdog is
      // re-armed by every output line, so a self-driving loop that keeps
      // printing never trips it. 0 disables (behaviour unchanged).
      maxTurnMs: cfg.maxTurnMinutes > 0 ? cfg.maxTurnMinutes * 60_000 : undefined,
      signal,
      env,
      stdinPayload: spawn.stdinPayload,
      preemptAutoUpdate: cfg.suppressAgyAutoUpdate,
      // stderr is liveness too: agy prints progress/diagnostics there while a
      // long step is running, and a run that only talks on stderr used to be
      // "idle" as far as the watchdog was concerned.
      stderrKeepalive: true,
      onLine: (line) => {
        recorder.feedLine(line, input.agyOnEvent, () => slotHandoff?.onFirstEvent())
      },
    })
    spawned = true
    recorder.attachProcess(proc)
    if (!input.isAux && sessionKey !== '') {
      recorder.rec.requestAbort = () => proc.kill('abort')
      deps.registerActiveRun(sessionKey, recorder.rec)
    }
    // The abort listener in the runner never fires on an ALREADY-aborted
    // signal: an abort that arrived while this call queued on the semaphore
    // (or during the throttle sleep above) would otherwise run a full turn
    // nobody is reading. Kill immediately so the outcome closure settles this
    // run as ABORTED and returns the slot.
    if (signal?.aborted) proc.kill('abort')
  } catch (e) {
    slot.releaseOnce()
    deps.clearInFlightPrompt(sessionKey, spawn.prompt)
    throw new LlmError('failed to spawn agy: ' + brief(String(e)), Err.PROCESS_EXIT)
  } finally {
    // Generator abandoned while suspended inside the try (throttle sleep):
    // the async outcome closure below was never created, so nothing else would
    // ever return the concurrency slot. releaseOnce() no-ops when the catch
    // already released.
    if (!spawned) {
      slot.releaseOnce()
      deps.clearInFlightPrompt(sessionKey, spawn.prompt)
    }
  }
  return { proc, runLogHome, runLogsBefore }
}