// Shared HTTP primitives for the plugin's /plugins/agy-link/* surface.
// Moved verbatim out of apply(): the bounded strict-body reader, the JSON
// writer and the small request accessors every route module needs.
import { readJsonBody } from '../../host/read-json-body.ts'

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

export const sendJson = (res: RawRes, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
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
