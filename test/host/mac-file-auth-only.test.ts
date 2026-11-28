import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { macFileAuthOnly, resolveConfig } from '../../src/common/config.ts'
import { validateConfigValue } from '../../src/transport/http/routes/config.ts'
import {
  ensureIsolatedKeychain,
  purgeStaleIsolatedKeychain,
  repairMacSystemKeychain,
  writeSystemKeyringRaw,
} from '../../src/runtime/agy/keychain.ts'
import { restoreTokenFromMacKeychain } from '../../src/host/boot-hygiene.ts'
import { readMacKeychainToken } from '../../src/features/quota/token.ts'
import { AccountPoolManager } from '../../src/host/pool.ts'

describe('macFileAuthOnly option', () => {
  it('resolves from overrides and DSH_AGY_MAC_FILE_AUTH_ONLY env var and validates as boolean', () => {
    assert.equal(resolveConfig(undefined, {}, {}).macFileAuthOnly, false)
    assert.equal(resolveConfig(undefined, {}, { macFileAuthOnly: true }).macFileAuthOnly, true)
    assert.equal(
      resolveConfig(undefined, { DSH_AGY_MAC_FILE_AUTH_ONLY: '1' }, { macFileAuthOnly: false }).macFileAuthOnly,
      true,
    )
    assert.equal(
      resolveConfig(undefined, { DSH_AGY_MAC_FILE_AUTH_ONLY: 'false' }, { macFileAuthOnly: true }).macFileAuthOnly,
      false,
    )
    assert.equal(validateConfigValue('macFileAuthOnly', true), null)
    assert.equal(validateConfigValue('macFileAuthOnly', false), null)
    assert.match(String(validateConfigValue('macFileAuthOnly', 'yes')), /boolean/)
  })

  it('honors env and overrides on darwin and always returns false off darwin', () => {
    const isDarwin = process.platform === 'darwin'
    assert.equal(macFileAuthOnly({}, { macFileAuthOnly: true }), isDarwin)
    assert.equal(macFileAuthOnly({ DSH_AGY_MAC_FILE_AUTH_ONLY: '1' }, { macFileAuthOnly: false }), isDarwin)
    assert.equal(macFileAuthOnly({ DSH_AGY_MAC_FILE_AUTH_ONLY: '0' }, { macFileAuthOnly: true }), false)
    assert.equal(macFileAuthOnly({}, { macFileAuthOnly: false }), false)
  })

  it('skips all macOS security keychain hooks and disables systemHome primary accounts when enabled', async () => {
    if (process.platform !== 'darwin') return
    const dir = mkdtempSync(join(tmpdir(), 'agy-mac-file-auth-'))
    const prevEnv = process.env.DSH_AGY_MAC_FILE_AUTH_ONLY
    process.env.DSH_AGY_MAC_FILE_AUTH_ONLY = '1'
    try {
      let called = 0
      const spy = () => {
        called++
        return ''
      }
      const kcDir = join(dir, 'Library', 'Keychains')
      mkdirSync(kcDir, { recursive: true })
      const kcFile = join(kcDir, 'login.keychain-db')
      writeFileSync(kcFile, '')

      assert.equal(writeSystemKeyringRaw('{}', dir), false)
      assert.equal(ensureIsolatedKeychain(join(dir, 'fresh'), 'darwin', spy), false)
      assert.equal(purgeStaleIsolatedKeychain(dir, 'darwin', spy), false)
      assert.equal(repairMacSystemKeychain(dir, 'darwin', spy), false)
      assert.equal(restoreTokenFromMacKeychain(dir, join(dir, 'token.json')), null)
      assert.equal(await readMacKeychainToken(), null)
      assert.equal(called, 0, 'must not invoke macOS security CLI when macFileAuthOnly is active')

      const poolDir = join(dir, 'pool')
      const pool = new AccountPoolManager(poolDir)
      const primary = pool.getAccounts().find((a) => a.systemHome)
      assert.ok(primary, 'default pool contains systemHome primary slot')
      assert.equal(primary.enabled, false, 'systemHome primary is disabled on boot under macFileAuthOnly')
      assert.equal(pool.setAccountEnabled(primary.id, true), false, 're-enabling systemHome primary is refused')
      assert.equal(pool.setPrimaryAccount(primary.id), false, 'pinning systemHome primary is refused')
    } finally {
      if (prevEnv === undefined) delete process.env.DSH_AGY_MAC_FILE_AUTH_ONLY
      else process.env.DSH_AGY_MAC_FILE_AUTH_ONLY = prevEnv
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
