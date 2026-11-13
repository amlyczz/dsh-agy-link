import type { HostServices } from '../../../host/services.ts'
import { runRoute, sendJson, readBody, methodOf, queryParam, type RawRes, type RouteRegistrar } from '../respond.ts'

function handleTranslate(services: HostServices, req: unknown, res: unknown): void {
  const { translation } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req, true)
        if (body.__invalidJson === true) {
          sendJson(res as RawRes, 400, { error: 'invalid JSON body' })
          return
        }
        const text = typeof body.text === 'string' ? body.text : ''
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const messageId = typeof body.messageId === 'string' ? body.messageId : ''
        const turn = typeof body.turn === 'number' && Number.isFinite(body.turn) ? body.turn : undefined
        const force = body.force === true
        const full = body.full === true
        const persist = body.persist !== false
        const model = typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim() : undefined
        const effort = typeof body.effort === 'string' && body.effort.trim() !== '' ? body.effort.trim() : undefined
        const lang = typeof body.lang === 'string' && body.lang.trim() !== '' ? body.lang.trim() : undefined
        const opts = {
          force,
          full,
          persist,
          ...(model === undefined ? {} : { model }),
          ...(effort === undefined ? {} : { effort }),
          ...(lang === undefined ? {} : { targetLanguage: lang }),
        }
        try {
          let result
          if (text.trim() !== '') {
            result = await translation.translate({
              text,
              force,
              ...(model === undefined ? {} : { model }),
              ...(effort === undefined ? {} : { effort }),
              ...(lang === undefined ? {} : { targetLanguage: lang }),
            })
          } else if (sessionId !== '' && messageId !== '') {
            result = await translation.translateMessage(sessionId, messageId, opts)
          } else if (sessionId !== '' && turn !== undefined) {
            result = await translation.translateTurn(sessionId, turn, opts)
          } else if (sessionId !== '') {
            result = await translation.translateLastTurn(sessionId, opts)
          } else {
            sendJson(res as RawRes, 400, { error: 'text, or sessionId (+ turn/messageId), is required' })
            return
          }
          const status =
            result.ok
              ? 200
              : result.code === 'TRANSIENT'
                ? 409
                : result.code === 'TURN_NOT_FOUND' || result.code === 'MESSAGE_NOT_FOUND' || result.code === 'EMPTY_TEXT'
                  ? 400
                  : 502
          sendJson(res as RawRes, status, result)
        } catch (e) {
          sendJson(res as RawRes, 500, { error: String(e) })
        }
      })
}

function handleTranslatePending(services: HostServices, req: unknown, res: unknown): void {
  const { translation } = services
      const session = queryParam(req, 'session')
      sendJson(res as RawRes, 200, {
        items: translation.pendingFor(session === '' ? undefined : session),
        stats: translation.stats(),
      })
}

function handleTranslateTurn(services: HostServices, req: unknown, res: unknown): void {
  const { translation } = services
      const session = queryParam(req, 'session')
      const turn = Number(queryParam(req, 'turn'))
      if (session === '' || !Number.isFinite(turn)) {
        sendJson(res as RawRes, 400, { error: 'session and turn are required' })
        return
      }
      const existing = translation.existingTurn(session, turn)
      sendJson(res as RawRes, 200, existing === null
        ? { state: 'idle' }
        : { state: 'ready', seq: existing.seq, model: existing.model, effort: existing.effort })
}

function handleTranslateState(services: HostServices, req: unknown, res: unknown): void {
  const { translation } = services
      const session = queryParam(req, 'session')
      const message = queryParam(req, 'message')
      if (session === '' || message === '') {
        sendJson(res as RawRes, 400, { error: 'session and message are required' })
        return
      }
      const existing = translation.existingMessage(session, message)
      if (existing !== null) {
        sendJson(res as RawRes, 200, { state: 'ready', seq: existing.seq, model: existing.model, effort: existing.effort })
        return
      }
      sendJson(res as RawRes, 200, { state: translation.isPending(session) ? 'busy' : 'idle' })
}

export function register(reg: RouteRegistrar, services: HostServices): void {
  reg({ kind: 'exact', path: '/plugins/agy-link/translate', handler: (req, res) => handleTranslate(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/translate/pending', handler: (req, res) => handleTranslatePending(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/translate/turn', handler: (req, res) => handleTranslateTurn(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/translate/state', handler: (req, res) => handleTranslateState(services, req, res) })
}
