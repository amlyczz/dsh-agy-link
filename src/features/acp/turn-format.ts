// Small pure formatting constants for one ACP turn.

/**
 * How long we watch a fresh ACP turn for its first event before handing the
 * recording back to the caller. A turn that dies without emitting anything is
 * the signature of a transport that is up but cannot reach Google; waiting for
 * the whole idle budget first would make the CLI fallback feel like a hang.
 */
export const FIRST_OUTPUT_GATE_MS = 20_000

/** First non-empty line of a payload, bounded for a one-line failure message. */
export function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '')
  return (line ?? text).trim().slice(0, 240)
}