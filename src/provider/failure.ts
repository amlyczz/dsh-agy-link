// Pure failure classification for one agy attempt.
//
// This was the ~110-line if/else chain inside AgyAdapter.streamAttempt. It is
// the single place that turns process outcome + parser evidence + transport
// signals into a stable code/message; keeping it pure makes every branch
// testable without spawning agy.
import { Err, ELIGIBILITY_ERROR_HINT, looksLikeContextWindowExceeded, looksLikeEligibilityFailure, looksLikeHardRateLimit } from '../common/types.ts'
import type { PluginConfig } from '../common/types.ts'

function brief(s: string): string {
  const flat = s.trim().replace(/\s+/g, ' ')
  return flat.length > 300 ? flat.slice(0, 300) + '...' : flat
}

export interface AttemptFailure {
  kind: 'error' | 'aborted'
  code: string
  message: string
  retryAfterMs?: number
}

export interface FailureContext {
  cfg: PluginConfig
  outcome: {
    aborted: boolean
    capped: boolean
    timedOut: boolean
    code: number | null
    stderrTail: string
  }
  parser: {
    stats: {
      sawAuthFailure: boolean
      lastResultError: string | undefined
      garbage: number
    }
  }
  sawAuthFailure: boolean
  consumable: boolean
  transportFailure: boolean
  keyringJitter: boolean
  rawErrText: string
  isRateLimit: boolean
  silentTimeout: boolean
}

export function classifyFailure(c: FailureContext): AttemptFailure | null {
    if (c.outcome.aborted) {
      return { kind: 'aborted', code: 'ABORTED', message: 'agy run aborted by caller' }
    } else if (c.outcome.capped) {
      return {
        kind: 'error',
        code: Err.TIMEOUT,
        message: 'agy turn exceeded maxTurnMinutes (' + c.cfg.maxTurnMinutes + ' min) — the agy process tree was terminated. Re-send to continue. 本轮超过 maxTurnMinutes 上限，已终止 agy 进程树',
      }
    } else if (c.outcome.timedOut) {
      return { kind: 'error', code: Err.TIMEOUT, message: 'agy run was idle for ' + c.cfg.timeoutMs + 'ms without output'
        + (c.silentTimeout
          ? ' — agy never emitted a single event; it is likely unable to reach Google (check proxy/network). 无法连接 Google，请检查代理或网络配置'
          : '') }
    } else if (!c.consumable) {
      if (c.sawAuthFailure) {
        // agy says "not logged in" both for a real sign-out AND when it cannot
        // validate a good token over a broken network (observed live: the
        // retry account had a token that expired 9 minutes earlier, its refresh
        // died on `Post https://oauth2.googleapis.com/token: EOF`, and agy fell
        // back to "not logged in and no controlling terminal"). Reporting AUTH
        // there ends the turn on a healthy account AND DSH renders the AUTH
        // code as "API key is invalid" — a label that sent users hunting for a
        // credential that was never the problem.
        return c.transportFailure
          ? {
              kind: 'error',
              code: Err.NETWORK,
              message: 'agy could not validate its Google login over the network (transport failure'
                + (c.keyringJitter ? '; its own log shows keyring auth timing out on the network, not a sign-out' : '')
                + ', not a sign-out) — retrying on another account. '
                + (c.rawErrText !== '' ? brief(c.rawErrText) : ''),
            }
          : { kind: 'error', code: Err.AUTH, message: 'agy is not signed in — run /agy auth (or run agy once in a terminal) to login' }
      } else if (c.isRateLimit) {
        const bestMsg = c.parser.stats.lastResultError || (c.outcome.stderrTail ? brief(c.outcome.stderrTail) : 'Rate limit or quota reached')
        // Two different animals:
        //  - HARD server refusal (429 / quota reached): the account is spent, so
        //    it is cooled down and the sticky pointer advances; the retry is
        //    served by the next account.
        //  - SOFT capacity signal ("model overloaded" / high traffic): Google-side
        //    capacity pressure. Nothing was spent locally, so no cooldown — and the
        //    scheduler STAYS on the current account with backoff retry rather than rotating,
        //    preventing temporary server bursts from burning through all healthy accounts.
        const hard = looksLikeHardRateLimit(c.rawErrText)
        return {
          kind: 'error',
          code: hard ? Err.RATE_LIMIT : Err.OVERLOADED,
          message: hard
            ? 'Google Antigravity quota / rate limit reached: ' + bestMsg
            : 'Google Antigravity quota / rate limit reached (server capacity overloaded): ' + bestMsg,
        }
      } else if (looksLikeContextWindowExceeded(c.rawErrText) || looksLikeContextWindowExceeded(c.parser.stats.lastResultError ?? '')) {
        const detail = c.parser.stats.lastResultError || (c.outcome.stderrTail !== '' ? brief(c.outcome.stderrTail) : 'Prompt exceeds context window limit')
        return {
          kind: 'error',
          code: Err.CONTEXT_WINDOW_EXCEEDED,
          message: 'Google Antigravity context window exceeded: ' + detail,
        }
      } else if (
        !c.transportFailure
        && (looksLikeEligibilityFailure(c.rawErrText) || looksLikeEligibilityFailure(c.parser.stats.lastResultError ?? ''))
      ) {
        // Region/account eligibility refusal (issue #32): a clear cause, not a
        // generic PROCESS_EXIT. It is ACCOUNT-level (each account can have its
        // own proxy/egress region), so the failing pointer is rotated before
        // the error surfaces and the code is retryable — an account that IS
        // eligible can then serve the retry instead of the same refused one
        // failing again and again.
        //
        // BUT agy wraps EVERY startup check in "Eligibility check failed:" —
        // including pure transport errors like "failed to get profile picture:
        // Get https://lh3.googleusercontent.com/...: net/http: TLS handshake
        // timeout". That is a network blip (observed live: it fails on the
        // first turn and succeeds on the retry), not a region refusal, so when
        // transport evidence is present it wins and we fall through to the
        // NETWORK classification instead of showing a misleading
        // "not eligible for this account/region" hint.
        const detail = c.parser.stats.lastResultError ?? (c.outcome.stderrTail !== '' ? brief(c.outcome.stderrTail) : '')
        return {
          kind: 'error',
          code: Err.ELIGIBILITY,
          message: ELIGIBILITY_ERROR_HINT + (detail !== '' ? ' (' + detail + ')' : ''),
        }
      } else if (c.outcome.code !== 0) {
        // agy reports its failure on STDOUT as a result envelope and often
        // exits 1 with EMPTY stderr; dropping the envelope here used to
        // leave users with a bare "agy exited with code 1" and no cause.
        // Prefer the envelope's error text, then the stderr tail.
        const detail = c.parser.stats.lastResultError ?? (c.outcome.stderrTail !== '' ? brief(c.outcome.stderrTail) : '')
        return c.transportFailure
          ? {
              kind: 'error',
              code: Err.NETWORK,
              message: 'agy hit a network error while talking to Google — the automatic retry usually succeeds. ' + (detail !== '' ? detail : brief(c.rawErrText)),
            }
          : { kind: 'error', code: Err.PROCESS_EXIT, message: 'agy exited with code ' + c.outcome.code + (detail !== '' ? ': ' + detail : '') }
      } else if (c.transportFailure) {
        return {
          kind: 'error',
          code: Err.NETWORK,
          message: 'agy hit a network error while talking to Google — the automatic retry usually succeeds. ' + brief(c.rawErrText),
        }
      } else if (c.parser.stats.lastResultError) {
        return { kind: 'error', code: Err.AGY_ERROR, message: 'agy reported an error: ' + c.parser.stats.lastResultError }
      } else {
        return { kind: 'error', code: Err.INVALID_OUTPUT, message: 'agy produced no result event (' + c.parser.stats.garbage + ' unparseable lines)' }
      }
    }
  return null
}
