import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatSubagentAction, SubagentTracker } from '../../../src/features/subagent/tracker.ts'
import { setAgyDbDir } from '../../../src/runtime/agy/db/paths.ts'
import type { AgyEvent } from '../../../src/common/types.ts'

describe('SubagentTracker and action formatting', () => {
  test('formatSubagentAction formats typical tool actions cleanly', () => {
    assert.equal(
      formatSubagentAction('Game Researcher', 'view_file', { Path: 'src/player.gd' }),
      '[子代理 · Game Researcher] 正在查阅文件: player.gd'
    )
    assert.equal(
      formatSubagentAction('Game Researcher', 'edit_file', { Path: 'src/combat/hit.gd' }),
      '[子代理 · Game Researcher] 正在修改/创建文件: hit.gd'
    )
    assert.equal(
      formatSubagentAction('Game Researcher', 'search_web', { query: 'Roguelike dopamine loop design' }),
      '[子代理 · Game Researcher] 正在检索网络: "Roguelike dopamine loop design"'
    )
    assert.equal(
      formatSubagentAction('Game Researcher', 'run_command', { toolSummary: 'Godot test', CommandLine: 'godot -s test.gd' }),
      '[子代理 · Game Researcher] 正在执行终端命令: Godot test'
    )
    assert.equal(
      formatSubagentAction('Game Researcher', 'send_message', {}),
      '[子代理 · Game Researcher] 阶段调研完成，正在向主代理提交报告'
    )
    assert.equal(
      formatSubagentAction('Game Researcher', 'generate_image', { prompt: 'Cyberpunk zombie portrait' }),
      '[子代理 · Game Researcher] 正在生成参考图像: Cyberpunk zombie portrait'
    )
  })

  test('SubagentTracker discovers subagents and streams transcript events', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-tracker-test-'))
    const convDir = join(root, '.gemini', 'antigravity-cli', 'conversations')
    const brainBase = join(root, '.gemini', 'antigravity-cli', 'brain')
    mkdirSync(convDir, { recursive: true })
    setAgyDbDir(convDir)

    const mainConvId = 'main-conv-123'
    const mainBrain = join(brainBase, mainConvId)
    const mainSubagentsDir = join(mainBrain, '.system_generated', 'subagents')
    mkdirSync(mainSubagentsDir, { recursive: true })

    const subConvId = 'sub-worker-456'
    const subBrain = join(brainBase, subConvId)
    const subLogsDir = join(subBrain, '.system_generated', 'logs')
    mkdirSync(subLogsDir, { recursive: true })

    const events: AgyEvent[] = []
    let activityNoted = 0

    const tracker = new SubagentTracker({
      conversationId: mainConvId,
      accountHome: root,
      pollIntervalMs: 50,
      onEvent: (ev) => {
        events.push(ev)
      },
      noteActivity: () => {
        activityNoted++
      },
    })

    try {
      tracker.start()

      // 1. Write subagent descriptor into main conversation
      writeFileSync(
        join(mainSubagentsDir, `${subConvId}.json`),
        JSON.stringify({
          conversationId: subConvId,
          subagentDescriptor: { typeName: 'DeepInvestigator', role: 'Game Researcher' },
          state: 'SUBAGENT_STATE_ALIVE',
        })
      )

      // 2. Write initial transcript steps
      const transcriptFile = join(subLogsDir, 'transcript.jsonl')
      writeFileSync(
        transcriptFile,
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          tool_calls: [{ name: 'view_file', args: { Path: 'src/main.gd' } }],
        }) + '\n'
      )

      // Wait a moment for tracker polling
      await new Promise((r) => setTimeout(r, 120))

      assert.ok(events.length >= 2, `expected at least 2 events, got ${events.length}`)
      // First event: spawn announcement
      const ev0 = events[0]
      assert.ok(ev0 && ev0.kind === 'step')
      assert.equal(ev0.stepKind, 'subagent')
      assert.ok(ev0.text.includes('已启动协同专员 (DeepInvestigator)'), ev0.text)

      // Second event: view_file action
      const ev1 = events[1]
      assert.ok(ev1 && ev1.kind === 'step')
      assert.equal(ev1.stepKind, 'subagent')
      assert.ok(ev1.text.includes('正在查阅文件: main.gd'))
      assert.ok(activityNoted >= 2, 'activity must be noted to refresh watchdog')

      // 3. Append subsequent step (web search)
      writeFileSync(
        transcriptFile,
        JSON.stringify({
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          tool_calls: [{ name: 'search_web', args: { query: 'PCG algorithms' } }],
        }) + '\n',
        { flag: 'a' }
      )

      await new Promise((r) => setTimeout(r, 120))

      assert.ok(events.length >= 3)
      const ev2 = events[2]
      assert.ok(ev2 && ev2.kind === 'step')
      assert.ok(ev2.text.includes('正在检索网络: "PCG algorithms"'))
    } finally {
      tracker.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('SubagentTracker tails an appending transcript without re-emitting or splitting a half-written line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-tracker-tail-'))
    const convDir = join(root, '.gemini', 'antigravity-cli', 'conversations')
    const brainBase = join(root, '.gemini', 'antigravity-cli', 'brain')
    mkdirSync(convDir, { recursive: true })
    setAgyDbDir(convDir)

    const mainConvId = 'main-conv-tail'
    const mainBrain = join(brainBase, mainConvId)
    mkdirSync(join(mainBrain, '.system_generated', 'subagents'), { recursive: true })

    const subConvId = 'sub-tail'
    const subLogsDir = join(brainBase, subConvId, '.system_generated', 'logs')
    mkdirSync(subLogsDir, { recursive: true })

    const events: AgyEvent[] = []
    const tracker = new SubagentTracker({
      conversationId: mainConvId,
      accountHome: root,
      pollIntervalMs: 50,
      onEvent: (ev) => {
        events.push(ev)
      },
    })

    const actions = (): string[] =>
      events.filter((ev) => ev.kind === 'step' && !ev.stepKey.startsWith('subagent-spawn')).map((ev) => (ev.kind === 'step' ? ev.text : ''))

    try {
      writeFileSync(
        join(mainBrain, '.system_generated', 'subagents', `${subConvId}.json`),
        JSON.stringify({ conversationId: subConvId, subagentDescriptor: { typeName: 'DeepCoder', role: 'Coder' } }),
      )

      const transcriptFile = join(subLogsDir, 'transcript.jsonl')
      const firstLine = JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'view_file', args: { Path: 'src/a.gd' } }],
      })
      // A second row that is only half written: the writer is mid-append.
      const secondRow = JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'edit_file', args: { Path: 'src/b.gd' } }],
      })
      writeFileSync(transcriptFile, `${firstLine}\n${secondRow.slice(0, 20)}`)

      tracker.start()
      await new Promise((r) => setTimeout(r, 150))

      assert.deepEqual(actions().length, 1, 'only the complete row is reported')
      assert.ok(actions()[0]?.includes('正在查阅文件: a.gd'))

      // Completing the row must report it exactly once.
      writeFileSync(transcriptFile, `${secondRow.slice(20)}\n`, { flag: 'a' })
      await new Promise((r) => setTimeout(r, 150))
      await new Promise((r) => setTimeout(r, 100))

      const texts = actions()
      assert.equal(texts.length, 2, `expected 2 actions, got ${JSON.stringify(texts)}`)
      assert.ok(texts[1]?.includes('正在修改/创建文件: b.gd'), texts[1])
    } finally {
      tracker.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('SubagentTracker with resumed=true baselines pre-existing transcripts at EOF without replaying prior turns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-tracker-resumed-'))
    const convDir = join(root, '.gemini', 'antigravity-cli', 'conversations')
    const brainBase = join(root, '.gemini', 'antigravity-cli', 'brain')
    mkdirSync(convDir, { recursive: true })
    setAgyDbDir(convDir)

    const mainConvId = 'main-conv-resumed'
    const mainBrain = join(brainBase, mainConvId)
    mkdirSync(join(mainBrain, '.system_generated', 'subagents'), { recursive: true })

    const subConvId = 'sub-prior-turn'
    const subLogsDir = join(brainBase, subConvId, '.system_generated', 'logs')
    mkdirSync(subLogsDir, { recursive: true })
    writeFileSync(
      join(mainBrain, '.system_generated', 'subagents', `${subConvId}.json`),
      JSON.stringify({ conversationId: subConvId, subagentDescriptor: { typeName: 'Researcher', role: 'Prior Worker' } }),
    )
    const transcriptFile = join(subLogsDir, 'transcript.jsonl')
    writeFileSync(
      transcriptFile,
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'view_file', args: { Path: 'src/old_turn.ts' } }],
      }) + '\n',
    )

    const events: AgyEvent[] = []
    const tracker = new SubagentTracker({
      conversationId: mainConvId,
      accountHome: root,
      resumed: true,
      pollIntervalMs: 40,
      onEvent: (ev) => { events.push(ev) },
    })

    try {
      tracker.start()
      await new Promise((r) => setTimeout(r, 90))
      assert.equal(events.length, 0, 'prior-turn subagent history must NOT be replayed on turn resume')

      // Appending a NEW action during the resumed turn MUST stream immediately
      writeFileSync(
        transcriptFile,
        JSON.stringify({
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          tool_calls: [{ name: 'edit_file', args: { Path: 'src/new_turn.ts' } }],
        }) + '\n',
        { flag: 'a' },
      )
      await new Promise((r) => setTimeout(r, 90))
      assert.equal(events.length, 1)
      assert.ok(events[0]?.kind === 'step' && events[0].text.includes('new_turn.ts'))
    } finally {
      tracker.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('SubagentTracker baselines pre-existing subagents when conversationId arrives late via setConversationId on resumed runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-tracker-late-cid-'))
    const convDir = join(root, '.gemini', 'antigravity-cli', 'conversations')
    const brainBase = join(root, '.gemini', 'antigravity-cli', 'brain')
    mkdirSync(convDir, { recursive: true })
    setAgyDbDir(convDir)

    const mainConvId = 'main-conv-late-resumed'
    const mainBrain = join(brainBase, mainConvId)
    mkdirSync(join(mainBrain, '.system_generated', 'subagents'), { recursive: true })

    const subConvId = 'sub-stale-alive'
    const subLogsDir = join(brainBase, subConvId, '.system_generated', 'logs')
    mkdirSync(subLogsDir, { recursive: true })
    writeFileSync(
      join(mainBrain, '.system_generated', 'subagents', `${subConvId}.json`),
      JSON.stringify({ conversationId: subConvId, subagentDescriptor: { typeName: 'DeepCoder', role: 'Prior Coder' }, state: 'SUBAGENT_STATE_ALIVE' }),
    )
    const transcriptFile = join(subLogsDir, 'transcript.jsonl')
    writeFileSync(
      transcriptFile,
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'view_file', args: { Path: 'src/old.ts' } }] }) + '\n',
    )

    const events: AgyEvent[] = []
    const tracker = new SubagentTracker({
      resumed: true,
      accountHome: root,
      pollIntervalMs: 40,
      onEvent: (ev) => { events.push(ev) },
    })
    try {
      tracker.start()
      // Defer cid delivery (like init envelope arriving after spawn)
      tracker.setConversationId(mainConvId)
      await new Promise((r) => setTimeout(r, 90))
      assert.equal(events.length, 0, 'deferred setConversationId on resumed run must NOT replay stale SUBAGENT_STATE_ALIVE files')

      writeFileSync(
        transcriptFile,
        JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'edit_file', args: { Path: 'src/fresh.ts' } }] }) + '\n',
        { flag: 'a' },
      )
      await new Promise((r) => setTimeout(r, 90))
      assert.equal(events.length, 1)
      assert.ok(events[0]?.kind === 'step' && events[0].text.includes('fresh.ts'))
    } finally {
      tracker.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('SubagentTracker does not claim killed subagent opened, surfaces state transitions and transcript errors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-tracker-state-'))
    const convDir = join(root, '.gemini', 'antigravity-cli', 'conversations')
    const brainBase = join(root, '.gemini', 'antigravity-cli', 'brain')
    mkdirSync(convDir, { recursive: true })
    setAgyDbDir(convDir)

    const mainConvId = 'main-conv-state'
    const mainBrain = join(brainBase, mainConvId)
    const subagentsDir = join(mainBrain, '.system_generated', 'subagents')
    mkdirSync(subagentsDir, { recursive: true })

    const deadSubId = 'sub-already-killed'
    mkdirSync(join(brainBase, deadSubId, '.system_generated', 'logs'), { recursive: true })
    const liveSubId = 'sub-will-die'
    const liveLogsDir = join(brainBase, liveSubId, '.system_generated', 'logs')
    mkdirSync(liveLogsDir, { recursive: true })

    const events: AgyEvent[] = []
    const tracker = new SubagentTracker({
      conversationId: mainConvId,
      accountHome: root,
      pollIntervalMs: 40,
      onEvent: (ev) => { events.push(ev) },
    })

    try {
      tracker.start()
      // 1. Subagent created already KILLED must never emit 已启动协同专员
      writeFileSync(
        join(subagentsDir, `${deadSubId}.json`),
        JSON.stringify({ conversationId: deadSubId, subagentDescriptor: { typeName: 'DeepCoder', role: 'Dead Worker' }, state: 'SUBAGENT_STATE_KILLED' }),
      )
      // 2. Live subagent starts ALIVE, reports transcript error, then transitions to KILLED
      const liveDescriptorPath = join(subagentsDir, `${liveSubId}.json`)
      writeFileSync(
        liveDescriptorPath,
        JSON.stringify({ conversationId: liveSubId, subagentDescriptor: { typeName: 'DeepInvestigator', role: 'Research Worker' }, state: 'SUBAGENT_STATE_ALIVE' }),
      )
      const liveTranscript = join(liveLogsDir, 'transcript.jsonl')
      writeFileSync(
        liveTranscript,
        JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'ERROR', content: 'Tool failed' }) + '\n',
      )

      await new Promise((r) => setTimeout(r, 100))
      const texts = () => events.filter((e) => e.kind === 'step').map((e) => (e.kind === 'step' ? e.text : ''))
      assert.ok(!texts().some((t) => t.includes('Dead Worker') && t.includes('已启动协同专员')), `killed subagent must not announce launch: ${JSON.stringify(texts())}`)
      assert.ok(texts().some((t) => t.includes('Dead Worker') && t.includes('未保持运行')), JSON.stringify(texts()))
      assert.ok(texts().some((t) => t.includes('Research Worker') && t.includes('执行异常/中止')), JSON.stringify(texts()))

      // Transition live subagent to KILLED
      writeFileSync(
        liveDescriptorPath,
        JSON.stringify({ conversationId: liveSubId, subagentDescriptor: { typeName: 'DeepInvestigator', role: 'Research Worker' }, state: 'SUBAGENT_STATE_KILLED' }),
      )
      await new Promise((r) => setTimeout(r, 100))
      assert.ok(texts().some((t) => t.includes('Research Worker') && t.includes('已停止')), JSON.stringify(texts()))

      // Once terminal, further transcript appends must not emit noise
      const countAfterStop = events.length
      writeFileSync(
        liveTranscript,
        JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'view_file', args: { Path: 'src/late.ts' } }] }) + '\n',
        { flag: 'a' },
      )
      await new Promise((r) => setTimeout(r, 90))
      assert.equal(events.length, countAfterStop)
    } finally {
      tracker.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
