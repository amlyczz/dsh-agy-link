import { test } from 'node:test'
import assert from 'node:assert/strict'
import { awaitWithNotices, STATUS_NOTICE_BLOCK_INDEX } from '../../src/host/adapter.ts'

/** Collect every chunk an async generator yields plus its return value. */
async function drain<T>(gen: AsyncGenerator<{ type: string; index?: number; text?: string }, T, void>) {
  const chunks: Array<{ type: string; index?: number; text?: string }> = []
  for (;;) {
    const step = await gen.next()
    if (step.done === true) return { chunks, value: step.value }
    chunks.push(step.value)
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test('awaitWithNotices stays silent when the wait is short', async () => {
  const { chunks, value } = await drain(
    awaitWithNotices(Promise.resolve('granted'), {
      intervalMs: 5_000,
      notice: () => 'should never appear',
    }),
  )
  assert.deepEqual(chunks, [], 'a fast dispatch must not pollute the transcript')
  assert.equal(value, 'granted')
})

test('awaitWithNotices reports the wait without losing the result', async () => {
  let release: (v: string) => void = () => {}
  const work = new Promise<string>((resolve) => {
    release = resolve
  })
  const gen = awaitWithNotices(work, {
    intervalMs: 15,
    escalate: 2,
    maxIntervalMs: 60,
    notice: (elapsedMs) => 'waiting ' + Math.max(1, Math.round(elapsedMs / 10)) + 'u',
  })
  const first = await gen.next()
  assert.equal(first.done, false)
  const chunk = first.value as { type: string; index: number; text: string }
  assert.equal(chunk.type, 'reasoning-delta')
  assert.equal(chunk.index, STATUS_NOTICE_BLOCK_INDEX)
  assert.equal(chunk.index, -1, 'reserved negative index cannot collide with the mapper')
  assert.match(chunk.text, /^waiting \d+u\n$/)
  release('done')
  const rest = await drain(gen)
  assert.equal(rest.value, 'done', 'the awaited value survives the notices')
})

test('awaitWithNotices escalates the cadence so long waits stay quiet', async () => {
  const noticeTimes: number[] = []
  const started = Date.now()
  let release: (v: number) => void = () => {}
  const work = new Promise<number>((resolve) => {
    release = resolve
  })
  const gen = awaitWithNotices(work, {
    intervalMs: 10,
    escalate: 3,
    maxIntervalMs: 200,
    notice: () => {
      noticeTimes.push(Date.now() - started)
      return 'tick'
    },
  })
  for (;;) {
    const step = await gen.next()
    if (step.done === true) break
    if (noticeTimes.length >= 3) {
      release(7)
    }
  }
  assert.ok(noticeTimes.length >= 3, 'three notices expected, got ' + noticeTimes.length)
  const gap1 = noticeTimes[1]! - noticeTimes[0]!
  const gap2 = noticeTimes[2]! - noticeTimes[1]!
  assert.ok(gap2 > gap1, 'cadence must grow (gap1=' + gap1 + 'ms, gap2=' + gap2 + 'ms)')
})

test('awaitWithNotices forwards the rejection untouched', async () => {
  const boom = new Error('slot exploded')
  await assert.rejects(
    drain(
      awaitWithNotices(Promise.reject(boom), {
        intervalMs: 5_000,
        notice: () => 'never',
      }),
    ),
    (err: unknown) => err === boom,
    'the original error instance must reach the caller',
  )
})

test('awaitWithNotices ends cleanly when the caller abandons it', async () => {
  const work = new Promise<string>(() => {
    /* never settles */
  })
  const gen = awaitWithNotices(work, { intervalMs: 10, notice: () => 'still waiting' })
  const first = await gen.next()
  assert.equal(first.done, false)
  // Simulate Stop: close the generator while the work is still pending. It is
  // suspended at the `yield`, so return() must resolve immediately and the
  // timer must be cleared by the finally block (no dangling handle keeps the
  // process alive).
  await gen.return('abandoned' as never)
  const after = await gen.next()
  assert.equal(after.done, true, 'a closed generator must not keep yielding')
})
