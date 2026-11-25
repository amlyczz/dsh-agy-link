import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Message } from '@deepseek-ai/dsh-llm'
import { defaultConfig, PROVIDER_ID } from '../../src/common/types.ts'
import { acpUpdateToAgyEvents, createAcpStreamState, extractAvailableCommands } from '../../src/features/acp/protocol.ts'
import { agySlashCommandDefinitions, DIRECT_AGY_SLASH_COMMANDS } from '../../src/host/agy-slash-commands.ts'
import { AgyAdapter } from '../../src/host/adapter.ts'
import type { CommandDeps, GoalServiceLike } from '../../src/host/commands/shared.ts'
import { RunRegistry } from '../../src/host/recording.ts'
import { SessionStore } from '../../src/host/sessions.ts'
import { createForcedPlanGuard } from '../../src/host/service-helpers.ts'
import { resolveCallContext } from '../../src/provider/call-context.ts'
import { extractLeadingAgySlash, formatWithLeadingAgySlash } from '../../src/provider/leading-slash.ts'
import { buildPromptPlan } from '../../src/provider/prompt.ts'
import { defuseQuotedSlashCommands } from '../../src/provider/prompt-text.ts'
import { purposePolicy } from '../../src/provider/purpose-policy.ts'

test('extractLeadingAgySlash captures single-segment commands and ignores file paths', () => {
  assert.deepEqual(extractLeadingAgySlash('/plan refactor auth'), {
    commandLine: '/plan refactor auth',
    rest: '',
  })
  assert.deepEqual(extractLeadingAgySlash('  /swarm split tasks\nwith details'), {
    commandLine: '/swarm split tasks',
    rest: 'with details',
  })
  assert.equal(extractLeadingAgySlash('/etc/hosts check'), null)
  assert.equal(extractLeadingAgySlash('/plan/sub/file.ts'), null)
  assert.equal(extractLeadingAgySlash('normal chat message'), null)
})

test('defuseQuotedSlashCommands neutralizes /swarm, /btw, and /fork in history digests', () => {
  const out = defuseQuotedSlashCommands('Earlier: /swarm run, /btw hello, /fork now, keep /src/btw/a.ts')
  assert.match(out, /\/ swarm run/)
  assert.match(out, /\/ btw hello/)
  assert.match(out, /\/ fork now/)
  assert.match(out, /\/src\/btw\/a\.ts/)
})

test('buildPromptPlan keeps leading agy slash command at character 0 even with system prompt and digest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-slash-prompt-'))
  try {
    const store = new SessionStore(join(dir, 'sessions.json'))
    const cfg = { ...defaultConfig(), forwardSystemPrompt: true, cloakSystemPrompt: false }
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'earlier q' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'earlier a' }] },
      { role: 'user', content: [{ type: 'text', text: '/plan design login flow' }] },
    ] as unknown as Message[]
    const ctx = resolveCallContext({
      options: { provider: PROVIDER_ID, model: 'gemini-3.8-flash', sessionId: 's-prompt' as never, system: 'Be concise.', messages },
      cfg,
      bin: 'agy',
      cwd: dir,
      warnOnce: () => {},
    })
    const plan = await buildPromptPlan({
      options: { provider: PROVIDER_ID, model: 'gemini-3.8-flash', sessionId: 's-prompt' as never, system: 'Be concise.', messages },
      cfg,
      ctx,
      policy: purposePolicy(ctx),
      account: undefined,
      model: 'gemini-3.8-flash',
      activeModel: 'gemini-3.8-flash',
      deps: {
        store,
        getActiveRun: () => undefined,
        recentlyCompactedSessions: new Map(),
        deliverContext: async (d) => d,
      },
    })
    assert.ok(plan.prompt.startsWith('/plan design login flow'), `expected prompt to start with /plan, got: ${plan.prompt.slice(0, 80)}`)
    assert.match(plan.prompt, /System instructions:\nBe concise\./)
    assert.match(plan.prompt, /earlier q/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('formatWithLeadingAgySlash places context below head command line', () => {
  const combined = formatWithLeadingAgySlash({ commandLine: '/boost optimize loop', rest: 'focus memory' }, 'DIGEST')
  assert.ok(combined.startsWith('/boost optimize loop\n\n'))
  assert.match(combined, /focus memory/)
  assert.match(combined, /DIGEST/)
})

test('acp protocol captures available_commands_update without emitting chat events', () => {
  const update = {
    sessionUpdate: 'available_commands_update',
    availableCommands: [
      { name: 'plan', description: 'Enter plan mode' },
      { name: 'swarm', description: 'Run swarm', input: { hint: '<task>' } },
    ],
  }
  const cmds = extractAvailableCommands(update)
  assert.equal(cmds?.length, 2)
  assert.equal(cmds?.[0]?.name, 'plan')
  assert.equal(cmds?.[1]?.inputHint, '<task>')
  const events = acpUpdateToAgyEvents('sid-1', update, createAcpStreamState())
  assert.deepEqual(events, [])
})

test('agySlashCommandDefinitions registers full a-prefix catalog, validates provider, and dispatches into current session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-slash-defs-'))
  try {
    const store = new SessionStore(join(dir, 'sessions.json'))
    const followups: Array<{ sessionId: string; text: string; attachments: number }> = []
    const enteredPlan: string[] = []
    const createdGoals: string[] = []
    const guard = createForcedPlanGuard()

    const deps: CommandDeps = {
      cfg: () => ({ ...defaultConfig(), backgroundWakeup: false }),
      bin: () => 'agy',
      version: () => '1.5.15',
      auth: () => null,
      catalog: () => ({ get: () => ({ source: 'fallback', models: [] }) }) as unknown as ReturnType<CommandDeps['catalog']>,
      store: () => store,
      lastRun: () => null,
      setOverride: () => {},
      runDoctor: async () => '',
      acpStatus: () => ({
        activeProcesses: 1,
        sessions: 1,
        keys: ['k'],
        availableCommands: [{ name: 'plan', description: 'Plan' }, { name: 'swarm', description: 'Swarm' }],
      }),
      goals: () => ({
        get: () => undefined,
        create: (_agent, req) => {
          createdGoals.push(req.objective)
          return { id: 'goal-1', revision: 1, objective: req.objective, phase: 'active' }
        },
        edit: () => { throw new Error('unused') },
        pause: () => { throw new Error('unused') },
        resume: () => { throw new Error('unused') },
        complete: () => { throw new Error('unused') },
        clear: () => {},
      }) satisfies GoalServiceLike,
      runOnce: async () => ({ ok: true, text: 'once result', durationMs: 10, conversationId: null }),
    }

    const defs = agySlashCommandDefinitions({
      deps: () => deps,
      armForcedPlan: (sid) => guard.arm(sid),
      planMode: () => ({ enter: (agent: unknown) => { enteredPlan.push(String((agent as { id?: unknown }).id ?? '')) } }),
    })
    const byName = new Map(defs.map((d) => [d.name, d]))

    for (const expected of [
      ...DIRECT_AGY_SLASH_COMMANDS,
      'acompact',
      'afork',
      'alearn',
    ]) {
      assert.ok(byName.has(expected), `missing command /${expected}`)
    }

    const makeAgent = (provider: string) => ({
      id: 'sess-cmd-1',
      options: { provider, model: 'gemini-3.8-flash' },
      session: { snapshotEvents: () => [] },
      followup: (msg: { content: Array<{ type: string; text?: string }>; source: { kind: string } }) => {
        const text = msg.content.find((b) => b.type === 'text')?.text ?? ''
        const attachments = msg.content.filter((b) => b.type === 'image').length
        followups.push({ sessionId: 'sess-cmd-1', text, attachments })
        assert.equal(msg.source.kind, 'user')
      },
    })

    // 1. Non-agy provider rejected for agy-only slash commands
    const wrongProv = await byName.get('aboost')!.handler({
      commandId: 'c1' as never,
      agent: makeAgent('deepseek') as never,
      rawInput: 'check perf',
      attachments: [],
      signal: new AbortController().signal,
    })
    assert.equal(wrongProv.kind, 'error')
    assert.equal(followups.length, 0)

    // 2. /aplan arms read-only plan guard, triggers host planMode if present, and forwards /plan + attachment
    const agyAgent = makeAgent(PROVIDER_ID)
    const planRes = await byName.get('aplan')!.handler({
      commandId: 'c2' as never,
      agent: agyAgent as never,
      rawInput: 'design auth',
      attachments: [{ type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png' } }] as never,
      signal: new AbortController().signal,
    })
    assert.equal(planRes.kind, 'success')
    assert.equal(planRes.text, undefined)
    assert.equal(guard.consume('sess-cmd-1'), true)
    assert.equal(guard.consume('sess-cmd-1'), false, 'forced plan guard is one-shot')
    assert.deepEqual(enteredPlan, ['sess-cmd-1'])
    assert.equal(followups[0]?.text, '/plan design auth')
    assert.equal(followups[0]?.attachments, 1)

    // 3. /agrill & /aswarm dispatch directly without confirmation
    const grillRes = await byName.get('agrill')!.handler({
      commandId: 'c3' as never,
      agent: agyAgent as never,
      rawInput: 'api surface',
      attachments: [],
      signal: new AbortController().signal,
    })
    assert.equal(grillRes.kind, 'success')
    assert.equal(followups[1]?.text, '/grill-me api surface')

    const swarmRes = await byName.get('aswarm')!.handler({
      commandId: 'c4' as never,
      agent: agyAgent as never,
      rawInput: 'split tests',
      attachments: [],
      signal: new AbortController().signal,
    })
    assert.equal(swarmRes.kind, 'success')
    assert.ok(followups[2]?.text.startsWith('/swarm split tests'))

    // 4. /agoal <objective> creates DSH goal AND triggers Round 1 immediately
    const goalRes = await byName.get('agoal')!.handler({
      commandId: 'c5' as never,
      agent: agyAgent as never,
      rawInput: 'ship v2 cleanly',
      attachments: [],
      signal: new AbortController().signal,
    })
    assert.equal(goalRes.kind, 'success')
    assert.deepEqual(createdGoals, ['ship v2 cleanly'])
    assert.equal(followups[3]?.text, 'ship v2 cleanly')

    // 5. /agoal status renders status card without sending a turn
    const goalStatus = await byName.get('agoal')!.handler({
      commandId: 'c6' as never,
      agent: agyAgent as never,
      rawInput: 'status',
      attachments: [],
      signal: new AbortController().signal,
    })
    assert.equal(goalStatus.kind, 'success')
    assert.match(goalStatus.text ?? '', /DSH Goal Status/)
    assert.equal(followups.length, 4)

    // 6. /acmd forwards raw single-segment commands, lists ACP commands, and rejects filesystem paths
    const acmdList = await byName.get('acmd')!.handler({
      commandId: 'c7' as never,
      agent: agyAgent as never,
      rawInput: 'list',
      attachments: [],
      signal: new AbortController().signal,
    })
    assert.equal(acmdList.kind, 'success')
    assert.match(acmdList.text ?? '', /\/plan/)

    const acmdBad = await byName.get('acmd')!.handler({
      commandId: 'c8' as never,
      agent: agyAgent as never,
      rawInput: '/etc/passwd',
      attachments: [],
      signal: new AbortController().signal,
    })
    assert.equal(acmdBad.kind, 'error')

    const acmdOk = await byName.get('acmd')!.handler({
      commandId: 'c9' as never,
      agent: agyAgent as never,
      rawInput: 'deep-review module-a',
      attachments: [],
      signal: new AbortController().signal,
    })
    assert.equal(acmdOk.kind, 'success')
    assert.equal(followups[4]?.text, '/deep-review module-a')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AgyAdapter enforces one-shot --mode plan when consumeForcedPlanMode returns true', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-slash-forced-plan-'))
  try {
    const store = new SessionStore(join(dir, 'sessions.json'))
    const runs = new RunRegistry()
    const guard = createForcedPlanGuard()
    const cfg = { ...defaultConfig(), permissionMode: 'skip' as const, transport: 'cli' as const }
    const { writeFileSync, chmodSync, readFileSync } = await import('node:fs')
    const argvLog = join(dir, 'argv.jsonl')
    const scriptPath = join(dir, 'mock-agy.mjs')
    writeFileSync(
      scriptPath,
      `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log(JSON.stringify({ event: 'response', content: 'ok' }));
console.log(JSON.stringify({ event: 'complete', stats: { total_tokens: 4 } }));
`,
      'utf8',
    )
    const bin = process.platform === 'win32' ? join(dir, 'agy.cmd') : join(dir, 'agy')
    if (process.platform === 'win32') {
      writeFileSync(bin, `@echo off\r\nnode "${scriptPath}" %*\r\n`, 'utf8')
    } else {
      writeFileSync(bin, `#!/usr/bin/env node\nimport('node:fs').then(async ({ appendFileSync }) => { appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + '\\n'); console.log(JSON.stringify({ event: 'response', content: 'ok' })); console.log(JSON.stringify({ event: 'complete', stats: { total_tokens: 4 } })); });\n`, 'utf8')
      chmodSync(bin, 0o755)
    }
    const adapter = new AgyAdapter({
      getConfig: () => cfg,
      catalog: {
        get: () => ({ source: 'discovered' as const, models: [{ id: 'gemini-3.8-flash', family: 'google' as const, efforts: [] }] }),
        advertisedEfforts: () => [],
      } as never,
      store,
      bin: () => bin,
      acquire: async () => () => {},
      runs,
      sessionCwd: () => dir,
      consumeForcedPlanMode: (sid) => guard.consume(sid),
    })

    guard.arm('s-plan-1')
    for await (const _ of adapter.stream({
      provider: PROVIDER_ID,
      model: 'gemini-3.8-flash',
      sessionId: 's-plan-1' as never,
      messages: [{ role: 'user', content: [{ type: 'text', text: '/plan inspect architecture' }] }] as never,
    })) { /* drain */ }

    for await (const _ of adapter.stream({
      provider: PROVIDER_ID,
      model: 'gemini-3.8-flash',
      sessionId: 's-plan-1' as never,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'apply changes now' }] }] as never,
    })) { /* drain */ }

    const lines = readFileSync(argvLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[])
    assert.equal(lines.length, 2)
    assert.ok(lines[0]!.includes('plan'), 'first turn should run under --mode plan')
    assert.ok(!lines[1]!.includes('plan') || lines[1]!.includes('--dangerously-skip-permissions'), 'second turn restores configured skip mode')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
  }
})
