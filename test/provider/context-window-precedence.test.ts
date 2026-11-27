// The context window advertised to DSH decides when a session compacts, so who
// outranks whom matters:
//
//   the user's own `contextWindowDefault`  >  a window agy reported for this
//   model  >  the shipped default (one number for every agy model).
//
// PR #227 taught the bridge to read the real window from ACP `usage_update.size`
// — the right idea: a 200k-class model shown against a 1M denominator makes the
// context ring decorative. As merged, though, a learned window also silently
// replaced a `contextWindowDefault` the user had set by hand (the documented
// workaround of issue #223 is exactly such a setting).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig } from '../../src/common/types.ts'
import { noteContextWindow, resetLearnedContextWindowsForTests } from '../../src/features/acp/context-window.ts'
import { makeAdapter } from '../helpers/adapter-fixtures.ts'

const SHIPPED = defaultConfig().contextWindowDefault

async function advertised(cfg: Record<string, unknown>, model = 'gemini-4-hydrogen'): Promise<number | undefined> {
  const { adapter } = makeAdapter(cfg)
  return (await adapter.resolveModel('antigravity', model))?.context?.contextWindow
}

test('learned window < user setting: agy reports the truth only while the configured window is the shipped default', async (t) => {
  // The learner persists what it saw; keep that out of the real state directory.
  const home = mkdtempSync(join(tmpdir(), 'agy-ctxwin-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  resetLearnedContextWindowsForTests()
  t.after(() => {
    resetLearnedContextWindowsForTests()
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  // Nothing learned yet: ADR-013's uniform default stands.
  assert.equal(await advertised({}), SHIPPED)

  assert.equal(noteContextWindow('gemini-4-hydrogen', 262_144), true)
  // Shipped default: one number for every agy model is not the truth for this one.
  assert.equal(await advertised({}), 262_144, 'a learned window replaces the shipped default')
  // A different model keeps the default: the learner is per slug.
  assert.equal(await advertised({}, 'claude-sonnet-5-5'), SHIPPED)

  // The user set the window by hand: that outranks what was learned.
  assert.equal(await advertised({ contextWindowDefault: 131_072 }), 131_072, 'an explicit setting wins')
  assert.equal(await advertised({ contextWindowDefault: 1_000_000 }), 1_000_000, 'even when it is larger')
})
