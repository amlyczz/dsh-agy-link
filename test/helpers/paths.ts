// One place for the test tree's path math.
//
// Every test used to recompute the repo root with `new URL('../..', import.meta.url)`
// or `join(fileURLToPath(import.meta.url), '..', '..')`. That silently breaks the
// moment a test file moves to another directory depth — which is exactly what the
// 2026-11-25 domain re-partition did (85 failures from one moved fixture path).
// Import the constants below instead of counting `..` segments.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `test/helpers/` */
const HERE = dirname(fileURLToPath(import.meta.url))

/** `test/` — the root of the test tree. */
export const TEST_ROOT = dirname(HERE)

/** Repository root (the package root). */
export const REPO_ROOT = dirname(TEST_ROOT)

/** `test/fixtures/` — recorded/replay data and fake binaries. */
export const FIXTURES_DIR = join(TEST_ROOT, 'fixtures')

/** The shared fake `agy` executable used by adapter/ACP/oneshot suites. */
export const FAKE_AGY = join(TEST_ROOT, 'fake-agy.mjs')
