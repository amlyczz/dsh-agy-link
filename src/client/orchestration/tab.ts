// Register the 编排 tab type with the right Sidebar, and open it on demand.
//
// A tab type registers in two stages (the shape the shipped plan/terminal pages
// use): the type itself into `sidebarRightTabs`, then its body and title into the
// keyed `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` seats under the
// definition's own id. Hosts without those packages simply keep everything else.

import { NS } from '../locales.ts'
import { currentSessionId, serviceOf, servicesContext } from '../services.ts'
import { OrchestrationPanel, OrchestrationTabTitle } from './Panel.ts'

/** The tab type's kind: what `openTab` names. */
export const ORCHESTRATION_TAB_KIND = 'agy-orchestration'
/** The type's own identity; also the key its body/title register under. */
export const ORCHESTRATION_TAB_ID = 'agy-link-orchestration'

interface TabRegistryLike {
  register(definition: Record<string, unknown>): () => void
}

interface SidebarLike {
  mounted?: { getSnapshot?: () => unknown }
  openTab?: (kind: string, options?: Record<string, unknown>) => void
  openTabIn?: (sessionId: string, kind: string, options?: Record<string, unknown>) => void
}

interface SlotHost {
  slots: {
    inject(name: string, register: () => () => void): void
    register(opts: Record<string, unknown>, C: (p?: unknown) => unknown): () => void
  }
  effect(fn: () => (() => void) | void, label?: string): void
}

/**
 * Register the orchestration page.
 * @param ctx - client root context.
 * @returns true when the host has a right Sidebar and the page was registered.
 */
export function installOrchestrationTab(ctx: unknown): boolean {
  const tabs = serviceOf<TabRegistryLike>(ctx, 'sidebarRightTabs')
  if (tabs === undefined || typeof tabs.register !== 'function') return false
  const host = ctx as SlotHost
  host.effect(() => tabs.register({
    id: ORCHESTRATION_TAB_ID,
    kind: ORCHESTRATION_TAB_KIND,
    title: () => '编排',
  }), 'agy-link: orchestration tab type')
  host.slots.inject('sidebar.right.pane.tab', () => host.slots.register(
    {
      name: 'sidebar.right.pane.tab',
      key: ORCHESTRATION_TAB_ID,
      locale: NS,
      // The body needs the session id; `inject` is not in this bundle's TS
      // surface, so it goes through the excess-property escape the header uses.
      ...({ inject: (sessionId: string) => ({ sessionId }) } as Record<string, unknown>),
    },
    OrchestrationPanel as (p?: unknown) => unknown,
  ))
  host.slots.inject('sidebar.right.pane.tab.title', () => host.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: ORCHESTRATION_TAB_ID, locale: NS },
    OrchestrationTabTitle,
  ))
  return true
}

/**
 * Open (or focus) the orchestration page in the Sidebar.
 * @returns false when this host has no Sidebar to open it in.
 */
export function openOrchestrationTab(): boolean {
  const ctx = servicesContext()
  const sidebar = serviceOf<SidebarLike>(ctx, 'sidebarRight')
  if (sidebar === undefined) return false
  try {
    sidebar.openTab?.(ORCHESTRATION_TAB_KIND)
    return typeof sidebar.openTab === 'function'
  } catch {
    // No on-screen Session to place into: name the conversation's session.
    const session = currentSessionId(ctx)
    if (session !== '' && typeof sidebar.openTabIn === 'function') {
      sidebar.openTabIn(session, ORCHESTRATION_TAB_KIND)
      return true
    }
    return false
  }
}

/** Whether this host can show the page at all (drives the header button). */
export function canOpenOrchestrationTab(): boolean {
  return serviceOf<SidebarLike>(servicesContext(), 'sidebarRight') !== undefined
}