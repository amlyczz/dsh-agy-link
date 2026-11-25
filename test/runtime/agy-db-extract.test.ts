import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

// A node:test timeout cannot interrupt synchronous parser loops. Keep malformed
// inputs in a killable subprocess so this regression cannot wedge the suite.
function extractBounded(payloads: Buffer[]): Array<string | null> {
  const moduleUrl = new URL('../../src/runtime/agy/db/extract.ts', import.meta.url).href
  const script = `
    import { readFileSync } from 'node:fs';
    import { extractStepThoughts } from ${JSON.stringify(moduleUrl)};
    const inputs = JSON.parse(readFileSync(0, 'utf8'));
    console.log(JSON.stringify(inputs.map(hex => extractStepThoughts(Buffer.from(hex, 'hex')))));
  `
  const result = spawnSync(process.execPath, [
    '--experimental-transform-types', '--input-type=module', '-e', script,
  ], {
    input: JSON.stringify(payloads.map((payload) => payload.toString('hex'))),
    encoding: 'utf8',
    // Generous: the point is that the parser TERMINATES, not that a cold Node
    // start with --experimental-transform-types fits in 3s. A tight budget made
    // this suite fail on slower hosts (Node 25, worktree node_modules) even
    // though the guard itself returned immediately.
    timeout: 20_000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout) as Array<string | null>
}

function wrap(tag: number[], bytes: Buffer): Buffer {
  assert.ok(bytes.length < 128)
  return Buffer.concat([Buffer.from([...tag, bytes.length]), bytes])
}

const overflowLength = Buffer.from([0x80, 0x80, 0x80, 0x80, 0x08]) // 2 ** 31
const badField = Buffer.concat([Buffer.from([0x0a]), overflowLength])

test('thought extraction rejects overflowing lengths at every protobuf nesting level', () => {
  const nested = Buffer.concat([badField, Buffer.alloc(4)])
  const payloads = [
    badField,
    wrap([0xa2, 0x01], Buffer.concat([Buffer.from([0x1a]), overflowLength])),
    wrap([0x0a], nested),
    wrap([0x0a], wrap([0x0a], nested)),
  ]
  assert.deepEqual(extractBounded(payloads), payloads.map(() => null))
})

test('six-byte lengths cannot wrap into small valid slices', () => {
  const thought = wrap([0xa2, 0x01], wrap([0x1a], Buffer.from('real')))
  assert.equal(thought.length, 9)
  // 2 ** 35 + 1 was decoded as 9 because JS bitwise shifts wrap modulo 32.
  const payload = Buffer.concat([Buffer.from([0x0a, 0x81, 0x80, 0x80, 0x80, 0x80, 0x01]), thought])
  assert.deepEqual(extractBounded([payload]), [null])
})

test('malformed nested bytes do not prevent extracting later sibling thoughts', () => {
  const thought = wrap([0xa2, 0x01], wrap([0x1a], Buffer.from('Inspect the parser.')))
  const nested = wrap([0x0a], Buffer.concat([badField, Buffer.alloc(4)]))
  assert.deepEqual(extractBounded([Buffer.concat([nested, thought])]), ['Inspect the parser.'])
})

test('truncated tags and lengths are rejected without blocking', () => {
  const payloads = [
    Buffer.from([0x80]),
    Buffer.from([0x0a, 0x80]),
    Buffer.from([0x0a, 0x05, 0x01]),
    wrap([0xa2, 0x01], Buffer.from([0x1a, 0x80])),
    Buffer.from([0x0a, ...Array<number>(12).fill(0xff)]),
  ]
  assert.deepEqual(extractBounded(payloads), payloads.map(() => null))
})
