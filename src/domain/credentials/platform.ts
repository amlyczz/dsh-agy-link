// Platform seam for the credential-slot state machine.
//
// The state machine, locking and handoff live in this domain folder and never
// import wincred / keychain / secret-service code directly. Everything the
// host must provide is one small interface, implemented by the host facade's
// `defaultSlotIo()` (backed by the Windows Credential Manager and the OAuth
// identity probe) or injected by tests.
//
// `SlotIo` is kept as an alias: it is the historical name used by callers and
// tests, and the shape is identical.
export interface CredentialPlatform {
  platform: NodeJS.Platform
  readSlot(): string | null
  writeSlot(raw: string): boolean
  identify(raw: string | null | undefined, proxyUrl?: string): Promise<string | undefined>
}

/** Historical name for {@link CredentialPlatform}; preserved for compatibility. */
export type SlotIo = CredentialPlatform