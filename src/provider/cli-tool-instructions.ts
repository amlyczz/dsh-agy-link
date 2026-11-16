// Adapt only complete native TypeScript PTC sections at the CLI boundary.
const PTC_ONLY_INSTRUCTION = '`run_code` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.'
const CLI_TOOL_INSTRUCTION = 'Use the DSH MCP tools by calling their exposed names directly. This CLI has no run_code transport and cannot execute the program-only tools.* SDK bindings. For a tool that is not exposed, call the MCP dev_tool_search tool with query to find its name, then toolNames with exact names to unlock. After unlocking, refresh tools/list (honour notifications/tools/list_changed) and use the refreshed schema before calling the newly exposed tool. Use only tools actually returned by MCP; all task, permission and safety instructions remain in force.'
const HEADING = '## Writing code for run_code\n\n'
const CODE_ARGUMENT = '`run_code` takes two required arguments: `code`'
const END_PROSE = 'A declaration does not make its name a directly callable tool; only names supplied as separate tool schemas may be called directly.'
const SDK_TAIL = 'declare const tools: {\n  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;\n}\n```'

/** Leave unknown or incomplete instructions untouched; never rewrite task prose. */
export function adaptCliSystemPrompt(system: string): string {
  // Normalise only for matching; all surviving source text keeps its line endings.
  const text = system.replaceAll('\r\n', '\n')
  if (!text.split('\n').includes(PTC_ONLY_INSTRUCTION)) return system
  const marker = text.indexOf(HEADING)
  if (marker < 0 || (marker > 0 && text[marker - 1] !== '\n')) return system
  // A quoted code sample is not the active native SDK section.
  if (text.slice(0, marker).split('\n').filter((line) => /^```|^~~~/.test(line)).length % 2 !== 0) return system
  const fence = text.indexOf('\n```ts\n', marker)
  if (fence < 0) return system
  const prefix = text.slice(marker + HEADING.length, fence)
  // Native renderers use either comma-separated or em-dash argument prose.
  if (!prefix.startsWith(CODE_ARGUMENT + ', ') && !prefix.startsWith(CODE_ARGUMENT + ' — ')) return system
  if (!prefix.includes(END_PROSE) || !prefix.includes('\n\nInside the program:\n\n- Call tools as `await tools.name(args)`') || !prefix.endsWith('Program-only SDK bindings:\n')) return system
  const close = text.indexOf('\n```', fence + 7)
  if (close < 0) return system
  const end = close + 4
  if (end < text.length && text[end] !== '\n') return system
  const sdk = text.slice(fence, end)
  if (!sdk.startsWith('\n```ts\ntype JsonValue = ') || !sdk.includes('\ninterface ToolArgsMap {') || !sdk.includes('\ninterface ToolOutputMap {') || !sdk.includes('\ntype ToolName = keyof ToolOutputMap\n') || !sdk.includes('\ndeclare class ToolCallError extends Error {') || !sdk.endsWith(SDK_TAIL)) return system
  const originalOffset = (offset: number) => {
    let result = offset
    for (const match of system.matchAll(/\r\n/g)) {
      if (match.index >= result) break
      result += 1
    }
    return result
  }
  // The active transport paragraph precedes the generated SDK. Never rewrite its tail.
  const before = system.slice(0, originalOffset(marker))
  if (!before.split(/\r?\n/).includes(PTC_ONLY_INSTRUCTION)) return system
  const adapted = before.split(/(\r?\n)/).map((line) => line === PTC_ONLY_INSTRUCTION ? CLI_TOOL_INSTRUCTION : line).join('')
  return adapted + CLI_TOOL_INSTRUCTION + system.slice(originalOffset(end))
}
