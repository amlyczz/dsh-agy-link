// The single-message budget this plugin keeps for one prompt (issue #223).
//
// agy truncates a prompt above its ceiling silently, and its own system prompt,
// tool schemas and skills are counted against the same ceiling on top of ours.
// How much room that leaves varies per installation, so the budget is a setting;
// its default is the value every release has shipped with.
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
