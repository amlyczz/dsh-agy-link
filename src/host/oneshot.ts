// One-shot text runner shared by the agy_ask tool: spawn agy, collect the
// final response text (streamed text steps, else the result envelope), and
// surface the conversation id so the caller can continue later.
import { looksLikeAuthFailure, type PluginConfig } from '../common/types.ts'
import { StreamJsonParser } from './parser.ts'
import { startAgyProcess } from './runner.ts'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Per-file inline cap; larger files are truncated. */
const INLINE_MAX_BYTES = 256 * 1024

/** Text-detection: anything that is very likely not binary. */
function looksTextual(head: string): boolean {
  if (head === '') return true
  let suspicious = 0
  const n = Math.min(head.length, 2000)
  for (let i = 0; i < n; i++) {
    const c = head.charCodeAt(i)
    if (c === 0 || (c < 9 && c !== 0) || (c > 13 && c < 32)) suspicious++
  }
  return suspicious / n < 0.05
}

/**
 * Inline text files into the prompt (v0.2): each readable textual file
 * becomes a fenced section. Paths resolve against the oneshot cwd;
 * absolute paths pass through.
 */
export async function inlineFiles(
  prompt: string,
  paths: readonly string[],
  cwd: string,
): Promise<string> {
  if (paths.length === 0) return prompt
  const sections: string[] = []
  for (const raw of paths) {
    const p = isAbsolute(raw) ? raw : resolve(cwd, raw)
    let note = ''
    let body = ''
    try {
      const buf = await readFile(p)
      if (!looksTextual(buf.subarray(0, Math.min(buf.length, 4096)).toString('utf8'))) {
        note = '(skipped: binary file - reference it by path and let agy read it with its own tools)'
      } else if (buf.byteLength > INLINE_MAX_BYTES) {
        note = '(truncated to the first ' + INLINE_MAX_BYTES + ' bytes)'
        body = buf.subarray(0, INLINE_MAX_BYTES).toString('utf8')
      } else {
        body = buf.toString('utf8')
      }
    } catch {
      note = '(skipped: unreadable - ' + raw + ')'
    }
    sections.push('--- file: ' + p + ' ' + note + ' ---' + '\n' + body)
  }
  return prompt + '\n\n' + sections.join('\n\n')
}

/** Write a JSON schema to a temp file; returns the --json-schema argv tail. */
export async function schemaArgs(schema: unknown): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  const text = JSON.stringify(schema)
  const dir = await mkdtemp(join(tmpdir(), 'agy-schema-'))
  const file = join(dir, 'schema.json')
  await writeFile(file, text, 'utf8')
  return { args: ['--json-schema', file], cleanup: () => rm(dir, { recursive: true, force: true }) }
}

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
  req: {
    prompt: string
    model?: string
    effort?: string
    mode?: string
    timeoutMs?: number
    signal?: AbortSignal
    /** Workspace-relative or absolute text files to inline into the prompt. */
    readPaths?: readonly string[]
    /** JSON schema enforcing the final result (--json-schema). */
    schema?: unknown
  },
): Promise<OneShotResult> {
  const cfg = deps.cfg()
  const bin = deps.bin()
  if (!bin) return { ok: false, text: '', conversationId: null, error: 'agy binary not found', durationMs: 0 }
  const timeoutMs = req.timeoutMs ?? cfg.timeoutMs
  const args: string[] = [
    '--output-format', 'stream-json',
    '--print-timeout', Math.max(1, Math.ceil(timeoutMs / 60_000)) + 'm',
  ]
  const mode = req.mode ?? cfg.permissionMode
  if (mode === 'skip') args.push('--dangerously-skip-permissions')
  else args.push('--mode', mode)
  if (req.model) args.push('--model', req.model)
  if (req.effort) args.push('--effort', req.effort)
  let prompt = req.prompt
  if (req.readPaths && req.readPaths.length > 0) {
    prompt = await inlineFiles(prompt, req.readPaths, cfg.workspaceRoot !== '' ? cfg.workspaceRoot : process.cwd())
  }
  let cleanup: (() => Promise<void>) | null = null
  if (req.schema !== undefined && req.schema !== null) {
    const sa = await schemaArgs(req.schema)
    args.push(...sa.args)
    cleanup = sa.cleanup
  }
  args.push('-p', prompt)
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
  if (cleanup) void cleanup().catch(() => {})
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
