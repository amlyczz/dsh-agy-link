// One place that turns a finished ACP turn into (a) a `[cache]` log line and
// (b) a process-wide metric sample. Kept out of run-attempt.ts so that file
// stays inside the module size budget.
import type { RawUsage } from '../../common/types.ts'
import { cacheMetrics } from '../../host/cache-metrics.ts'
import type { AttemptDeps, AttemptInput } from '../../provider/attempt.ts'
import { classifyCacheReason, formatCacheTurn, summarizeCacheTurn } from './cache-stats.ts'

export function reportAcpCacheTurn(args: {
  deps: AttemptDeps
  input: AttemptInput
  sessionStatus: 'created' | 'resumed' | 'loaded' | 'cached' | 'rebuilt'
  lastUsage: RawUsage | null
  envelopeUsage: RawUsage | undefined
  selfHealed: boolean
}): void {
  const { deps, input, sessionStatus, lastUsage, envelopeUsage, selfHealed } = args
  const stats = summarizeCacheTurn(lastUsage ?? envelopeUsage)
  const modelSwitched =
    input.binding?.model !== undefined && input.model !== '' && input.binding.model !== input.model
  // A binding under ANOTHER account for this same DSH session means the pool
  // moved us mid-session: that costs a full cold prefill, so name it.
  const accountSwitched =
    input.binding === undefined &&
    input.sessionKey !== '' &&
    Object.keys(deps.store.all()).some(
      (k) => k.startsWith(input.sessionKey + ':') && k !== input.sessionAccountKey,
    )
  const idleMs = input.binding !== undefined ? Date.now() - input.binding.updatedAt : undefined
  const reason = classifyCacheReason({
    sessionStatus,
    accountSwitched,
    modelSwitched,
    retried: selfHealed,
    ...(idleMs === undefined ? {} : { idleMs }),
  })
  cacheMetrics.record({ at: Date.now(), reason, stats, sessionKey: input.sessionKey, model: input.model })
  deps.log?.('[cache] ' + formatCacheTurn(stats, reason))
}
