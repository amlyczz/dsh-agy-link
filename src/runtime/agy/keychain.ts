// macOS isolated-keychain provisioning / repair and interactive terminals.
//
// MOVED VERBATIM from src/host/runner.ts (Phase 5h). Platform branches, the
// `security` command lines and the terminal-emulator candidate order are
// unchanged.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * macOS: an isolated HOME has no login keychain, so the first keyring write
 * makes the Security framework pop the "create login keychain" password
 * dialog (right system.keychain.create.loginkc) on every token refresh.
 * Provisioning a throwaway per-account keychain under that HOME keeps keyring
 * writes silent. Never modifies the user's global default-keychain.
 * No-op on other platforms or when already provisioned. Never throws.
 * Exported for tests.
 */
export function ensureIsolatedKeychain(
  dir: string,
  platform: string = process.platform,
  run: (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => unknown = (file, args, env) =>
    execFileSync(file, args, { stdio: 'ignore', env, timeout: 10_000 }),
): boolean {
  if (platform !== 'darwin') return false
  if (dir === '') return false
  const kc = join(dir, 'Library', 'Keychains', 'login.keychain-db')
  if (existsSync(kc)) return false
  try {
    const env = { ...process.env, HOME: dir }
    mkdirSync(join(dir, 'Library', 'Keychains'), { recursive: true })
    run('security', ['create-keychain', '-p', '', kc], env)
    run('security', ['set-keychain-settings', kc], env)
    return true
  } catch {
    return false
  }
}

/**
 * Purge any stale locked keychain from an isolated account HOME directory.
 * Keychains from older versions (v0.4.41-v0.4.44) were provisioned with
 * ephemeral random passwords that cannot be unlocked with an empty password,
 * causing repeated modal password dialogs from macOS SecurityAgent.
 * We test whether the keychain settings can be updated silently without prompt.
 * If setting settings fails, the file is un-unlockable or corrupted, so it is
 * unregistered and purged so ensureIsolatedKeychain can cleanly re-provision it.
 */
export function purgeStaleIsolatedKeychain(
  dir: string,
  platform: string = process.platform,
  run: (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => unknown = (file, args, env) =>
    execFileSync(file, args, { stdio: 'ignore', env, timeout: 5000 }),
): boolean {
  if (platform !== 'darwin') return false
  if (dir === '') return false
  const kc = join(dir, 'Library', 'Keychains', 'login.keychain-db')
  if (!existsSync(kc)) return false
  const env = { ...process.env, HOME: dir }
  try {
    // Attempt silent settings update without prompt
    run('security', ['set-keychain-settings', kc], env)
    return false // healthy and accessible, not stale
  } catch {
    // Failed to update settings — locked with unknown passphrase or corrupted
    try {
      run('security', ['delete-keychain', kc], env)
    } catch {
      // ignore
    }
    try {
      rmSync(kc, { force: true })
    } catch {
      // ignore
    }
    return true
  }
}

/**
 * macOS: Repair hijacked user-level keychain configuration.
 *
 * Versions prior to v0.4.49 set `security default-keychain -s <isolated-kc>`,
 * redirecting the user's desktop session default and login keychain into an
 * account-specific folder under ~/.dsh/agy-accounts/.
 *
 * This function detects if default-keychain, login-keychain, or the search list
 * (`list-keychains -d user`) point to any path containing `agy-accounts` or `.dsh`,
 * and restores them to the user's real login keychain (`~/Library/Keychains/login.keychain-db`).
 */
export function repairMacSystemKeychain(
  userHome: string = homedir(),
  platform: string = process.platform,
  run: (file: string, args: readonly string[], env?: NodeJS.ProcessEnv) => string = (file, args, env) =>
    execFileSync(file, args, { encoding: 'utf8', env: env ?? process.env, timeout: 5000 }),
): boolean {
  if (platform !== 'darwin') return false
  if (!userHome) return false

  let repaired = false
  const realCandidates = [
    join(userHome, 'Library', 'Keychains', 'login.keychain-db'),
    join(userHome, 'Library', 'Keychains', 'login.keychain'),
  ]
  const realKc = realCandidates.find((p) => existsSync(p))
  if (!realKc) return false

  const isIsolatedPath = (p: string) => /[\\/]\.dsh[\\/]agy-accounts[\\/]/i.test(p)
  const env = { ...process.env, HOME: userHome }

  try {
    const def = run('security', ['default-keychain'], env).trim().replace(/^"|"$/g, '')
    if (isIsolatedPath(def)) {
      run('security', ['default-keychain', '-s', realKc], env)
      repaired = true
    }
  } catch {
    // ignore
  }

  try {
    const loginkc = run('security', ['login-keychain'], env).trim().replace(/^"|"$/g, '')
    if (isIsolatedPath(loginkc)) {
      run('security', ['login-keychain', '-s', realKc], env)
      repaired = true
    }
  } catch {
    // ignore
  }

  try {
    const rawList = run('security', ['list-keychains', '-d', 'user'], env)
    const entries = rawList
      .split('\n')
      .map((l) => l.trim().replace(/^"|"$/g, ''))
      .filter(Boolean)
    const hasTainted = entries.some(isIsolatedPath)
    const hasReal = entries.includes(realKc)
    if (hasTainted || !hasReal) {
      const cleaned = entries.filter((p) => !isIsolatedPath(p))
      if (!cleaned.includes(realKc)) cleaned.unshift(realKc)
      const sysKc = '/Library/Keychains/System.keychain'
      if (!cleaned.includes(sysKc) && existsSync(sysKc)) {
        cleaned.push(sysKc)
      }
      run('security', ['list-keychains', '-d', 'user', '-s', ...cleaned], env)
      repaired = true
    }
  } catch {
    // ignore
  }

  return repaired
}
