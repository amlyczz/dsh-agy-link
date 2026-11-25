import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cloakPromptText } from '../../src/provider/prompt-cloak.ts'
import { stripAgyInternalNoise } from '../../src/provider/mapper/text.ts'
import { EventMapper } from '../../src/provider/mapper/event-mapper.ts'
import { defaultConfig, Err, looksLikeAiCreditsLow, looksLikeHardRateLimit } from '../../src/common/types.ts'
import { classifyFailure } from '../../src/provider/failure.ts'
import { shouldSelfHealAcpResult } from '../../src/features/acp/run-attempt.ts'

describe('Slice 5: prompt cloak, dirty text stripping, AI credits & ACP self-heal', () => {
  it('cloaks known DSH/Codex boilerplate fingerprints without changing meaning and respects enabled=false', () => {
    const raw = [
      'You are an AI agent powered by DeepSeek Harness.',
      'The browser provides no implicit DOM, route, or screenshot context.',
      'Tokens prefixed with @ are paths in the workspace.\nFollow them carefully.',
      'You are Codex, based on GPT-5. Keep answers concise.',
    ].join('\n\n')

    const cloaked = cloakPromptText(raw, true)
    assert.ok(cloaked.includes("You're an AI agent powered by DeepSeek Harness."))
    assert.ok(cloaked.includes('The browser gives no implicit DOM, route, or screenshot context.'))
    assert.ok(!cloaked.includes('Tokens prefixed with @ are paths'))
    assert.ok(cloaked.includes('Paths prefixed with @ refer to workspace files'))
    assert.ok(!/You are Codex,\s*based on GPT-5/i.test(cloaked))

    assert.equal(cloakPromptText(raw, false), raw)
  })

  it('strips leaked agy API error retry lines and 3-line output-token-limit continuation notices', () => {
    const dirty = [
      'Here is the first part.',
      '⚠ API error (attempt 2): transient 502 from backend',
      'Your previous response was cut off because it exceeded the output token limit.',
      'Continue directly from where you left off without repeating.',
      'Retries remaining: 2',
      'Here is the rest of the answer.',
    ].join('\n')

    const clean = stripAgyInternalNoise(dirty)
    assert.equal(clean, 'Here is the first part.\nHere is the rest of the answer.')
  })

  it('EventMapper filters agy internal noise from streamed assistant text', () => {
    const mapper = new EventMapper({ runId: 'r1', cutOnTool: true })
    const chunks = [
      ...mapper.map(
        {
          kind: 'step',
          stepKey: 's1',
          stepKind: 'text',
          text: '⚠ API error (attempt 1): 503\nClean answer here.',
          raw: {},
        },
        0,
      ),
    ]
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    assert.equal(deltas, 'Clean answer here.')
  })

  it('classifies AI credits balance too low as hard RATE_LIMIT with clear hint', () => {
    const msg = 'Your AI credits balance is too low to complete this request.'
    assert.equal(looksLikeAiCreditsLow(msg), true)
    assert.equal(looksLikeHardRateLimit(msg), true)

    const failure = classifyFailure({
      cfg: defaultConfig(),
      outcome: { aborted: false, capped: false, timedOut: false, code: 1, stderrTail: msg },
      parser: { stats: { sawAuthFailure: false, lastResultError: msg, garbage: 0 } },
      sawAuthFailure: false,
      consumable: false,
      transportFailure: false,
      keyringJitter: false,
      rawErrText: msg,
      isRateLimit: true,
      silentTimeout: false,
    })
    assert.ok(failure)
    assert.equal(failure.code, Err.RATE_LIMIT)
    assert.match(failure.message, /AI credits balance is too low/i)
  })

  it('triggers ACP same-session warm self-heal for invalid output or thinking-only empty turn, never after tools', () => {
    assert.equal(
      shouldSelfHealAcpResult(
        { kind: 'result', ok: false, conversationId: 's1', response: '', error: '⚠ Model produced invalid output.', usage: {}, raw: {} },
        { sawText: false, sawThinking: false, sawTools: false },
      ),
      true,
    )
    assert.equal(
      shouldSelfHealAcpResult(
        { kind: 'result', ok: true, conversationId: 's1', response: '', usage: {}, raw: {} },
        { sawText: false, sawThinking: true, sawTools: false },
      ),
      true,
    )
    assert.equal(
      shouldSelfHealAcpResult(
        { kind: 'result', ok: true, conversationId: 's1', response: 'Done!', usage: {}, raw: {} },
        { sawText: true, sawThinking: true, sawTools: false },
      ),
      false,
    )
    assert.equal(
      shouldSelfHealAcpResult(
        { kind: 'result', ok: false, conversationId: 's1', response: '', error: '⚠ Model produced invalid output.', usage: {}, raw: {} },
        { sawText: false, sawThinking: true, sawTools: true },
      ),
      false,
    )
  })
})
