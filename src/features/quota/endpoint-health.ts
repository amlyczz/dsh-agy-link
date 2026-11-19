// Endpoint health memory for the quota REST calls.
//
// WHY (live incident 2026-11-19): `daily-cloudcode-pa.googleapis.com/v1internal:
// retrieveUserQuotaSummary` resets the connection for every account on this
// machine (measured 5.3-8.4s, concurrent accounts included), while the sandbox
// endpoint answers normally. AGY_ENDPOINTS is a fixed list that every fetch
// walks from the same end, so every single quota refresh — manual clicks and
// the hourly background sweep alike — paid that timeout BEFORE falling back.
// Remembering "this endpoint just failed" for a few minutes (keyed per
// endpoint+operation: a summary refusal says nothing about fetchAvailableModels,
// which answers 200 on the same host) removes the dead weight without banning
// anything permanently.
//
// The memory is per QuotaService instance rather than module-global state:
// tests that build QuotaHttpDeps directly simply do not pass one and keep the
// historical first-endpoint ordering.
import { QUOTA_ENDPOINT_DOWN_MS } from '../../common/timeouts.ts'

/** The three quota calls that walk AGY_ENDPOINTS. */
export type QuotaEndpointOp = 'summary' | 'models' | 'userQuota'

export interface EndpointHealthLike {
  isDown(key: string): boolean
  noteFailure(key: string): void
  noteSuccess(key: string): void
}

export function endpointHealthKey(op: QuotaEndpointOp, endpoint: string): string {
  return `${op}|${endpoint}`
}

/** TTL-bounded failure memory; a recovered endpoint re-enters on its own. */
export class EndpointHealth implements EndpointHealthLike {
  private readonly downUntil = new Map<string, number>()

  constructor(
    private readonly downMs: number = QUOTA_ENDPOINT_DOWN_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  isDown(key: string): boolean {
    const until = this.downUntil.get(key)
    if (until === undefined) return false
    if (until <= this.now()) {
      this.downUntil.delete(key)
      return false
    }
    return true
  }

  noteFailure(key: string): void {
    this.downUntil.set(key, this.now() + this.downMs)
  }

  noteSuccess(key: string): void {
    this.downUntil.delete(key)
  }
}

/**
 * Re-order an endpoint list so recently-failed endpoints are tried LAST.
 *
 * Never returns an empty list and never drops an endpoint: when everything is
 * marked down the original order is used, because a total outage must still be
 * probed (skipping all of them would lock the pool out of a recovered network).
 */
export function orderEndpointsByHealth<T extends string>(
  endpoints: readonly T[],
  op: QuotaEndpointOp,
  health?: EndpointHealthLike,
): T[] {
  if (health === undefined || endpoints.length < 2) return [...endpoints]
  const healthy: T[] = []
  const unhealthy: T[] = []
  for (const endpoint of endpoints) {
    if (health.isDown(endpointHealthKey(op, endpoint))) unhealthy.push(endpoint)
    else healthy.push(endpoint)
  }
  return unhealthy.length === 0 || healthy.length === 0 ? [...endpoints] : [...healthy, ...unhealthy]
}
