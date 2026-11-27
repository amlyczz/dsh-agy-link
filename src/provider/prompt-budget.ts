// The single-message budget this plugin keeps for one prompt (issue #223).
//
// agy truncates a prompt above its ceiling silently, and its own system prompt,
// tool schemas and skills are counted against the same ceiling on top of ours.
//
// Why the default is 150,000 and not "the ceiling minus a little": the largest
// overhead measured is about 27 KB. A 180,000 B default left 12 KB of margin
// under agy's 192,000 B ceiling, so agy cut the tail of a request that was
// inside our budget — silently, and with nothing downstream to show for it.
// 150,000 leaves 42 KB. What the plugin gives up goes into its own digest /
// archive path, which is visible. A test pins that the margin exceeds the
// largest overhead measured, so raising the default back is a deliberate act.
//
// How much room agy needs still varies per installation, so the budget is a
// setting (`promptMaxBytes`); AGY_PROMPT_SAFE_BYTES is its default.
import type { PluginConfig } from '../common/types.ts'
import { AGY_PROMPT_SAFE_BYTES, AGY_SINGLE_MESSAGE_MAX_BYTES } from './prompt-text.ts'

/** Below this there is no room for a policy, an environment and a request. */
export const PROMPT_BUDGET_MIN_BYTES = 16_000

/**
 * The budget to apply for one configuration: `promptMaxBytes` when it is a
 * whole number within [PROMPT_BUDGET_MIN_BYTES, AGY_SINGLE_MESSAGE_MAX_BYTES],
 * else the shipped default. Anything else — including a value above agy's
 * ceiling, which would configure the silent truncation back in — is ignored.
 */
export function promptBudgetBytes(cfg: Partial<Pick<PluginConfig, 'promptMaxBytes'>>): number {
  const requested = cfg.promptMaxBytes
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return AGY_PROMPT_SAFE_BYTES
  const bytes = Math.floor(requested)
  return bytes >= PROMPT_BUDGET_MIN_BYTES && bytes <= AGY_SINGLE_MESSAGE_MAX_BYTES ? bytes : AGY_PROMPT_SAFE_BYTES
}
