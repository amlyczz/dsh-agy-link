# Changelog

## 0.1.1 (2026-08-18)

- Fixed cordis activation in app-less profiles (optional services are now
  resolved via `ctx.get`, not `?`-suffixed inject entries).
- Added `providerRetryPolicy`: AUTH failures fail fast (no quota-burning
  retries); transient process failures retry once.

## 0.1.0 (2026-08-18)

Initial release.

- `antigravity` LLM provider route over `agy -p --output-format stream-json`.
- Streaming text / thinking / tool-activity mapping with token usage.
- Session ↔ conversation binding with history digest on first contact.
- Model discovery (`agy models`) with Gemini effort folding and fallback
  catalog.
- Google login: `/agy auth` + `/agy auth-code` + GUI panel (QR + paste).
- `/agy` command family: status / auth / auth-code / models / mode /
  effort / clear / doctor / help.
- `agy_ask` delegation tool (optional).
- Permission modes: plan / accept-edits / skip with red-flag UI on skip.
- `/agy doctor` diagnostics export with auth redaction.
- Auxiliary calls (compaction / session-title) via one-shot plan-mode turns.
