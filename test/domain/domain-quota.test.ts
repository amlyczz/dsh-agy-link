// Focused unit coverage for domain helpers that had no direct test before the
// Phase 5a move. The bucket/identity helpers keep their existing coverage in
// test/quota.test.ts and test/pool.test.ts (they are re-exported unchanged);
// only the atomic JSON writer lacked a direct, isolated test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonAtomic } from '../../src/domain/accounts/paths.ts'

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
import { buildFamilyQuotas, buildModelsCatalog } from '../../src/domain/quota/parse.ts'
import { summaryHasArgonGroup } from '../../src/domain/quota/buckets.ts'
import { AGY_ENDPOINTS } from '../../src/host/oauth.ts'

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

// ---- A shared pool that *mentions* Argon must not become a dedicated Argon pool ----

test('group description listing "Gemini 4 Argon" does not make the shared Gemini pool an Argon pool', () => {
  // agy 1.5.12 changed the plain `Gemini Models` group description to enumerate
  // its members: "Models within this group: Gemini 4 Neon, Gemini 4 Carbon,
  // Gemini 4 Argon, Gemini 4 Hydrogen, Gemini 3.8 Flash". Matching "argon" in
  // the description therefore filed the SHARED pool under `argon` and left
  // `google` without its weekly numbers (observed live 2026-11-19).
  const now = Date.parse('2026-11-19T02:00:00Z')
  const fiveHourReset = '2026-11-19T06:06:42Z'
  const weeklyReset = '2026-11-25T02:36:02Z'

  const { familyQuotas } = buildFamilyQuotas({
    summary: {
      groups: [
        {
          displayName: 'Gemini Models',
          description:
            'Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Gemini 3.8 Flash',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.83, resetTime: fiveHourReset },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.72, resetTime: weeklyReset },
          ],
        },
      ],
    },
    modelsCatalog: {},
    prevQuotas: {},
    now,
  })

  assert.equal(familyQuotas.argon, undefined, 'the shared Gemini pool must not be filed as a dedicated Argon pool')
  assert.equal(familyQuotas.google?.weeklyFraction, 0.72, 'the Gemini weekly bucket must survive on google')
  assert.equal(familyQuotas.google?.remainingFraction, 0.83)
  assert.equal(familyQuotas.google?.weeklyResetTime, weeklyReset)
})

test('a genuinely dedicated Argon group is still detected by its name or bucket id', () => {
  // Name evidence ("Gemini 4 Argon").
  assert.equal(
    summaryHasArgonGroup([
      { displayName: 'Gemini 4 Argon', buckets: [{ bucketId: 'argon-weekly' }] },
    ]),
    true,
    'a group named after Argon is a dedicated pool',
  )
  // Bucket-id evidence, even when the display name is generic.
  assert.equal(
    summaryHasArgonGroup([
      { displayName: 'Extra models', buckets: [{ bucketId: 'argon-weekly' }] },
    ]),
    true,
    'an argon bucket id is a dedicated pool',
  )
  // Description-only mention is NOT evidence (agy >= 1.5.12 enumeration).
  assert.equal(
    summaryHasArgonGroup([
      {
        displayName: 'Gemini Models',
        description: 'Models within this group: Gemini 4 Argon, Gemini 4 Carbon',
        buckets: [{ bucketId: 'gemini-weekly' }],
      },
    ]),
    false,
    'a description that merely lists Argon must not mark a dedicated pool',
  )
})
