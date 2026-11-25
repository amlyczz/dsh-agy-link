// Transport-failure backoff and egress-sharing decisions are pure helpers so
// the adapter's NETWORK handling stays testable without spawning agy.
//
// Live evidence (2026-10-21 16:34–16:48): every agy run on every account died
// with `Post "…/loadCodeAssist": EOF` for ~14 minutes while the machine's
// single egress proxy flapped. DSH retried twice inside ~4 seconds and gave up,
// rotating the pool for a failure no account caused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NETWORK_RETRY_DELAYS_MS, accountsShareSingleEgress, networkRetryDelayMs } from '../../src/common/types.ts'

test('network retry schedule escalates 5s/15s/30s and caps there', () => {
  assert.deepEqual([...NETWORK_RETRY_DELAYS_MS], [5_000, 15_000, 30_000])
  assert.equal(networkRetryDelayMs(1), 5_000)
  assert.equal(networkRetryDelayMs(2), 15_000)
  assert.equal(networkRetryDelayMs(3), 30_000)
  assert.equal(networkRetryDelayMs(4), 30_000, 'a long outage must not escalate past 30s')
  assert.equal(networkRetryDelayMs(0), 5_000, 'a zero streak still gets the first delay')
  assert.equal(networkRetryDelayMs(-3), 5_000)
})

test('a pool without per-account proxies shares one egress', () => {
  assert.equal(accountsShareSingleEgress([]), true, 'no pool: nothing to rotate to')
  assert.equal(accountsShareSingleEgress([{ enabled: true }, { enabled: true }]), true)
  assert.equal(
    accountsShareSingleEgress([{ proxyUrl: '   ' }, { enabled: true }]),
    true,
    'a blank override falls back to the global/system proxy, so it is still shared',
  )
  assert.equal(
    accountsShareSingleEgress([
      { proxyUrl: 'http://127.0.0.1:17891' },
      { proxyUrl: 'http://127.0.0.1:17891' },
    ]),
    true,
    'the same explicit proxy on every account is still one egress',
  )
})

test('one account on a distinct proxy makes the egress account-scoped', () => {
  assert.equal(
    accountsShareSingleEgress([
      { proxyUrl: 'http://127.0.0.1:17891' },
      { proxyUrl: 'socks5://127.0.0.1:7890' },
    ]),
    false,
  )
  assert.equal(
    accountsShareSingleEgress([{}, { proxyUrl: 'socks5://127.0.0.1:7890' }]),
    false,
    'an override next to a default (system) proxy is a real difference',
  )
})

test('an account seeded with the system proxy is still the same egress as one without', () => {
  // Pool accounts are created with a COPY of the detected system proxy while
  // the primary account keeps an empty override. Comparing raw overrides made
  // every blip look account-scoped and rotated the pool for nothing.
  assert.equal(
    accountsShareSingleEgress([{}, { proxyUrl: 'http://127.0.0.1:17891' }], 'http://127.0.0.1:17891'),
    true,
  )
  assert.equal(
    accountsShareSingleEgress([{}, { proxyUrl: 'socks5://127.0.0.1:7890' }], 'http://127.0.0.1:17891'),
    false,
    'an override that differs from the global proxy is a real second egress',
  )
})

test('disabled accounts do not count toward egress distinctness', () => {
  assert.equal(
    accountsShareSingleEgress([
      { enabled: true },
      { enabled: false, proxyUrl: 'socks5://127.0.0.1:7890' },
    ]),
    true,
  )
})
