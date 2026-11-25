import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '@deepseek-ai/dsh-llm'
import {
  detectGoalContext,
  resolveGoalContext,
  isPlanMode,
  isGoalToolContinuation,
  isPlanToolContinuation,
  classifyPlanToolContinuation,
  buildGoalCompleteToolCallBlock,
  buildPlanExitToolCallBlock,
} from '../../src/host/dsh-goal.ts'
import { parseMirrorCallId } from '../../src/host/recording.ts'

test('detectGoalContext extracts goal context from source.kind === "goal"', () => {
  const messages: Message[] = [
    {
      role: 'user',
      content: 'Regular prompt',
    } as unknown as Message,
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<goal_round>\nObjective: "Complete feature X and verify"\nRound: 2/256\n\nContinue working...\n</goal_round>',
        },
      ],
      source: {
        kind: 'goal',
        goalId: 'goal-uuid-123',
        revision: 2,
        round: 2,
      },
    } as unknown as Message,
  ]

  const ctx = detectGoalContext(messages)
  assert.ok(ctx, 'Should detect goal context')
  assert.equal(ctx.goalId, 'goal-uuid-123')
  assert.equal(ctx.revision, 2)
  assert.equal(ctx.round, 2)
  assert.equal(ctx.maxRounds, 256)
  assert.equal(ctx.objective, 'Complete feature X and verify')
})

test('detectGoalContext extracts goal context from bare text <goal_round>', () => {
  const messages: Message[] = [
    {
      role: 'user',
      content: '<goal_round>\nObjective: "Fix the bug in parser"\nRound: 5/100\n</goal_round>',
    } as unknown as Message,
  ]

  const ctx = detectGoalContext(messages)
  assert.ok(ctx, 'Should detect goal context from text')
  assert.equal(ctx.round, 5)
  assert.equal(ctx.maxRounds, 100)
  assert.equal(ctx.objective, 'Fix the bug in parser')
  assert.equal(ctx.revision, 1)
})

// Verbatim shape of DSH's real round prompt (@deepseek-ai/dsh-goal-round-driver
// renderGoalRoundPrompt). Its prose contains "goal-tool policy" and the
// <goal_round> tag — a loose /goal-[A-Za-z0-9_-]+/ id scan once turned that
// prose into goalId "goal-tool", so every synthesized update_goal missed and
// the driver queued round after round (the 2026-10-16 cardboard-empire loop).
const REAL_ROUND_PROMPT = `<goal_round>
Objective: "按照你说的建议全部实施 并验证"
Round: 1/256

Continue working toward the objective in this same session. Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current. Make concrete progress and verify the result. Before claiming completion, gather evidence that the whole objective is achieved, read the current goal, and mark it complete. If work remains, leave the goal active for the next round. Follow the configured goal-tool policy before reporting a blocker.
</goal_round>`

test('detectGoalContext prefers the source goalId over round-prompt prose', () => {
  const messages: Message[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: REAL_ROUND_PROMPT }],
      source: {
        kind: 'goal',
        goalId: 'goal-3fe686a1-0298-4a5a-88dd-670562821182',
        revision: 1,
        round: 1,
      },
    } as unknown as Message,
  ]

  const ctx = detectGoalContext(messages)
  assert.ok(ctx, 'Should detect goal context')
  assert.equal(ctx.goalId, 'goal-3fe686a1-0298-4a5a-88dd-670562821182')
  assert.notEqual(ctx.goalId, 'goal-tool')
  assert.equal(ctx.revision, 1)
  assert.equal(ctx.round, 1)
  assert.equal(ctx.maxRounds, 256)
  assert.equal(ctx.objective, '按照你说的建议全部实施 并验证')
})

test('detectGoalContext never invents "goal-tool" from round-prompt prose', () => {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: REAL_ROUND_PROMPT }] } as unknown as Message,
  ]

  const ctx = detectGoalContext(messages)
  assert.ok(ctx, 'Round prompt alone still marks a goal round')
  assert.notEqual(ctx.goalId, 'goal-tool', 'prose words must not become the goal id')
  assert.equal(ctx.goalId, undefined, 'without source or an id: field the bridge must defer to the host-side lookup')
  assert.equal(ctx.round, 1)
  assert.equal(ctx.maxRounds, 256)
})

test('detectGoalContext accepts a UUID-shaped goal id embedded in text', () => {
  const messages: Message[] = [
    {
      role: 'user',
      content: `<goal_round>\nObjective: "Do it"\nRound: 2/9\nid: goal-0f4c9e2a-11b2-4c33-9d00-52aa10bb77e1\n</goal_round>`,
    } as unknown as Message,
  ]

  const ctx = detectGoalContext(messages)
  assert.ok(ctx)
  assert.equal(ctx.goalId, 'goal-0f4c9e2a-11b2-4c33-9d00-52aa10bb77e1')
})

test('detectGoalContext returns null for non-goal conversations', () => {
  const messages: Message[] = [
    {
      role: 'user',
      content: 'Hello, please help me with code',
    } as unknown as Message,
    {
      role: 'assistant',
      content: 'Sure! What do you need?',
    } as unknown as Message,
  ]

  const ctx = detectGoalContext(messages)
  assert.equal(ctx, null)
})

test('isPlanMode detects plan mode prompt context', () => {
  const nonPlanMessages: Message[] = [
    {
      role: 'user',
      content: 'Just write some code',
    } as unknown as Message,
  ]
  assert.equal(isPlanMode(nonPlanMessages), false)

  const planMessages: Message[] = [
    {
      role: 'user',
      content: 'You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches mode.',
    } as unknown as Message,
  ]
  assert.equal(isPlanMode(planMessages), true)
})

test('isGoalToolContinuation recognizes agytc-bridge-goal callId', () => {
  const normalTool: Message[] = [
    {
      role: 'tool',
      toolCallId: 'agytc-run-1-step-2',
      content: 'output',
    } as unknown as Message,
  ]
  assert.equal(isGoalToolContinuation(normalTool), false)

  const goalBridgeTool: Message[] = [
    {
      role: 'tool',
      toolCallId: 'agytc-bridge-goal-123-1',
      content: '{"ok":true}',
    } as unknown as Message,
  ]
  assert.equal(isGoalToolContinuation(goalBridgeTool), true)

  const deferredGoalComplete: Message[] = [
    {
      role: 'tool',
      toolCallId: 'agytc-bridge-goal-123-1',
      content: '{"ok":true}',
    } as unknown as Message,
    {
      role: 'user',
      content: '<goal_complete>\nObjective: "Test"\nThe goal is marked complete.',
      source: { kind: 'tool-goal', form: 'notice' },
    } as unknown as Message,
  ]
  assert.equal(isGoalToolContinuation(deferredGoalComplete), true)
})

test('a genuine user message after the goal result is NOT a continuation (must reach agy)', () => {
  // 2026-10-17 incident: the user sent "把相关的经验整理到agents.md" right after a
  // goal completed. The old fixed-window marker scan found the goal tool-result
  // 2 messages earlier and short-circuited the turn into an empty finish — the
  // instruction never reached agy. Twice in a row.
  const afterGoal = [
    {
      role: 'assistant',
      content: 'We removed the web-like layout and rebuilt the tabletop view.',
    },
    {
      role: 'tool',
      toolCallId: 'agytc-bridge-goal-goal-3fe686a1-0298-4a5a-88dd-670562821182-1',
      content: '{"ok":true}',
    },
    {
      role: 'user',
      content: '把相关的经验整理到agents.md 杜绝这种web味！',
    },
  ] as unknown as Message[]
  assert.equal(isGoalToolContinuation(afterGoal), false)
})

test('a goal marker merely quoted by tool output is NOT a continuation', () => {
  // 2026-11-15 incident: the agent grepped this package's own dist for
  // "result", which printed the doc comment containing `<goal_complete>` into a
  // tool result. The next request short-circuited into an empty finish, so the
  // turn completed with zero content — three times in a row, including the turn
  // where the user reported the missing output.
  const grepHit: Message[] = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          id: 'agytc-run-1-step-34',
          name: 'agy_tool',
          arguments: '{"run":"run-1","step":34}',
        },
      ],
    } as unknown as Message,
    {
      role: 'tool',
      toolCallId: 'agytc-run-1-step-34',
      content: [
        {
          type: 'text',
          text: '3199: * This covers both the direct tool-result message and DSH\'s deferred `<goal_complete>` notice.\n3453:function resultText',
        },
      ],
    } as unknown as Message,
  ]
  assert.equal(isGoalToolContinuation(grepHit), false)

  // Same for an assistant message that echoes the marker back while explaining it.
  const echoInAssistant: Message[] = [
    {
      role: 'assistant',
      content: 'The scan looks for <goal_complete> in the trailing window.',
    } as unknown as Message,
  ]
  assert.equal(isGoalToolContinuation(echoInAssistant), false)

  // The genuine user-role notice keeps short-circuiting (regression guard).
  const realNotice: Message[] = [
    {
      role: 'user',
      content: '<goal_complete>\nThe goal is marked complete.',
      source: { kind: 'tool-goal', form: 'notice' },
    } as unknown as Message,
  ]
  assert.equal(isGoalToolContinuation(realNotice), true)
})

test('deferred goal_complete notice followed by a real user message drives agy', () => {
  const noticeThenUser = [
    {
      role: 'tool',
      toolCallId: 'agytc-bridge-goal-123-1',
      content: '{"ok":true}',
    },
    {
      role: 'user',
      content: '<goal_complete>\nObjective: "Test"\nThe goal is marked complete.',
      source: { kind: 'tool-goal', form: 'notice' },
    },
    {
      role: 'user',
      content: '把相关的经验整理到agents.md 杜绝这种web味！',
    },
  ] as unknown as Message[]
  assert.equal(isGoalToolContinuation(noticeThenUser), false)
})

test('trailing goal markers still short-circuit when nothing genuine follows', () => {
  const toolThenNotice = [
    {
      role: 'tool',
      toolCallId: 'agytc-bridge-goal-123-1',
      content: '{"ok":true}',
    },
    {
      role: 'user',
      content: '<goal_complete>\nObjective: "Test"\nThe goal is marked complete.',
      source: { kind: 'tool-goal', form: 'notice' },
    },
  ] as unknown as Message[]
  assert.equal(isGoalToolContinuation(toolThenNotice), true)

  const reminderTail = [
    {
      role: 'tool',
      toolCallId: 'agytc-bridge-goal-123-1',
      content: '{"ok":true}',
    },
    {
      role: 'user',
      content: '<goal_complete>\nThe goal is marked complete.',
      source: { kind: 'tool-goal', form: 'notice' },
    },
    {
      role: 'user',
      content: 'Time sampled while preparing turn 2, step 1: 2026-10-17T00:40:00+08:00',
    },
  ] as unknown as Message[]
  // A harness-injected reminder after the notice is not a user instruction:
  // the completion hop still finishes cleanly.
  assert.equal(isGoalToolContinuation(reminderTail), true)
})

test('isPlanToolContinuation recognizes agytc-bridge-plan callId', () => {
  const planBridgeTool: Message[] = [
    {
      role: 'tool',
      toolCallId: 'agytc-bridge-plan-179204000',
      content: '{"ok":true}',
    } as unknown as Message,
  ]
  assert.equal(isPlanToolContinuation(planBridgeTool), true)
})

test('buildGoalCompleteToolCallBlock produces valid update_goal chunk sequence', () => {
  const chunks = buildGoalCompleteToolCallBlock(
    {
      goalId: 'goal-abc',
      revision: 3,
    },
    2,
  )

  assert.equal(chunks.length, 2)
  assert.equal(chunks[0]!.type, 'block-start')
  assert.equal(chunks[0]!.index, 2)
  assert.equal((chunks[0] as { blockType?: string }).blockType, 'tool-call')

  assert.equal(chunks[1]!.type, 'block-end')
  assert.equal(chunks[1]!.index, 2)
  const block = (chunks[1] as { block?: { type: string; name: string; arguments: string } }).block
  assert.ok(block)
  assert.equal(block.type, 'tool-call')
  assert.equal(block.name, 'update_goal')

  const parsedArgs = JSON.parse(block.arguments)
  assert.equal(parsedArgs.goal_id, 'goal-abc')
  assert.equal(parsedArgs.revision, 3)
  assert.equal(parsedArgs.action, 'complete')
})

test('buildPlanExitToolCallBlock produces valid exit_plan_mode chunk sequence', () => {
  const chunks = buildPlanExitToolCallBlock('# Implementation Plan\n\n1. Do this\n2. Do that', 0)

  assert.equal(chunks.length, 2)
  assert.equal(chunks[0]!.type, 'block-start')
  assert.equal((chunks[0] as { blockType?: string }).blockType, 'tool-call')

  assert.equal(chunks[1]!.type, 'block-end')
  const block = (chunks[1] as { block?: { type: string; name: string; arguments: string } }).block
  assert.ok(block)
  assert.equal(block.type, 'tool-call')
  assert.equal(block.name, 'exit_plan_mode')

  const parsedArgs = JSON.parse(block.arguments)
  assert.match(parsedArgs.plan, /# Implementation Plan/)
})

// ---------------------------------------------------------------------------
// Regression: 2026-11-07 `400 Duplicate 'call_id'` incident.
//
// agy-link re-synthesized `update_goal(complete)` on every turn of a session
// whose goal had already completed (revision 2), with the deterministic id
// `agytc-bridge-goal-<goalId>-<revision>`. Nine turns produced nine identical
// tool_call ids; after the model was switched to the `crs` HTTP route the whole
// transcript was rejected with `400 Duplicate 'call_id'`.
// ---------------------------------------------------------------------------

const STALE_GOAL_ID = 'goal-a88ea83e-5f52-4791-9395-0da953433e13'

function goalRoundMessage(goalId: string, revision: number, round = 1): Message {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `<goal_round>\nObjective: "重新验证剩余路径"\nRound: ${round}/4\n\nContinue working...\n</goal_round>`,
      },
    ],
    source: { kind: 'goal', goalId, revision, round },
  } as unknown as Message
}

function goalToolResultMessage(callId: string, text: string): Message {
  return { role: 'tool', toolCallId: callId, content: text } as unknown as Message
}

function humanMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] } as unknown as Message
}

function harnessReminder(text: string): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'time-context' },
  } as unknown as Message
}

test('detectGoalContext ignores a completed goal round once a new human turn has started', () => {
  const messages: Message[] = [
    goalRoundMessage(STALE_GOAL_ID, 2),
    goalToolResultMessage(
      `agytc-bridge-goal-${STALE_GOAL_ID}-2`,
      'Error: cannot complete goal "goal-a88ea83e-..." from phase "complete"; expected active or paused or blocked',
    ),
    humanMessage('继续看另一个问题：这条日志是什么意思？'),
  ]

  // The goal markers belong to an earlier turn; a later human message must not
  // resurrect that goal (the incident re-emitted update_goal here).
  assert.equal(detectGoalContext(messages), null)
})

test('detectGoalContext still detects the trailing goal round through harness reminders', () => {
  const messages: Message[] = [
    goalRoundMessage(STALE_GOAL_ID, 2),
    harnessReminder('Time sampled while preparing turn 4, step 1: 2026-11-07T11:00:00+08:00'),
  ]

  const ctx = detectGoalContext(messages)
  assert.ok(ctx, 'trailing goal round must still be detected')
  assert.equal(ctx.goalId, STALE_GOAL_ID)
  assert.equal(ctx.revision, 2)
})

test('resolveGoalContext never completes when the live goal service reports no active goal', () => {
  const messages: Message[] = [
    goalRoundMessage(STALE_GOAL_ID, 2),
    goalToolResultMessage(`agytc-bridge-goal-${STALE_GOAL_ID}-2`, 'Error: goal already complete'),
    humanMessage('这个报错怎么处理？'),
  ]

  // live === null: the host says the goal is complete/paused/blocked, so even a
  // stale goal marker in history must not produce a completion call.
  assert.equal(resolveGoalContext(messages, null), null)
})

test('resolveGoalContext prefers the live goal id/revision over stale history', () => {
  const messages: Message[] = [
    goalRoundMessage(STALE_GOAL_ID, 2),
    harnessReminder('Time sampled while preparing turn 5, step 1'),
  ]

  const ctx = resolveGoalContext(messages, { goalId: 'goal-live', revision: 7 })
  assert.ok(ctx)
  assert.equal(ctx.goalId, 'goal-live')
  assert.equal(ctx.revision, 7)
})

test('resolveGoalContext does not auto-complete an armed goal from a direct human turn', () => {
  const messages: Message[] = [humanMessage('先暂停一下，解释这个设计')]

  // live says active+armed, but this request is a human turn, not a goal round.
  assert.equal(resolveGoalContext(messages, { goalId: 'goal-live', revision: 3 }), null)
})

test('resolveGoalContext falls back to history when the live goal service is unavailable', () => {
  const messages: Message[] = [goalRoundMessage(STALE_GOAL_ID, 2)]

  const ctx = resolveGoalContext(messages, undefined)
  assert.ok(ctx, 'history fallback keeps older hosts working')
  assert.equal(ctx.goalId, STALE_GOAL_ID)
  assert.equal(ctx.revision, 2)
})

test('buildGoalCompleteToolCallBlock mints unique tool_call ids for repeated emissions', () => {
  const fn = (): { id: string; block: { id: string; arguments: string } } => {
    const chunks = buildGoalCompleteToolCallBlock({ goalId: 'goal-dup', revision: 2 }, 0)
    return chunks[1] as unknown as { id: string; block: { id: string; arguments: string } }
  }
  const first = fn()
  const second = fn()

  const firstId = first.block.id
  const secondId = second.block.id
  assert.notEqual(firstId, secondId, 'the same goal+revision must not reuse a call id')
  assert.ok(firstId.startsWith('agytc-bridge-goal-'), 'continuation detection relies on the prefix')
  assert.equal(JSON.parse(first.block.arguments).action, 'complete')
})

// ---- issue #136: plan mode must come from the CURRENT turn, not from history ----
import { isPlanMode as isPlanMode136 } from '../../src/host/dsh-goal.ts'

test('issue #136: a historical "You are in plan mode" inside tool output does not lock the session', () => {
  const messages: Message[] = [
    { role: 'user', content: 'read that file' } as unknown as Message,
    // A tool result quoting source code / logs that mention the phrase.
    { role: 'tool', toolCallId: 't1', content: 'const x = "You are in plan mode. Stay in plan mode"' } as unknown as Message,
    { role: 'assistant', content: 'here it is' } as unknown as Message,
    { role: 'user', content: 'now run the tests' } as unknown as Message,
  ]
  assert.equal(isPlanMode136(messages), false, 'history text must not prove plan mode')
})

test('issue #136: the current turn\'s plan instruction still counts', () => {
  const messages: Message[] = [
    { role: 'user', content: 'older turn' } as unknown as Message,
    { role: 'user', content: 'You are in plan mode. Stay in plan mode until exit_plan_mode succeeds.' } as unknown as Message,
  ]
  assert.equal(isPlanMode136(messages), true)
})

test('issue #136: DSH rejecting our synthesized exit_plan_mode is decisive evidence against plan mode', () => {
  const messages: Message[] = [
    { role: 'user', content: 'You are in plan mode.' } as unknown as Message,
    { role: 'tool', toolCallId: 't2', content: 'Error: exit_plan_mode is only available in plan mode' } as unknown as Message,
  ]
  assert.equal(isPlanMode136(messages), false, 'a rejected exit_plan_mode means the session is not planning')
})

test('plan mode semantics: system policy, live planMode, approved reset, continuation classification, and bridge call ids', () => {
  const plain: Message[] = [{ role: 'user', content: 'write plan' } as unknown as Message]
  assert.equal(isPlanMode(plain, 'You are in plan mode. Read only.'), true, 'options.system plan:policy activates plan mode')
  assert.equal(isPlanMode(plain, undefined, true), true, 'live session planMode flag activates plan mode')
  assert.equal(isPlanMode([{ role: 'user', content: 'You are in plan mode.' } as unknown as Message], undefined, false), false, 'explicit live false overrides stale message text')

  const approvedMsgs: Message[] = [
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'agytc-bridge-plan-1', content: [{ type: 'text', text: 'Plan approved. Exit plan mode and execute the plan.' }] }] } as unknown as Message,
  ]
  assert.equal(isPlanMode(approvedMsgs, undefined, undefined), false, 'approved exit_plan_mode exits plan mode')
  assert.equal(classifyPlanToolContinuation(approvedMsgs), 'continue', 'approved plan must run next turn')
  assert.equal(isPlanToolContinuation(approvedMsgs), true, 'approved exit_plan_mode is a bridge plan continuation')

  const feedbackMsgs: Message[] = [
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'agytc-bridge-plan-2', content: [{ type: 'text', text: 'Keep planning with feedback:\nSplit phase 2' }] }] } as unknown as Message,
  ]
  assert.equal(classifyPlanToolContinuation(feedbackMsgs), 'continue', 'keep-planning feedback must re-run planner')

  const dismissedMsgs: Message[] = [
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'agytc-bridge-plan-3', content: [{ type: 'text', text: 'Plan review was dismissed by the user.' }] }] } as unknown as Message,
  ]
  assert.equal(classifyPlanToolContinuation(dismissedMsgs), 'dismissed', 'dismissed plan must short-circuit cleanly')
  assert.equal(isPlanToolContinuation(dismissedMsgs), true)

  const planChunksA = buildPlanExitToolCallBlock('Step 1\nStep 2', 0) as Array<{ type: string; block?: { id: string; arguments: string } }>
  const planChunksB = buildPlanExitToolCallBlock('# Existing Title\nStep 1', 1) as Array<{ type: string; block?: { id: string; arguments: string } }>
  const idA = planChunksA[1]!.block!.id
  const idB = planChunksB[1]!.block!.id
  assert.notEqual(idA, idB, 'each synthesized exit_plan_mode receives a unique callId')
  assert.equal(JSON.parse(planChunksA[1]!.block!.arguments).plan.startsWith('# '), true, 'prepends # heading when absent')
  assert.equal(JSON.parse(planChunksB[1]!.block!.arguments).plan.startsWith('# Existing Title'), true, 'preserves existing # heading')
  assert.equal(parseMirrorCallId(idA), null, 'bridge plan callId must not parse as a mirror runId/eventIndex')
  const goalChunks = buildGoalCompleteToolCallBlock({ goalId: 'g1', revision: 1 }, 0) as Array<{ type: string; block?: { id: string } }>
  assert.equal(parseMirrorCallId(goalChunks[1]!.block!.id), null, 'bridge goal callId must not parse as a mirror runId/eventIndex')
})
