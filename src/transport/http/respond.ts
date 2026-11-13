// Shared HTTP primitives for the plugin's /plugins/agy-link/* surface.
// Moved verbatim out of apply(): the bounded strict-body reader, the JSON
// writer and the small request accessors every route module needs.
import { readJsonBody } from '../../host/read-json-body.ts'
import { ROUTE_TIMEOUT_MS } from '../../common/timeouts.ts'

export { ROUTE_TIMEOUT_MS }

export type StatusWriter = {
  writeHead(status: number, headers: Record<string, string>): unknown
  end(body?: unknown): unknown
};
export type RawReq = {
  method?: string
  on(event: string, cb: (chunk: Buffer) => void): unknown
};
export type RawRes = StatusWriter;
export type WebServerLike = {
  port?: number;
  register(route: Route): unknown;
};

export type RouteHandler = (req: unknown, res: unknown) => void;
export type Route = { kind: string; path: string; handler: RouteHandler };
export type RouteRegistrar = (route: Route) => void;

/** Every plugin HTTP response has a hard deadline (see common/timeouts.ts). */
/** WeakSet: `sendJson` must be exactly-once per response, even after a timeout. */
const answered = new WeakSet<object>();

export const sendJson = (res: RawRes, status: number, body: unknown): void => {
  if (answered.has(res as object)) return;
  answered.add(res as object);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * Run one async route body with a GUARANTEED single response:
 *  - normal path: the body sends whatever it likes;
 *  - a rejection (thrown by a dependency, or a bug): 500 with `ok:false`;
 *  - a hung promise past `ROUTE_TIMEOUT_MS`: 504 with `ok:false`.
 *
 * `sendJson` is exactly-once, so a late body can never write a second head
 * (`ERR_HTTP_HEADERS_SENT`) after a timeout. Every async route uses this one
 * helper instead of a bare `void (async () => …)()` — there is no second
 * error-handling copy to drift.
 */
export function runRoute(
  res: unknown,
  body: () => Promise<void>,
  timeoutMs: number = ROUTE_TIMEOUT_MS,
): void {
  const raw = res as RawRes;
  const timer = setTimeout(() => {
    sendJson(raw, 504, { ok: false, error: 'request timed out' });
  }, timeoutMs);
  // A pending route must never keep the host process alive on shutdown.
  timer.unref?.();
  void body()
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(raw, 500, { ok: false, error: message });
    })
    .finally(() => clearTimeout(timer));
}

// Bounded, shared JSON reader (see ./host/read-json-body.ts): plugin
// payloads are small config JSON, and an unbounded buffer let a local
// client exhaust host memory by streaming a huge POST body.
export const readBody = async (req: unknown, strict = false): Promise<Record<string, unknown>> => {
  const result = await readJsonBody(req)
  // Strict callers must be able to tell malformed/oversized bodies from
  // `{}`: an empty body must not silently become "do it for all accounts".
  if (result.invalid || result.tooLarge) return strict ? { __invalidJson: true } : {}
  return result.value
};

export const methodOf = (req: unknown): string => {
  const m = (req as { method?: unknown }).method
  return typeof m === 'string' ? m.toUpperCase() : 'GET'
};

export const queryParam = (req: unknown, key: string): string => {
  const rawUrl = (req as { url?: unknown }).url
  if (typeof rawUrl !== 'string') return ''
  const m = new RegExp('[?&]' + key + '=([^&]+)').exec(rawUrl)
  if (m === null) return ''
  const raw = m[1] ?? ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
};
