// Owns the persisted list of models that must not receive `--effort` (#67).
//
// Extracted from the composition factory so one cohesive module holds the file
// path, the filter/dedupe rules, the picker notification and the live-reload
// invariant (issue #115): an operator clearing a false refusal must not need
// a DSH restart. No in-process cache — the file is tiny and read only a few
// times per turn.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface EffortUnsupportedStore {
  read(): readonly string[]
  remember(model: string): void
}

export interface EffortUnsupportedStoreDeps {
  stateDir: () => string
  notifyPicker: () => void
  log?: (msg: string) => void
}

export function createEffortUnsupportedStore(deps: EffortUnsupportedStoreDeps): EffortUnsupportedStore {
  const path = (): string => join(deps.stateDir(), 'effort-unsupported.json')

  const read = (): readonly string[] => {
    try {
      const raw = existsSync(path()) ? JSON.parse(readFileSync(path(), 'utf8')) : []
      return Array.isArray(raw)
        ? raw.filter((m): m is string => typeof m === 'string' && m.trim() !== '')
        : []
    } catch {
      return []
    }
  }

  const remember = (model: string): void => {
    const known = read()
    if (known.some((m) => m.trim().toLowerCase() === model.trim().toLowerCase())) return
    const next = [...known, model]
    try {
      mkdirSync(deps.stateDir(), { recursive: true })
      writeFileSync(path(), JSON.stringify(next, null, 2), 'utf8')
    } catch (e) {
      deps.log?.('failed to persist the effort-unsupported list: ' + String(e))
    }
    // Even a failed write must refresh the picker: in-process learning already
    // unblocks the current turn, and the UI must not show stale capabilities.
    deps.notifyPicker()
  }

  return { read, remember }
}
