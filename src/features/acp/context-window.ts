// Real context windows, learned from the ACP stream.
//
// ACA/P's `usage_update` carries `{ used, size }` where `size` is the window the
// running model was actually started with. The bridge used to ignore `size`
// entirely and report `cfg.contextWindowDefault` for every model, so agy's
// 200k-class models were shown against a 1M denominator (and vice versa) — the
// context ring was decorative, not truthful (issue #2 of the orchestration work).
//
// We keep the learned numbers per model slug, in memory and on disk, so a model
// only has to be seen once. Never touched: the usage counters. #158 proved that
// writing ACP's cumulative `used` into usage destroys cache-hit accounting; this
// module only ever supplies the denominator.
import { readFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { defaultPoolDir, writeJsonAtomic } from '../../domain/accounts/paths.ts'

/** Below this a number is a token count, not a window; above it, not a window either. */
const MIN_PLAUSIBLE_WINDOW = 8_000
const MAX_PLAUSIBLE_WINDOW = 20_000_000
const SAVE_DEBOUNCE_MS = 1_000

const windows = new Map<string, number>()
let loaded = false
let saveTimer: NodeJS.Timeout | null = null

function storeFile(): string {
  // `<state>/agy-link/context-windows.json`, next to the account pool.
  return join(dirname(defaultPoolDir(homedir())), 'agy-link', 'context-windows.json')
}

function loadOnce(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = JSON.parse(readFileSync(storeFile(), 'utf8')) as unknown
    if (raw === null || typeof raw !== 'object') return
    for (const [model, size] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof size === 'number' && size >= MIN_PLAUSIBLE_WINDOW && size <= MAX_PLAUSIBLE_WINDOW) {
        windows.set(model, Math.round(size))
      }
    }
  } catch {
    // No file yet, or an unreadable one: learning simply starts empty.
  }
}

function scheduleSave(): void {
  if (saveTimer !== null) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    persist()
  }, SAVE_DEBOUNCE_MS)
  saveTimer.unref?.()
}

function persist(): void {
  try {
    const file = storeFile()
    mkdirSync(dirname(file), { recursive: true })
    writeJsonAtomic(file, JSON.stringify(Object.fromEntries(windows), null, 2))
  } catch {
    // Learned windows are an optimization; never fail a turn over them.
  }
}

/**
 * Record the window one ACP `usage_update` reported for `model`.
 * Returns true when this taught us something new (callers may log it).
 */
export function noteContextWindow(model: string, size: number | undefined): boolean {
  const id = typeof model === 'string' ? model.trim() : ''
  if (id === '' || size === undefined) return false
  if (!Number.isFinite(size) || size < MIN_PLAUSIBLE_WINDOW || size > MAX_PLAUSIBLE_WINDOW) return false
  loadOnce()
  const rounded = Math.round(size)
  if (windows.get(id) === rounded) return false
  windows.set(id, rounded)
  scheduleSave()
  return true
}

/** The window learned for `model` (exact slug, then a loose match), if any. */
export function learnedContextWindow(model: string): number | undefined {
  const id = typeof model === 'string' ? model.trim() : ''
  if (id === '') return undefined
  loadOnce()
  const exact = windows.get(id)
  if (exact !== undefined) return exact
  // Session slugs and catalog ids can drift in case or effort suffix
  // (`gemini-4-hydrogen-high` vs `gemini-4-hydrogen-high-2`): accept a prefix
  // match in either direction but only when it is unambiguous.
  let match: number | undefined
  for (const [key, size] of windows) {
    const a = key.toLowerCase()
    const b = id.toLowerCase()
    if (a.startsWith(b) || b.startsWith(a)) {
      if (match !== undefined && match !== size) return undefined
      match = size
    }
  }
  return match
}

/** Test-only: forget everything learned in this process. */
export function resetLearnedContextWindowsForTests(): void {
  windows.clear()
  loaded = true
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
}