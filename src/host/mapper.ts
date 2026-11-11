// Facade for the event -> StreamChunk mapper. The implementation now lives in
// `src/provider/mapper/` (event mapping, tool-block assembly, usage/thought
// mapping); this module keeps the historical export surface so existing
// importers (src/provider/span.ts and the tests) are unchanged.
export { EventMapper } from '../provider/mapper/event-mapper.ts'
export type { EventMapperOptions } from '../provider/mapper/event-mapper.ts'
export {
  consumeToolBinding,
  expirePendingToolCalls,
  rememberToolCallId,
  toToolCallId,
} from '../provider/mapper/tool-calls.ts'
export type { ToolCallBinding, ToolCallState } from '../provider/mapper/tool-calls.ts'
export { usageFromRaw } from '../provider/mapper/usage.ts'
export { rewriteImageMarkdown, suffixDelta } from '../provider/mapper/text.ts'
