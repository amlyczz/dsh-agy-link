import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig } from '../../../src/common/types.ts'
import { AcpProcess } from '../../../src/features/acp/client.ts'
import { AcpSessionPool } from '../../../src/features/acp/pool.ts'

function makeFakeAcpBin(dir: string, opts: { supportsImage: boolean; failResume?: boolean }): string {
  const script = join(dir, `fake-acp-${opts.supportsImage ? 'img' : 'noimg'}-${opts.failResume ? 'fail' : 'ok'}.mjs`)
  writeFileSync(
    script,
    `
import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin })
const supportsImage = ${JSON.stringify(opts.supportsImage)}
const failResume = ${JSON.stringify(Boolean(opts.failResume))}
let seq = 0
rl.on('line', (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  const { id, method, params } = msg
  if (method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: supportsImage } },
      },
    }) + '\\n')
    return
  }
  if ((method === 'session/resume' || method === 'session/load') && failResume) {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32001, message: 'session not found' },
    }) + '\\n')
    return
  }
  if (method === 'session/new') {
    seq++
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: { sessionId: 'fresh-sid-' + seq },
    }) + '\\n')
    return
  }
  if (method === 'session/set_config_option' || method === 'session/set_mode') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + '\\n')
    return
  }
  if (method === 'session/prompt') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: JSON.stringify(params.prompt) },
        },
      },
    }) + '\\n')
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: { stopReason: 'end_turn' },
    }) + '\\n')
  }
})
`,
    'utf8',
  )
  return script
}

function safeCleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // ignore Windows transient cwd handle delay
  }
}

describe('Slice 6: ACP spare pre-warm, native inline images, and stale session rebuild', () => {
  it('defaults the transport to the persistent ACP channel', () => {
    assert.equal(defaultConfig().transport, 'acp')
  })

  it('warmSpare pre-initializes one idle ACP process and acquireProcess adopts it instantaneously', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-spare-'))
    const bin = makeFakeAcpBin(dir, { supportsImage: true })
    const pool = new AcpSessionPool({ bin: () => bin, cfg: defaultConfig })
    try {
      const ok = await pool.warmSpare({
        bin,
        cwd: dir,
        accountId: 'acc-1',
        mode: 'skip',
        sandbox: false,
        agent: '',
        preemptAutoUpdate: false,
      })
      assert.equal(ok, true)
      assert.equal(pool.status().activeProcesses, 1)

      const p1 = pool.acquireProcess({
        bin,
        cwd: dir,
        accountId: 'acc-1',
        mode: 'skip',
        sandbox: false,
        agent: '',
        preemptAutoUpdate: false,
      })
      assert.equal(p1.isAlive(), true)
      assert.equal(p1.supportsImageBlocks, true)
      assert.equal(pool.status().activeProcesses, 1)
    } finally {
      pool.dispose()
      safeCleanup(dir)
    }
  })

  it('sends native inline image blocks only when agy advertises promptCapabilities.image === true', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-img-'))
    const binWithImg = makeFakeAcpBin(dir, { supportsImage: true })
    const binNoImg = makeFakeAcpBin(dir, { supportsImage: false })
    const p1 = new AcpProcess({ bin: binWithImg, cwd: dir, permissionMode: 'skip', preemptAutoUpdate: false })
    const p2 = new AcpProcess({ bin: binNoImg, cwd: dir, permissionMode: 'skip', preemptAutoUpdate: false })
    try {
      const { sessionId: sid1 } = await p1.openSession({ cwd: dir, mode: 'skip' })
      assert.equal(p1.supportsImageBlocks, true)
      let echoed1 = ''
      await p1.prompt({
        sessionId: sid1,
        text: 'Describe this screenshot',
        images: [{ data: 'AQID', mimeType: 'image/png' }],
        timeoutMs: 10_000,
        onUpdate: (u) => {
          const content = u.content as { text?: string } | undefined
          if (content?.text) echoed1 += content.text
        },
      })
      const blocks1 = JSON.parse(echoed1) as Array<Record<string, unknown>>
      assert.equal(blocks1.length, 2)
      assert.deepEqual(blocks1[0], { type: 'image', data: 'AQID', mimeType: 'image/png' })
      assert.deepEqual(blocks1[1], { type: 'text', text: 'Describe this screenshot' })

      const { sessionId: sid2 } = await p2.openSession({ cwd: dir, mode: 'skip' })
      assert.equal(p2.supportsImageBlocks, false)
      let echoed2 = ''
      await p2.prompt({
        sessionId: sid2,
        text: 'Fallback text only',
        images: [{ data: 'AQID', mimeType: 'image/png' }],
        timeoutMs: 10_000,
        onUpdate: (u) => {
          const content = u.content as { text?: string } | undefined
          if (content?.text) echoed2 += content.text
        },
      })
      const blocks2 = JSON.parse(echoed2) as Array<Record<string, unknown>>
      assert.deepEqual(blocks2, [{ type: 'text', text: 'Fallback text only' }])
    } finally {
      p1.close()
      p2.close()
      safeCleanup(dir)
    }
  })

  it('flags rebuilt sessions when resumeId fails session/resume and session/load', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-rebuild-'))
    const bin = makeFakeAcpBin(dir, { supportsImage: false, failResume: true })
    const proc = new AcpProcess({ bin, cwd: dir, permissionMode: 'skip', preemptAutoUpdate: false })
    try {
      const opened = await proc.openSession({ cwd: dir, resumeId: 'dead-old-sid', mode: 'skip' })
      assert.equal(opened.sessionId, 'fresh-sid-1')
      assert.equal(opened.resumeFailed, true)
      assert.equal(proc.consumeRebuiltSession(opened.sessionId), true)
      assert.equal(proc.consumeRebuiltSession(opened.sessionId), false)
    } finally {
      proc.close()
      safeCleanup(dir)
    }
  })
})
