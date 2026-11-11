// Shared vocabulary for dsh-agy-link: plugin config, provider-route ids,
// stable error codes, failure classification, and the normalized event stream
// produced by the stream-json parser and consumed by the StreamChunk mapper.
//
// The declarations live in ./types/* grouped by concern; this file stays the
// single import surface (and keeps every export's identity unchanged).
export * from './types/config.ts'
export * from './types/failures.ts'
export * from './types/errors.ts'
export * from './types/events.ts'
export * from './types/diagnostics.ts'
