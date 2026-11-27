// Store cleanup after a model switch: drop the same-family bindings the
// previous model left behind.
//
// Split out of prompt.ts, which sits at the 600-line budget: this is a rule
// about the binding store with no prompt assembly in it.
import { modelFamilyOf, sharedArgonPeerFamily, type ManagedAccount } from '../common/pool-types.ts'
import { resolveModelSlug } from '../host/models.ts'
import type { SessionStore } from '../host/sessions.ts'

/**
 * Drop older same-family bindings under `bindingKey:` whose model differs from
 * `currentModel` so a model switch never leaves behind an older account's
 * conversation binding to resurrect as `stickyAccount` while the new run is
 * in flight or if it fails before creating a conversation.
 */
export function clearStaleFamilyModelBindings(
  store: SessionStore,
  bindingKey: string,
  currentModel: string,
  account: ManagedAccount | undefined,
): void {
  if (bindingKey === '') return
  const targetFam = modelFamilyOf(currentModel)
  if (targetFam === 'unknown') return
  const targetSlug = resolveModelSlug(currentModel)
  const prefix = `${bindingKey}:`
  const peerFam = account !== undefined ? sharedArgonPeerFamily(account, targetFam) : undefined
  for (const [k, b] of Object.entries(store.all())) {
    if (!k.startsWith(prefix) || !b?.model) continue
    if (resolveModelSlug(b.model) === targetSlug) continue
    const bFam = modelFamilyOf(b.model)
    if (bFam === targetFam || (peerFam !== undefined && bFam === peerFam)) {
      store.delete(k)
    }
  }
}
