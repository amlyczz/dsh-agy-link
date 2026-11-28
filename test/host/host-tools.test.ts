// Every bridge at once: which host tools a hop may call for agy, and how.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Message } from '@deepseek-ai/dsh-llm'
import { NO_BRIDGE_TOOLS, resolveBridgeToolSupport } from '../../src/host/host-tools.ts'
import { PTC_TOOLS_SDK } from '../helpers/ptc-sdk.ts'

const SDK_WITH_ASK = PTC_TOOLS_SDK.replace('  "read-file": { path: string };\n}', '  "read-file": { path: string };\n  ask_user_question: { questions: unknown[] };\n}')

test('resolveBridgeToolSupport follows the tool list, plan mode and the PTC tools SDK', () => {
  const direct = ['update_goal', 'exit_plan_mode', 'ask_user_question'].map((name) => ({ name }))
  assert.deepEqual(resolveBridgeToolSupport(direct, undefined, { planActive: true }), { goalUpdate: 'direct', planExit: 'direct', askUser: 'direct' })
  // Plan mode is a property of the turn: without it exit_plan_mode is not offered.
  assert.deepEqual(resolveBridgeToolSupport(direct, undefined, { planActive: false }), { goalUpdate: 'direct', planExit: false, askUser: 'direct' })
  // PTC: only run_code is direct; the rest must be declared in the tools SDK.
  const ptc = [{ name: 'run_code' }]
  assert.deepEqual(resolveBridgeToolSupport(ptc, SDK_WITH_ASK, { planActive: true }), { goalUpdate: 'run_code', planExit: 'run_code', askUser: 'run_code' })
  assert.deepEqual(resolveBridgeToolSupport(ptc, PTC_TOOLS_SDK, { planActive: true }), { goalUpdate: 'run_code', planExit: 'run_code', askUser: false }, 'ask_user_question is not declared there')
  assert.deepEqual(resolveBridgeToolSupport(undefined, undefined, { planActive: true }), NO_BRIDGE_TOOLS)
})

test('auxiliary calls never ask: a hidden title or compaction call must not park the turn on a card', () => {
  const direct = ['update_goal', 'exit_plan_mode', 'ask_user_question'].map((name) => ({ name }))
  const aux = resolveBridgeToolSupport(direct, undefined, { planActive: false, aux: true })
  assert.equal(aux.askUser, false)
  assert.equal(aux.goalUpdate, 'direct', 'the goal and plan bridges keep their own gating')
  assert.equal(aux.planExit, false)
})
