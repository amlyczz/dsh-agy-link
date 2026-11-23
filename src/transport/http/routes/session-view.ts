// GET /plugins/agy-link/session-view?session=<id>
//
// One session's truthful account readout: the model selected in this session,
// its quota family, the account serving it, and that family's own remaining
// quota. Kept separate from `/status` because `/status` is a single shared,
// ETagged snapshot for the whole process while this answer is per conversation
// (the header badge is per conversation and used to show the google pointer,
// contradicting an Argon/GPT-OSS session — reported 2026-11-23).
import type { HostServices } from '../../../host/services.ts'
import { resolveSessionView } from '../../../host/session-view.ts'
import { queryParam, runRoute, sendJsonWithEtag, type RawRes, type RouteRegistrar } from '../respond.ts'

function handleSessionView(services: HostServices, req: unknown, res: unknown): void {
  runRoute(res, async () => {
    const session = queryParam(req, 'session')
    sendJsonWithEtag(req, res as RawRes, 200, resolveSessionView(services, session))
  })
}

export function register(reg: RouteRegistrar, services: HostServices): void {
  reg({ kind: 'exact', path: '/plugins/agy-link/session-view', handler: (req, res) => handleSessionView(services, req, res) })
}