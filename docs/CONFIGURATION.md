# Configuration reference

Resolution order (highest first): `DSH_AGY_*` environment variable → runtime overrides written by `/agy` (`.dsh/agy-link/runtime-overrides.json`) → plugin entry config in the DSH profile → defaults below.

| Legend | Meaning |
| --- | --- |
| `—` | No environment variable; set it through the plugin config |

## Basics

| Key | Environment | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `DSH_AGY_ENABLED` | `true` | Master switch |
| `agyBin` | `DSH_AGY_BIN` | `''` (auto-detect) | Path to the `agy` binary |
| `extraArgs` | `DSH_AGY_EXTRA_ARGS` | `[]` | Extra argv appended to every `agy` spawn (space separated in the env var) |
| `permissionMode` | `DSH_AGY_MODE` | `skip` | `skip` / `plan` / `accept-edits`. `DSH_AGY_SKIP_PERMISSIONS` maps `true`→`skip`, `false`→`plan` |
| `workspaceRoot` | `DSH_AGY_WORKSPACE_ROOT` | `''` (session cwd) | Workspace root passed to agy |

## Models and effort

| Key | Environment | Default | Description |
| --- | --- | --- | --- |
| `defaultModel` | `DSH_AGY_DEFAULT_MODEL` | `''` (agy default) | Initial model slug |
| `defaultEffort` | `DSH_AGY_DEFAULT_EFFORT` | `high` | Initial thinking effort: `low` / `medium` / `high` / `auto`; overridable per model in the session menu |
| `hiddenModels` | `DSH_AGY_HIDDEN_MODELS` | `[]` | Slugs hidden from the model picker (comma separated) |
| `fallbackModels` | `—` | Gemini 3.8/3.7/3.6/3.5 Flash, Gemini 4 Argon, Claude Sonnet 4.6, Claude Opus 4.6 (Thinking), GPT-OSS 120B | Catalog shown before `agy models` succeeds (signed out or offline) |
| `autoFallbackModel` | `DSH_AGY_AUTO_FALLBACK_MODEL` | `false` | Retry on a fallback model when the selected one cannot run |
| `modelsCacheTtlMs` | `—` | `300000` | Model catalog cache lifetime |

## Timeouts and scheduling

| Key | Environment | Default | Description |
| --- | --- | --- | --- |
| `timeoutMs` | `DSH_AGY_TIMEOUT_MS` | `600000` | Activity watchdog timeout per turn |
| `longToolIdleMinutes` | `DSH_AGY_LONG_TOOL_IDLE_MINUTES` | `240` | Idle budget while a tool step is open; `0` keeps `timeoutMs` so wedged tools fail fast |
| `dispatchTimeoutMinutes` | `—` | `15` | Cap on waiting for the Windows credential slot before backing off and retrying; `0` waits indefinitely |
| `dispatchRetries` | `—` | `1` | Extra dispatch attempts after a credential-slot timeout |
| `parallelSameAccount` | `—` | `true` | Concurrent sessions on the credential already in the slot start without exclusivity; `false` restores full slot exclusivity |
| `maxConcurrent` | `—` | `0` (unlimited) | Cross-session cap on concurrent agy streams |
| `rateLimitPerMinute` | `DSH_AGY_RATE_LIMIT_PER_MINUTE` | `0` (off) | Admission cap on requests per minute |

## Context and metering

| Key | Environment | Default | Description |
| --- | --- | --- | --- |
| `contextWindowDefault` | `—` | `1048576` | Context window advertised when agy does not report one |
| `maxTokensDefault` | `—` | `65536` | Max output tokens advertised when agy does not report one |
| `forwardSystemPrompt` | `—` | `false` | Forward the DSH system prompt to agy |
| `digestMaxChars` | `—` | `8000` | Budget for the history digest sent each turn |
| `contextTransferMaxChars` | `—` | `660000` | Character cap for the transferred context block |
| `contextTransferMaxBytes` | `—` | `150000` | Byte cap for the transferred context block |
| `contextTransferFileAboveBytes` | `—` | `55000` | Files larger than this are elided in the context block |
| `contextTransferFileMaxBytes` | `—` | `2000000` | Hard cap for an inlined file |
| `compactionMaxChars` | `—` | `800000` | Character budget for compaction input |
| `allowAuxiliary` | `—` | `true` | Allow auxiliary calls (titles, goal derivation) through the adapter |

## Media

| Key | Environment | Default | Description |
| --- | --- | --- | --- |
| `mediaDir` | `DSH_AGY_MEDIA_DIR` | `''` (plugin data dir) | Staging directory for multimodal images |
| `mediaTtlMs` | `DSH_AGY_MEDIA_TTL_MS` | `86400000` | Staged image lifetime |
| `mediaMaxBytes` | `—` | `10485760` | Per-image size cap |
| `mediaMaxImages` | `—` | `8` | Images per turn |

## MCP and tools

| Key | Environment | Default | Description |
| --- | --- | --- | --- |
| `askTool` | `—` | `false` | Expose the `agy_ask` delegation tool |
| `mcpBridge` | `DSH_AGY_MCP_BRIDGE` | `false` | Bridge DSH-side MCP servers into agy |
| `mcpConfigScope` | `DSH_AGY_MCP_CONFIG_SCOPE` | `global` | `global` / `workspace` / `both` |
| `mcpConfigPath` | `DSH_AGY_MCP_CONFIG_PATH` | `''` | Explicit agy MCP config path |
| `mcpToolAllowlist` | `DSH_AGY_MCP_TOOL_ALLOWLIST` | `''` | Only expose these MCP tools (comma separated) |

## Network, quota and updates

| Key | Environment | Default | Description |
| --- | --- | --- | --- |
| `proxyUrl` | `DSH_AGY_PROXY_URL` | `''` | Global proxy for agy processes; per-account proxies take precedence |
| `quotaPollIntervalMs` | `DSH_AGY_QUOTA_POLL_INTERVAL_MS` | `3600000` | Background quota poll interval (minimum 60 s) |
| `quotaViaCli` | `DSH_AGY_QUOTA_VIA_CLI` | `true` | Prefer the agy CLI path for quota queries |
| `autoWarmup` | `DSH_AGY_AUTO_WARMUP` | `false` | Opt-in weekly-quota warmup |
| `warmupModels` | `DSH_AGY_WARMUP_MODELS` | `gemini-3.8-flash,claude-sonnet-5-5` | Models used for warmup probes |
| `suppressAgyAutoUpdate` | `DSH_AGY_SUPPRESS_AUTOUPDATE` | `true` on Windows, `false` elsewhere | Refresh agy's update-check timestamp before every spawn to stop the `--bg-updater` console flash chain |

## Translation (`/tsl`)

| Key | Environment | Default | Description |
| --- | --- | --- | --- |
| `autoTranslate` | `DSH_AGY_AUTO_TRANSLATE` | `false` | Translate every completed turn |
| `translateModel` | `DSH_AGY_TRANSLATE_MODEL` | `gemini-3.8-flash` | Translate model, with catalog fallback |
| `translateEffort` | `DSH_AGY_TRANSLATE_EFFORT` | `high` | Reasoning effort for the translate model |
| `translateTargetLanguage` | `DSH_AGY_TRANSLATE_LANG` | `中文（简体）` | Target language wording in the prompt |
| `translateMaxChars` | `—` | `8000` | Source truncation limit |
| `translateMaxTokens` | `—` | `4096` | Output token cap |
| `translateTimeoutMs` | `—` | `120000` | Per-translation timeout |
| `translateRetries` | `—` | `2` | Retries on retryable failures (account stall, empty answer) |

`translateModel` and `translateEffort` are also editable in **DSH Settings → Antigravity**, on the auto-translate row (two dropdowns next to the on/off control). Leaving them on their default option hands the choice back to the fallback chain above.
| `translateSkipSameModel` | `—` | `true` | Skip translation when the reply already came from the translate model |
| `translateBindConversation` | `—` | `true` | One agy conversation per DSH session, persona sent once |
| `translateMinIntervalMs` | `—` | `3000` | Minimum spacing between automatic translations |

## Diagnostics

| Key | Environment | Default | Description |
| --- | --- | --- | --- |
| `logRetentionDays` | `DSH_AGY_LOG_RETENTION_DAYS` | `7` | Host log retention |
| `disableTelemetry` | `DSH_AGY_DISABLE_TELEMETRY` | `true` | Disable outbound telemetry |
