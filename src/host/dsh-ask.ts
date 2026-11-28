// agy's `ask_question`, asked through DSH's native question card (issue #236).
//
// Over ACP, agy parks a question and ends the turn. The bridge used to show it
// as a generic tool card plus plain text, and the answer only reached agy when
// the user typed it as the next message. When the host tool is reachable the
// bridge now synthesises `ask_user_question` instead, and the answer comes back
// as that call's tool result — which the prompt builder already forwards to agy
// as the next prompt, where agy resolves it as the pending question's answer.
//
// Three outcomes of that call matter. Answered: forward the answer. Timed out
// (`pending`): the questions stay answerable on the host side and a later reply
// arrives as an ordinary user message, so this hop ends without calling agy.
// Skipped: agy auto-fills "User Skipped" itself when nobody answers, and gets
// the same words from us.
import type { Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { toolCallIdOf } from '../provider/continuation.ts'
import { isToolResultMessage, textOf } from '../provider/prompt-text.ts'
import { trailingNonSyntheticMessage } from './dsh-goal.ts'
import { bridgeCall, nextBridgeCallId, type ExcludeUnavailable, type HostToolSupport } from './host-tools.ts'

/** agy's built-in question tool, exactly as ACP names it. */
export const AGY_ASK_TOOL = 'ask_question'
/** Call-id prefix of the bridge's `ask_user_question`; the continuation scan keys on it. */
export const ASK_BRIDGE_PREFIX = 'agytc-bridge-ask-'

/** One question in the schema DSH's `ask_user_question` takes. */
export interface DshAskQuestion {
  id: string
  question: string
  header?: string
  options?: { label: string; description?: string }[]
  multi_select?: boolean
}

/**
 * Map agy's `ask_question` input onto DSH's question schema, or null when there
 * is nothing usable. Entries without a question are dropped, never sent as
 * blank cards; a question without options is a free-text answer.
 */
export function mapAgyQuestions(input: unknown): DshAskQuestion[] | null {
  const raw = input !== null && typeof input === 'object' ? (input as { questions?: unknown }).questions : undefined
  if (!Array.isArray(raw)) return null
  const out: DshAskQuestion[] = []
  raw.forEach((q, i) => {
    if (q === null || typeof q !== 'object') return
    const o = q as Record<string, unknown>
    const question = typeof o.question === 'string' ? o.question.trim() : ''
    if (question === '') return
    const heading = [o.header, o.title].find((h): h is string => typeof h === 'string' && h.trim() !== '')
    const options = Array.isArray(o.options)
      ? o.options.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((label) => ({ label: label.trim() }))
      : []
    out.push({
      id: `q${i + 1}`,
      question,
      ...(heading !== undefined ? { header: heading.trim() } : {}),
      ...(options.length > 0 ? { options } : {}),
      ...(o.is_multi_select === true || o.multi_select === true ? { multi_select: true } : {}),
    })
  })
  return out.length === 0 ? null : out
}

/** The part of a recorded step the ask rules read; an AgyEvent satisfies it. */
export interface AskStepLike {
  kind: string
  stepKind?: string
  tool?: { name?: string; args?: unknown }
  raw?: unknown
}

function acpSessionUpdate(raw: unknown): string {
  return raw !== null && typeof raw === 'object' ? String((raw as { sessionUpdate?: unknown }).sessionUpdate ?? '') : ''
}

/**
 * True for a tool step that is agy asking the user OVER ACP. The CLI's print
 * mode has no pending question — it auto-answers `ask_question` — so a step
 * that did not come from an ACP session update is never an ask to forward.
 */
export function isAcpAskStep(ev: AskStepLike): boolean {
  if (ev.kind !== 'step' || ev.stepKind !== 'tool' || ev.tool?.name !== AGY_ASK_TOOL) return false
  const update = acpSessionUpdate(ev.raw)
  return update === 'tool_call' || update === 'tool_call_update'
}

/** The questions of a step when it is a mappable ACP ask, else null. */
export function trailingAskQuestions(step: AskStepLike | null | undefined): DshAskQuestion[] | null {
  if (!step || !isAcpAskStep(step)) return null
  return mapAgyQuestions(step.tool?.args)
}

/** Build the bridge's `ask_user_question` tool-call chunk. */
export function buildAskUserToolCallBlock(
  questions: readonly DshAskQuestion[],
  blockIdx: number,
  access: ExcludeUnavailable,
): StreamChunk[] {
  const first = questions[0]?.question ?? ''
  const brief = first.length > 80 ? first.slice(0, 79) + '…' : first
  return [
    { type: 'block-start', index: blockIdx, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: blockIdx,
      block: {
        type: 'tool-call',
        id: nextBridgeCallId(ASK_BRIDGE_PREFIX),
        ...bridgeCall('ask_user_question', { questions }, access, `ask the user: ${brief}`),
      },
    },
  ]
}

/**
 * The question-card chunks for a span that ended on a mappable ACP ask, or
 * null when nothing should be synthesised — the one entry point the event
 * mapper needs at its result event.
 */
export function askSynthesisChunks(
  support: HostToolSupport | undefined,
  lastToolStep: AskStepLike | null | undefined,
  blockIdx: number,
): StreamChunk[] | null {
  if (!support) return null
  const questions = trailingAskQuestions(lastToolStep)
  if (questions === null) return null
  return buildAskUserToolCallBlock(questions, blockIdx, support === 'run_code' ? 'run_code' : 'direct')
}

type AskResult =
  | { kind: 'pending'; message: string }
  | { kind: 'answers'; answers: { id: string; selected: string[]; custom?: string }[] }

function parseAskResult(text: string): AskResult | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const o = parsed as { pending?: unknown; message?: unknown; answers?: unknown }
  if (o.pending === true) return { kind: 'pending', message: typeof o.message === 'string' ? o.message : '' }
  if (!Array.isArray(o.answers)) return null
  return {
    kind: 'answers',
    answers: o.answers.flatMap((a) => {
      if (a === null || typeof a !== 'object') return []
      const answer = a as { id?: unknown; selected?: unknown; custom?: unknown }
      return [{
        id: typeof answer.id === 'string' ? answer.id : '',
        selected: Array.isArray(answer.selected) ? answer.selected.filter((x): x is string => typeof x === 'string') : [],
        ...(typeof answer.custom === 'string' && answer.custom.trim() !== '' ? { custom: answer.custom.trim() } : {}),
      }]
    }),
  }
}

/**
 * - `'none'`: the trailing message is not the result of a bridge question.
 * - `'pending'`: there is no answer to forward — the host timed out (the
 *   questions stay answerable and a later reply is an ordinary user message),
 *   or the call itself failed. The hop ends without calling agy.
 * - `'skipped'` / `'answered'`: run agy with the answer as the prompt.
 */
export type AskContinuation = 'none' | 'pending' | 'skipped' | 'answered'

/** Classify the trailing span: the tool result of the bridge's question call, and what became of it. */
export function classifyAskToolContinuation(messages: readonly Message[]): AskContinuation {
  const trailing = trailingNonSyntheticMessage(messages)
  if (!trailing || !isToolResultMessage(trailing)) return 'none'
  const callId = toolCallIdOf(trailing)
  if (callId === null || !callId.startsWith(ASK_BRIDGE_PREFIX)) return 'none'
  // The call itself failed — the tool was missing or rejected the arguments:
  // that text is not an answer, and must never be forwarded as one.
  const blocks = (trailing.content as readonly unknown[] | undefined) ?? []
  if (blocks.some((b) => b !== null && typeof b === 'object' && (b as { type?: unknown; isError?: unknown }).type === 'tool-result' && (b as { isError?: unknown }).isError === true)) {
    return 'pending'
  }
  const parsed = parseAskResult(textOf(trailing))
  if (parsed?.kind === 'pending') return 'pending'
  if (parsed?.kind === 'answers' && parsed.answers.every((a) => a.selected.length === 0 && a.custom === undefined)) return 'skipped'
  return 'answered'
}

/**
 * The prompt agy receives for the answer: readable `Q` / `A` lines keyed by the
 * question's own number, or the result text as is when it is not a result
 * object. `User Skipped` is agy's own wording for an unanswered question.
 */
export function askAnswerPrompt(resultText: string, questions: readonly DshAskQuestion[]): string {
  const parsed = parseAskResult(resultText)
  if (parsed === null) return resultText
  if (parsed.kind === 'pending') return parsed.message
  if (parsed.answers.every((a) => a.selected.length === 0 && a.custom === undefined)) return 'User Skipped'
  return parsed.answers
    .map((a, i) => {
      const byId = /^q(\d+)$/.exec(a.id)
      const n = byId !== null ? Number(byId[1]) : i + 1
      const question = questions.find((q) => q.id === a.id)?.question ?? `(question ${a.id !== '' ? a.id : n})`
      const answer = [a.selected.join('; '), ...(a.custom !== undefined ? [a.custom] : [])].filter((s) => s !== '').join(' — ')
      return `Q${n}: ${question}\nA${n}: ${answer}`
    })
    .join('\n\n')
}

/**
 * The questions a bridge call asked, read back from its tool-call block, so the
 * answer prompt can quote them. Null when the call is not in the history.
 */
export function askQuestionsOfCall(callId: string, messages: readonly Message[]): DshAskQuestion[] | null {
  for (const m of messages) {
    const content = (m.content as readonly unknown[] | undefined) ?? []
    for (const raw of content) {
      const b = raw as { type?: unknown; id?: unknown; toolCallId?: unknown; tool_call_id?: unknown; arguments?: unknown } | null
      if (!b || b.type !== 'tool-call') continue
      const id = [b.id, b.toolCallId, b.tool_call_id].find((x) => typeof x === 'string')
      if (id !== callId) continue
      const args = typeof b.arguments === 'string' ? safeJson(b.arguments) : b.arguments
      const questions = (args as { questions?: unknown } | null)?.questions
      if (!Array.isArray(questions)) return null
      const valid = questions.filter((q) => q !== null && typeof q === 'object' && typeof (q as { question?: unknown }).question === 'string')
      return valid.length > 0 ? (valid as DshAskQuestion[]) : null
    }
  }
  return null
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
