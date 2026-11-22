// Plugin-owned session records (never model-visible, never part of the agy text
// stream). Extracted from services.ts to keep that file inside the size budget.

export const ACP_REPORT_RECORD_TYPE = 'plugin:agy-link/acp-report'
export const ACP_NOTICE_RECORD_TYPE = 'plugin:agy-link/acp-notice'

export interface SessionRecordsDeps {
  /** Resolve a DSH session by id; the host may expose it through ctx or ctx.sessions. */
  session(id: string): { append?: (type: string, data: unknown) => { seq?: number } | number } | undefined
  log(msg: string): void
}

type AppendPluginRecord = (session: unknown, type: string, data: unknown) => number

export interface SessionRecords {
  /**
   * Persist one plugin-owned record. Returns the record seq, or null when the
   * host cannot write records at all — callers must then fall back to a
   * followup wake.
   */
  appendRecordTo(sessionId: string, type: string, data: unknown, what: string): Promise<number | null>
  /** Convenience wrapper for the records the ACP channel writes itself. */
  appendPluginRecordTo(sessionId: string, type: string, data: unknown): Promise<number | null>
  /** Best-effort user-visible ACP notice; never throws into the run path. */
  appendAcpNotice(sessionKey: string, notice: { kind: string; text: string }): void
}

export function createSessionRecords(deps: SessionRecordsDeps): SessionRecords {
  let appendPluginRecordPromise: Promise<AppendPluginRecord | null> | null = null
  const loadAppendPluginRecord = (): Promise<AppendPluginRecord | null> => {
    if (appendPluginRecordPromise === null) {
      appendPluginRecordPromise = (async () => {
        try {
          const spec = '@deepseek-ai/dsh-session'
          const mod = (await import(spec)) as { appendPluginRecord?: AppendPluginRecord }
          return typeof mod.appendPluginRecord === 'function' ? mod.appendPluginRecord : null
        } catch (e) {
          deps.log('translation records unavailable: ' + String(e))
          return null
        }
      })()
    }
    return appendPluginRecordPromise
  }

  const appendRecordTo = async (sessionId: string, type: string, data: unknown, what: string): Promise<number | null> => {
    const session = deps.session(sessionId)
    if (session === undefined) return null
    const append = await loadAppendPluginRecord()
    if (append !== null) {
      try {
        const res = append(session, type, data)
        if (typeof res === 'number') return res
      } catch (e) {
        deps.log('failed to ' + what + ' ' + type + ' via appendPluginRecord: ' + String(e))
      }
    }
    try {
      if (typeof session.append === 'function') {
        const res = session.append(type, data)
        if (typeof res === 'number') return res
        if (res !== null && typeof res === 'object' && typeof (res as { seq?: unknown }).seq === 'number') {
          return (res as { seq: number }).seq
        }
        return 0
      }
    } catch (e) {
      deps.log('failed to ' + what + ' ' + type + ' via session.append: ' + String(e))
    }
    return null
  }

  const appendPluginRecordTo = (sessionId: string, type: string, data: unknown): Promise<number | null> =>
    appendRecordTo(sessionId, type, data, 'append')

  const appendAcpNotice = (sessionKey: string, notice: { kind: string; text: string }): void => {
    if (sessionKey === '') return
    void appendRecordTo(sessionKey, ACP_NOTICE_RECORD_TYPE, { ...notice, at: Date.now() }, 'append').catch(() => null)
  }

  return { appendRecordTo, appendPluginRecordTo, appendAcpNotice }
}
