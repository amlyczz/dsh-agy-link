// ACP transport kill semantics: `close()` must actually terminate the server.
//
// agy ignores SIGTERM while its graceful-shutdown handlers run (the CLI path
// documented the same behaviour in runtime/agy/process.ts). The ACP client used
// to send one SIGTERM to a non-detached child and forget it, which leaked a
// live `agy acp` server — plus its MCP children — on every eviction.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AcpProcess } from '../../../src/features/acp/client.ts'
import { killTree } from '../../../src/runtime/agy/process.ts'
import { pidAlive } from '../../../src/runtime/agy/process-table.ts'
import { removeTempDir } from '../../helpers/temp.ts'

/** Mock acp server: answers `initialize`, ignores SIGTERM, spawns a child. */
const STUBBORN_ACP = `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

process.on('SIGTERM', () => {})

const grand = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' })
writeFileSync(process.env.PID_FILE, String(grand.pid))

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed === '') return
  let msg
  try { msg = JSON.parse(trimmed) } catch { return }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false } }, authMethods: [] },
    }) + '\\n')
  }
})

setInterval(() => {}, 1000)
`

function waitForPidFile(path: string, timeoutMs = 5_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const tick = (): void => {
      try {
        const pid = Number.parseInt(readFileSync(path, 'utf8'), 10)
        if (Number.isFinite(pid) && pid > 0) {
          resolve(pid)
          return
        }
      } catch {
        // not written yet
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('mock acp never reported its child pid'))
        return
      }
      setTimeout(tick, 25)
    }
    tick()
  })
}

function waitForDeath(pid: number, timeoutMs = 6_000): Promise<boolean> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const tick = (): void => {
      if (!pidAlive(pid)) {
        resolve(true)
        return
      }
      if (Date.now() - startedAt > timeoutMs) {
        resolve(false)
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
}

test('killTree escalates a SIGTERM-ignoring process group to SIGKILL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-killtree-'))
  try {
    const script = join(dir, 'stubborn.mjs')
    const pidFile = join(dir, 'grand.pid')
    writeFileSync(script, STUBBORN_ACP)
    const child = spawn(process.execPath, [script], {
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PID_FILE: pidFile },
    })
    const exited = new Promise<boolean>((resolve) => {
      child.once('exit', () => resolve(true))
      setTimeout(() => resolve(false), 6_000).unref?.()
    })
    const grandPid = await waitForPidFile(pidFile)
    assert.equal(pidAlive(grandPid), true)

    killTree(child, { escalateMs: 150 })
    assert.equal(await exited, true, 'the direct child must die')
    assert.equal(await waitForDeath(grandPid), true, 'the group kill must reach the grandchild')
  } finally {
    removeTempDir(dir)
  }
})

test('AcpProcess.close() terminates the server and its children even when SIGTERM is ignored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-acp-close-'))
  try {
    const script = join(dir, 'mock-acp.mjs')
    const pidFile = join(dir, 'grand.pid')
    writeFileSync(script, STUBBORN_ACP)
    const proc = new AcpProcess({
      bin: script,
      // cwd deliberately OUTSIDE the temp dir: a process whose cwd is the temp
      // directory keeps it locked on Windows even after it dies, which made the
      // final rmSync flake with EPERM under full-suite concurrency.
      cwd: tmpdir(),
      env: { ...process.env, PID_FILE: pidFile },
      permissionMode: 'skip',
      sandbox: false,
      logDir: dir,
      preemptAutoUpdate: false,
    })
    await proc.ensureInitialized()
    const pid = proc.pid
    assert.ok(pid !== null && pid > 0, 'acp server started')
    const grandPid = await waitForPidFile(pidFile)
    assert.equal(pidAlive(pid!), true)

    proc.close()

    assert.equal(await waitForDeath(pid!), true, 'the acp server must not survive close()')
    assert.equal(await waitForDeath(grandPid), true, 'its MCP-style children must go too')
  } finally {
    removeTempDir(dir)
  }
})
