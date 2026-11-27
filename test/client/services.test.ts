import { test } from 'node:test'
import assert from 'node:assert/strict'

import { currentSessionId, serviceOf } from '../../src/client/services.ts'

test('serviceOf resolves a service through ctx.reflect.get (Cordis v4)', () => {
  const sidebar = { openTab: () => {} }
  const ctx = { reflect: { get: (name: string, strict?: boolean) => (name === 'sidebarRight' && strict === false ? sidebar : undefined) } }
  assert.deepEqual(serviceOf(ctx, 'sidebarRight'), sidebar)
})

test('serviceOf falls back to a plain property and tolerates a missing one', () => {
  const tabs = { register: () => () => {} }
  assert.deepEqual(serviceOf({ sidebarRightTabs: tabs }, 'sidebarRightTabs'), tabs)
  assert.equal(serviceOf({}, 'sidebarRight'), undefined)
  assert.equal(serviceOf(null, 'sidebarRight'), undefined)
})

test('serviceOf keeps the reflect lookup ahead of a throwing getter-less context', () => {
  const ctx = {
    reflect: { get: () => undefined },
    get: () => {
      throw new Error('no such service')
    },
  }
  assert.equal(serviceOf(ctx, 'sidebarRight'), undefined)
})

test('currentSessionId reads the uiSession key, then the only listed session', () => {
  assert.equal(currentSessionId({ uiSession: { current: { value: { key: 's-1' } } } }), 's-1')
  assert.equal(currentSessionId({ uiSession: { current: { value: { sessionId: 's-2' } } } }), 's-2')
  assert.equal(currentSessionId({ sessions: { list: { getSnapshot: () => ({ byId: { 's-3': {} } }) } } }), 's-3')
  assert.equal(currentSessionId({}), '')
})