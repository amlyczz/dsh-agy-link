// Small pure helpers for the translation service.
//
// Split out because service.ts sat at the 600-line budget. These four are
// stateless (error mapping, empty result, provider-qualified model compare), so
// they cost nothing to isolate and are easy to test on their own.
import { Err } from '../../common/types.ts'
import type { TranslateFailureCode, TranslateResult } from './types.ts'

export function failureText(code: string | undefined, message: string | undefined): string {
  if (message !== undefined && message.trim() !== '') return message
  switch (code) {
    case Err.AGY_NOT_INSTALLED:
      return 'agy binary not found — install it via https://antigravity.google/docs/cli/install'
    case Err.AUTH:
      return 'agy is not signed in — run /agy auth'
    case Err.AUX_DISABLED:
      return 'auxiliary calls are disabled for the antigravity route (allowAuxiliary: false)'
    case Err.RATE_LIMIT:
    case Err.QUOTA:
      return 'Antigravity quota exhausted on every available account'
    case Err.EMPTY_RESPONSE:
      return 'the model returned nothing this time — retry'
    default:
      return 'translation failed'
  }
}

export function mapCode(raw: string | undefined): TranslateFailureCode {
  if (raw === Err.RATE_LIMIT || raw === Err.QUOTA) return 'NO_ACCOUNT'
  if (raw === Err.AUTH || raw === Err.NETWORK || raw === Err.ELIGIBILITY) return 'AGY_ERROR'
  if (raw === Err.TIMEOUT) return 'TIMEOUT'
  if (raw === 'ABORTED') return 'ABORTED'
  if (raw === Err.AUX_DISABLED) return 'AUX_DISABLED'
  return 'AGY_ERROR'
}

export function emptyResult(model: string, effort: string): TranslateResult {
  return { ok: false, text: '', model, effort, cached: false, durationMs: 0 }
}

export function sameModel(a: string, b: string): boolean {
  const norm = (s: string): string => s.trim().toLowerCase().replace(/^.*\//, '')
  return norm(a) === norm(b)
}
