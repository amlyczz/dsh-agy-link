# Security notes

Threat model and boundaries for dsh-agy-link.

## What the plugin executes

- Only the agy binary resolved from config (`agyBin`) or `PATH` /
  `~/.local/bin`. No shell interpolation: argv is passed as an array.
- Prompt text is passed as a single `-p` argument, never through a shell.
- Every spawn is its own detached process group; watchdog + abort signal
  kill the whole tree (no orphaned agy processes).

## What it can do to your machine

Whatever agy itself may do under the configured permission mode. **skip**
(`--dangerously-skip-permissions`) auto-approves ordinary AGY permission
prompts for unattended file writes and shell execution inside agy's workspace
— treat it like giving any other agent skip-permissions. It does **not** bypass
AGY hardcoded system protections. The GUI marks this mode red for a reason.

## Headless permission behavior

The bridge forwards the configured `plan` or `accept-edits` mode to the
official `agy` process; it does not answer permission prompts or bypass them.
In a headless/print invocation, agy may automatically deny a tool request.
The bridge preserves that raw tool error in run status. Such an automatic
denial is **not** evidence that a person approved or denied a prompt.
Missing-file failures are reported as `missing_file`, not as approval outcomes;
hardcoded-system-protection failures remain distinct. Raw AGY tool error text
and its error result are preserved for replay.

Do not rely on undocumented wildcard behavior for `plan` or `accept-edits`.
Use a deliberately scoped workspace and test the exact commands and agy
version you intend to operate. `skip` remains an explicit unattended-execution
choice, not a fallback applied by this plugin.

## What it never touches

- The OAuth token file (see [AUTH.md](AUTH.md)).
- DSH-side secrets, API keys, or other providers' configuration.

## Report hygiene

`/agy doctor` writes its report with redaction: Google auth URLs,
`4/...` authorization codes, `ya29.*` tokens, and `Bearer` headers are
stripped before the file hits disk. Still read it before attaching.
