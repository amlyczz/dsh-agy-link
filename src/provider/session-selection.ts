// One account selection for a turn, with the pool-reset wait made visible.
//
// Extracted from AgyAdapter.streamAttempt for the same reason
// account-selection.ts was: the adapter owns the call site and the
// post-selection side effects, this module owns the selection deps assembly and
// the session-visible notice that keeps a long pool-reset wait from looking
// like a freeze.
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { PluginConfig } from '../common/types.ts'
import type { AgyGenerateOptions } from '../common/protocol.ts'
import type { AgyAdapterDeps } from './adapter-contract.ts'
import { selectSessionAccount, type AccountSelectionResult } from './account-selection.ts'
import { awaitWithNotices, describePoolResetWait } from './notices.ts'

export interface SessionSelectionInput {
  deps: AgyAdapterDeps
  cfg: PluginConfig
  options: AgyGenerateOptions
  model: string
  isAux: boolean
  isCompaction: boolean
  isTitle: boolean
  sessionKey: string
  warnOnce: (key: string, message: string) => void
}

/**
 * Select the account (and family/model) for this turn.
 *
 * A drained pool can park the selection for up to `poolResetWaitMs`; the wait is
 * streamed as a session-visible notice on the reserved status block index, and
 * each session logs one WARN line. A fast selection emits nothing.
 */
export async function* selectSessionAccountWithWait(
  input: SessionSelectionInput,
): AsyncGenerator<StreamChunk, AccountSelectionResult, void> {
  const { deps, cfg, options, model, isAux, isCompaction, isTitle, sessionKey, warnOnce } = input
  const poolWait = { resetAt: 0, capMs: 0 }
  const work = selectSessionAccount({
    deps: {
      ...(deps.pool === undefined ? {} : { pool: deps.pool }),
      store: deps.store,
      ...(deps.syncSessionModel === undefined ? {}
        : { syncSessionModel: (id: string, m: string, effort?: string) => deps.syncSessionModel?.(id, m, effort) }),
      ...(deps.refreshQuota === undefined ? {} : { refreshQuota: deps.refreshQuota }),  // #125 heal
      poolWaitNotice: (countdownMs: number, capMs: number) => {
        poolWait.resetAt = Date.now() + countdownMs
        poolWait.capMs = capMs
        warnOnce(
          'pool-reset-wait:' + sessionKey,
          `agy pool exhausted; waiting ${Math.ceil(countdownMs / 1000)}s for the next quota/cooldown reset (cap ${Math.ceil(capMs / 1000)}s) before spawning`,
        )
      },
    },
    cfg,
    model,
    isAux,
    allowAuxModelFallback: isCompaction || isTitle,
    sessionKey,
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: String(options.reasoningEffort) }),
    ...(options.agyQuotaModel === undefined ? {} : { quotaModel: options.agyQuotaModel }),
    ...(options.agyAvoidAccountIds === undefined ? {} : { avoidAccountIds: options.agyAvoidAccountIds }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  return yield* awaitWithNotices(work, {
    intervalMs: 20_000,
    escalate: 2,
    maxIntervalMs: 120_000,
    // Idle state (no pool wait handed to us yet) renders nothing: a fast pick
    // must not put a blank status line into the transcript.
    notice: (waitedMs) =>
      poolWait.resetAt === 0 ? '' : describePoolResetWait(poolWait.resetAt - Date.now(), poolWait.capMs, waitedMs),
  })
}
