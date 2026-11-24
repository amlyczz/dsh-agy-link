// Client half of `/btw` side questions: module-level per-session store,
// SSE streaming subscription (with fetch fallback), `conversation.input.dock`
// card mount, `conversation.chat.commandview` noise suppression, and Esc handling.
import type { BtwSessionView } from '../common/btw-types.ts'
import { base, getJson, postJson, win } from './api.ts'
import { BTW_STYLE_ID, BtwCard, injectBtwStyles } from './btw-card.ts'
import { translateOr } from './i18n-bridge.ts'
import { h, useEffect, useState } from './react.ts'
import type { ClientContextLike } from './translate-context.ts'
import { agyModalStore } from './ui/Modal.ts'

const PLUGIN_BTW = '/plugins/agy-link/btw'

interface SessionBtwRecord {
  view: BtwSessionView
  listeners: Set<(view: BtwSessionView) => void>
  es: { close(): void } | null
  pollTimer: ReturnType<typeof setInterval> | null
}

const sessionStore = new Map<string, SessionBtwRecord>()

function emptyView(sessionId: string): BtwSessionView {
  return { sessionId, open: false, activeIndex: 0, entries: [], revision: 0 }
}

function getRecord(sessionId: string): SessionBtwRecord {
  let rec = sessionStore.get(sessionId)
  if (!rec) {
    rec = { view: emptyView(sessionId), listeners: new Set(), es: null, pollTimer: null }
    sessionStore.set(sessionId, rec)
  }
  return rec
}

export function btwStateOf(sessionId: string): BtwSessionView {
  return sessionStore.get(sessionId)?.view ?? emptyView(sessionId)
}

export function publishBtwView(view: BtwSessionView): void {
  const rec = getRecord(view.sessionId)
  if (view.revision < rec.view.revision) return
  rec.view = view
  for (const fn of [...rec.listeners]) {
    try {
      fn(view)
    } catch {
      // contained
    }
  }
  syncConnection(view.sessionId, rec)
}

function closeTransport(rec: SessionBtwRecord): void {
  if (rec.es) {
    try { rec.es.close() } catch { /* ignore */ }
    rec.es = null
  }
  if (rec.pollTimer !== null) {
    clearInterval(rec.pollTimer)
    rec.pollTimer = null
  }
}

function syncConnection(sessionId: string, rec: SessionBtwRecord): void {
  const active = rec.listeners.size > 0 && (rec.view.open || rec.view.entries.some((e) => e.status === 'running'))
  if (!active) {
    closeTransport(rec)
    return
  }
  if (rec.es !== null || rec.pollTimer !== null) return

  const EventSourceCtor = (globalThis as unknown as {
    EventSource?: new (url: string) => {
      addEventListener(type: string, cb: (ev: { data?: string }) => void): void
      onerror: (() => void) | null
      close(): void
    }
  }).EventSource

  if (typeof EventSourceCtor === 'function') {
    try {
      const es = new EventSourceCtor(`${base}${PLUGIN_BTW}/stream?session=${encodeURIComponent(sessionId)}`)
      es.addEventListener('state', (ev) => {
        if (typeof ev.data !== 'string') return
        try {
          const next = JSON.parse(ev.data) as BtwSessionView
          if (next && typeof next.sessionId === 'string') publishBtwView(next)
        } catch {
          // ignore malformed frame
        }
      })
      es.onerror = () => {
        // Fall back to short polling while open/running if SSE fails
        closeTransport(rec)
        startPollFallback(sessionId, rec)
      }
      rec.es = es
      return
    } catch {
      // fall through to poll fallback
    }
  }
  startPollFallback(sessionId, rec)
}

function startPollFallback(sessionId: string, rec: SessionBtwRecord): void {
  if (rec.pollTimer !== null || rec.listeners.size === 0) return
  rec.pollTimer = setInterval(() => {
    void refreshBtwState(sessionId)
  }, 600)
  ;(rec.pollTimer as unknown as { unref?: () => void }).unref?.()
}

export async function refreshBtwState(sessionId: string): Promise<BtwSessionView | null> {
  if (sessionId === '') return null
  const res = await getJson<{ ok?: boolean; state?: BtwSessionView }>(`${PLUGIN_BTW}/state?session=${encodeURIComponent(sessionId)}`)
  if (res?.ok && res.state) {
    publishBtwView(res.state)
    return res.state
  }
  return null
}

export async function wakeBtwSession(sessionId: string): Promise<void> {
  if (sessionId === '') return
  const rec = getRecord(sessionId)
  // Optimistically mark open when /btw command just executed so SSE attaches immediately.
  if (!rec.view.open) {
    rec.view = { ...rec.view, open: true }
    for (const fn of [...rec.listeners]) {
      try { fn(rec.view) } catch { /* ignore */ }
    }
  }
  syncConnection(sessionId, rec)
  await refreshBtwState(sessionId)
}

export function subscribeBtwState(sessionId: string, listener: (view: BtwSessionView) => void): () => void {
  const rec = getRecord(sessionId)
  rec.listeners.add(listener)
  syncConnection(sessionId, rec)
  return () => {
    rec.listeners.delete(listener)
    if (rec.listeners.size === 0) closeTransport(rec)
  }
}

export function resetBtwStoreForTest(): void {
  for (const rec of sessionStore.values()) closeTransport(rec)
  sessionStore.clear()
}

async function postBtw(action: 'ask' | 'cancel' | 'dismiss' | 'clear', body: Record<string, unknown>): Promise<void> {
  const res = await postJson(`${PLUGIN_BTW}/${action}`, body)
  if (res?.ok && res.state) publishBtwView(res.state as BtwSessionView)
}

function resolvePropSessionId(props?: Record<string, unknown>): string {
  const direct = props?.sessionId
  if (typeof direct === 'string' && direct !== '') return direct
  const sess = props?.session as { id?: unknown; sessionId?: unknown } | undefined
  if (typeof sess?.sessionId === 'string' && sess.sessionId !== '') return sess.sessionId
  if (typeof sess?.id === 'string' && sess.id !== '') return sess.id
  return ''
}

export function BtwDock(props?: Record<string, unknown>): unknown {
  const sessionId = resolvePropSessionId(props)
  const t = props?.t as ((key: string, params?: Record<string, unknown>) => string) | undefined
  const [view, setView] = useState<BtwSessionView>(() => btwStateOf(sessionId))

  useEffect(() => {
    if (sessionId === '') return
    setView(btwStateOf(sessionId))
    const unsub = subscribeBtwState(sessionId, setView)
    void refreshBtwState(sessionId)
    return unsub
  }, [sessionId])

  useEffect(() => {
    if (sessionId === '' || !view.open) return
    const doc = win.document as {
      addEventListener?: (type: string, fn: (ev: { key?: string; defaultPrevented?: boolean; preventDefault?: () => void }) => void) => void
      removeEventListener?: (type: string, fn: (ev: { key?: string; defaultPrevented?: boolean; preventDefault?: () => void }) => void) => void
      querySelector?: (sel: string) => unknown
    } | null | undefined
    if (!doc || typeof doc.addEventListener !== 'function') return
    const onKeyDown = (ev: { key?: string; defaultPrevented?: boolean; preventDefault?: () => void }): void => {
      if (ev.key !== 'Escape' || ev.defaultPrevented) return
      if (agyModalStore.open) return
      if (doc.querySelector?.('[data-composer-overlay] > *')) return
      const cur = btwStateOf(sessionId)
      if (!cur.open) return
      const active = cur.entries[cur.activeIndex]
      ev.preventDefault?.()
      if (active?.status === 'running') void postBtw('cancel', { sessionId })
      else void postBtw('dismiss', { sessionId, open: false })
    }
    doc.addEventListener('keydown', onKeyDown)
    return () => { doc.removeEventListener?.('keydown', onKeyDown) }
  }, [sessionId, view.open])

  if (sessionId === '' || !view.open) return null
  return h(BtwCard as never, {
    view,
    ...(t !== undefined ? { t } : {}),
    onAsk: (question: string, opts: { followUp: boolean; newThread: boolean }) => {
      void postBtw('ask', { sessionId, question, followUp: opts.followUp, newThread: opts.newThread })
    },
    onCancel: () => { void postBtw('cancel', { sessionId }) },
    onDismiss: () => { void postBtw('dismiss', { sessionId, open: false }) },
    onNavigate: (index: number) => { void postBtw('dismiss', { sessionId, open: true, activeIndex: index }) },
  })
}

/**
 * Suppress noisy GenericCommandCard rows for `/btw` in the main chat transcript:
 * the BtwDock card above the composer owns live streaming, tool steps, and
 * answers. Only surface an inline error line if a headless/sync run failed.
 */
export function BtwCommandRow(props?: { node?: { outcome?: { kind?: string; text?: string } | null } }): unknown {
  const outcome = props?.node?.outcome
  if (outcome?.kind !== 'error') return null
  const text = typeof outcome.text === 'string' && outcome.text !== ''
    ? outcome.text
    : translateOr('btw.failed', 'Side question failed')
  return h('div', { className: 'agy-btw-error', role: 'alert' }, text)
}

export function installBtwUi(ctx: ClientContextLike, localeNs: string): () => void {
  injectBtwStyles()
  const disposers: Array<() => void> = []

  try {
    const dockOff = ctx.slots.inject('conversation.input.dock', () =>
      ctx.slots.register(
        {
          name: 'conversation.input.dock',
          id: 'agy-btw',
          order: 15,
          locale: localeNs,
          inject: (sessionId: string) => ({ sessionId }),
        },
        BtwDock as never,
      ),
    )
    if (typeof dockOff === 'function') disposers.push(dockOff)

    const cmdViewOff = ctx.slots.inject('conversation.chat.commandview', () =>
      ctx.slots.register(
        {
          name: 'conversation.chat.commandview',
          key: 'btw',
          locale: localeNs,
        },
        BtwCommandRow as never,
      ),
    )
    if (typeof cmdViewOff === 'function') disposers.push(cmdViewOff)
  } catch (e) {
    console.warn('[dsh-agy-link] btw slots unavailable:', e)
  }

  try {
    const on = (ctx as { on?: (ev: string, fn: (sid: unknown, name: unknown) => void) => (() => void) | undefined }).on
    if (typeof on === 'function') {
      const off = on.call(ctx, 'command/executed', (sid: unknown, cmdName: unknown) => {
        if (cmdName === 'agy-btw' && typeof sid === 'string' && sid !== '') {
          void wakeBtwSession(sid)
        }
      })
      if (typeof off === 'function') disposers.push(off)
    }
  } catch {
    // host without command/executed event
  }

  return () => {
    for (const off of disposers) {
      try { off() } catch { /* ignore */ }
    }
    resetBtwStoreForTest()
    try {
      const doc = win.document as { getElementById?: (id: string) => { remove?: () => void } | null } | null | undefined
      doc?.getElementById?.(BTW_STYLE_ID)?.remove?.()
    } catch {
      // ignore
    }
  }
}
