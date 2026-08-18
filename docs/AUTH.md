# Authentication notes

The plugin never stores credentials. Login is the official agy CLI flow:

1. `/agy auth` spawns an agy probe that prints the Google consent URL.
2. You open the URL, approve, and get an authorization code.
3. `/agy auth-code <code>` (or the GUI paste box) feeds the code to the
   still-running probe on stdin; agy completes the exchange itself.

The token lands wherever agy itself puts it
(`~/.gemini/antigravity-cli/antigravity-oauth-token`). The plugin:

- never reads, copies, moves, or deletes that file;
- never logs authorization codes (the `/agy doctor` report redacts auth
  URLs, `4/...` codes, and bearer tokens before writing);
- kills the login probe (process group) on cancel/dispose.

Expiry: when the token expires mid-session, calls fail fast with an
`AUTH` error pointing at `/agy auth`; no retries burn your quota.
