# dsh-agy-link

[![CI](https://img.shields.io/badge/CI-github--actions-blue)](.github/workflows/ci.yml) [![npm](https://img.shields.io/badge/npm-dsh--agy--link-red)](https://www.npmjs.com/package/dsh-agy-link)

Bring **Google Antigravity models into [DeepSeek Harness (DSH)]** — chat,
thinking, tool activity, and token usage from your Antigravity subscription,
driven by the official `agy` CLI.

English | [简体中文](README.zh.md)

---

> 全网统一昵称：**小斯syzs** · B站 [@小斯syzs](https://space.bilibili.com/390211071) · 抖音 · 小红书 · 快手（全网同名）
>
> 💬 **小斯syzs 邀请你加入飞书群** —— [点此一键加入](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=553i2f4a-5cc8-487f-95d3-3c4095bec0d9)

> Known online as **小斯syzs** — Bilibili [@小斯syzs](https://space.bilibili.com/390211071) · Douyin · Xiaohongshu · Kuaishou (same handle on every platform).
>
> 💬 **Join the Feishu community group** hosted by 小斯syzs — [one-click invite](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=553i2f4a-5cc8-487f-95d3-3c4095bec0d9)


## What you get

- **A model route, not a proxy** — registers the `antigravity` provider in
  DSH's model config; pick any Antigravity model from the `/model` picker.
- **Full streaming** — text, thinking (reasoning), and agy tool activity
  (annotated as reasoning blocks), mapped onto DSH's native chunk protocol.
- **Session continuity** — each DSH session binds to a native agy
  conversation (`--conversation`), so multi-turn context rides agy history
  instead of re-sending everything.
- **Token usage** — input/output/thinking/cache tokens surface in DSH
  usage accounting.
- **In-GUI Google login** — `/agy auth` prints the consent URL; the sidebar
  panel adds a QR code and a paste box for the authorization code.
- **`agy_ask` tool** — let any DSH model delegate a one-shot task to an
  Antigravity model (the AskAntigravity pattern).
- **`/agy` commands** — `status`, `auth`, `auth-code`, `models`, `mode`,
  `effort`, `clear`, `doctor`, `help`.
- **Dormant-safe** — no agy binary? Not signed in? The plugin loads anyway
  and tells you what to fix.

## Requirements

- DSH (DeepSeek Harness) with a web profile
- Node.js >= 24
- The official `agy` CLI >= 1.1.8, installed and on `PATH`

## Install

```bash
dsh plugin --profile web add dsh-agy-link
```

Restart DSH, then run `/agy status` in the GUI.

## Login (one time)

1. `/agy auth` — prints a Google consent URL.
2. Open it, approve access, copy the authorization code.
3. `/agy auth-code <code>` — or use the sidebar panel (QR + paste box).

The plugin never reads, copies, or moves
`~/.gemini/antigravity-cli/antigravity-oauth-token`; login is driven
entirely through the official CLI's own flow.

## Configuration

Config lives in the `agy-link` plugin entry (edit via `/plugin` or the
profile patch layer). Environment variables override the file:

| Key | Env | Default | Meaning |
| --- | --- | --- | --- |
| enabled | `DSH_AGY_ENABLED` | `true` | master switch |
| agyBin | `DSH_AGY_BIN` | auto | explicit agy binary path |
| permissionMode | `DSH_AGY_MODE` | `skip` | `skip` / `plan` / `accept-edits` (below) |
| defaultModel | `DSH_AGY_DEFAULT_MODEL` | `(agy default)` | model slug |
| defaultEffort | `DSH_AGY_DEFAULT_EFFORT` | `(model default)` | `low` / `medium` / `high` |
| timeoutMs | `DSH_AGY_TIMEOUT_MS` | `600000` | per-turn watchdog |
| extraArgs | `DSH_AGY_EXTRA_ARGS` | — | extra agy flags, space-separated |

### Permission modes — read this

agy runs its **own** tool loop with its own file edits and shell commands.
The bridge maps that to one of three modes:

- **plan** — read-only; the safe default for trying the bridge.
- **accept-edits** — agy may edit files without asking.
- **skip** — `--dangerously-skip-permissions`: agy runs **every** tool
  without approval. Non-interactive DSH turns need this (or plan) because
agy permission prompts hang print mode, but it means real unattended
  write/exec access. The settings panel shows this button in red.

DSH-side tools and permissions are unaffected — this only governs what the
spawned agy process may do in its workspace.

## How it works

One DSH model call = one short-lived `agy -p --output-format stream-json`
process. The NDJSON event stream is parsed, normalized, and mapped to
DSH StreamChunks: thinking → reasoning blocks, text → text blocks, tool
activity → annotated reasoning blocks, and the result envelope → usage +
finish. Conversation ids are discovered from the stream itself with a
conversations-directory snapshot diff as fallback. No reverse-engineered
database scraping, no protobuf decoding, no token file access.

## Known gaps

See [docs/KNOWN-GAPS.md](docs/KNOWN-GAPS.md). Notably: images are not
forwarded (agy print mode is text-only), and DSH tools are not exposed to
agy (its MCP reverse bridge is future work).

## Disclaimer & risk note

This plugin spawns the **official, unmodified** `agy` binary and consumes
its public print-mode output. It does not decode internal databases or
touch OAuth tokens. Automating a subscription CLI may still conflict with
the provider's terms of service (Google Antigravity ToS §6 context); use
it at your own risk, and stop if asked to.

## License

MIT

[DeepSeek Harness (DSH)]: https://npmjs.com/package/@deepseek-ai/dsh
