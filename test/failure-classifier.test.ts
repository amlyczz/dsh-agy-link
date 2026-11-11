import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyFailure, type FailureContext } from '../src/provider/failure.ts'
import { defaultConfig, Err } from '../src/common/types.ts'

function c(over: Partial<FailureContext> = {}, outcome: Partial<FailureContext['outcome']> = {}, stats: Partial<FailureContext['parser']['stats']> = {}): FailureContext {
  return {
    cfg: { ...defaultConfig(), maxTurnMinutes: 30, timeoutMs: 600_000 },
    outcome: { aborted: false, capped: false, timedOut: false, code: 0, stderrTail: '', ...outcome },
    parser: { stats: { sawAuthFailure: false, lastResultError: undefined, garbage: 0, ...stats } },
    sawAuthFailure: false,
    consumable: true,
    transportFailure: false,
    keyringJitter: false,
    rawErrText: '',
    isRateLimit: false,
    silentTimeout: false,
    ...over,
  }
}

test('aborted and capped map to stable codes', () => {
  assert.equal(classifyFailure(c({}, { aborted: true }))?.code, 'ABORTED')
  assert.equal(classifyFailure(c({}, { capped: true }))?.code, Err.TIMEOUT)
  assert.match(classifyFailure(c({}, { capped: true }))!.message, /maxTurnMinutes/)
})

test('a silent idle timeout says Google is unreachable', () => {
  const f = classifyFailure(c({ silentTimeout: true }, { timedOut: true }))!
  assert.equal(f.code, Err.TIMEOUT)
  assert.match(f.message, /never emitted a single event/)
})

test('consumable output has no failure', () => {
  assert.equal(classifyFailure(c()), null)
})

test('auth failure over a transport error is NETWORK, otherwise AUTH', () => {
  const net = classifyFailure(c({ sawAuthFailure: true, transportFailure: true, keyringJitter: true, consumable: false }))!
  assert.equal(net.code, Err.NETWORK)
  assert.match(net.message, /keyring auth timing out/)
  const auth = classifyFailure(c({ sawAuthFailure: true, consumable: false }))!
  assert.equal(auth.code, Err.AUTH)
})

test('hard rate limit cools the account; soft overload does not', () => {
  assert.equal(classifyFailure(c({ isRateLimit: true, consumable: false, rawErrText: '429 quota exceeded' }))?.code, Err.RATE_LIMIT)
  assert.equal(classifyFailure(c({ isRateLimit: true, consumable: false, rawErrText: 'model overloaded, high traffic' }))?.code, Err.OVERLOADED)
})

test('context window, eligibility, exit code, network, envelope and invalid output', () => {
  assert.equal(classifyFailure(c({ consumable: false, rawErrText: 'context window exceeded' }))?.code, Err.CONTEXT_WINDOW_EXCEEDED)
  assert.equal(classifyFailure(c({ consumable: false, rawErrText: 'User location is not supported' }))?.code, Err.ELIGIBILITY)
  assert.equal(classifyFailure(c({ consumable: false }, { code: 1, stderrTail: 'boom' }))?.code, Err.PROCESS_EXIT)
  assert.equal(classifyFailure(c({ consumable: false, transportFailure: true, rawErrText: 'EOF' }))?.code, Err.NETWORK)
  assert.equal(classifyFailure(c({ consumable: false }, { code: 0 }, { lastResultError: 'model said no' }))?.code, Err.AGY_ERROR)
  assert.equal(classifyFailure(c({ consumable: false }, { code: 0 }))?.code, Err.INVALID_OUTPUT)
})

test('eligibility loses to transport evidence (TLS timeout is not a region refusal)', () => {
  const f = classifyFailure(c({ consumable: false, transportFailure: true, rawErrText: 'Eligibility check failed: TLS handshake timeout' }))!
  assert.equal(f.code, Err.NETWORK)
})
