// Bounded JSON body reader for the plugin's HTTP surfaces.
//
// Both the loopback MCP bridge (/call) and the plugin's web routes
// (/plugins/agy-link/*) used to buffer an unbounded request body, so a local
// client — including a prompt-injected agy child holding the bridge token, or a
// page able to POST to the plugin routes — could exhaust host memory by
// streaming a huge body. This centralizes a size-capped reader so the limit and
// the parse/strict semantics live in one tested place instead of drifting.

/** Default cap: plugin payloads are tiny config JSON; 1 MiB is already generous. */
export const DEFAULT_JSON_BODY_MAX_BYTES = 1 * 1024 * 1024

export interface ReadJsonBodyOptions {
  /** Max buffered bytes. Bodies larger than this resolve with `tooLarge: true`. */
  maxBytes?: number
}

export interface ReadJsonBodyResult {
  /** Parsed object (never an array/primitive), or {} when invalid / too large. */
  value: Record<string, unknown>
  /** True when the body exceeded `maxBytes` and was discarded. */
  tooLarge: boolean
  /** True when the body was absent or not a JSON object. */
  invalid: boolean
}

/** Minimal structural view of an IncomingMessage we need (keeps tests simple). */
interface BodyEmitter {
  on?(event: string, cb: (chunk?: Buffer) => void): void
}

export function readJsonBody(
  req: unknown,
  opts: ReadJsonBodyOptions = {},
): Promise<ReadJsonBodyResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_JSON_BODY_MAX_BYTES
  const emitter = req as BodyEmitter
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    const done = (result: ReadJsonBodyResult): void => resolve(result)
    emitter.on?.('data', (chunk) => {
      const buf = chunk ?? Buffer.alloc(0)
      size += buf.length
      if (size > maxBytes) {
        // Stop buffering but keep draining so the caller can still respond.
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(buf)
    })
    emitter.on?.('end', () => {
      if (tooLarge) return done({ value: {}, tooLarge: true, invalid: false })
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return done({ value: parsed as Record<string, unknown>, tooLarge: false, invalid: false })
        }
        return done({ value: {}, tooLarge: false, invalid: true })
      } catch {
        return done({ value: {}, tooLarge: false, invalid: true })
      }
    })
    emitter.on?.('error', () => done({ value: {}, tooLarge: false, invalid: true }))
  })
}
