// agy_tool — the native-UI mirror (v0.3).
//
// The adapter cuts each completed agy tool step into a finish:tool-calls span
// addressed to THIS tool. It executes instantly (the output was already
// recorded by the agy child process) and returns it as the tool result, so
// DSH records genuine tool/call + tool/result session events and renders the
// activity with its own dedicated tool-card UI. presentCall/presentResult map
// the mirrored agy tool onto the provider-neutral card vocabulary: agy
// run_command becomes a terminal card, write_to_file an inline diff card, and
// reads/searches generic cards with the right icon kind. Presenters are pure
// functions of the arguments, so session-log replays render identically.
//
// Phase 5h moved the implementation into src/provider/mirror/:
//   names.ts       tool/wrapper names
//   args.ts        recorded-arg reading and MCP unwrapping
//   git-head.ts    committed HEAD content for write diffs
//   runcode.ts     run_code wrapper generation + cursor parsing
//   brief.ts       short human step previews
//   present.ts     native call/result card projection
//   definition.ts  tool definition + degraded-recording notice
// The exports and signatures below are unchanged.
export {
  MIRROR_TOOL_NAME,
  WRAPPER_TOOL_NAME,
} from '../provider/mirror/names.ts'
export { getGitHeadContent } from '../provider/mirror/git-head.ts'
export { buildMirrorRunCode, parseMirrorInvocation } from '../provider/mirror/runcode.ts'
export { toolStepBrief } from '../provider/mirror/brief.ts'
export {
  cleanResultText,
  cleanString,
  parseInnerArgs,
  unwrapMcpTool,
  type UnwrappedToolCall,
} from '../provider/mirror/args.ts'
export { presentMirrorCall, presentMirrorResult } from '../provider/mirror/present.ts'
export { defineAgyMirrorTool, recordingUnavailable } from '../provider/mirror/definition.ts'