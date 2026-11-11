// agy_tool definition and the degraded-recording notice.
//
// MOVED VERBATIM from src/host/mirror-tool.ts (Phase 5h): same tool name,
// description, parameters, presenters and execute body.
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { RunRegistry } from '../../host/recording.ts'
import { toolInput, unwrapMcpTool } from './args.ts'
import { toolStepBrief } from './brief.ts'
import { MIRROR_TOOL_NAME } from './names.ts'
import { presentMirrorCall, presentMirrorResult } from './present.ts'

/** Short preview of the recorded step for the degraded-result message. */
function stepLabel(toolName: string, input: unknown): string {
  if (toolName === '') return ''
  return toolStepBrief(toolName, input)
}

/**
 * Degraded result for a mirrored step whose recording is gone (bridge
 * restarted, or the run was recycled while a wedged tool step held the span
 * for hours). It must NOT read like a harness error: the model used to
 * receive `no recorded agy run` and spent the whole turn reverse-engineering
 * this plugin instead of finishing the user's task (flash-blast incident,
 * 2026-10-10). The step really did run — only its replay is unavailable.
 */
export function recordingUnavailable(step: number, toolName: string, input?: unknown, reason?: string): string {
  const label = stepLabel(toolName, input)
  const why = reason !== undefined && reason !== ''
    ? reason
    : 'the step ran for a long time and the in-memory recording was recycled'
  return (
    '⚠ [agy bridge] This agy tool step executed, but its recorded output is no longer resident ' +
    'in the bridge (' + why + '). ' +
    'Nothing is wrong with the tool or the workspace, and there is nothing to debug here — ' +
    'do NOT investigate the bridge, its logs or this message; continue the user\'s task. ' +
    'If the output is needed, re-run the same operation as a new step. ' +
    'Step #' + step + (label !== '' ? ': ' + label : '')
  )
}

export function defineAgyMirrorTool(deps: { runs: RunRegistry }) {
  // Presenter-side enrichment: when the invocation carries only the
  // (run, step) cursor — which is all the generated run_code wrapper
  // embeds — resolve the tool name/input from the recording so cards still
  // render with full detail. Keeps replayed sessions identical to live ones.
  const enrichArgs = (args: Record<string, unknown>): Record<string, unknown> => {
    let tool = typeof args.tool === 'string' ? args.tool : ''
    let input = args.input
    let server = typeof args.server === 'string' ? args.server : undefined
    if (tool === '' || /^(call_mcp_tool|callMcpTool|call_mcp|mcp_call)$/i.test(tool)) {
      const runId = typeof args.run === 'string' ? args.run : ''
      const step = typeof args.step === 'number' ? args.step : -1
      const t = deps.runs.get(runId)?.toolEventAt(step) ?? null
      if (t !== null) {
        if (tool === '') tool = t.name
        input ??= t.args
      }
    }
    const unwrapped = unwrapMcpTool(tool, input)
    return {
      ...args,
      tool: unwrapped.tool,
      input: unwrapped.input,
      ...(unwrapped.server ? { server: unwrapped.server } : server ? { server } : {}),
    }
  }
  return defineTool({
    name: MIRROR_TOOL_NAME,
    description:
      'Internal to the dsh-agy-link bridge: replays one tool activity recorded from a Google Antigravity (agy) CLI run so it renders as a native tool card and rides the agent loop. Emitted automatically by the antigravity provider — do not call it directly.',
    parameters: {
      run: { type: 'string', required: true, description: 'Recording run id.' },
      step: { type: 'number', required: true, description: 'Recorded event index of the tool step.' },
      tool: { type: 'string', description: 'agy tool name that ran (optional — resolved from the recording).' },
      input: { type: 'json', description: 'agy tool arguments as recorded (optional — resolved from the recording).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    presentCall: (args) => presentMirrorCall(enrichArgs(args as Record<string, unknown>)),
    presentResult: (args, result) => presentMirrorResult(enrichArgs(args as Record<string, unknown>), result),
    async execute(args, exec) {
      void exec.signal
      const runId = typeof args.run === 'string' ? args.run : ''
      const step = typeof args.step === 'number' ? args.step : -1
      const toolName = typeof args.tool === 'string' ? args.tool : ''
      const input = toolInput(args as { input?: unknown })
      const rec = deps.runs.get(runId)
      if (rec === undefined) {
        // The recording was recycled (or the bridge restarted) while this
        // step's replay was still queued. Degrade to an explicit, task-facing
        // notice instead of throwing a harness-internal error at the model.
        return recordingUnavailable(step, toolName, input)
      }
      const t = rec.toolEventAt(step)
      if (t === null) {
        // Distinguish WHY the step cannot be replayed: an out-of-range or
        // non-tool event index is a cursor problem (the step may not even have
        // happened yet), not "the output was recycled" — blaming recycling
        // there would send the model hunting for lost output that never was
        // recorded. `rec.length` bounds the recording; toolEventAt only
        // resolves completed tool steps.
        const ev = step >= 0 && step < rec.length ? rec.eventAt(step) : undefined
        const reason = ev === undefined
          ? 'the step index is outside this recording — the step has not been recorded (yet), or the bridge restarted'
          : 'event #' + step + ' in this recording is not a completed tool step'
        return recordingUnavailable(step, toolName !== '' ? toolName : 'unknown', input, reason)
      }
      if (t.error !== undefined) {
        throw new Error('agy tool ' + t.name + ' failed: ' + t.error)
      }
      const out = t.output
      if (out === undefined || out === null) return ''
      if (typeof out === 'string') return out
      try {
        return JSON.stringify(out, null, 2)
      } catch {
        return String(out)
      }
    },
  })
}