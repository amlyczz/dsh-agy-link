import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statSync, mkdtempSync, rmSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeDoctorReport } from '../src/host/diagnostics.ts'

const deps = {
  cfg: () => ({ suppressAgyAutoUpdate: false, proxyUrl: '', extraArgs: [] } as never),
  bin: () => null,
  version: () => null,
  catalog: () => ({ get: () => ({ source: 'test', models: [], lastError: undefined }) } as never),
  store: () => ({ all: () => ({}) } as never),
  recentLines: () => [],
}

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'agy-doctor-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return fn(home)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
}

test('writeDoctorReport writes the report with 0600 permissions', () => {
  if (process.platform === 'win32') return
  withHome(() => {
    const file = writeDoctorReport(deps)
    assert.equal(statSync(file).mode & 0o777, 0o600, 'report must be owner-only readable')
  })
})

test('writeDoctorReport tightens an existing world-readable diagnostics dir to 0700', () => {
  if (process.platform === 'win32') return
  withHome((home) => {
    const dir = join(home, 'agy-link', 'diagnostics')
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    chmodSync(dir, 0o755)
    writeDoctorReport(deps)
    assert.equal(statSync(dir).mode & 0o777, 0o700, 'existing dir must be tightened')
  })
})
