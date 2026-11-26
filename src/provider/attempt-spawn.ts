// Spawning the child under a held credential slot.
//
// Extracted from ./attempt.ts so that file stays inside the size budget: the
// acquire→spawn window, the burst throttle, the run-log snapshot and the
// first-event hand-off are one concern, and they own the "give the slot back"
// path for spawn failures.
import { LlmError } from '@deepseek-ai/dsh-llm'
import { Err } from '../common/types.ts'
import type { RunningProcess } from '../host/runner.ts'
import { ensureIsolatedKeychain, startAgyProcess } from '../host/runner.ts'
import { agyHomeDirFor, snapshotAgyLogs, type AgyLogSnapshot } from '../host/agy-log.ts'
import { buildAgyEnv, pickProxy } from '../runtime/net/account-env.ts'
import {
  persistBindingOnResult,
  type AttemptDeps,
  type AttemptInput,
  type AttemptRecorder,
  type AttemptSlot,
  type SpawnPlan,
} from './attempt.ts'

/** Abort-aware sleep: rejects with the same error text the call sites used. */
function abortableDelay(ms: number, signal: AbortSignal | undefined, abortedMessage: string): Promise<void> {
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

function brief(s: string): string {
  const flat = s.trim().replace(/\s+/g, ' ')
  return flat.length > 300 ? flat.slice(0, 300) + '...' : flat
}

export interface SpawnedAttempt {
  proc: RunningProcess
  runLogHome: string
  runLogsBefore: AgyLogSnapshot
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
  if (input.bridgeRoute) env.DSH_MCP_ROUTE = input.bridgeRoute
  else delete env.DSH_MCP_ROUTE

  let proc: RunningProcess
  let spawned = false
  try {
    // Per-account burst spacing throttle with randomized jitter (prevents
    // high-frequency flood to Google endpoints). Suspension point INSIDE the
    // slot-owning window: a generator abandoned here must still give the slot
    // back — the finally below owns that.
    // TAT per-account + shared-egress burst spacing throttle (reserves slot
    // synchronously BEFORE await so parallel sessions never wake together).
    if (account) {
      const egressKey = pickProxy(account.proxyUrl, cfg.proxyUrl) || '__direct__'
      const delayMs = deps.spawnLimiter
        ? deps.spawnLimiter.reserveSpawnDelay(account.id, egressKey, deps.minSpawnIntervalMs)
        : Math.max(0, deps.minSpawnIntervalMs + Math.floor(Math.random() * 300) - (Date.now() - (deps.lastAccountSpawnTime.get(account.id) ?? 0)))
      if (delayMs > 0) {
        await abortableDelay(delayMs, signal, 'request aborted before the agy process was spawned')
      }
      deps.lastAccountSpawnTime.set(account.id, Date.now())
    }
    // Arm the narrow hand-off BEFORE the spawn: stdout can deliver the first
    // line before startAgyProcess() even returns, and that first line is the
    // proof that agy is past its credential read.
    const slotHandoff = slot.armHandoff()
    const effectiveCwd = input.persistBinding && input.binding?.cwd ? input.binding.cwd : workspaceRoot
    proc = startAgyProcess({
      bin: input.bin,
      args: spawn.args,
      cwd: effectiveCwd,
      timeoutMs: cfg.timeoutMs,
      // Wall-clock cap for the whole turn (issue #92): the idle watchdog is
      // re-armed by every output line, so a self-driving loop that keeps
      // printing never trips it. 0 disables (behaviour unchanged).
      maxTurnMs: 'maxTurnMs' in recorder ? recorder.maxTurnMs : (cfg.maxTurnMinutes > 0 ? cfg.maxTurnMinutes * 60_000 : undefined),
      // A turn that legitimately waits on background work (a build, an
      // integration test, a Docker job it launched) prints `root agent idle;
      // waiting for N background task(s)`; the reaper must not treat that as an
      // orphan after 5 s (issue #144). 0 disables the reaper.
      idleGraceMs: cfg.idleGraceMinutes > 0 ? Math.round(cfg.idleGraceMinutes * 60_000) : 0,
      signal,
      env,
      stdinPayload: spawn.stdinPayload,
      preemptAutoUpdate: cfg.suppressAgyAutoUpdate,
      // stderr is liveness too: agy prints progress/diagnostics there while a
      // long step is running, and a run that only talks on stderr used to be
      // "idle" as far as the watchdog was concerned.
      stderrKeepalive: true,
      onLine: (line) => recorder.feedLine(
        line,
        (ev) => { persistBindingOnResult(deps, input, recorder, ev); input.agyOnEvent?.(ev) },
        () => slotHandoff?.onFirstEvent(),
      ),
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
