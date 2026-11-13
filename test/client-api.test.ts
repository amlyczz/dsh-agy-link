// Client request-deadline regression: every write must SETTLE, otherwise the
// console's per-action busy flag (and its "同步中" spinner) never clears.
import test from 'node:test'
import assert from 'node:assert/strict'

import { postJson, getJson, timedSignal, WRITE_TIMEOUT_MS, STATUS_TIMEOUT_MS } from '../src/client/api.ts'

type FetchInit = { signal?: AbortSignal; method?: string; body?: unknown }
type FetchLike = (url: string, init?: FetchInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

function withFetch<T>(fn: FetchLike, body: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as { fetch?: unknown }
  const original = g.fetch
  g.fetch = fn
  return body().finally(() => { g.fetch = original })
}

test('postJson attaches an abort signal to every write', async () => {
  const seen: FetchInit[] = []
  await withFetch(async (_url, init) => {
    seen.push(init ?? {})
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }, async () => {
    assert.deepEqual(await postJson('/plugins/agy-link/pool/refresh-quota', { id: 'x' }), { ok: true })
  })
  assert.equal(seen.length, 1)
  assert.ok(seen[0]?.signal instanceof AbortSignal, 'a bounded write must be abortable')
  assert.equal(seen[0]?.signal?.aborted, false)
})

test('getJson attaches an abort signal too (status reads and other GETs)', async () => {
  const seen: FetchInit[] = []
  await withFetch(async (_url, init) => {
    seen.push(init ?? {})
    return { ok: true, status: 200, json: async () => ({ hello: 'world' }) }
  }, async () => {
    assert.deepEqual(await getJson('/plugins/agy-link/status'), { hello: 'world' })
  })
  assert.ok(seen[0]?.signal instanceof AbortSignal)
})

test('postJson resolves to null when the request is aborted, so the busy flag still clears', async () => {
  // A fetch that rejects (as AbortSignal.timeout does) must not propagate:
  // postJson returns null, every caller's `finally` runs and the spinner stops.
  await withFetch((_url, init) => new Promise((_resolve, reject) => {
    assert.ok(init?.signal instanceof AbortSignal)
    setTimeout(() => reject(new Error('The operation was aborted')), 5)
  }), async () => {
    assert.equal(await postJson('/slow', {}), null)
  })
})

test('timedSignal actually aborts after its deadline', async () => {
  const sig = timedSignal(5) as AbortSignal | undefined
  if (sig === undefined) return // unsupported runtime — the guard skips it
  assert.equal(sig.aborted, false)
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(sig.aborted, true)
})

test('status timeout is shorter than a write timeout', () => {
  assert.ok(STATUS_TIMEOUT_MS < WRITE_TIMEOUT_MS)
})
