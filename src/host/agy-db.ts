// Read full tool parameters and thought text from the Antigravity (agy)
// conversation database.
//
// agy's stream-json output applies `filterToolParameters` which strips large
// content fields (CodeContent, TargetContent, ReplacementContent, etc.) from
// the tool_info parameters to keep the stream compact. Only "metadata" fields
// like TargetFile survive. This means the DSH-side mirror arguments arrive
// incomplete — a replace_file_content step only carries {TargetFile} instead
// of the full {TargetFile, TargetContent, ReplacementContent, ...}.
//
// The reader itself now lives in src/runtime/agy/db/ (path resolution, schema,
// protobuf extraction, SQLite open/query and the shared cache). This module is
// kept as the stable import surface, so callers (and tests) are unchanged.
export * from '../runtime/agy/db/index.ts'
