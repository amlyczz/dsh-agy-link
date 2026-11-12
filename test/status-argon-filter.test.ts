import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { createHostServices } from '../src/host/services.ts'
import { register as registerStatus } from '../src/transport/http/routes/status.ts'
import { register as registerPool } from '../src/transport/http/routes/pool.ts'

function createSandbox(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'agy-status-sandbox-'))
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(process.env)) saved[k] = process.env[k]
  process.env.HOME = root
  process.env.DSH_HOME = root
  process.env.DSH_STATE_DIR = root
  process.env.DSH_AGY_ACCOUNTS_DIR = root
  t.after(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k]
    }
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v
    }
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

function mockRes() {
  let statusCode = 0
  let bodyStr = ''
  return {
    writeHead(code: number) { statusCode = code },
    end(data?: string) { if (data) bodyStr += data },
    get status() { return statusCode },
    json() { return JSON.parse(bodyStr) },
  }
}

test('status route filters catalogModels based on the active account capabilities', async (t) => {
  createSandbox(t)
  const emitted: string[] = []
  const fakeCtx = {
    logger: { info: () => {} },
    emit: (ev: string) => emitted.push(ev),
  } as unknown as Context

  const services = createHostServices(fakeCtx, {
    enabled: true,
  })

  // Set up routes
  const routes = new Map<string, (req: any, res: any) => void>()
  const registrar = (route: { kind: string; path: string; handler: (req: any, res: any) => void }) => {
    routes.set(route.path, route.handler)
  }
  registerStatus(registrar, services)
  registerPool(registrar, services)

  const pool = services.pool
  const accWithArgon = pool.createAccountSlot('dao')
  const accWithoutArgon = pool.createAccountSlot('ele')

  pool.updateAccountQuotas(accWithArgon.id, {
    google: { remainingFraction: 1 },
    argon: { remainingFraction: 1, models: [{ modelId: 'gemini-4-argon', displayName: 'Gemini 4 Argon' }] },
  })
  pool.updateAccountQuotas(accWithoutArgon.id, {
    google: { remainingFraction: 1, models: [{ modelId: 'gemini-3.8-pro', displayName: 'Gemini 3.8 Pro' }] },
    anthropic: { remainingFraction: 1 },
  })

  const statusHandler = routes.get('/plugins/agy-link/status')!
  assert.ok(statusHandler)

  // 1. When accWithArgon is active:
  pool.setActiveAccount(accWithArgon.id)
  const res1 = mockRes()
  statusHandler({ method: 'GET' }, res1)
  await new Promise((r) => setTimeout(r, 10))
  const data1 = res1.json()
  const models1 = data1.catalogModels as Array<{ id: string }>
  assert.ok(models1.some((m) => m.id.includes('argon')), 'dao should see argon in catalogModels')

  // 2. When accWithoutArgon (ele) is active:
  pool.setActiveAccount(accWithoutArgon.id)
  const res2 = mockRes()
  statusHandler({ method: 'GET' }, res2)
  await new Promise((r) => setTimeout(r, 10))
  const data2 = res2.json()
  const models2 = data2.catalogModels as Array<{ id: string }>
  assert.equal(models2.some((m) => m.id.includes('argon')), false, 'ele should NOT see argon in catalogModels')
})

test('POST /plugins/agy-link/pool/import imports refresh token via HTTP', async (t) => {
  createSandbox(t)
  const fakeCtx = {
    logger: { info: () => {} },
    emit: () => {},
  } as unknown as Context

  const services = createHostServices(fakeCtx, {
    enabled: true,
  })

  // Override refresh and email in poolAuth
  const poolAuth = services.poolAuth
  ;(poolAuth as any).refresh = async (rt: string) => ({
    access_token: 'acc_' + rt,
    refresh_token: rt,
  })
  ;(poolAuth as any).userEmail = async () => 'imported_user@example.com'

  const routes = new Map<string, (req: any, res: any) => void>()
  registerPool((route) => routes.set(route.path, route.handler), services)

  const importHandler = routes.get('/plugins/agy-link/pool/import')!
  assert.ok(importHandler)

  // Post token import
  const req = {
    method: 'POST',
    on(event: string, handler: any) {
      if (event === 'data') {
        handler(Buffer.from(JSON.stringify({ token: '1//refresh-token-test', alias: 'Imported Web User' })))
      }
      if (event === 'end') {
        handler()
      }
    },
  }
  const res = mockRes()
  importHandler(req, res)
  await new Promise((r) => setTimeout(r, 20))

  assert.equal(res.status, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.email, 'imported_user@example.com')
  assert.equal(body.isNew, true)
  assert.equal(body.account.alias, 'Imported Web User')
})
