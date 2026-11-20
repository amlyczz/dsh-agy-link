// Idle-budget watchdog for one agy run: raises the idle budget while a tool step
// is genuinely working (#33), keeps a bounded floor for bare generation, and
// suspends the `root agent idle` reaper while a subagent wake-up is pending
// (#124). Extracted from attempt.ts so that file stays a coherent recorder.
import type { AgyEvent, PluginConfig } from '../common/types.ts'
import type { RunningProcess } from '../host/runner.ts'

export interface ToolWatchdog {
  printTimeoutMinutes: number
  attach: (proc: RunningProcess | null) => void
  markEvent: () => void
  trackStep: (ev: AgyEvent) => void
  stop: () => void
}

/**
 * agy tools that hand work to a subagent and leave the ROOT agent idle until the
 * subagent reports back. While one of these is outstanding, the
 * `root agent idle; waiting …` line is normal cooperation, not an orphaned
 * background command (issue #124).
 */
const SUBAGENT_COLLAB_TOOLS = new Set(['invoke_subagent', 'send_message', 'run_workflow', 'swarm'])

/**
 * Tools that hand work to the BACKGROUND and return `state === 'RUNNING'` with a
 * DETERMINISTIC finish: a scheduled wake-up reports back when its timer fires.
 * The root agent idles until then, so the reaper stays suspended for the wait
 * (issue #148).
 *
 * `run_command` is deliberately NOT here: agy also uses it for daemons (dev
 * servers, watchers) that never report back, and reclaiming those is exactly
 * what #119 exists for. A backgrounded BUILD is protected by agy's own count
 * instead — `waiting for N background task(s)` with N > 0 keeps the reaper
 * disarmed (see idle-line.ts).
 */
const BACKGROUND_WAIT_TOOLS = new Set(['schedule'])

function resolveWatchdogBudgets(cfg: PluginConfig) {
  const longToolIdleMinutes = cfg.longToolIdleMinutes > 0 ? cfg.longToolIdleMinutes : 0
  let printTimeoutMinutes = Math.max(
    longToolIdleMinutes > 0 ? longToolIdleMinutes : Math.ceil(cfg.timeoutMs / 60_000),
    Math.ceil(cfg.timeoutMs / 60_000),
  )
  if (cfg.maxTurnMinutes > 0 && printTimeoutMinutes > cfg.maxTurnMinutes) {
    printTimeoutMinutes = cfg.maxTurnMinutes
  }
  const longToolIdleMs = longToolIdleMinutes > 0 ? longToolIdleMinutes * 60_000 : cfg.timeoutMs
  const generationIdleMs = Math.max(cfg.timeoutMs, 15 * 60_000)
  return { printTimeoutMinutes, longToolIdleMs, generationIdleMs }
}

function isStepFailedOrCanceled(ev: Extract<AgyEvent, { kind: 'step' }>): boolean {
  return ev.state === 'ERROR' || ev.state === 'CANCELED' || ev.state === 'CANCELLED' || ev.tool?.error !== undefined
}

function isToolStepCompleted(ev: Extract<AgyEvent, { kind: 'step' }>): boolean {
  return (
    ev.state === 'DONE' ||
    ev.state === 'ERROR' ||
    ev.state === 'CANCELED' ||
    ev.state === 'CANCELLED' ||
    ev.state === 'RUNNING' ||
    (ev.state === undefined && (ev.tool?.output !== undefined || ev.tool?.error !== undefined))
  )
}

/**
 * Idle-budget + long-tool heartbeat state. While an agy tool step is ACTIVE the
 * child is legitimately silent on stdout (maven compile, language-server
 * build, …) — issue #33 — so the watchdog raises the idle budget; bare
 * generation gets a bounded floor so a hung SSE stream can fail and rotate.
 */
/**
 * Tracks backgrounded hand-offs whose completion agy will report later
 * (`schedule`). They hold the idle-grace exemption on their own: the mapper
 * treats `RUNNING` as a completed hand-off, so they never appear in
 * `openToolKeys`, yet the root agent is still waiting on them (issue #148).
 */
function createBackgroundWaits(onChange: () => void) {
  const keys = new Set<string>()
  return {
    note(stepKey: string, name: string, state: string | undefined, completed: boolean): void {
      if (!BACKGROUND_WAIT_TOOLS.has(name)) return
      const before = keys.size
      if (state === 'RUNNING') keys.add(stepKey)
      else if (completed) keys.delete(stepKey)
      if (keys.size !== before) onChange()
    },
    get active(): boolean {
      return keys.size > 0
    },
    clear(): void {
      keys.clear()
    },
  }
}

/** Heartbeat log line: what the turn is waiting on and for how long. */
function heartbeatMessage(openCount: number, oldestAt: number, sinceOutput: number, longToolIdleMs: number): string {
  const mins = Math.max(1, Math.round((Date.now() - (openCount === 0 && sinceOutput > 0 ? sinceOutput : oldestAt)) / 60_000))
  const budget = Math.round(longToolIdleMs / 60_000) + 'm'
  return openCount > 0
    ? 'agy tool step still running: ' + openCount + ' open, oldest ' + mins + 'm (idle budget ' + budget + ') — the turn is waiting on agy'
    : 'agy run still working: no new output for ' + mins + 'm (idle budget ' + budget + ') — the turn is waiting on agy; press Stop to cancel'
}

export function createToolWatchdog(log: ((msg: string) => void) | undefined, cfg: PluginConfig): ToolWatchdog {
  const openToolKeys = new Set<string>()
  const openToolSince = new Map<string, number>()
  const { printTimeoutMinutes, longToolIdleMs, generationIdleMs } = resolveWatchdogBudgets(cfg)
  let runningProc: RunningProcess | null = null
  let awaitingSubagent = false
  let sawAnyEvent = false
  let lastOutputAt = 0
  const TOOL_HEARTBEAT_MS = 5 * 60_000
  let toolHeartbeat: NodeJS.Timeout | null = null
  // The orphan reaper must stay suspended while agy is legitimately waiting on
  // work it launched — whether that is a subagent hand-off (#124) or ANY tool
  // step still open: a build / test command routinely runs far longer than the
  // old hard-coded 5 s grace (#144). The recording is re-armed as soon as the
  // last tool step completes, so a genuinely orphaned background job is still
  // reclaimed by the activity watchdog / maxTurnMinutes.
  let idleGraceExempt = false
  const backgroundWaits = createBackgroundWaits(() => syncIdleGraceExempt())
  const syncIdleGraceExempt = (): void => {
    const next = awaitingSubagent || openToolKeys.size > 0 || backgroundWaits.active
    if (next === idleGraceExempt) return
    idleGraceExempt = next
    runningProc?.exemptIdleGrace(next)
  }
  const apply = (): void => {
    runningProc?.noteActivity(openToolKeys.size > 0 ? longToolIdleMs : generationIdleMs)
    syncIdleGraceExempt()
  }
  const setAwaitingSubagent = (next: boolean): void => {
    if (awaitingSubagent === next) return
    awaitingSubagent = next
    syncIdleGraceExempt()
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
      log?.(heartbeatMessage(openToolKeys.size, oldest, lastOutputAt, longToolIdleMs))
    }, TOOL_HEARTBEAT_MS)
    toolHeartbeat.unref?.()
  }
  return {
    printTimeoutMinutes,
    attach: (proc) => {
      runningProc = proc
      proc?.exemptIdleGrace(idleGraceExempt)
      apply()
    },
    markEvent: () => {
      sawAnyEvent = true
      lastOutputAt = Date.now()
      start()
      apply()
    },
    trackStep: (ev) => {
      if (ev.kind !== 'step') return
      if (ev.stepKind === 'tool' && ev.tool !== undefined) {
        if (SUBAGENT_COLLAB_TOOLS.has(ev.tool.name)) {
          setAwaitingSubagent(!isStepFailedOrCanceled(ev))
        }
        // A backgrounded hand-off keeps the root agent waiting even though the
        // step counts as "completed" for mapper purposes (issue #148).
        // Only the exemption changes here: the idle BUDGET keeps the normal
        // generation window because the root agent runs no synchronous tool.
        backgroundWaits.note(ev.stepKey, ev.tool.name, ev.state, isToolStepCompleted(ev))
        // Mirror mapper's completion rule: DONE/ERROR/CANCELED/RUNNING state, or legacy events
        // that carry output/error without an explicit state.
        const completed = isToolStepCompleted(ev)
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
      } else if (ev.stepKind === 'text' || ev.stepKind === 'thinking') {
        // The root agent spoke again: a pending subagent wait is over.
        setAwaitingSubagent(false)
        // When the model resumes generating text or thinking, no tool is running synchronously.
        // Any previously open tool has completed or backgrounded. Clear openToolKeys so the
        // idle budget restores to normal generationIdleMs instead of staying raised.
        // `backgroundWaitKeys` is deliberately NOT cleared: agy asks the model for a
        // short status line BEFORE it prints the idle line, so this text is part of
        // the wait, not the end of it (issue #148).
        if (openToolKeys.size > 0) {
          openToolKeys.clear()
          openToolSince.clear()
          apply()
          stop()
        }
      }
    },
    stop: () => {
      stop()
      awaitingSubagent = false
      openToolKeys.clear()
      openToolSince.clear()
      backgroundWaits.clear()
      syncIdleGraceExempt()
    },
  }
}
