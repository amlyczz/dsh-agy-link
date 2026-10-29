import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeDoctorReport } from '../src/host/diagnostics.ts'

test('writeDoctorReport writes the doctor report with 0600 permissions', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-doctor-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const file = writeDoctorReport({
      cfg: () => ({ suppressAgyAutoUpdate: false, proxyUrl: '', extraArgs: [] } as never),
      bin: () => null,
      version: () => null,
      catalog: () => ({ get: () => ({ source: 'test', models: [], lastError: undefined }) } as never),
      store: () => ({ all: () => ({}) } as never),
      recentLines: () => [],
    })
    if (process.platform !== 'win32') {
      const mode = statSync(file).mode & 0o777
      assert.equal(mode, 0o600, 'report must be owner-only readable')
    }
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})
