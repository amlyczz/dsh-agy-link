// agy spawn environment helpers: account isolation, proxy env and quiet env.
//
// MOVED VERBATIM from src/host/runner.ts (Phase 5h). Keys and precedence are
// unchanged — the Windows USERPROFILE / HOMEDRIVE+HOMEPATH handling and the
// Linux D-Bus block are load-bearing for account isolation.
import { join } from 'node:path'
import { homedir } from 'node:os'

const IS_WIN = process.platform === 'win32'

/**
 * Environment that relocates the agy home directory for account isolation.
 * On Unix, HOME suffices. On Windows, libuv (Node) and Go both resolve the
 * home directory from USERPROFILE / HOMEDRIVE+HOMEPATH and IGNORE $HOME, so
 * omitting them silently breaks account isolation (every account would share
 * the real user profile). GEMINI_CLI_HOME is honored by the agy CLI on all
 * platforms for its .gemini dir.
 */
/**
 * Linux/Unix: env that points D-Bus at a nonexistent, per-account PRIVATE path
 * so agy cannot fall through to the desktop Secret Service (gnome-keyring) and
 * read the primary account's token. The path lives INSIDE the isolated home:
 * a shared world-writable path (e.g. /tmp/…) could be hijacked by another local
 * user binding a fake bus socket there and MITM-ing the Secret Service lookup.
 */
export function linuxDbusDisabledEnv(dir: string): { DBUS_SESSION_BUS_ADDRESS: string } {
  return { DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + join(dir, '.no-dbus-session') }
}

export function isolatedHomeEnv(dir: string): Record<string, string> {
  const geminiDir = join(dir, '.gemini')
  const env: Record<string, string> = {
    HOME: dir,
    GEMINI_CLI_HOME: geminiDir,
    ANTIGRAVITY_GEMINI_DIR: geminiDir,
    ANTIGRAVITY_APP_DATA_DIR: join(geminiDir, 'antigravity-cli'),
    DSH_STATE_DIR: process.env.DSH_STATE_DIR || join(homedir(), '.dsh'),
  }
  if (IS_WIN) {
    env.USERPROFILE = dir
    const m = dir.match(/^([A-Za-z]:)(.*)$/)
    if (m) {
      env.HOMEDRIVE = m[1] as string
      env.HOMEPATH = m[2] as string
    }
  } else if (process.platform === 'linux') {
    // Linux/Unix: block the user-wide D-Bus Secret Service session bus so agy
    // is forced to read the isolated per-account token file instead of falling
    // through to the desktop's gnome-keyring / secret-tool (which holds the primary).
    Object.assign(env, linuxDbusDisabledEnv(dir))
  }
  return env
}

/**
 * Standard proxy env block for one proxy URL. agy is a Go binary and only
 * honors HTTP(S)_PROXY / ALL_PROXY; GUI hosts don't inherit shell proxy
 * env, so the plugin injects this explicitly (global config or per-account).
 * Exported for tests.
 */
export function proxyEnvFor(proxyUrl: string | undefined | null): Record<string, string> {
  const url = proxyUrl?.trim()
  if (!url) return {}
  return {
    ALL_PROXY: url,
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    all_proxy: url,
    https_proxy: url,
    http_proxy: url,
  }
}

/**
 * Quiet env for every agy spawn (issue #23).
 *
 * agy.exe itself creates a visible conhost on Windows — especially via its
 * `--bg-updater` auto-update child chain — even when the parent spawn used
 * `windowsHide: true`. Both switches are present in the official binary.
 * Existing values win so operators can opt out (`=0`).
 */
export function withAgyQuietEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    AGY_CLI_DISABLE_AUTO_UPDATE: env.AGY_CLI_DISABLE_AUTO_UPDATE ?? '1',
    AGY_CLI_INTERACTIVE_HEADLESS: env.AGY_CLI_INTERACTIVE_HEADLESS ?? '1',
    AGY_CLI_NONINTERACTIVE_HEADLESS: env.AGY_CLI_NONINTERACTIVE_HEADLESS ?? '1',
    BROWSER: env.BROWSER ?? 'none',
    CI: env.CI ?? '1',
  }
}

/**
 * Environment for spawning a script through `process.execPath`.
 *
 * In the packaged desktop host `process.execPath` is the **Electron binary**,
 * not node: without this flag the child would boot a second GUI instance
 * instead of executing the script. Plain node ignores the variable, so the
 * POSIX/test paths are unaffected.
 */
export function nodeScriptEnv<T extends object>(env: T): T & { ELECTRON_RUN_AS_NODE: string } {
  return { ...env, ELECTRON_RUN_AS_NODE: '1' }
}