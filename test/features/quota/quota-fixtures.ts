// Shared fixtures for the quota suites.
//
// Every quota test needs the same three things before it can say anything about
// quota behaviour: a throwaway HOME with a fresh account pool in it, a valid
// on-disk `agy` token for an isolated account, and an agy log file for the
// email-detection paths. Building those inline in each test made the files long
// and, worse, let two tests drift into subtly different on-disk shapes.
//
// Only fixtures live here. Stub `QuotaService` subclasses stay inline in the
// test that needs them: each one encodes that test's specific backend answer,
// and hoisting them would hide which endpoint returned what.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPoolManager } from '../../../src/host/pool.ts'

/** The directory agy keeps its CLI credentials in, under a HOME. */
export function agyCliDir(homeDir: string): string {
  return join(homeDir, '.gemini', 'antigravity-cli')
}

/**
 * A throwaway HOME plus an account pool rooted at it.
 *
 * `dir` is also the pool directory, so tests that need a log file or a durable
 * primary credential write it under the same HOME the pool reads.
 */
export function makeTempPool(prefix: string): { dir: string; pool: AccountPoolManager } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, pool: new AccountPoolManager(dir) }
}

/**
 * Write the token file agy itself would leave in an isolated account's HOME.
 *
 * Defaults to a token that is valid for an hour, which is what the quota paths
 * treat as "no refresh needed" — tests then exercise the read path rather than
 * the OAuth refresh flow. Returns the file path for assertions.
 */
export function writeAccountToken(
  accountDir: string,
  accessToken: string,
  opts: { refreshToken?: string; expiryMs?: number } = {},
): string {
  const cliDir = agyCliDir(accountDir)
  mkdirSync(cliDir, { recursive: true })
  const file = join(cliDir, 'antigravity-oauth-token')
  const doc: Record<string, string | number> = { access_token: accessToken }
  if (opts.refreshToken !== undefined) doc.refresh_token = opts.refreshToken
  doc.expiry = opts.expiryMs ?? Date.now() + 3600_000
  writeFileSync(file, JSON.stringify(doc), 'utf8')
  return file
}

/**
 * Write one agy CLI log under `homeDir/.gemini/antigravity-cli/log/`.
 *
 * Logs are append-ordered, so the caller controls which login appears last —
 * that ordering is the whole point of the email-detection assertions.
 */
export function writeAgyLog(homeDir: string, fileName: string, content: string): string {
  const logDir = join(agyCliDir(homeDir), 'log')
  mkdirSync(logDir, { recursive: true })
  const file = join(logDir, fileName)
  writeFileSync(file, content, 'utf8')
  return file
}
