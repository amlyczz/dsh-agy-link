// GET /plugins/agy-link/tool-seats?run=<runId>
//
// The lookup the tool cards render from: `{ "16": { seat: "planner", … } }`.
// Cards know only their own `{ run, step }` arguments, so this is the smallest
// bridge between them and the seat attribution the host derived from the
// transcript while the step ran.
import type { HostServices } from '../../../host/services.ts'
import { toolSeatsForRun } from '../../../features/orchestration/tool-seats.ts'
import { queryParam, runRoute, sendJson, type RawRes, type RouteRegistrar } from '../respond.ts'

function handleToolSeats(_services: HostServices, req: unknown, res: unknown): void {
  runRoute(res, async () => {
    const run = queryParam(req, 'run')
    sendJson(res as RawRes, 200, { ok: true, seats: toolSeatsForRun(run) })
  })
}

export function register(reg: RouteRegistrar, services: HostServices): void {
  reg({ kind: 'exact', path: '/plugins/agy-link/tool-seats', handler: (req, res) => handleToolSeats(services, req, res) })
}