// Access to host services the plugin uses opportunistically.
//
// The client half declares `inject = ['slots', 'locale']` and must keep working
// on hosts without the right-sidebar packages, so the sidebar faces are resolved
// at use time: a missing service means "this host has no right sidebar", never a
// failed plugin load.

let ctxRef: unknown = null

/** Remember the client root context for the DOM-level enhancers. */
export function setServicesContext(ctx: unknown): void {
  ctxRef = ctx
}

/** The client root context captured at apply() time (null before it). */
export function servicesContext(): unknown {
  return ctxRef
}

/**
 * Resolve one Cordis service without declaring it.
 * @param ctx - a client context (root or injected).
 * @param name - the service id.
 * @returns the service, or undefined when this composition does not provide it.
 */
export function serviceOf<T>(ctx: unknown, name: string): T | undefined {
  const c = ctx as {
    get?: (key: string) => unknown
    reflect?: { get?: (key: string, strict?: boolean) => unknown }
  } & Record<string, unknown>
  if (c === null || c === undefined) return undefined
  // Cordis v4 resolves services through `ctx.reflect.get(name, strict)`: this is
  // the ONLY lookup that reaches a service the plugin did not declare in
  // `inject`. `ctx.get` does not exist on v4 and a plain property read answers
  // for the injection store alone, so without this the right-Sidebar faces were
  // "missing" and the 编排 page never registered (issue: page would not open).
  try {
    const fromReflect = c.reflect?.get?.(name, false)
    if (fromReflect !== undefined && fromReflect !== null) return fromReflect as T
  } catch {
    // Older/other runtimes: fall through to the remaining lookups.
  }
  try {
    const fromGet = c.get?.(name)
    if (fromGet !== undefined && fromGet !== null) return fromGet as T
  } catch {
    // Not injected in this composition: fall through to the property read.
  }
  try {
    const direct = c[name]
    return direct === undefined || direct === null ? undefined : (direct as T)
  } catch {
    return undefined
  }
}

/** The Session the visible conversation belongs to; `''` when unknown. */
export function currentSessionId(ctx: unknown): string {
  const uiSession = serviceOf<{ current?: { value?: Record<string, unknown> } }>(ctx, 'uiSession')
  const value = uiSession?.current?.value
  if (value !== undefined && value !== null) {
    for (const key of ['key', 'sessionId', 'id']) {
      const id = value[key]
      if (typeof id === 'string' && id !== '') return id
    }
  }
  const sessions = serviceOf<{ list?: { getSnapshot?: () => { byId?: Record<string, unknown> } } }>(ctx, 'sessions')
  const byId = sessions?.list?.getSnapshot?.()?.byId
  if (byId !== undefined && byId !== null) {
    const ids = Object.keys(byId)
    if (ids.length === 1 && ids[0] !== undefined) return ids[0]
  }
  return ''
}