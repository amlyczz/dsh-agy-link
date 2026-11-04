# dsh-agy-link — English

Integrate Google Antigravity models into DeepSeek Harness (DSH) through the official, unmodified `agy` CLI. The plugin provides streaming, thinking, tool activity, token metering, in-GUI OAuth login, official multi-bucket quota tracking, and `/tsl` plain-language translation.

## Requirements

| Requirement | Verification |
| --- | --- |
| DSH | `dsh --version` |
| Node.js >= 24 | `node --version` |
| Google Antigravity CLI | `agy --version` |
| Google connectivity | proxy/VPN/TUN where required |

Where Google is not directly reachable, enable system proxy/TUN mode. If the terminal does not inherit proxy settings, export them before starting DSH:

```bash
export HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 ALL_PROXY=socks5://127.0.0.1:7890
```

Replace the port with the correct local proxy port. An HTTP(S) or SOCKS proxy can also be configured per account in the DSH Antigravity panel.

## Install and quick start

```bash
# Install into the web profile
dsh plugin --profile web add dsh-agy-link

# Start DSH Web
dsh web
```

In DSH, click the `AGY (n)` badge and choose **Add Account** to complete Google login in the browser. Alternatively run `/agy auth` to start primary-account login. Then choose an Antigravity model from `/model` and start chatting. Use `/agy status` to check status.

## Features

- Account pool with isolated HOME environments and credentials.
- Sequential failover on HTTP 429 or quota exhaustion.
- Official five-hour, seven-day, and Argon weekly quota monitoring with reset countdowns.
- Text, thinking, and tool-activity streaming into native DSH UI cards.
- DSH sessions bound to native `agy` conversations through `--conversation`.
- Gemini, Claude, and GPT-OSS models available through the `antigravity` provider.
- Mobile web responsiveness: transitions to full-height drawer (`100dvh`) under 680px with equal-width buttons.
- Plain-language translation (`/tsl`): Gemini-branded card pinned below reply, 1:1 bound translation conversation.
- Effort learning: learns when a model rejects `--effort` and re-runs smoothly without failure.
- Multimodal images staged locally and authorized to `agy` through `--add-dir`.
- `agy_ask` for delegating a one-off task to an Antigravity model.

## Configuration

| Key | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `DSH_AGY_ENABLED` | `true` | Plugin master switch |
| `agyBin` | `DSH_AGY_BIN` | auto-detected | Path to the `agy` executable |
| `permissionMode` | `DSH_AGY_MODE` | `skip` | `skip`, `plan`, or `accept-edits` (fixed to `skip` in settings panel; config/env still override) |
| `defaultModel` | `DSH_AGY_DEFAULT_MODEL` | agy default | Default model slug |
| `defaultEffort` | `DSH_AGY_DEFAULT_EFFORT` | `high` | `low`, `medium`, `high`, or `auto`; initial effort level in model picker |
| `timeoutMs` | `DSH_AGY_TIMEOUT_MS` | `600000` | Activity watchdog timeout in ms |
| `longToolIdleMinutes` | `DSH_AGY_LONG_TOOL_IDLE_MINUTES` | `240` | Idle budget (minutes) while an agy tool step is still open; `0` = keep `timeoutMs` |
| `workspaceRoot` | `DSH_AGY_WORKSPACE_ROOT` | session cwd | Workspace root |
| `suppressAgyAutoUpdate` | `DSH_AGY_SUPPRESS_AUTOUPDATE` | `true` on Windows | Refreshes update check timestamp before spawn to block console flash |
| `autoWarmup` | `DSH_AGY_AUTO_WARMUP` | `false` | Opt-in 7-day weekly quota warmup probe |
| `autoTranslate` | `DSH_AGY_AUTO_TRANSLATE` | `false` | Automatically translate completed turns using Gemini |
| `translateModel` | `DSH_AGY_TRANSLATE_MODEL` | `gemini-3.8-flash` | Model used for `/tsl` plain translation |

> For complete configuration options, see [docs/CONFIGURATION.md](./CONFIGURATION.md).

## Commands

`/agy`: `status`, `pool`, `auth`, `models`, `mode`, `effort`, `workspace`, `goal`, `session`, `enable-account`, `disable-account`, `clear`, `doctor`, and `help`.  
`/tsl`: translate last turn or arbitrary text with optional `--full`, `--text`, `--model`, or `auto on|off`.

## Security and terms

The plugin invokes only the official, unmodified `agy` binary installed locally. Use it in accordance with Google Antigravity Terms of Service. Preserve commands, variables, model IDs, and paths literally when adapting this documentation.

## License

MIT License.
