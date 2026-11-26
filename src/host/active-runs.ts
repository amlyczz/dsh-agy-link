// Tracks live in-flight runs and pre-spawn pending account assignments per DSH session.
import type { ModelFamily } from '../common/pool-types.ts'
import type { ActiveRunView } from '../provider/prompt.ts'
import type { RunRecording } from './recording.ts'

export interface LiveSessionAccount {
  accountId: string
  family: ModelFamily
}

interface PendingEntry extends LiveSessionAccount {
  token: symbol
}

/**
 * Owns `activeRuns` (steer preemption, live progress, continuation) and the
 * brief pre-spawn `pending` window between `selectSessionAccount()` and
 * `registerActiveRun()`, so the header badge never reports an older stale
 * binding while a turn is queueing or executing.
 */
export class ActiveRunTracker {
  private readonly active = new Map<string, RunRecording>()
  private readonly pending = new Map<string, PendingEntry>()

  get(sessionKey: string): RunRecording | undefined {
    return this.active.get(sessionKey)
  }

  get size(): number {
    return this.active.size
  }

  register(sessionKey: string, rec: RunRecording): void {
    this.active.set(sessionKey, rec)
  }

  /** Map-compatible alias kept for callers/tests inspecting activeRuns directly. */
  set(sessionKey: string, rec: RunRecording): this {
    this.active.set(sessionKey, rec)
    return this
  }

  delete(sessionKey: string): boolean {
    return this.active.delete(sessionKey)
  }

  unregister(sessionKey: string, rec: RunRecording): void {
    if (this.active.get(sessionKey) === rec) this.active.delete(sessionKey)
  }

  isSuperseded(sessionKey: string, rec: RunRecording): boolean {
    const cur = this.active.get(sessionKey)
    return cur !== undefined && cur !== rec
  }

  promptView(sessionKey: string): ActiveRunView | undefined {
    const rec = this.active.get(sessionKey)
    if (rec === undefined) return undefined
    return {
      isSettled: rec.isSettled,
      conversationId: rec.conversationId,
      ...(rec.accountHome === undefined ? {} : { accountHome: rec.accountHome }),
    }
  }

  attemptHooks() {
    return {
      registerActiveRun: (key: string, r: RunRecording) => this.register(key, r),
      unregisterActiveRun: (key: string, r: RunRecording) => this.unregister(key, r),
      isSuperseded: (key: string, r: RunRecording) => this.isSuperseded(key, r),
    }
  }

  setPending(sessionKey: string, accountId: string, family: ModelFamily): symbol {
    const token = Symbol('pending-run')
    this.pending.set(sessionKey, { accountId, family, token })
    return token
  }

  clearPending(sessionKey: string, token: symbol): void {
    if (this.pending.get(sessionKey)?.token === token) {
      this.pending.delete(sessionKey)
    }
  }

  activeAccountFor(sessionKey: string): LiveSessionAccount | undefined {
    if (sessionKey === '') return undefined
    const live = this.active.get(sessionKey)
    if (live !== undefined && !live.isSettled && live.accountId !== undefined && live.family !== undefined) {
      return { accountId: live.accountId, family: live.family }
    }
    const pend = this.pending.get(sessionKey)
    return pend !== undefined ? { accountId: pend.accountId, family: pend.family } : undefined
  }
}
