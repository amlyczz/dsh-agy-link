#!/usr/bin/env node
/**
 * publish-retry.mjs — publish this package to npm with bounded retries for
 * transient registry failures, then VERIFY the version is actually readable.
 *
 * Why: v0.6.19 and v0.6.20 both got GitHub Releases whose Publish runs died on
 * a single transient `404 Not Found - PUT https://registry.npmjs.org/...`.
 * The release stayed published and green-looking, but those versions were
 * never installable from npm (404), and nothing in the workflow noticed.
 * v0.6.21 succeeded with the same token minutes later.
 *
 * This script:
 *   1. skips a version already present in the registry (idempotent re-runs),
 *   2. retries only *transient* errors with a short backoff,
 *   3. fails immediately on fatal errors (bad auth / bad version),
 *   4. after a successful publish, polls `npm view <name>@<version> version`
 *      for a bounded window. Registry propagation has taken 2-6 minutes in
 *      practice, so an unresolved probe is a WARNING, not a failed run: the
 *      authoritative signal is `npm publish` exiting 0. Set
 *      PUBLISH_STRICT_VERIFY=1 to make an unresolved probe fatal (e.g. canary).
 *
 * Kept dependency-free and injectable so it has real unit tests.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/** Registry-side hiccups worth retrying; auth/validation errors are not. */
const FATAL = [/ENEEDAUTH/, /E403/, /403 Forbidden/, /E401/, /401 Unauthorized/, /EBADSEMVER/, /EINVALIDTAGNAME/, /EPUBLISHCONFLICT/, /EACCES/, /ENOTDIR/, /EISDIR/, /EJSONPARSE/]
const TRANSIENT = [/E404/, /\b404\b/, /404 Not Found/, /ETIMEDOUT/, /ECONNRESET/, /ECONNREFUSED/, /EAI_AGAIN/, /ENOTFOUND/, /EPIPE/, /socket hang up/i, /fetch failed/i, /\b5\d\d\b/, /internal server error/i, /service unavailable/i]

export function isTransientPublishError(text) {
  if (FATAL.some((re) => re.test(text))) return false
  return TRANSIENT.some((re) => re.test(text))
}

function defaultRun(bin, args) {
  const r = spawnSync(bin, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * @param {object} o
 * @param {{name:string,version:string}} [o.pkg] - defaults to package.json (name/version)
 * @param {(bin:string,args:string[])=>{status:number,stdout:string,stderr:string}} [o.run]
 * @param {(ms:number)=>Promise<void>} [o.sleep]
 * @param {number} [o.attempts] - max publish attempts
 * @param {number[]} [o.delays] - backoff between attempts (ms)
 * @param {number} [o.verifyAttempts] - registry probes after a successful publish
 * @param {number} [o.verifyDelayMs]
 * @param {(msg:string)=>void} [o.log]
 */
export async function publishWithRetry(o = {}) {
  const pkg = o.pkg ?? JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
  const spec = pkg.name + '@' + pkg.version
  const run = o.run ?? defaultRun
  const sleep = o.sleep ?? defaultSleep
  const log = o.log ?? ((m) => console.log('[publish-retry] ' + m))
  const attempts = o.attempts ?? 3
  const delays = o.delays ?? [5000, 15000, 30000]
  const verifyAttempts = o.verifyAttempts ?? 12
  const verifyDelayMs = o.verifyDelayMs ?? 10_000
  const strictVerify = o.strictVerify ?? (process.env.PUBLISH_STRICT_VERIFY === '1')

  const probe = () => {
    const r = run('npm', ['view', spec, 'version'])
    return r.status === 0 && r.stdout.trim() === pkg.version
  }
  if (probe()) {
    log(spec + ' is already on the registry — nothing to publish')
    return { published: false, attempts: 0 }
  }

  let lastError = ''
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const r = run('npm', ['publish', '--access', 'public'])
    const out = (r.stdout ?? '') + '\n' + (r.stderr ?? '')
    if (r.status === 0) {
      // A publish that exits 0 is NOT proof: the registry can still 404 for
      // several seconds (or the request may have been dropped silently).
      for (let v = 1; v <= verifyAttempts; v++) {
        if (probe()) {
          log(spec + ' published and verified on the registry')
          return { published: true, attempts: attempt, verified: true }
        }
        if (v < verifyAttempts) {
          log(spec + ' not readable yet (probe ' + v + '/' + verifyAttempts + ') — waiting')
          await sleep(verifyDelayMs)
        }
      }
      const warning = 'npm publish exited 0, but ' + spec + ' was still not readable from the registry after ' + verifyAttempts + ' probes (propagation can take minutes)'
      if (strictVerify) throw new Error(warning)
      log('WARNING: ' + warning)
      return { published: true, attempts: attempt, verified: false }
    }
    lastError = out.trim()
    log('publish attempt ' + attempt + '/' + attempts + ' failed: ' + lastError.split('\n').slice(-3).join(' | '))
    if (!isTransientPublishError(lastError)) {
      throw new Error('npm publish failed with a non-transient error:\n' + lastError)
    }
    // A 404 can also mean "it actually landed, but the response was lost".
    if (attempt < attempts) {
      await sleep(delays[Math.min(attempt - 1, delays.length - 1)])
      if (probe()) {
        log(spec + ' found on the registry after a failed publish response')
        return { published: true, attempts: attempt, verified: true }
      }
    }
  }
  throw new Error('npm publish failed after ' + attempts + ' attempts; last error:\n' + lastError)
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
if (isMain) {
  publishWithRetry().then(
    (r) => { if (!r.published) process.stdout.write('[publish-retry] already published\n') },
    (e) => { console.error('[publish-retry] FAILED: ' + (e?.message ?? String(e))); process.exitCode = 1 },
  )
}
