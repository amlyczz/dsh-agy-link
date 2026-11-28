// The tool-card seat cache (client/orchestration/seats.ts) keeps one table per
// mirror run. A long-lived session runs hundreds of turns, so an unbounded
// cache grows for as long as the window stays open — and the host only keeps
// attribution for its last few runs anyway (features/orchestration/
// tool-seats.ts, MAX_RUNS), so the older tables can never be refreshed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  resetToolSeatsClientForTests,
  toolSeatFor,
} from '../../src/client/orchestration/seats.ts'

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25))

async function withSeatFetch(
  run: (fetches: Map<string, number>) => Promise<void>,
): Promise<void> {
  const fetches = new Map<string, number>()
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (url: string) => {
      const run = new URL(url, 'http://dsh.local').searchParams.get('run') ?? ''
      fetches.set(run, (fetches.get(run) ?? 0) + 1)
      return { ok: true, status: 200, json: async () => ({ ok: true, seats: { 1: { seat: 'executor' } } }) }
    },
  })
  resetToolSeatsClientForTests()
  try {
    await run(fetches)
  } finally {
    resetToolSeatsClientForTests()
    if (prev) Object.defineProperty(globalThis, 'fetch', prev)
    else delete (globalThis as { fetch?: unknown }).fetch
  }
}

test('the seat cache keeps the most recent runs and refetches an evicted one on demand', async () => {
  await withSeatFetch(async (fetches) => {
    for (let i = 1; i <= 20; i++) toolSeatFor(`run-${i}`, 1)
    await settle()

    // Only the newest 16 stay cached: the host keeps no more than that.
    assert.equal(toolSeatFor('run-20', 1)?.seat, 'executor')
    assert.equal(toolSeatFor('run-5', 1)?.seat, 'executor')
    assert.equal(toolSeatFor('run-4', 1), undefined, 'the oldest table was evicted')

    // Asking for it IS the request: an evicted run is fetched again, and the
    // chip comes back on scroll-back instead of the memory staying allocated.
    assert.equal(fetches.get('run-4'), 2)
    await settle()
    assert.equal(toolSeatFor('run-4', 1)?.seat, 'executor')
    assert.equal(fetches.get('run-20'), 1, 'a cached run is served from memory, never refetched')
  })
})
