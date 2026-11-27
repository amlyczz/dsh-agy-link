// Issue #229: `getConfig` sits on every hot path; `resolveConfig` re-reads the
// overrides file and ~65 env vars per call, which showed up in DSH host CPU
// profiles. The cached resolver keeps bursts in memory with a 2 s TTL and is
// invalidated the moment the host itself writes the overrides file.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { CONFIG_CACHE_TTL_MS, createCachedConfigResolver } from '../../src/host/config-cache.ts'

test('#229 repeated getConfig calls inside the TTL resolve once; the TTL re-resolves', () => {
  let clock = 1_000
  let resolutions = 0
  const getConfig = createCachedConfigResolver(() => ({ n: ++resolutions }), { now: () => clock })
  assert.equal(CONFIG_CACHE_TTL_MS, 2_000)
  const a = getConfig()
  assert.equal(getConfig(), a, 'same object inside the TTL')
  assert.equal(getConfig(), a)
  assert.equal(resolutions, 1, 'the resolver ran once')
  clock += CONFIG_CACHE_TTL_MS - 1
  assert.equal(getConfig(), a, 'still inside the window')
  assert.equal(resolutions, 1)
  clock += 1
  const b = getConfig()
  assert.notEqual(b, a, 'a new object once the TTL elapsed')
  assert.equal(resolutions, 2)
  assert.equal(getConfig.resolutions(), 2)
})

test('#229 invalidate() makes the very next read see the new value (the host writes overrides itself)', () => {
  let value = 'before'
  const getConfig = createCachedConfigResolver(() => value)
  assert.equal(getConfig(), 'before')
  value = 'after'
  assert.equal(getConfig(), 'before', 'inside the TTL a blind write is not seen')
  getConfig.invalidate()
  assert.equal(getConfig(), 'after', 'after the host invalidates, it is')
  getConfig.invalidate()
  assert.equal(getConfig(), 'after', 'invalidate is idempotent')
})

test('#229 the host wires the cache and invalidates it inside setOverride', () => {
  const src = readFileSync(new URL('../../src/host/services.ts', import.meta.url), 'utf8')
  assert.match(src, /const getConfig = createCachedConfigResolver\(\(\): PluginConfig => resolveConfig\(entryConfig\)\)/)
  assert.match(src, /writeFileAtomicSync\(file, JSON\.stringify\(current, null, 2\)\); getConfig\.invalidate\(\)/)
})
