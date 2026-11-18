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
  const apply = (): void => {
    runningProc?.noteActivity(openToolKeys.size > 0 ? longToolIdleMs : generationIdleMs)
  }
  const setAwaitingSubagent = (next: boolean): void => {
    if (awaitingSubagent === next) return
    awaitingSubagent = next
    runningProc?.exemptIdleGrace(next)
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
      proc?.exemptIdleGrace(awaitingSubagent)
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
      setAwaitingSubagent(false)
      openToolKeys.clear()
      openToolSince.clear()
    },
  }
}
