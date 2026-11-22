// Shared classifier for false-positive `Error: unknown tool "agy_tool"` results.
//
// `agy_tool` is a synthetic mirror registered by dsh-agy-link to replay tool
// steps that ALREADY finished inside the agy child process. If the plugin
// reloads (HMR / bundle update / `tools` sub-fiber restart) or an agent scope
// restricts global tools in the narrow window between yielding a tool-call
// block and DSH executing it, DSH records `ToolNotFoundError (UNKNOWN_TOOL):
// Error: unknown tool "agy_tool"`. That error is never a failure of the
// underlying agy tool.

const MIRROR_UNKNOWN_TOOL_RE =
  /^\s*(?:Error:\s*)?unknown tool\s+["'`]?agy_tool["'`]?(?:\s*:|\s*$)/i

export const MIRROR_TOOL_RELOAD_NOTICE =
  'Step already executed in agy (result replay skipped during bridge reload — not a tool error).'

/** True when a tool-result text is DSH's transient `unknown tool "agy_tool"` miss. */
export function isMirrorToolNotFoundText(text: string): boolean {
  if (text === '') return false
  return MIRROR_UNKNOWN_TOOL_RE.test(text.trim())
}
