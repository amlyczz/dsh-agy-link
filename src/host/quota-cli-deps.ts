import type { ManagedAccount } from '../common/pool-types.ts'
import { defaultSlotIo, readPrimaryCredential } from './credential-slot.ts'
import { installSlotOrThrow } from '../domain/credentials/lease.ts'

// The CLI quota read has to leave the credential in the safety window before it
// spawns agy (see src/features/quota/cli-token.ts). On Windows agy authenticates
// from Credential Manager, so the refreshed token document also has to be
// installed into the slot — and that install must happen inside the
// credentialSlotMutex the read already holds. The host supplies the write; unit
// tests leave it unwired, so no test can touch the real machine slot.
export interface CliQuotaDeps {
  bin: () => string | null
  viaCli: () => boolean
  preemptAutoUpdate: () => boolean
  syncSlot?: () => boolean
  log: (msg: string) => void
}

export function buildCliQuotaDeps(opts: {
  bin: () => string | null
  viaCli: () => boolean
  preemptAutoUpdate: () => boolean
  poolDir: () => string
  log: (msg: string) => void
}): CliQuotaDeps {
  const base = {
    bin: opts.bin,
    viaCli: opts.viaCli,
    preemptAutoUpdate: opts.preemptAutoUpdate,
    log: opts.log,
  }
  // Other platforms have no slot: agy reads the token document itself, which the
  // refresh already rewrote.
  if (process.platform !== 'win32') return base
  return {
    ...base,
    syncSlot: () => {
      const raw = readPrimaryCredential(opts.poolDir())?.raw
      if (raw === undefined || raw === '') return false
      try {
        installSlotOrThrow(defaultSlotIo(), raw, opts.log, 'quota token refresh')
        return true
      } catch {
        return false
      }
    },
  }
}

export type { ManagedAccount }
