// Plain-language translation service (spec: .spec/translation.md).
//
// One unified entry for "turn the latest agent answer into 人话": the /tsl
// command, the automatic post-turn hook and the per-message button all call
// TranslationService. The model call rides this plugin's own adapter through
// the auxiliary `purpose:'translation'` route, so account selection, quota
// cooldowns, per-account proxy/HOME and failure classification are exactly the
// ones real turns use.
//
// The implementation is split by concern under src/features/translation/:
// types.ts (vocabulary), prompt.ts (persona/prompt/chunk), session.ts (event
// log + digest), target.ts (model/effort), records.ts (durable record + cache
// key) and service.ts (orchestration). This module stays the stable host-facing
// entry point so existing `./translate.ts` imports are unchanged.
export * from '../features/translation/index.ts'
