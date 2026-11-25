// Model-scoped availability: an image-model 429 must pause ONLY that model.
//
// Google meters image generation against a per-model bucket inside the same
// `google` family (`quotas.google.models[].modelId = gemini-3.1-flash-image`),
// so the family is the wrong granularity for a 429. These tests pin the
// contract: family stays usable, the model cools down, selection skips it, and
// ImageService rotates locally without moving the global sticky pointer.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig } from '../../src/common/types.ts'
import { baseModelSlug, type ManagedAccount } from '../../src/common/pool-types.ts'
import { isModelQuotaClear } from '../../src/domain/accounts/selection.ts'
import { AccountPoolManager } from '../../src/host/pool.ts'
import { ImageService } from '../../src/features/image/service.ts'

const IMAGE = 'gemini-3.1-flash-image'
const DRIVER = 'gemini-4-neon'

function pngFile(dir: string): string {
  const file = join(dir, 'ok.png')
  const png = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0)
  png.writeUInt32BE(13, 8)
  png.write('IHDR', 12, 'ascii')
  png.writeUInt32BE(512, 16)
  png.writeUInt32BE(512, 20)
  writeFileSync(file, png)
  return file
}

function fullGoogle(pool: AccountPoolManager, id: string, imageFraction = 1): void {
  pool.updateAccountQuotas(id, {
    google: {
      remainingFraction: 1,
      weeklyFraction: 1,
      updatedAt: Date.now(),
      models: [{ modelId: IMAGE, remainingFraction: imageFraction }],
    },
  })
}

/** Two enabled accounts on a clean pool (the built-in primary is disabled). */
function twoAccounts(root: string): { pool: AccountPoolManager; a: ManagedAccount; b: ManagedAccount } {
  const pool = new AccountPoolManager(join(root, 'pool'))
  pool.setCatalog({
    get: () => ({ source: 'discovered', models: [{ id: DRIVER }, { id: IMAGE }, { id: 'gemini-3.8-flash' }] }),
  })
  const a = pool.createAccountSlot('acc-a')
  const b = pool.createAccountSlot('acc-b')
  for (const acc of pool.getAccounts()) {
    if (acc.id !== a.id && acc.id !== b.id) pool.setAccountEnabled(acc.id, false)
  }
  fullGoogle(pool, a.id)
  fullGoogle(pool, b.id)
  return { pool, a, b }
}

describe('model-scoped cooldown', () => {
  test('a model 429 cools only that model; the family and its other models stay available', () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-model-cd-'))
    try {
      const { pool, a } = twoAccounts(root)
      pool.recordModelFailure(a.id, IMAGE, 'You have exhausted your capacity on this model.', '2026-11-23T20:46:40Z')

      const after = pool.getAccount(a.id)!
      assert.equal(after.cooldowns.google, undefined, 'the family must never be cooled by a model 429')
      assert.ok(after.modelCooldowns?.[baseModelSlug(IMAGE)], 'the image model carries the cooldown')
      assert.equal(pool.isAccountEligibleForModel(after, 'google', IMAGE), false)
      assert.equal(pool.isAccountEligibleForModel(after, 'google', DRIVER), true)
      assert.equal(isModelQuotaClear(after, 'google', IMAGE, Date.now()), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the cooldown persists across a pool reload and a success clears it', () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-model-cd-persist-'))
    try {
      const dir = join(root, 'pool')
      const pool = new AccountPoolManager(dir)
      const a = pool.createAccountSlot('acc-a')
      pool.recordModelFailure(a.id, IMAGE, 'capacity exhausted', '2026-11-23T20:46:40Z')

      const reloaded = new AccountPoolManager(dir)
      assert.ok(reloaded.getAccount(a.id)?.modelCooldowns?.[baseModelSlug(IMAGE)])

      reloaded.recordModelSuccess(a.id, IMAGE)
      assert.equal(reloaded.getAccount(a.id)?.modelCooldowns?.[baseModelSlug(IMAGE)], undefined)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('selection takes a SECOND quota model into account (image bucket pre-filter)', () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-model-cd-select-'))
    try {
      const { pool, a, b } = twoAccounts(root)
      fullGoogle(pool, a.id, 0)
      fullGoogle(pool, b.id, 1)
      pool.markAccountActive(b.id, 'google')

      // Without the hint the family is healthy on both accounts.
      assert.ok(pool.selectAccount('google', DRIVER))
      // With the image bucket as a second dimension, the drained account is skipped.
      assert.equal(pool.selectAccount('google', DRIVER, IMAGE)?.id, b.id)
      assert.equal(isModelQuotaClear(a, 'google', IMAGE, Date.now()), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('ImageService model-scoped rotation', () => {
  test('rotates locally on an image 429 without cooling the family or moving the pointer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-img-model-rot-'))
    try {
      const { pool, a } = twoAccounts(root)
      pool.markAccountActive(a.id, 'google')
      const pointerBefore = pool.getActiveAccountId('google')
      const okImg = pngFile(root)
      let calls = 0
      let sawQuotaModel: string | undefined
      let sawExclusions: readonly string[] | undefined

      const service = new ImageService({
        cfg: () => ({ ...defaultConfig(), imageRetries: 0, imageModel: DRIVER }),
        bin: () => '/fake/agy',
        poolQuotaHops: () => 1,
        imageQuotaModel: () => IMAGE,
        onQuotaExhausted: (accId, model, errText, quotaModel) => {
          if (accId) pool.recordModelFailure(accId, quotaModel ?? model, errText)
          return pool.findAccount('google', model, quotaModel) !== null
        },
        onModelSuccess: (accId, quotaModel) => pool.recordModelSuccess(accId, quotaModel),
        run: async (call) => {
          calls++
          sawQuotaModel = call.quotaModel
          sawExclusions = call.excludeAccountIds
          const usable = pool
            .getAccounts()
            .find((acc) => acc.enabled && isModelQuotaClear(acc, 'google', IMAGE, Date.now()) && !(call.excludeAccountIds ?? []).includes(acc.id))
          assert.ok(usable, 'the local rotation must keep a usable account')
          if (calls === 1) {
            return {
              ok: true,
              text: 'quota error',
              accountId: usable.id,
              toolCalls: [{ name: 'generate_image', error: 'RESOURCE_EXHAUSTED (code 429): You have exhausted your capacity on this model. Your quota will reset after 4h.' }],
              subagents: [],
              durationMs: 5,
            }
          }
          return {
            ok: true,
            text: 'IMAGE_PATH=' + okImg,
            accountId: usable.id,
            toolCalls: [{ name: 'generate_image', output: 'ok' }],
            subagents: [],
            durationMs: 5,
          }
        },
      })

      const res = await service.generate({ prompt: 'a cat' })
      assert.equal(res.ok, true, res.error)
      assert.equal(calls, 2)
      assert.equal(sawQuotaModel, IMAGE, 'the image bucket is passed to selection and the failover hook')
      assert.deepEqual(sawExclusions, [a.id], 'the failed account is excluded from the same request')
      assert.equal(pool.getActiveAccountId('google'), pointerBefore, 'the global sticky pointer must not move')
      assert.equal(pool.getAccount(a.id)?.cooldowns.google, undefined, 'no family cooldown')
      assert.ok(pool.getAccount(a.id)?.modelCooldowns?.[baseModelSlug(IMAGE)], 'only the image model cools down')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
