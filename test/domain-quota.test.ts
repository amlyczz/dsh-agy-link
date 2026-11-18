// Focused unit coverage for domain helpers that had no direct test before the
// Phase 5a move. The bucket/identity helpers keep their existing coverage in
// test/quota.test.ts and test/pool.test.ts (they are re-exported unchanged);
// only the atomic JSON writer lacked a direct, isolated test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonAtomic } from '../src/domain/accounts/paths.ts'

test('writeJsonAtomic publishes a complete JSON snapshot with no temp residue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-write-json-atomic-'))
  try {
    const file = join(dir, 'pool.json')
    writeJsonAtomic(file, '{"accounts":[]}')
    assert.equal(readFileSync(file, 'utf8'), '{"accounts":[]}')
    assert.equal(readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0, 'no temp file may survive')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeJsonAtomic refuses to publish an unparsable snapshot over a good file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-write-json-atomic-'))
  try {
    const file = join(dir, 'pool.json')
    writeFileSync(file, '{"keep":true}')
    assert.throws(() => writeJsonAtomic(file, 'not-json'))
    // The JSON round-trip guard fires before the rename, so the real file is intact.
    assert.equal(readFileSync(file, 'utf8'), '{"keep":true}')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


// ---- Risk Control & Proto3 Zero-Quota Regression Tests ----
import { buildFamilyQuotas, buildModelsCatalog } from '../src/domain/quota/parse.ts'
import { AGY_ENDPOINTS } from '../src/host/oauth.ts'

test('risk-control: AGY_ENDPOINTS never includes enterprise cloudcode-pa.googleapis.com', () => {
  assert.equal(AGY_ENDPOINTS[0], 'https://daily-cloudcode-pa.googleapis.com')
  assert.equal(
    AGY_ENDPOINTS.includes('https://cloudcode-pa.googleapis.com'),
    false,
    'enterprise cloudcode-pa returns 429/403 and divergent 100% quotas on consumer OAuth',
  )
})

test('proto3 zero-quota omission: omitted remainingFraction with resetTime normalizes to 0 (exhausted)', () => {
  const now = Date.parse('2026-11-18T02:00:00Z')
  const futureReset = '2026-11-18T06:00:00Z'
  const weeklyReset = '2026-11-24T00:00:00Z'

  const catalog = buildModelsCatalog(
    {
      models: {
        'gemini-4-hydrogen': {
          displayName: 'Gemini 4 Hydrogen',
          // Proto3 omits 0.0 remainingFraction on exhausted models!
          quotaInfo: { resetTime: futureReset },
        },
      },
    },
    {
      buckets: [
        { modelId: 'claude-sonnet-5-5', resetTime: futureReset },
      ],
    },
  )

  const { familyQuotas } = buildFamilyQuotas({
    summary: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            // Proto3 omits 0.0 remainingFraction!
            { bucketId: 'gemini-5h', window: '5h', resetTime: futureReset },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.4, resetTime: weeklyReset },
          ],
        },
      ],
    },
    modelsCatalog: catalog,
    prevQuotas: {},
    now,
  })

  assert.equal(familyQuotas.google?.remainingFraction, 0, 'omitted 5h remainingFraction with resetTime must be 0')
  assert.equal(familyQuotas.google?.models?.[0]?.remainingFraction, 0, 'exhausted model entry must not be dropped or treated as 100%')
  assert.equal(familyQuotas.anthropic?.remainingFraction, 0, 'omitted userQuota bucket remainingFraction with resetTime must be 0')
})
