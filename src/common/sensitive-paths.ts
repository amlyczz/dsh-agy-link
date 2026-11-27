// Paths whose contents this plugin must never hand out — not as a media
// response, and not copied into a tool result — whatever a browser or a model
// asked for. One home for the lists, so they cannot drift apart.
//
// SENSITIVE_PATH_RE is the list the media routes have always refused (moved
// here verbatim). SECRET_FILE_RE names the other files that are credentials by
// convention; result recovery uses the union, because a recovered tool result
// is written into DSH's session log and that history can be replayed to
// whatever model the session later switches to.
export const SENSITIVE_PATH_RE = /(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|antigravity-oauth-token(?:\.bak)?|\.primary-credential\.json|\.ssh|Keychains|id_rsa|id_ed25519)(?:$|[/\\])/i

/**
 * Files that are credentials by convention: env files, netrc-style logins, key
 * material, and the stores the common CLIs and browsers keep their logins in
 * (gh, gcloud, a service account, a Firefox profile, kube and docker config).
 * Listed by their own name or path, never by a bare word such as `config`.
 */
export const SECRET_FILE_RE = /(?:^|[/\\])(?:\.envrc|\.netrc|\.npmrc|\.pgpass|\.htpasswd|(?:credentials|secrets)(?:\.(?:json|[xy]ml|ya?ml|ini|cfg|conf|toml|env|txt|db|sqlite3?))?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/\\]+\.(?:pem|key|p12|pfx|keystore|kdbx|jks)|\.git-credentials|\.gnupg|application_default_credentials\.json|service-accounts?\.(?:json|pem)|key4\.db|logins\.json|Login Data|gh[/\\]hosts\.yml|\.kube[/\\]config|\.docker[/\\]config\.json)(?:$|[/\\])/i

/** True for a path on either list. */
export function isSensitivePath(p: string): boolean {
  return SENSITIVE_PATH_RE.test(p) || SECRET_FILE_RE.test(p)
}
