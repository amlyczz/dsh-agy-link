# dsh-agy-link — English

Integrate Google Antigravity models into DeepSeek Harness (DSH) through the official, unmodified `agy` CLI. The plugin provides streaming, thinking, tool activity, token metering, in-GUI OAuth login, and quota monitoring.

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
- Official five-hour and seven-day quota monitoring with reset countdowns.
- Text, thinking, and tool-activity streaming into native DSH UI cards.
- DSH sessions bound to native `agy` conversations through `--conversation`.
- Gemini, Claude, and GPT-OSS models available through the `antigravity` provider.
- Multimodal images staged locally and authorized to `agy` through `--add-dir`.
- `agy_ask` for delegating a one-off task to an Antigravity model.

## Configuration

| Key | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `DSH_AGY_ENABLED` | `true` | Plugin master switch |
| `agyBin` | `DSH_AGY_BIN` | auto-detected | Path to the `agy` executable |
| `permissionMode` | `DSH_AGY_MODE` | `skip` | `skip`, `plan`, or `accept-edits` |
| `defaultModel` | `DSH_AGY_DEFAULT_MODEL` | agy default | Default model slug |
| `defaultEffort` | `DSH_AGY_DEFAULT_EFFORT` | model default | `low`, `medium`, or `high` |
| `timeoutMs` | `DSH_AGY_TIMEOUT_MS` | `600000` | Activity watchdog timeout in ms |
| `workspaceRoot` | `DSH_AGY_WORKSPACE_ROOT` | session cwd | Workspace root |

## `/agy` commands

`status`, `auth`, `models`, `mode`, `effort`, `workspace`, `clear`, `doctor`, and `help`.

## Security and terms

The plugin invokes only the official, unmodified `agy` binary installed locally. Use it in accordance with Google Antigravity Terms of Service. Preserve commands, variables, model IDs, and paths literally when adapting this documentation.

## License

MIT License.
