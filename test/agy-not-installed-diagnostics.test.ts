// A missing agy executable must be self-explanatory: the user needs to know
// WHERE the plugin looked and how to point it at a binary installed outside
// those locations, otherwise the only clue is "not found on PATH".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agyBinCandidates, agyBinDiagnostics, resolveAgyBin } from '../src/runtime/agy/bin.ts'
import { agyNotInstalledMessage, resolveCallContext } from '../src/provider/call-context.ts'
import { writeDoctorReport } from '../src/host/diagnostics.ts'
import { defaultConfig, type PluginConfig } from '../src/common/types.ts'
import type { AgyGenerateOptions } from '../src/common/protocol.ts'

function cfgWith(over: Partial<PluginConfig> = {}): PluginConfig {
  return { ...defaultConfig(), ...over }
}

test('agyBinCandidates includes the configured agyBin first', () => {
  const candidates = agyBinCandidates(cfgWith({ agyBin: '/custom/agy' }))
  assert.equal(candidates[0], '/custom/agy')
})

test('agyBinCandidates probes PATH entries with the per-platform extension', () => {
  const candidates = agyBinCandidates(cfgWith())
  const onPath = candidates.filter((c) => c.includes('nodejs'))
  assert.ok(onPath.length > 0, 'the nodejs PATH entry must be probed')
  if (process.platform === 'win32') {
    assert.ok(onPath.some((c) => c.endsWith('agy.exe')), 'windows probes agy.exe')
  } else {
    assert.ok(onPath.some((c) => c.endsWith('agy')), 'posix probes the extensionless agy')
  }
})

test('agyBinCandidates probes the documented per-platform install locations', () => {
  const candidates = agyBinCandidates(cfgWith())
  const joined = candidates.join('\n')
  if (process.platform === 'win32') {
    assert.ok(joined.includes('agy\\bin\\agy.exe') || joined.includes('agy/bin/agy.exe'), 'windows local-appdata default')
    assert.ok(joined.includes('npm'), 'windows npm global shim')
  } else {
    assert.ok(joined.includes('/usr/local/bin/agy'), 'posix /usr/local/bin')
    assert.ok(joined.includes('homebrew'), 'posix homebrew')
  }
})

test('resolveAgyBin still honours an explicit agyBin that exists', () => {
  const found = resolveAgyBin(cfgWith({ agyBin: process.execPath }))
  assert.equal(found, process.execPath)
})

test('agyBinDiagnostics reports the probed locations and the install hint', () => {
  const diag = agyBinDiagnostics(cfgWith())
  assert.ok(diag.probed.length > 0)
  assert.ok(diag.installHint.length > 0)
  assert.match(diag.installHint, /agy/)
})

test('agyNotInstalledMessage names the probed locations and both overrides', () => {
  const message = agyNotInstalledMessage(cfgWith())
  assert.match(message, /not found/)
  assert.match(message, /antigravity\.google\/docs\/cli\/install/)
  assert.match(message, /agyBin/)
  assert.match(message, /DSH_AGY_BIN/)
  assert.match(message, /\/agy doctor/)
})

test('agyNotInstalledMessage lists a configured but missing agyBin', () => {
  const message = agyNotInstalledMessage(cfgWith({ agyBin: '/nonexistent/agy/path/xyz' }))
  assert.match(message, /nonexistent/)
  assert.match(message, /does not exist/)
})

test('resolveCallContext throws AGY_NOT_INSTALLED with actionable detail', () => {
  const options = { provider: 'antigravity', model: 'gemini-3.8-flash', messages: [] } as unknown as AgyGenerateOptions
  assert.throws(
    () =>
      resolveCallContext({
        options,
        cfg: cfgWith(),
        bin: null,
        warnOnce: () => undefined,
        cwd: '/proc-cwd',
      }),
    (err: unknown) => {
      const e = err as { code?: string; message?: string }
      assert.equal(e.code, 'AGY_NOT_INSTALLED')
      assert.match(e.message ?? '', /DSH_AGY_BIN/)
      return true
    },
  )
})

test('doctor report lists the probed locations when the binary is missing', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-doctor-probe-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const file = writeDoctorReport({
      cfg: () => cfgWith(),
      bin: () => null,
      version: () => null,
      catalog: () => ({ get: () => ({ source: 'test', models: [], lastError: undefined }) } as never),
      store: () => ({ all: () => ({}) } as never),
      recentLines: () => [],
    })
    const report = readFileSync(file, 'utf8')
    assert.match(report, /agy lookup: NOT FOUND/)
    assert.match(report, /DSH_AGY_BIN/)
    assert.match(report, /agy lookup: install hint/)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})
