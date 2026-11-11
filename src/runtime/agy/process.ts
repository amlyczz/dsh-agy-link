// Process spawn, output collection and the activity/watchdog kill tree.
//
// MOVED VERBATIM from src/host/runner.ts (Phase 5h). Spawn semantics are
// frozen: argv quoting, detached process groups, stdin handling, the idle
// watchdog re-arm, the turn wall-clock cap, and the SIGTERM→SIGKILL escalation
// are unchanged. The only difference is that the single 170-line
// `startAgyProcess` is organised into small helpers that share one RunState.
import { spawn, type ChildProcess } from 'node:child_process'
import { preemptAgyAutoUpdate } from '../../host/auto-updater.ts'
import { isCmdShim, windowsQuote } from './bin.ts'
import { makeLineDecoder, consoleOutputEncoding } from './console.ts'
import { nodeScriptEnv, withAgyQuietEnv } from './env.ts'

const IS_WIN = process.platform === 'win32'

export interface RunOutcome {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  /** True when the turn's wall-clock cap (opts.maxTurnMs) fired. */
  capped: boolean
  stdout: string
  stderrTail: string
  durationMs: number
}

export interface RunOptions {
  bin: string
  args: readonly string[]
  cwd?: string
  timeoutMs?: number
  /**
   * Hard wall-clock cap for one turn. Unlike timeoutMs (an idle watchdog the
   * activity stream re-arms), this fires once regardless of output, so a
   * self-driving loop that keeps printing cannot run unbounded (issue #92).
   * Undefined/0 disables it.
   */
  maxTurnMs?: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  onLine?: (line: string) => void
  /** stdin stays writable (auth code injection). */
  keepStdin?: boolean
  /**
   * Write this payload to stdin and close it (long-prompt transport).
   * Takes precedence over the default immediate stdin close; mutually
   * exclusive with keepStdin auth-code flows.
   */
  stdinPayload?: string
  /**
   * Let stderr activity re-arm the idle watchdog. Off by default: agy logs
   * dial-retry noise to stderr forever when offline, which used to keep a
   * dead run "active" until the 240m print-timeout. Login flows opt in —
   * a browser login is legitimately silent on stdout for minutes.
   */
  stderrKeepalive?: boolean
  /**
   * Pre-empt agy's own auto-updater before spawn (issue #49). Default true:
   * agy >= 1.4.2 spawns `--bg-updater`, whose `agy --version` grandchild
   * allocates a visible console window on Windows before any env switch can
   * apply. Refreshing `last_check.timestamp` keeps agy on its 15-minute fast
   * path so that chain never starts (see auto-updater.ts).
   */
  preemptAutoUpdate?: boolean
}

export interface RunningProcess {
  child: ChildProcess
  outcome: Promise<RunOutcome>
  kill(reason: 'timeout' | 'abort'): void
  /**
   * Re-arm the activity watchdog, optionally on a different idle budget.
   * Long-running tools (maven/compile, issue #33) go silent on stdout while
   * they work — the adapter raises the budget when a tool step is ACTIVE and
   * restores the normal budget when the tool completes.
   */
  noteActivity(budgetMs?: number): void
}

const GRACE_MS = 5000

/**
 * Windows CreateProcess caps the command line at ~32767 chars. Leave headroom
 * for env, cwd, quoting, and the rest of the argv so a long `-p` prompt does
 * not fail with spawn ENAMETOOLONG (issue #14 / #11). Above this, the prompt
 * rides agy `--input-format stream-json` on stdin instead.
 */
export const ARGV_PROMPT_LIMIT = 24_000

/** One NDJSON line for agy --input-format stream-json (verified on agy 1.2.x). */
export function buildStreamInputLine(prompt: string): string {
  return JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } }) + '\n'
}

/**
 * Remove NUL characters from text destined for a child process.
 *
 * `spawn()` rejects any argv element containing U+0000 with
 * `ERR_INVALID_ARG_VALUE: The argument 'args[N]' must be a string without null
 * bytes`, which aborts the whole turn before agy is even started. NULs reach the
 * assembled prompt through binary tool output (a tool result that quoted a
 * binary file — `.git` objects, packed refs, images, …), so every prompt that
 * can carry tool text passes through here. Other control characters are legal in
 * argv and are left untouched.
 */
export function stripNulBytes(text: string): string {
  return text.includes('\u0000') ? text.split('\u0000').join('') : text
}

/** Whether the assembled argv (including a trailing `-p <prompt>`) risks ENAMETOOLONG. */
export function shouldUsePromptStdin(argsWithPrompt: readonly string[]): boolean {
  let size = 0
  for (const a of argsWithPrompt) size += a.length + 1
  return size > ARGV_PROMPT_LIMIT
}

// Children that already have a SIGKILL escalation armed (SIGTERM sent once).
const escalating = new WeakSet<ChildProcess>()

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (IS_WIN) {
    // No Unix process groups on Windows: kill the whole tree via taskkill.
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      try { child.kill() } catch { /* already gone */ }
    }
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      // already gone
    }
    return
  }
  // agy installs graceful-shutdown handlers; a run wedged in a dial-retry
  // loop (offline) ignores SIGTERM forever, which made the UI Stop button
  // a no-op. Escalate to SIGKILL for the whole group shortly after.
  if (escalating.has(child)) return
  escalating.add(child)
  const pid = child.pid
  const escalate = setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL') } catch { /* group already gone */ }
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }, 3000)
  escalate.unref?.()
  child.once('exit', () => {
    clearTimeout(escalate)
    escalating.delete(child)
  })
}

/** Mutable state for one spawned run. */
interface RunState {
  stdout: string
  stderr: string
  pending: string
  timedOut: boolean
  aborted: boolean
  capped: boolean
  settled: boolean
  idleBudgetMs: number | undefined
  watchdog: NodeJS.Timeout | null
  turnCap: NodeJS.Timeout | null
}

function createRunState(opts: RunOptions): RunState {
  return {
    stdout: '',
    stderr: '',
    pending: '',
    timedOut: false,
    aborted: false,
    capped: false,
    settled: false,
    idleBudgetMs: opts.timeoutMs,
    watchdog: null,
    turnCap: null,
  }
}

function spawnAgyChild(opts: RunOptions, env: NodeJS.ProcessEnv, viaCmd: boolean, isNode: boolean): ChildProcess {
  return viaCmd
    ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [opts.bin, ...opts.args].map(windowsQuote).join(' ')], {
        cwd: opts.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsVerbatimArguments: true,
        windowsHide: true,
      })
    : isNode
      ? spawn(process.execPath, [opts.bin, ...opts.args], {
          cwd: opts.cwd,
          env: nodeScriptEnv(env),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
      : spawn(opts.bin, opts.args, {
          cwd: opts.cwd,
          env,
          detached: !IS_WIN,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
}

/**
 * agy reads stdin when it is a pipe and never sees EOF (observed on
 * 1.1.15: `agy models` hangs forever with an open pipe stdin, which is
 * why model discovery silently timed out). Close stdin immediately for
 * every spawn that does not explicitly need to write to it — unless a
 * stdinPayload was provided (long-prompt stream-json transport).
 */
function writeInitialStdin(opts: RunOptions, child: ChildProcess): void {
  if (opts.stdinPayload !== undefined) {
    try {
      child.stdin?.write(opts.stdinPayload)
      child.stdin?.end()
    } catch {
      // ignore — child may have exited already
    }
  } else if (!opts.keepStdin) {
    try {
      child.stdin?.end()
    } catch {
      // ignore — child may have exited already
    }
  }
}

function makeRefreshWatchdog(child: ChildProcess, state: RunState): () => void {
  return () => {
    if (!state.idleBudgetMs || state.idleBudgetMs <= 0 || state.settled) return
    if (state.watchdog) clearTimeout(state.watchdog)
    state.watchdog = setTimeout(() => {
      state.timedOut = true
      killTree(child)
    }, state.idleBudgetMs)
  }
}

function armTurnCap(child: ChildProcess, opts: RunOptions, state: RunState): void {
  if (opts.maxTurnMs !== undefined && opts.maxTurnMs > 0) {
    state.turnCap = setTimeout(() => {
      state.capped = true
      killTree(child)
    }, opts.maxTurnMs)
    state.turnCap.unref?.()
  }
}

function attachOutputStreams(
  child: ChildProcess,
  opts: RunOptions,
  state: RunState,
  refreshWatchdog: () => void,
): { stdoutDecoder: ReturnType<typeof makeLineDecoder>; stderrDecoder: ReturnType<typeof makeLineDecoder> } {
  // No setEncoding('utf8') on purpose: the raw bytes are decoded line by line
  // through the console code page so Windows GBK tool output survives (issue #37).
  const stdoutDecoder = makeLineDecoder(consoleOutputEncoding())
  const stderrDecoder = makeLineDecoder(consoleOutputEncoding())
  child.stdout?.on('data', (chunk: Buffer) => {
    refreshWatchdog()
    const text = stdoutDecoder.push(chunk)
    if (text === '') return
    state.stdout += text
    if (state.stdout.length > 4_000_000) state.stdout = state.stdout.slice(-2_000_000)
    state.pending += text
    let nl: number
    while ((nl = state.pending.indexOf('\n')) >= 0) {
      const line = state.pending.slice(0, nl).replace(/\r$/, '')
      state.pending = state.pending.slice(nl + 1)
      opts.onLine?.(line)
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    if (opts.stderrKeepalive) refreshWatchdog()
    const text = stderrDecoder.push(chunk)
    if (text !== '') state.stderr = (state.stderr + text).slice(-4096)
  })
  return { stdoutDecoder, stderrDecoder }
}

function awaitOutcome(
  child: ChildProcess,
  opts: RunOptions,
  state: RunState,
  decoders: { stdoutDecoder: ReturnType<typeof makeLineDecoder>; stderrDecoder: ReturnType<typeof makeLineDecoder> },
  onAbort: () => void,
  started: number,
): Promise<RunOutcome> {
  return new Promise<RunOutcome>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (state.settled) return
      state.settled = true
      if (state.watchdog) clearTimeout(state.watchdog)
      if (state.turnCap) clearTimeout(state.turnCap)
      opts.signal?.removeEventListener('abort', onAbort)
      // Flush the partial tails before settling: a final line without a
      // trailing newline must still be decoded (and parsed) exactly once.
      const stdoutTail = decoders.stdoutDecoder.flush()
      if (stdoutTail !== '') {
        state.stdout += stdoutTail
        state.pending += stdoutTail
      }
      const stderrTail = decoders.stderrDecoder.flush()
      if (stderrTail !== '') state.stderr = (state.stderr + stderrTail).slice(-4096)
      if (state.pending !== '') {
        opts.onLine?.(state.pending)
        state.pending = ''
      }
      resolve({
        code,
        signal,
        timedOut: state.timedOut,
        aborted: state.aborted,
        capped: state.capped,
        stdout: state.stdout,
        stderrTail: state.stderr,
        durationMs: Date.now() - started,
      })
    }
    child.on('exit', (code, signal) => finish(code, signal))
    child.on('error', (err) => {
      state.stderr = (state.stderr + String(err)).slice(-4096)
      finish(null, null)
    })
  })
}

export function startAgyProcess(opts: RunOptions): RunningProcess {
  const started = Date.now()
  const viaCmd = IS_WIN && isCmdShim(opts.bin)
  const isNode = IS_WIN && /\.(mjs|js|cjs)$/i.test(opts.bin)
  const env = withAgyQuietEnv(opts.env ?? process.env)
  // Issue #49: the quiet env cannot stop agy's internal `--bg-updater` child
  // (that chain allocates its own console), so pre-empt the update *check*
  // instead. Node-script spawns (the MCP bridge) never touch it.
  if (opts.preemptAutoUpdate !== false && !isNode) preemptAgyAutoUpdate(env)
  // EPIPE on stdin arrives ASYNC as an 'error' event (the try/catch around
  // write/end only guards sync throws). Without a listener Node turns it into
  // an uncaughtException and kills the whole DSH host
  // (crash: WriteWrap.onWriteComplete write EPIPE). Swallow it — a dead child
  // is handled by the exit/close handlers below.
  const child = spawnAgyChild(opts, env, viaCmd, isNode)
  const state = createRunState(opts)
  child.stdin?.on('error', () => {})
  writeInitialStdin(opts, child)

  const refreshWatchdog = makeRefreshWatchdog(child, state)
  refreshWatchdog()
  armTurnCap(child, opts, state)

  const onAbort = () => {
    state.aborted = true
    killTree(child)
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  const decoders = attachOutputStreams(child, opts, state, refreshWatchdog)
  const outcome = awaitOutcome(child, opts, state, decoders, onAbort, started)

  return {
    child,
    outcome,
    noteActivity: (budgetMs?: number) => {
      if (budgetMs !== undefined) state.idleBudgetMs = budgetMs
      refreshWatchdog()
    },
    kill: (reason) => {
      if (reason === 'timeout') state.timedOut = true
      else state.aborted = true
      if (state.watchdog) clearTimeout(state.watchdog)
      if (state.turnCap) clearTimeout(state.turnCap)
      killTree(child)
    },
  }
}

/** Simple one-shot helper for --version / models probes. */
export async function probeProcess(
  bin: string,
  args: readonly string[],
  timeoutMs = 30_000,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
  preemptAutoUpdate?: boolean,
): Promise<RunOutcome> {
  const p = startAgyProcess({ bin, args, timeoutMs, signal, env, preemptAutoUpdate })
  return p.outcome
}
