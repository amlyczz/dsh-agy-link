# Authentication & Credential Isolation

`dsh-agy-link` supports both the system-wide primary Google Antigravity sign-in and isolated multi-account pool slots (`PoolAuthFlow`). See [`.spec/credential-lifecycle.md`](../.spec/credential-lifecycle.md) for the authoritative state machine.

## Flows

1. **In-GUI / `/agy auth` PKCE OAuth (`PoolAuthFlow`)**:
   - Generates a standard PKCE (`S256`) Google OAuth consent URL using the public Antigravity desktop OAuth client and starts a loopback listener on `127.0.0.1:51121` (with manual code/URL paste fallback).
   - Exchanges the code directly with `oauth2.googleapis.com/token` (sending `agyUserAgent()` and honoring per-account proxy overrides).
   - Writes the token atomically (`0600` permissions + `.bak` recovery snapshot) in `agy`'s native JSON format (`~/.dsh/agy-accounts/<id>/.gemini/antigravity-cli/antigravity-oauth-token` for isolated pool accounts, or system `HOME` + OS keyring for the primary account).
2. **Refresh Token Import (`/agy import` / GUI Import Tab)**:
   - Exchanges an existing `refresh_token` or token JSON document, verifies account identity via `userinfo`, updates matching accounts in place (or commits a new isolated slot), and lifts stale `authRequired` / cooldown flags.

## Platform Keyring Isolation

- **macOS / Linux**: Secondary pool accounts run with isolated `HOME` directories and silent per-account login keychains (`ensureIsolatedKeychain`) so `go-keyring` never prompts or touches the user's primary login keychain.
- **Windows**: `agy` reads one machine-wide Credential Manager entry (`gemini:antigravity`). `acquireCredentialSlot` serializes cross-identity handoffs (with in-process refcounting + cross-process lockfile), verifies grant fingerprints (`sameCredentialGrant`), and restores the verified primary credential (`.primary-credential.json`) after startup read.

## Hygiene & Anti-False-Quarantine

- Network/proxy/HTTP2/keyring-timeout blips (`looksLikeNetworkError`, `looksLikeAuthVerificationJitter`) are classified as `NETWORK`, never `AUTH`.
- Non-authoritative CLI sign-out banners require `AUTH_CONFIRM_STRIKES = 2` consecutive confirmations before setting `authRequired`.
- Terminal `TOS_VIOLATION` suspensions quarantine only the affected account and halt automatic failover to prevent IP-correlated ban sweeps.
- `/agy doctor` redacts OAuth URLs, `4/...` authorization codes, `ya29.*` access tokens, `1//...` refresh tokens, JWTs, API keys, and proxy credentials before writing to disk.
