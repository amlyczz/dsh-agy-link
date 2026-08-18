# Known gaps

Deliberate v1 boundaries and upstream-behavior notes.

## Not forwarded to agy

- **Images / attachments** — agy print mode (`-p`) accepts text only.
  Image blocks in DSH messages are skipped silently.
- **DSH tools** — agy runs its own closed tool loop; DSH tool schemas are
  not exported to it. The reverse direction (agy calling DSH tools over MCP)
  is tracked as future work.
- **Structured outputs** — `--json-schema` exists on agy but is not wired
  through DSH tool-call generation in v1.

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
