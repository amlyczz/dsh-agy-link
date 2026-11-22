// Duplicate-identity detection for the account pool.
//
// The same Google account can end up in the pool twice: once as the primary
// (system sign-in) and once as an isolated copy added later — or twice as
// isolated copies after a re-add. Both then share ONE Google quota and one
// credential identity, so the pool over-reports capacity and the Windows
// credential slot keeps being rewritten between two rows that are the same
// person. Nothing here mutates state; it only names the duplicates so the UI,
// the doctor report and boot hygiene can point at them.
import type { ManagedAccount } from './pool-types.ts'

export function normalizeAccountEmail(email: string | undefined): string {
  return (email ?? '').trim().toLowerCase()
}

export interface DuplicateEmailGroup {
  email: string
  ids: string[]
  aliases: string[]
}

/** Groups of pool rows that resolve to the same Google account. */
export function findDuplicateEmailGroups(accounts: readonly ManagedAccount[]): DuplicateEmailGroup[] {
  const byEmail = new Map<string, { ids: string[]; aliases: string[] }>()
  for (const acc of accounts) {
    const email = normalizeAccountEmail(acc.email)
    if (email === '') continue
    const bucket = byEmail.get(email)
    const alias = acc.alias !== undefined && acc.alias !== '' ? acc.alias : acc.id
    if (bucket === undefined) byEmail.set(email, { ids: [acc.id], aliases: [alias] })
    else {
      bucket.ids.push(acc.id)
      bucket.aliases.push(alias)
    }
  }
  const out: DuplicateEmailGroup[] = []
  for (const [email, bucket] of byEmail) {
    if (bucket.ids.length > 1) out.push({ email, ids: bucket.ids, aliases: bucket.aliases })
  }
  return out
}

/** Ids of every account that shares its Google account with another row. */
export function duplicateAccountIds(accounts: readonly ManagedAccount[]): Set<string> {
  const ids = new Set<string>()
  for (const group of findDuplicateEmailGroups(accounts)) {
    for (const id of group.ids) ids.add(id)
  }
  return ids
}

/**
 * The OTHER aliases sharing this account's email — what the badge tooltip shows
 * ("also added as …"). Empty when the account is unique.
 */
export function siblingAliases(acc: ManagedAccount, accounts: readonly ManagedAccount[]): string[] {
  const email = normalizeAccountEmail(acc.email)
  if (email === '') return []
  const self = acc.alias !== undefined && acc.alias !== '' ? acc.alias : acc.id
  return accounts
    .filter((other) => other.id !== acc.id && normalizeAccountEmail(other.email) === email)
    .map((other) => (other.alias !== undefined && other.alias !== '' ? other.alias : other.id))
    .filter((alias) => alias !== self)
}
