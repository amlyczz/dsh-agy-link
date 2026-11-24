// HTTP surface + SSE stream for `/btw` side questions.
import type { HostServices } from '../../../host/services.ts'
import { methodOf, queryParam, readBody, runRoute, sendJson, type RawRes, type RouteRegistrar } from '../respond.ts'

type SseRes = RawRes & {
  write?: (chunk: string) => boolean
}

type Closeable = {
  on?: (event: string, cb: () => void) => unknown
}

function handleState(services: HostServices, req: unknown, res: unknown): void {
  if (methodOf(req) !== 'GET') {
    sendJson(res as RawRes, 405, { ok: false, error: 'GET only' })
    return
  }
  const session = queryParam(req, 'session').trim()
  if (session === '') {
    sendJson(res as RawRes, 400, { ok: false, error: 'session query parameter is required' })
    return
  }
  sendJson(res as RawRes, 200, { ok: true, state: services.btw.view(session) })
}

function handleStream(services: HostServices, req: unknown, res: unknown): void {
  if (methodOf(req) !== 'GET') {
    sendJson(res as RawRes, 405, { ok: false, error: 'GET only' })
    return
  }
  const session = queryParam(req, 'session').trim()
  if (session === '') {
    sendJson(res as RawRes, 400, { ok: false, error: 'session query parameter is required' })
    return
  }
  const raw = res as SseRes
  if (typeof raw.write !== 'function') {
    sendJson(raw, 200, { ok: true, state: services.btw.view(session) })
    return
  }
  try {
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })
  } catch {
    return
  }

  let closed = false
  let unsub: (() => void) | null = null
  let keepalive: ReturnType<typeof setInterval> | null = null
  const cleanup = (): void => {
    if (closed) return
    closed = true
    if (keepalive !== null) {
      clearInterval(keepalive)
      keepalive = null
    }
    unsub?.()
    unsub = null
  }
  const sendState = (state: unknown): void => {
    if (closed) return
    try {
      raw.write?.(`event: state\ndata: ${JSON.stringify(state)}\n\n`)
    } catch {
      cleanup()
    }
  }

  unsub = services.btw.subscribe(session, (state) => sendState(state))
  sendState(services.btw.view(session))

  keepalive = setInterval(() => {
    if (closed) return
    try {
      raw.write?.(': keepalive\n\n')
    } catch {
      cleanup()
    }
  }, 20_000)
  keepalive.unref?.()

  ;(req as Closeable)?.on?.('close', cleanup)
  ;(res as Closeable)?.on?.('close', cleanup)
}

function handleAsk(services: HostServices, req: unknown, res: unknown): void {
  runRoute(res, async () => {
    if (methodOf(req) !== 'POST') {
      sendJson(res as RawRes, 405, { error: 'POST only' })
      return
    }
    const body = await readBody(req, true)
    if (body.__invalidJson === true) {
      sendJson(res as RawRes, 400, { ok: false, error: 'invalid JSON body' })
      return
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    const question = typeof body.question === 'string' ? body.question.trim() : ''
    if (sessionId === '' || question === '') {
      sendJson(res as RawRes, 400, { ok: false, error: 'sessionId and question are required' })
      return
    }
    const model = typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim() : undefined
    const effort = typeof body.effort === 'string' && body.effort.trim() !== '' ? body.effort.trim() : undefined
    const started = services.btw.start({
      sessionId,
      question,
      followUp: body.followUp === true,
      newThread: body.newThread === true,
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
    })
    sendJson(res as RawRes, 200, { ok: true, entryId: started.entryId, state: started.view })
  })
}

function handleCancel(services: HostServices, req: unknown, res: unknown): void {
  runRoute(res, async () => {
    if (methodOf(req) !== 'POST') {
      sendJson(res as RawRes, 405, { error: 'POST only' })
      return
    }
    const body = await readBody(req, true)
    if (body.__invalidJson === true) {
      sendJson(res as RawRes, 400, { ok: false, error: 'invalid JSON body' })
      return
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (sessionId === '') {
      sendJson(res as RawRes, 400, { ok: false, error: 'sessionId is required' })
      return
    }
    const cancelled = services.btw.cancel(sessionId)
    sendJson(res as RawRes, 200, { ok: true, cancelled, state: services.btw.view(sessionId) })
  })
}

function handleDismiss(services: HostServices, req: unknown, res: unknown): void {
  runRoute(res, async () => {
    if (methodOf(req) !== 'POST') {
      sendJson(res as RawRes, 405, { error: 'POST only' })
      return
    }
    const body = await readBody(req, true)
    if (body.__invalidJson === true) {
      sendJson(res as RawRes, 400, { ok: false, error: 'invalid JSON body' })
      return
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (sessionId === '') {
      sendJson(res as RawRes, 400, { ok: false, error: 'sessionId is required' })
      return
    }
    const current = services.btw.view(sessionId)
    const open = typeof body.open === 'boolean' ? body.open : current.open
    const activeIndex = typeof body.activeIndex === 'number' ? body.activeIndex : undefined
    const state = services.btw.dismiss(sessionId, open, activeIndex)
    sendJson(res as RawRes, 200, { ok: true, state })
  })
}

function handleClear(services: HostServices, req: unknown, res: unknown): void {
  runRoute(res, async () => {
    if (methodOf(req) !== 'POST') {
      sendJson(res as RawRes, 405, { error: 'POST only' })
      return
    }
    const body = await readBody(req, true)
    if (body.__invalidJson === true) {
      sendJson(res as RawRes, 400, { ok: false, error: 'invalid JSON body' })
      return
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (sessionId === '') {
      sendJson(res as RawRes, 400, { ok: false, error: 'sessionId is required' })
      return
    }
    const state = services.btw.clear(sessionId)
    sendJson(res as RawRes, 200, { ok: true, state })
  })
}

export function register(reg: RouteRegistrar, services: HostServices): void {
  reg({ kind: 'exact', path: '/plugins/agy-link/btw/state', handler: (req, res) => handleState(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/btw/stream', handler: (req, res) => handleStream(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/btw/ask', handler: (req, res) => handleAsk(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/btw/cancel', handler: (req, res) => handleCancel(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/btw/dismiss', handler: (req, res) => handleDismiss(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/btw/clear', handler: (req, res) => handleClear(services, req, res) })
}
