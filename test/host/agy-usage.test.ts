import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAgyUsageOutput,
  parseUsageTextTable,
  usageGroupsToFamilies,
  mergeUsageFamilies,
  readAgyUsage,
  type AgyUsageGroup,
} from '../../src/host/agy-usage.ts'
import type { FamilyQuotaInfo, ModelFamily } from '../../src/common/pool-types.ts'

test('parseAgyUsageOutput parses command_result stream-json event', () => {
  const jsonEvent = JSON.stringify({
    event: 'command_result',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            description: 'Gemini 3.7 Flash and Pro models',
            buckets: [
              { id: 'gemini-5h', window: '5h', remaining_fraction: 0.85, reset_time: '2026-10-23T20:00:00Z' },
              { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.95, reset_time: '2026-10-30T00:00:00Z' },
            ],
          },
          {
            name: 'Gemini 4 Argon',
            description: 'For paid Pro plans, Argon quota is separate.',
            buckets: [
              { id: 'gemini-argon-wtu-weekly', window: 'weekly', remaining_fraction: 0.944, reset_time: '2026-10-30T02:42:31Z' },
            ],
          },
          {
            name: 'Claude and GPT models',
            description: 'Claude Opus, Sonnet, GPT-OSS',
            buckets: [
              { id: '3p-5h', window: '5h', remaining_fraction: 0.5, reset_time: '2026-10-23T21:00:00Z' },
            ],
          },
        ],
      },
    },
  })

  const groups = parseAgyUsageOutput(jsonEvent)
  assert.ok(groups !== null)
  assert.equal(groups.length, 3)
  assert.equal(groups[0]?.name, 'Gemini Models')
  assert.equal(groups[0]?.buckets.length, 2)
  assert.equal(groups[1]?.name, 'Gemini 4 Argon')
  assert.equal(groups[2]?.name, 'Claude and GPT models')
})

test('parseUsageTextTable parses tabular CLI output fallback', () => {
  const table = [
    'Gemini Models\t5-hour limit\t85%\t2026-10-23T20:00:00Z',
    'Gemini Models\tWeekly limit\t95%\t2026-10-30T00:00:00Z',
    'Gemini 4 Argon\tWeekly limit\t94%\t2026-10-30T02:42:31Z',
    'Claude and GPT models\t5-hour limit\t50%\t2026-10-23T21:00:00Z',
  ].join('\n')

  const groups = parseUsageTextTable(table)
  assert.ok(groups !== null)
  assert.equal(groups.length, 3)
  const gemini = groups.find((g) => g.name === 'Gemini Models')
  assert.ok(gemini)
  assert.equal(gemini.buckets.length, 2)
  assert.equal(gemini.buckets[0]?.remainingFraction, 0.85)
  assert.equal(gemini.buckets[1]?.remainingFraction, 0.95)
})

test('usageGroupsToFamilies correctly routes Argon before Gemini', () => {
  const groups: AgyUsageGroup[] = [
    {
      name: 'Gemini 4 Argon',
      description: 'Gemini Argon quota is separate for Pro users',
      buckets: [
        { id: 'argon-weekly', window: 'weekly', remainingFraction: 0.944, resetTime: '2026-10-30T02:42:31Z' },
        { id: 'argon-5h', window: '5h', remainingFraction: 0.8, resetTime: '2026-10-23T20:00:00Z' },
      ],
    },
    {
      name: 'Gemini Models',
      description: 'Gemini 3.7 Flash and Pro',
      buckets: [
        { id: 'gemini-5h', window: '5h', remainingFraction: 0.75, resetTime: '2026-10-23T19:00:00Z' },
      ],
    },
    {
      name: 'Claude and GPT models',
      description: '3P Models',
      buckets: [
        { id: '3p-5h', window: '5h', remainingFraction: 0.4, resetTime: '2026-10-23T18:30:00Z' },
      ],
    },
  ]

  const families = usageGroupsToFamilies(groups)
  assert.ok(families.argon)
  assert.equal(families.argon.weeklyFraction, 0.944)
  assert.equal(families.argon.remainingFraction, 0.8)

  assert.ok(families.google)
  assert.equal(families.google.remainingFraction, 0.75)

  // 3P maps to both anthropic and openai
  assert.ok(families.anthropic)
  assert.equal(families.anthropic.remainingFraction, 0.4)
  assert.ok(families.openai)
  assert.equal(families.openai.remainingFraction, 0.4)
})

test('mergeUsageFamilies overlays CLI quota on base without losing model breakdown', () => {
  const base: Partial<Record<ModelFamily, FamilyQuotaInfo>> = {
    google: {
      remainingFraction: 0.5,
      resetTime: 'old_reset',
      models: [
        { modelId: 'gemini-3.7-flash', remainingFraction: 0.5 },
      ],
    },
  }

  const cli: Partial<Record<ModelFamily, FamilyQuotaInfo>> = {
    google: {
      remainingFraction: 0.9,
      resetTime: 'new_reset',
      weeklyFraction: 0.99,
    },
    argon: {
      weeklyFraction: 1.0,
    },
  }

  const merged = mergeUsageFamilies(base, cli)
  assert.equal(merged.google?.remainingFraction, 0.9)
  assert.equal(merged.google?.resetTime, 'new_reset')
  assert.equal(merged.google?.weeklyFraction, 0.99)
  assert.equal(merged.google?.models?.length, 1, 'models list preserved')
  assert.equal(merged.argon?.weeklyFraction, 1.0)
})

test('readAgyUsage never throws and returns null when binary is missing or fails', async () => {
  const result = await readAgyUsage({
    bin: '/nonexistent/bin/agy-missing',
    env: process.env,
    timeoutMs: 1000,
  })
  assert.equal(result, null)
})

// issue #169: the CLI /usage path must use the SAME Argon rule as the REST
// summary path fixed in #130/#131 — a shared "Gemini Models" group whose
// DESCRIPTION merely enumerates "Gemini 4 Argon" is not a dedicated pool.
test('issue #169: a shared Gemini group is not argon just because its description lists Argon', () => {
  const shared: AgyUsageGroup[] = [{
    name: 'Gemini Models',
    description: 'Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Orchestrator (Neon), Orchestrator (Argon), Gemini 3.8 Flash',
    buckets: [
      { id: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9963 },
      { id: 'gemini-5h', window: '5h', remainingFraction: 0.9853 },
    ],
  } as never]
  const families = usageGroupsToFamilies(shared as never)
  assert.ok(families.google, 'the shared group must land in the google family')
  assert.equal(families.argon, undefined, 'it must NOT be written into the argon family')
})

test('issue #169: a real dedicated Argon group is still recognised', () => {
  const dedicated: AgyUsageGroup[] = [{
    name: 'Gemini 4 Argon',
    description: 'Models within this group: Gemini 4 Argon',
    buckets: [{ id: 'argon-weekly', window: 'weekly', remainingFraction: 0.5 }],
  } as never]
  assert.ok(usageGroupsToFamilies(dedicated as never).argon, 'by group name')
  const byBucket: AgyUsageGroup[] = [{
    name: 'Some pool',
    buckets: [{ id: 'argon-5h', window: '5h', remainingFraction: 0.5 }],
  } as never]
  assert.ok(usageGroupsToFamilies(byBucket as never).argon, 'by bucket id')
})
