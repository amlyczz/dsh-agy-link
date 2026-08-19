# Changelog

## 0.2.0 (2026-08-19)

- Multimodal (path-based): DSH image attachments are staged to a local media
  directory (config `mediaDir`, TTL sweep `mediaTtlMs`, caps `mediaMaxBytes` /
  `mediaMaxImages`) and referenced by absolute path in the agy prompt with
  `--add-dir` - agy views them with its own tools. Env: `DSH_AGY_MEDIA_DIR`,
  `DSH_AGY_MEDIA_TTL_MS`.
- `agy_ask` gains `readPaths` (inline text files into the one-shot prompt;
  binaries skipped with a note) and `schema` (JSON Schema enforced via
  `--json-schema`).
- MCP reverse bridge (experimental, `mcpBridge: true` / `DSH_AGY_MCP_BRIDGE=1`):
  agy can call DSH-side tools through a loopback, token-guarded endpoint plus a
  zero-dep stdio MCP server merged into the workspace `.mcp.json`.
  `mcpToolAllowlist` restricts the exposed set; `run_code` / `agy_ask` are
  never bridged.
- Abort semantics locked by a regression test: everything the model produced
  before the caller hits stop is preserved (open block closed, then failure
  finish).
- 12 new tests (51 total).

## 0.1.5 (2026-08-19)

- README restructured into a single bilingual page: Chinese first, then
  English (README.zh.md removed; package files list updated).
- Releases now publish to npm automatically (NPM_TOKEN secret configured).

