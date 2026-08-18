// One-shot text runner shared by the agy_ask tool: spawn agy, collect the
// final response text (streamed text steps, else the result envelope), and
// surface the conversation id so the caller can continue later.
import { looksLikeAuthFailure, type PluginConfig } from '../common/types.ts'
import { StreamJsonParser } from './parser.ts'
import { startAgyProcess } from './runner.ts'

export interface OneShotResult {
  ok: boolean
  text: string
  conversationId: string | null
  error?: string
  durationMs: number
}

export interface OneShotDeps {
  cfg: () => PluginConfig
  bin: () => string | null
}

export async function runAgyOnce(
  deps: OneShotDeps,
  req: { prompt: string; model?: string; effort?: string; mode?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<OneShotResult> {
  const cfg = deps.cfg()
  const bin = deps.bin()
  if (!bin) return { ok: false, text: '', conversationId: null, error: 'agy binary not found', durationMs: 0 }
  const args: string[] = ['--output-format', 'stream-json']
  const mode = req.mode ?? cfg.permissionMode
  if (mode === 'skip') args.push('--dangerously-skip-permissions')
  else args.push('--mode', mode)
  if (req.model) args.push('--model', req.model)
  if (req.effort) args.push('--effort', req.effort)
  args.push('-p', req.prompt)
  const timeoutMs = req.timeoutMs ?? cfg.timeoutMs
  const parser = new StreamJsonParser()
  const textParts: string[] = []
  let resultText = ''
  let conversationId: string | null = null
  const proc = startAgyProcess({
    bin,
    args,
    cwd: cfg.workspaceRoot !== '' ? cfg.workspaceRoot : undefined,
    timeoutMs,
    signal: req.signal,
    onLine: (line) => {
      for (const ev of parser.feed(line + '\n')) {
        if (ev.kind === 'init' && ev.conversationId) conversationId = ev.conversationId
        if (ev.kind === 'step' && ev.stepKind === 'text' && ev.text !== '') textParts.push(ev.text)
        if (ev.kind === 'result') {
          if (ev.conversationId !== '') conversationId = ev.conversationId
          resultText = ev.response
        }
      }
    },
  })
  const outcome = await proc.outcome
  for (const ev of parser.flush()) {
    if (ev.kind === 'result') {
      if (ev.conversationId !== '') conversationId = ev.conversationId
      resultText = ev.response
    }
  }
  if (outcome.aborted) {
    return { ok: false, text: '', conversationId, error: 'aborted', durationMs: outcome.durationMs }
  }
  if (outcome.timedOut) {
    return { ok: false, text: '', conversationId, error: 'timed out after ' + timeoutMs + 'ms', durationMs: outcome.durationMs }
  }
  if (looksLikeAuthFailure(outcome.stderrTail) || looksLikeAuthFailure(outcome.stdout.slice(0, 4000))) {
    return { ok: false, text: '', conversationId, error: 'agy is not signed in — run /agy auth', durationMs: outcome.durationMs }
  }
  const joined = textParts.join('\n').trim()
  const text = joined !== '' ? joined : resultText
  if (outcome.code !== 0 && text === '') {
    return { ok: false, text: '', conversationId, error: 'agy exited with code ' + outcome.code + ': ' + outcome.stderrTail.slice(-300), durationMs: outcome.durationMs }
  }
  return { ok: text !== '', text: text === '' ? '(no output)' : text, conversationId, durationMs: outcome.durationMs }
}
