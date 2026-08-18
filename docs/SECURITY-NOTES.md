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
(`--dangerously-skip-permissions`) grants unattended file writes and shell
execution inside agy's workspace — treat it like giving any other agent
skip-permissions. The GUI marks this mode red for a reason.

## What it never touches

- The OAuth token file (see [AUTH.md](AUTH.md)).
- DSH-side secrets, API keys, or other providers' configuration.

## Report hygiene

`/agy doctor` writes its report with redaction: Google auth URLs,
`4/...` authorization codes, `ya29.*` tokens, and `Bearer` headers are
stripped before the file hits disk. Still read it before attaching.
