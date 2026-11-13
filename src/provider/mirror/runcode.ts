// run_code wrapper generation and cursor parsing for the mirror.
//
// MOVED VERBATIM from src/host/mirror-tool.ts (Phase 5h).
/**
 * Build the run_code tool-call arguments that replay one recorded agy tool
 * step. The deployment's tool-dispatch policy only allows `run_code` as a
 * direct model call (everything else must be invoked from inside a
 * program), so the span cut addresses run_code with a generated program
 * whose single statement calls the registered mirror tool — the inner
 * dispatch is what renders the native tool card.
 */
export function buildMirrorRunCode(
  runId: string,
  eventIndex: number,
  toolName: string,
  brief?: string,
): { code: string; description: string } {
  const invocation = JSON.stringify({ run: runId, step: eventIndex })
  const label = brief !== undefined && brief !== ''
    ? brief
    : toolName
  return {
    code:
      '// dsh-agy-link mirror: replay recorded agy tool step ' +
      eventIndex +
      ' (' +
      toolName +
      ')\n' +
      "await tools['agy_tool'](" +
      invocation +
      ')',
    // Keep the wire tool name visible but surface a human preview first so
    // Code Mode rows are not a wall of "replay agy tool step N".
    description: brief !== undefined && brief !== '' ? brief + ' · ' + toolName : toolName,
  }
}

/** Extract the (run, step) cursor embedded by buildMirrorRunCode. */
export function parseMirrorInvocation(code: string): { run: string; step: number } | null {
  const m = /tools\['agy_tool'\]\((\{"run":.*?,"step":\d+\})\)/.exec(code)
  if (m === null) return null
  try {
    const v = JSON.parse(m[1] as string) as { run?: unknown; step?: unknown }
    if (typeof v.run === 'string' && typeof v.step === 'number') return { run: v.run, step: v.step }
    return null
  } catch {
    return null
  }
}