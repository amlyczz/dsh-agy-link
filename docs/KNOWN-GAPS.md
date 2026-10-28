# Known gaps

Deliberate v1 boundaries and upstream-behavior notes.

## Platform limits

- **Windows: pool credential isolation is implemented by handing the shared
  slot over (issue #45)** — agy on Windows resolves its Google credential from
  ONE process-global Credential Manager slot `gemini:antigravity`
  (go-keyring); `HOME`/`USERPROFILE`/`GEMINI_CLI_HOME` move files only. Rather
  than pretending the pool is isolated, the plugin owns the slot: the primary
  credential is kept in a durable, identity-verified store
  (`agy-accounts/.primary-credential.json`), and every run acquires the slot
  through `acquireCredentialSlot`.
  - **Same-identity runs are parallel (v0.4.60).** The installed identity is
    reference-counted: the first run on an account performs the handoff and
    keeps the mutex, later runs on the same grant join as fast leases (each
    verifies the slot still carries that grant), and runs already QUEUED for
    the slot join too — they poll every 100ms and take a lease as soon as their
    own grant is installed, so a backlog drains in parallel. The LAST holder
    persists a rotated access token and restores the primary. Only identity
    SWITCHES serialize — a switcher registers its claim BEFORE queueing, and
    new same-identity joins are refused while a different identity waits.
  - **The slot is held only until agy has READ it (v0.4.68).** Measured on agy
    1.4.3 with a live 14-minute run: print mode resolves its credential once at
    startup (`printmode.go:403 "not authenticated, trying silent auth"` →
    `:405 "silent auth succeeded"` at +3.2s) and performs zero further
    token/auth work for the rest of the run. The adapter therefore arms
    `armSlotHandoff` before the spawn and releases the lease on the child's
    FIRST output line (45s ceiling for a slow startup) instead of holding the
    machine-wide slot for the whole run. Different accounts now overlap: the
    2026-10-22 design parked two sessions for 15 minutes behind another
    project's 14-minute run; the exclusive window is now a few seconds.
    Residual exposure (unchanged in kind, now diagnosable): a mid-run 401 that
    forces a re-auth would read whatever identity is installed at that moment —
    the hand-off logs when it fires so that case is visible instead of silent.
  - `SlotUnavailableError` aborts a run instead of letting it silently spend
    the wrong account when the primary cannot be verified.
  - Remaining boundary: the mutex is **per process**, so two DSH hosts (web +
    headless) running agy at the same moment can still interleave slot writes;
    avoid driving two hosts at once.

## Credential injection: what agy actually supports (verified 2026-10-17)

The clean fix for the Windows boundary above would be per-process credential
injection (each account's HOME carries its own credential, no global slot, no
mutex, identical on macOS/Linux/Windows). It is NOT available in the current
agy build — measured, not assumed:

- **The per-HOME token file is a FALLBACK, not the source (re-measured
  2026-10-23).** With an entry in the keyring the file is ignored: a fresh
  isolated HOME containing a deliberately bogus
  `.gemini/antigravity-cli/antigravity-oauth-token` still authenticated from the
  machine keyring and completed a prompt (exit 0, `OK`), and the bogus file was
  left untouched.
  - **But with the keyring entry ABSENT, agy DOES read the per-HOME file.**
    Probe: delete `gemini:antigravity`, isolate a HOME whose token file holds
    `ya29.BOGUS_FROM_HOME_FILE`, run a prompt → `Eligibility check failed:
    UNAUTHENTICATED (code 401)`. The bogus file was the only credential in play,
    so the load path really did come from the file.
  - That is *not* enough for a lock-free design, because the keyring is
    keyring-first on the SAVE side too (`Failed to save token to keyring,
    falling back to file` — the file is only written when the keyring write
    fails). Any successful run therefore repopulates the single global entry,
    and the next spawn on a different account would inherit it. (Inferred from
    the binary's strings; not yet reproduced with a live token save.)
  - Net: per-account credential isolation is read-path only. The machine-wide
    entry still needs an owner, so identity SWITCHES stay serialized — but only
    until the child has read the credential (see above), not for the whole run.
- **No credential CLI flag**: `agy --help` exposes no `--api-key` /
  `--credential*` / `--token*` option.
- **`JETSKI_OAUTH_TOKEN` exists in the binary but is IGNORED (re-measured
  2026-10-22).** `agy.exe` contains the string pair
  `JETSKI_OAUTH_TOKEN` + `Using OAuth token from environment variable`, so it
  looked like the per-process injection route. Probing it directly: a brand-new
  isolated HOME with `JETSKI_OAUTH_TOKEN=bogus-token-should-fail` still
  completed a prompt (`exit 0`, `PROBE_OK`) — the variable is not consulted on
  this build (1.4.3), and with no per-HOME token file either, the credential
  could only have come from the machine keyring. The string belongs to another
  auth product in the same binary.
- **Documented env routes are different auth products**: `AGY_ADC_AUTH`
  (Application Default Credentials / Agent Platform), and
  `GEMINI_API_KEY` + `"modelProvider": "gemini"` in `settings.json` (the Gemini
  API, not Antigravity subscription quota).
- `AGY_ACCOUNT` selects among *plugin/manager* accounts, not CLI sign-ins.

Therefore a true fix must come from agy itself, either of:

1. **Namespace the keyring entry by HOME** — derive the go-keyring
   service/user from the resolved home (e.g. `gemini:antigravity:<hash>`), so
   an isolated HOME really is an isolated credential space. Needs a migration
   path for the existing single entry.
2. **Accept a per-process credential** — a `--credential-file` flag (or a
   documented env var) that points at the account's token document, bypassing
   the keyring entirely.

Either one retires `credential-slot.ts` and the dispatch queue; until then the
reference-counted slot is the strongest isolation the plugin can provide.

## Not forwarded to agy

- **Images as true multimodal blocks** - agy print mode (`-p`) has no image
  input flag. Since v0.2 the bridge stages DSH image attachments to a local
  media directory (`mediaDir`, TTL-swept) and references them by absolute
  path in the prompt, granting `--add-dir` so agy can view them with its own
  file/vision tools. Same approach as the pi extension.
- **DSH tools to agy (reverse MCP bridge)** - available since v0.2 behind the
  `mcpBridge` config flag (experimental): the plugin runs a loopback-only,
  token-guarded HTTP endpoint and registers a zero-dependency stdio MCP
  server in the MCP registry (`~/.gemini/config/mcp_config.json` by default,
  where `agy` 1.4+ actually reads it, merged in and restored on disable).
  Bridged calls carry caller identity via `DSH_MCP_SESSION` so identity-enforcing
  tools (such as `agent_teams`) function correctly. `run_code` and `agy_ask`
  are never bridged; `mcpToolAllowlist` restricts the set further.
  Every bridged call is audit-logged as `mcp call <tool> [<outcome>] <ms>` with
  the caller class and the failure text (never the arguments), so a failed run
  is visible in journald instead of only in transcripts.
- **DSH `send_message` from an agy child** - DSH's sub-agent runtime appends a
  footer telling the child to report with `send_message({ agent_id: <parent> })`.
  In an agy run that name resolves to agy's **own** `send_message`, which does
  not know DSH agent ids and fails with `recipient "..." not found`. The DSH
  tool itself is bridgeable - add `send_message` to `mcpToolAllowlist` and call
  it explicitly on the `dsh-tools-<port>` MCP server (agy dispatches MCP calls
  by server + tool name, so there is no collision with the native tool). The
  footer still names the native one, so an agy member should report through
  `agent_teams_send_message` (or an explicit instruction) instead. Root cause is
  upstream in `@deepseek-ai/dsh-subagent`, which assumes a DSH-native child.
- **Weekly quota auto-warmup is opt-in (v0.4.74+)** - `autoWarmup` defaults to
  `false` because the feature deliberately bypasses the CLI-first quota path and
  sends minimal `loadCodeAssist` + `generateContent` probes straight to Google's
  internal endpoints. When enabled it scans every 5 minutes, only targets rows
  whose `weeklyFraction` is explicitly >= 99.9%, records a 30-minute failure
  backoff, skips accounts in cooldown / auth quarantine, and never guesses a
  missing `cloudaicompanionProject` (no shared fallback project id). The manual
  "Warmup" buttons still work while auto mode is off.
- **Full tool args / diff cards (v0.4.28+)** - the bridge reads agy's
  conversation SQLite DB via the `sqlite3` CLI to recover arguments that
  `filterToolParameters` strips from stream-json. When `sqlite3` is missing
  or the DB is unreadable, cards fall back to stream-carried metadata only
  (no path traversal: conversation ids are whitelist-validated).
- **Structured outputs** - `agy_ask` accepts a `schema` parameter (JSON
  Schema as a JSON string) enforced via `--json-schema` since v0.2. Wiring
  schema enforcement into DSH-native tool-call generation remains future
  work: DSH `GenerateOptions` has no schema field to map onto.

## Mapping choices

- agy tool activity becomes **reasoning-block annotations**
  (`[agy tool: name] ... -> output`), not DSH tool-call blocks — there is no
  DSH-side tool round-trip to honor.
- Gemini effort suffixes fold into one base model with selectable efforts
  (`gemini-3-6-flash` + `--effort`); Claude / GPT-OSS slugs stay verbatim
  (agy rejects `--effort` for them).
- Compaction / session-title auxiliary calls run as one-shot agy turns in
  forced `plan` mode, capped at 800K chars of history.

## Upstream behaviors observed

- Permission prompts hang print mode (upstream issue #318) — hence the
  permission-mode design.
- `--sandbox` must not combine with `--dangerously-skip-permissions`
  (upstream issue #36).
- First unauthenticated call takes ~60-70s to fail (agy waits for a pasted
  code); later failures are faster.

## Fallbacks

- If `agy models` fails (signed out, old CLI), a bundled fallback catalog is
  served so the model picker is never empty; unknown ids are still accepted.
- Conversation-id discovery prefers stream-embedded ids and falls back to a
  conversations-directory snapshot diff (newest file wins; ambiguity is
  tolerated).
