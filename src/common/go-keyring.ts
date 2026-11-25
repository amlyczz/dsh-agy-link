// `go-keyring` payload unwrapping — the ONE place that knows the envelope.
//
// Go's go-keyring library (used by agy and by the Antigravity desktop app)
// stores some secrets with a `go-keyring-base64:` prefix in front of a
// base64-encoded JSON document. Readers on every platform must strip it before
// JSON.parse, otherwise the credential looks like "invalid JSON" and the caller
// silently falls back to a stale source (issue #203: on Windows the desktop
// app's slot entry was rejected, so respectExternalSignIn could not protect it).
//
// Lives in common/ because both runtime/ (keychain readers) and
// domain/credentials (document parsing) depend on it, and domain must not
// depend on runtime.

export const GO_KEYRING_PREFIX = 'go-keyring-base64:'

/**
 * Unwrap a `go-keyring` payload (`go-keyring-base64:<b64>` or a raw JSON string)
 * into UTF-8 JSON text. Trims surrounding whitespace for both forms.
 *
 * NB: an invalid base64 tail still decodes to *some* bytes (Buffer is
 * permissive); callers that need soundness must run `JSON.parse` on the
 * result, which is exactly what `parseCredentialDoc` does.
 */
export function unwrapGoKeyringPayload(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith(GO_KEYRING_PREFIX)) {
    return Buffer.from(trimmed.slice(GO_KEYRING_PREFIX.length), 'base64').toString('utf8')
  }
  return trimmed
}

/** Wrap raw JSON text the way AGY's desktop build stores it (round-trip tests). */
export function wrapGoKeyringPayload(rawJson: string): string {
  return GO_KEYRING_PREFIX + Buffer.from(rawJson, 'utf8').toString('base64')
}