// GET /plugins/agy-link/orchestration?session=<id>
//
// The right-sidebar 编排 page's single read: which seats are running, the
// planner's plan, the agent's checklist, the tool flow of the current turn, the
// subagents (merged out of the header popover), the real context window and the
// per-seat token totals.
//
// All of it is host-side state the ACP stream never exposed: the seat split comes
// from transcript.jsonl, the plan/mode/title from the sessionUpdates the mapper
// used to drop, and the window from `usage_update.size`.
import type { HostServices } from '../../../host/services.ts'
import { snapshotOrchestration } from '../../../features/orchestration/live.ts'
import { queryParam, runRoute, sendJson, type RawRes, type RouteRegistrar } from '../respond.ts'

function handleOrchestration(_services: HostServices, req: unknown, res: unknown): void {
  runRoute(res, async () => {
    const session = queryParam(req, 'session')
    sendJson(res as RawRes, 200, {
      ok: true,
      orchestration: snapshotOrchestration(session),
    })
  })
}

export function register(reg: RouteRegistrar, services: HostServices): void {
  reg({
    kind: 'exact',
    path: '/plugins/agy-link/orchestration',
    handler: (req, res) => handleOrchestration(services, req, res),
  })
}