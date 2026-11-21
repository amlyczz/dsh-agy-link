// One-shot text runner shared by the agy_ask tool: spawn agy, collect the
// final response text (streamed text steps, else the result envelope), and
// surface the conversation id so the caller can continue later.
import {
  extractQuotaErrorModel,
  isHardQuotaResultError,
  isNonConsumableResultError,
  isTransientBurstRateLimit,
  looksLikeAuthFailure,
  looksLikeEligibilityFailure,
  looksLikeHardRateLimit,
  looksLikeTosViolation,
  parseResetDurationMs,
  shouldMarkAuthRequired,
  type PluginConfig,
} from '../common/types.ts'
import { modelFamilyOf, type ManagedAccount, type ModelFamily } from '../common/pool-types.ts'
import type { AccountPoolManager } from './pool.ts'
import { acquireCredentialSlot } from './credential-slot.ts'
import { detectSystemProxy } from './wincred.ts'
import { StreamJsonParser } from './parser.ts'
import { startAgyProcess, buildStreamInputLine, shouldUsePromptStdin, stripNulBytes } from './runner.ts'
import { buildAgyEnv } from '../runtime/net/account-env.ts'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** Per-file inline cap; larger files are truncated. */
const INLINE_MAX_BYTES = 256 * 1024

const SENSITIVE_INLINE_RE = /(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|antigravity-oauth-token|\.primary-credential\.json|id_rsa|id_ed25519)(?:$|[/\\])/i

/** Truncate a buffer to <= max bytes without splitting a UTF-8 code point. */
function truncateUtf8(buf: Buffer, max: number): Buffer {
  if (buf.length <= max) return buf
  let end = max
  let i = end - 1
  let back = 0
  while (i >= 0 && (buf[i]! & 0xc0) === 0x80 && back < 3) {
    i--
    back++
  }
  if (i >= 0) {
    const lead = buf[i]!
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
    if (i + need > end) end = i
  }
  return buf.subarray(0, end)
}

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
 * Inline text files into the prompt (v0.2): each readable textual file inside
 * `cwd` becomes a fenced section. Paths escaping `cwd` (via `..`, symlinks, or
 * outside absolute paths) or naming sensitive credential files are refused.
 */
export async function inlineFiles(
  prompt: string,
  paths: readonly string[],
  cwd: string,
): Promise<string> {
  if (paths.length === 0) return prompt
  const rootReal = await realpath(resolve(cwd)).catch(() => resolve(cwd))
  const sections: string[] = []
  for (const raw of paths) {
    const candidate = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)
    let note = ''
    let body = ''
    try {
      const targetReal = await realpath(candidate)
      const rel = relative(rootReal, targetReal)
      if (rel.startsWith('..') || isAbsolute(rel) || SENSITIVE_INLINE_RE.test(targetReal)) {
        note = '(skipped: outside workspace boundary - ' + raw + ')'
      } else {
        const buf = await readFile(targetReal)
        if (!looksTextual(buf.subarray(0, Math.min(buf.length, 4096)).toString('utf8'))) {
          note = '(skipped: binary file - reference it by path and let agy read it with its own tools)'
        } else if (buf.byteLength > INLINE_MAX_BYTES) {
          note = '(truncated to the first ' + INLINE_MAX_BYTES + ' bytes)'
          body = truncateUtf8(buf, INLINE_MAX_BYTES).toString('utf8')
        } else {
          body = buf.toString('utf8')
        }
      }
    } catch {
      note = '(skipped: unreadable - ' + raw + ')'
    }
    sections.push('--- file: ' + candidate + ' ' + note + ' ---' + '\n' + body)
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
  pool?: () => AccountPoolManager | undefined
  acquire?: (signal?: AbortSignal) => Promise<() => void>
  log?: (msg: string) => void
  effortUnsupported?: () => readonly string[]
  onEffortUnsupported?: (model: string) => void
}

type SingleOneShotAttemptOutcome =
  | { kind: 'done'; result: OneShotResult }
  | { kind: 'retry'; error: string; durationMs: number }

async function runSingleOneShotAttempt(opts: {
  deps: OneShotDeps
  cfg: PluginConfig
  bin: string
  baseArgs: readonly string[]
  prompt: string
  conversationId?: string
  timeoutMs: number
  signal?: AbortSignal
  pool?: AccountPoolManager
  account?: ManagedAccount
  family: ModelFamily
  model?: string
  canRetry: boolean
}): Promise<SingleOneShotAttemptOutcome> {
  const { deps, cfg, bin, baseArgs, prompt, conversationId: reqCid, timeoutMs, signal, pool, account, family, model, canRetry } = opts
  const args = [...baseArgs]
  if (reqCid && reqCid.trim() !== '') args.push('--conversation', reqCid.trim())
  args.push('-p', prompt)
  let stdinPayload: string | undefined
  if (shouldUsePromptStdin(args)) {
    args.splice(args.length - 2, 2)
    args.push('--input-format', 'stream-json')
    stdinPayload = buildStreamInputLine(prompt)
  }

  let releaseSem: (() => void) | undefined
  let slotLease: { release(): void } | undefined
  try {
    if (deps.acquire) releaseSem = await deps.acquire(signal)
    if (process.platform === 'win32' && process.env.NODE_TEST_CONTEXT === undefined && pool && account) {
      slotLease = await acquireCredentialSlot(account, pool, {
        baseDir: pool.dir,
        proxyUrl: account.proxyUrl || cfg.proxyUrl || detectSystemProxy() || undefined,
        log: deps.log,
        signal,
        dispatchTimeoutMs: cfg.dispatchTimeoutMinutes > 0 ? cfg.dispatchTimeoutMinutes * 60_000 : 60_000,
        parallel: cfg.parallelSameAccount,
      })
    }

    const parser = new StreamJsonParser()
    let streamedText = ''
    let prevWasStepText = false
    let resultText = ''
    let resultOk: boolean | null = null
    let resultError: string | undefined
    let conversationId: string | null = null
    const appendTextEv = (text: string, fragment?: boolean) => {
      if (text === '') return
      if (fragment) {
        streamedText += text
        prevWasStepText = false
      } else {
        if (streamedText !== '' && prevWasStepText && !streamedText.endsWith('\n')) {
          streamedText += '\n'
        }
        streamedText += text
        prevWasStepText = true
      }
    }
    const handleEv = (ev: ReturnType<StreamJsonParser['feed']>[number]) => {
      if (ev.kind === 'init' && ev.conversationId) conversationId = ev.conversationId
      if (ev.kind === 'step' && ev.stepKind === 'text') appendTextEv(ev.text, ev.fragment)
      if (ev.kind === 'result') {
        if (ev.conversationId !== '') conversationId = ev.conversationId
        resultOk = ev.ok
        resultText = ev.response
        resultError = ev.error
      }
    }
    const proc = startAgyProcess({
      bin,
      args,
      cwd: cfg.workspaceRoot !== '' ? cfg.workspaceRoot : undefined,
      timeoutMs,
      signal,
      env: buildAgyEnv({ ...(account ? { account } : {}), cfg }),
      stdinPayload,
      preemptAutoUpdate: cfg.suppressAgyAutoUpdate,
      onLine: (line) => {
        for (const ev of parser.feed(line + '\n')) handleEv(ev)
      },
    })
    const outcome = await proc.outcome
    for (const ev of parser.flush()) handleEv(ev)

    if (outcome.aborted) {
      return { kind: 'done', result: { ok: false, text: '', conversationId, error: 'aborted', durationMs: outcome.durationMs } }
    }
    if (outcome.timedOut) {
      return { kind: 'done', result: { ok: false, text: '', conversationId, error: 'timed out after ' + timeoutMs + 'ms', durationMs: outcome.durationMs } }
    }

    const joined = streamedText.trim()
    const text = joined !== '' ? joined : resultText
    const rawErr = [
      resultError,
      parser.stats.lastResultError,
      outcome.stderrTail,
      resultOk === false ? resultText : '',
    ]
      .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      .join(' ')
      .trim()

    if (looksLikeTosViolation(rawErr) || looksLikeTosViolation(resultText)) {
      if (pool && account) pool.markAuthRequired(account.id, rawErr || resultText)
      return {
        kind: 'done',
        result: { ok: false, text: '', conversationId, error: rawErr || resultText || 'TOS_VIOLATION', durationMs: outcome.durationMs },
      }
    }

    const hardQuota =
      isHardQuotaResultError(resultOk !== false, resultError, resultText)
      || (looksLikeHardRateLimit(rawErr) && !isTransientBurstRateLimit(rawErr))
    if (hardQuota) {
      const errModel = extractQuotaErrorModel(rawErr)
      const modelFam = errModel ? modelFamilyOf(errModel) : undefined
      const targetFam: ModelFamily = modelFam && modelFam !== 'unknown' ? modelFam : family
      const resetMs = parseResetDurationMs(rawErr)
      const resetIso = resetMs && resetMs > 0 ? new Date(Date.now() + resetMs).toISOString() : undefined
      if (pool && account) {
        pool.recordFailure(account.id, targetFam, rawErr || 'quota exhausted', resetIso)
        if (targetFam !== family) pool.advanceAccount(account.id, family, model)
      }
      const errMsg = rawErr || 'Antigravity quota / rate limit reached'
      if (canRetry && pool && pool.selectAccount(family, model) !== null) {
        return { kind: 'retry', error: errMsg, durationMs: outcome.durationMs }
      }
      return { kind: 'done', result: { ok: false, text: '', conversationId, error: errMsg, durationMs: outcome.durationMs } }
    }

    const nonConsumable = resultOk === false && isNonConsumableResultError(false, resultError, resultText)
    if (nonConsumable || text === '') {
      if (looksLikeEligibilityFailure(rawErr)) {
        if (pool && account) pool.advanceAccount(account.id, family, model)
        if (canRetry && pool && pool.selectAccount(family, model) !== null) {
          return { kind: 'retry', error: rawErr, durationMs: outcome.durationMs }
        }
        return { kind: 'done', result: { ok: false, text: '', conversationId, error: rawErr, durationMs: outcome.durationMs } }
      }
      if (looksLikeAuthFailure(rawErr) || parser.stats.sawAuthFailure) {
        if (pool && account && shouldMarkAuthRequired('AUTH', rawErr)) {
          pool.noteAuthFailure(account.id, rawErr)
          pool.advanceAccount(account.id, family, model)
        }
        if (canRetry && pool && pool.selectAccount(family, model) !== null) {
          return { kind: 'retry', error: 'agy is not signed in — run /agy auth', durationMs: outcome.durationMs }
        }
        return { kind: 'done', result: { ok: false, text: '', conversationId, error: 'agy is not signed in — run /agy auth', durationMs: outcome.durationMs } }
      }
      if (nonConsumable) {
        return { kind: 'done', result: { ok: false, text: '', conversationId, error: rawErr || resultText, durationMs: outcome.durationMs } }
      }
    }

    if (outcome.code !== 0 && text === '') {
      const envelopeError = parser.stats.lastResultError ?? ''
      const detail = envelopeError !== '' ? envelopeError : outcome.stderrTail.slice(-300)
      return { kind: 'done', result: { ok: false, text: '', conversationId, error: 'agy exited with code ' + outcome.code + ': ' + detail, durationMs: outcome.durationMs } }
    }
    if (text !== '') {
      if (pool && account) pool.recordSuccess(account.id, family)
      return { kind: 'done', result: { ok: true, text, conversationId, durationMs: outcome.durationMs } }
    }
    return { kind: 'done', result: { ok: false, text: '(no output)', conversationId, durationMs: outcome.durationMs } }
  } finally {
    slotLease?.release()
    releaseSem?.()
  }
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
    readPaths?: readonly string[]
    schema?: unknown
    agent?: string
    sandbox?: boolean
    agySettings?: string
    conversationId?: string
  },
): Promise<OneShotResult> {
  const cfg = deps.cfg()
  const bin = deps.bin()
  if (!bin) return { ok: false, text: '', conversationId: null, error: 'agy binary not found', durationMs: 0 }
  const timeoutMs = req.timeoutMs ?? cfg.timeoutMs
  const baseArgs: string[] = [
    '--output-format', 'stream-json',
    '--print-timeout', Math.max(1, Math.ceil(timeoutMs / 60_000)) + 'm',
  ]
  const mode = req.mode ?? cfg.permissionMode
  if (mode === 'skip') baseArgs.push('--dangerously-skip-permissions')
  else baseArgs.push('--mode', mode)
  if (req.sandbox ?? cfg.sandbox) baseArgs.push('--sandbox')
  const agent = (req.agent ?? cfg.agent).trim()
  if (agent !== '') baseArgs.push('--agent', agent)
  const agySettings = (req.agySettings ?? cfg.agySettings).trim()
  if (agySettings !== '') baseArgs.push('--settings', agySettings)
  if (req.model) baseArgs.push('--model', req.model)
  if (req.effort) baseArgs.push('--effort', req.effort)
  let prompt = req.prompt
  if (req.readPaths && req.readPaths.length > 0) {
    prompt = await inlineFiles(prompt, req.readPaths, cfg.workspaceRoot !== '' ? cfg.workspaceRoot : process.cwd())
  }
  prompt = stripNulBytes(prompt)

  const pool = deps.pool?.()
  const family = modelFamilyOf(req.model || cfg.defaultModel || 'gemini')
  const enabledCount = pool ? pool.getAccounts().filter((a) => a.enabled).length : 0
  const maxAttempts = pool ? Math.min(Math.max(1, enabledCount), 17) : 1
  const triedAccounts = new Set<string>()
  let totalDurationMs = 0
  let lastError = ''

  let cleanup: (() => Promise<void>) | null = null
  try {
    if (req.schema !== undefined && req.schema !== null) {
      const sa = await schemaArgs(req.schema)
      baseArgs.push(...sa.args)
      cleanup = sa.cleanup
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (req.signal?.aborted) {
        return { ok: false, text: '', conversationId: null, error: 'aborted', durationMs: totalDurationMs }
      }
      let account: ManagedAccount | undefined
      if (pool && pool.getAccounts().length > 0) {
        const selected = pool.selectAccount(family, req.model)
        if (!selected || triedAccounts.has(selected.id)) {
          return {
            ok: false,
            text: '',
            conversationId: null,
            error: lastError || 'All Antigravity accounts are currently unavailable (cooling down, quota exhausted, or disabled)',
            durationMs: totalDurationMs,
          }
        }
        account = selected
        triedAccounts.add(selected.id)
      }

      const out = await runSingleOneShotAttempt({
        deps,
        cfg,
        bin,
        baseArgs,
        prompt,
        ...(attempt === 0 && req.conversationId !== undefined ? { conversationId: req.conversationId } : {}),
        timeoutMs,
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        ...(pool !== undefined ? { pool } : {}),
        ...(account !== undefined ? { account } : {}),
        family,
        ...(req.model !== undefined ? { model: req.model } : {}),
        canRetry: attempt + 1 < maxAttempts,
      })
      if (out.kind === 'retry') {
        totalDurationMs += out.durationMs
        lastError = out.error
        continue
      }
      return { ...out.result, durationMs: totalDurationMs + out.result.durationMs }
    }

    return {
      ok: false,
      text: '',
      conversationId: null,
      error: lastError || 'All Antigravity accounts are currently unavailable',
      durationMs: totalDurationMs,
    }
  } finally {
    if (cleanup) void cleanup().catch(() => {})
  }
}
