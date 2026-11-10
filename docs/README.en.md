<h1 align="center">🛰️ dsh-agy-link</h1>

<p align="center">
  <b>DeepSeek Harness × Google Antigravity</b> — multi-account pooling and a native <code>agy</code> CLI bridge for DSH
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-agy-link"><img src="https://img.shields.io/npm/v/dsh-agy-link?color=cb3837&label=npm&logo=npm" alt="npm"/></a>
  <a href="https://github.com/amlyczz/dsh-agy-link/actions/workflows/ci.yml"><img src="https://github.com/amlyczz/dsh-agy-link/actions/workflows/ci.yml/badge.svg" alt="CI"/></a>
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="MIT"/>
  <img src="https://img.shields.io/badge/node-%3E%3D24-green" alt="node"/>
</p>

<p align="center">
  <b>🌐 Language:</b>
  <a href="../README.md">中文</a> ·
  English ·
  <a href="./CONFIGURATION.md">Configuration</a>
</p>

---

Bring **Google Antigravity models into DeepSeek Harness (DSH)** through the official, unmodified `agy` CLI: streaming, thinking, native tool cards, exact token metering, in-GUI OAuth login, a multi-account pool with automatic rotation, and official multi-bucket quota tracking (5h rolling + 7d weekly + Argon weekly).

## ✨ Features

| | |
| --- | --- |
| 🤖 **Antigravity models in DSH** | Gemini 3.8 Flash, Claude 5.5, GPT-OSS … selected from the normal `/model` picker; streaming, thinking blocks, tool cards and usage are native DSH chunks. |
| 🔁 **Multi-account pool** | Sequential drain or round-robin; per-account isolated HOME, proxy and credentials; quota exhaustion cools the account and moves to the next one automatically. |
| 📊 **Quota console** | 5h rolling, 7d weekly and Argon weekly buckets; countdowns, cooldowns and one-click sync from the header badge. |
| 🔐 **In-GUI OAuth** | Add accounts without pasting credentials; headless paste-URL and manual code paths are also supported. |
| 🗣 **Plain-language translation (`/tsl`)** | A native Gemini card anchored under the reply; per-session 1:1 translation conversation; auto mode and per-reply button. |
| 🎨 **Image generation (`dsh-agy-image`)** | Bridges agy's built-in `generate_image` as a CLI that reuses the same adapter and account pool; strict artifact validation. |
| 🖥 **Headless ready** | `dsh headless "…"` works; permissions are documented in [HEADLESS-PERMISSIONS.md](./HEADLESS-PERMISSIONS.md). |

## 📋 Requirements

| Requirement | Verify |
| --- | --- |
| DSH | `dsh --version` |
| Node.js ≥ 24 | `node --version` |
| Google Antigravity CLI | `agy --version` (install: https://antigravity.google/docs/cli/install) |
| Google connectivity | proxy/VPN/TUN where required |

Where Google is unreachable directly, enable system proxy/TUN before starting DSH, or set a per-account proxy in the Antigravity panel.

## 🚀 Quick start

```bash
# Install into the web profile
dsh plugin --profile web add dsh-agy-link --registry https://registry.npmjs.org

# Start DSH Web
dsh web

# In the chat input:
/agy status              # binary, version, pool and catalog status
/agy auth                # sign the primary account in
/agy pool                # list account IDs
/agy auth <account-id>   # reauthenticate an existing secondary account (also accepts full alias or email)
/agy auth-status         # check the final login result within 30 seconds
```

Add more accounts from the **AGY (n)** badge in the header (browser login), then pick an Antigravity model in `/model`.

## 🗣 Plain-language translation (`/tsl`)

```bash
/tsl                       # translate the last completed turn
/tsl 3                     # translate turn 3
/tsl --full                # include intermediate narration
/tsl --text <any text>     # translate text only (no card)
/tsl --model <id> --effort low|medium|high
/tsl --print               # echo the translation in the command output
/tsl auto on|off|status    # per-session auto mode
```

- A native DSH card is rendered under the translated reply and survives reloads.
- Each DSH session gets its own translation conversation; the persona is sent once.
- The per-reply “translate” button translates the **message you clicked**, not the turn's last answer.
- Default effort is `medium` (measured on real agy: `low` ≈ 12s, `medium` ≈ 33s, `high` ≈ 45s for a 964-char reply; most of the low figure is agy startup).

## 🎨 Image generation (`dsh-agy-image`)

agy ships a built-in `generate_image` tool. The plugin exposes it as a CLI and **reuses the real `AgyAdapter`** (`purpose:'image'`): account selection, quota cooldown/rotation, proxy, failure classification and the `--effort` fallback are the same code path normal turns use. There is **no HTTP endpoint**.

```bash
dsh-agy-image -p "a shiba in sunglasses, flat illustration" -a 16:9 -o ./dog.jpg
dsh-agy-image -p "change the background to night" -i ./day.png -n night_scene --json
```

- Parameters passed verbatim to the tool: `Prompt`, `ImageName`, `AspectRatio` (14 values), `ImagePaths`.
- Strict validation before success: the artifact must exist, pass magic-byte sniffing (PNG/JPEG/WebP/GIF/BMP), parse its dimensions, stay under `imageMaxBytes`, and match the requested aspect ratio within 3%.
- `--json` returns `{ok, path, mime, width, height, aspectRatio, bytes, model, effort, durationMs, attempts, accountId?, conversationId?}`; failures carry a stable `code` (`BAD_PARAMS`, `IMAGE_NOT_FOUND`, `IMAGE_INVALID`, `IMAGE_ASPECT_MISMATCH`, `IMAGE_REGION_UNSUPPORTED`, `NO_ACCOUNT`, `TIMEOUT`, …).
- Exit codes: `0` ok · `2` usage · `3` agy missing · `4` generation failed · `5` validation failed · `6` account/region unavailable.
- The image model only produces ratios, not arbitrary pixel sizes (1:1 → 1024×1024, 16:9 → 1376×768). Region refusals (`User location is not supported`) are account/egress-level; the pool rotates to the next account on retry.

## ⚙️ Configuration

Every key, environment variable, default and advanced option lives in **one place**: [CONFIGURATION.md](./CONFIGURATION.md). The README deliberately does not duplicate that table.

Common entry points: `/plugin`, the Antigravity settings panel, `DSH_AGY_*` environment variables, and `~/.dsh/agy-link/runtime-overrides.json` (where the panel writes).

## 🧩 How it works

1. **One short-lived process per turn**: `agy -p --output-format stream-json`, parsed as NDJSON.
2. **Per-account sandbox**: the primary account uses the system HOME/keychain; secondary accounts get an isolated HOME with their own agy OAuth credentials. On Windows the credential slot is leased by identity, so parallel sessions on the same account are not serialized.
3. **Pooled failover**: 429/quota/region/auth failures are classified and routed — cool down, rotate the pointer, or retry on another account.
4. **Aux routes**: translation and image generation ride the same pool through dedicated purposes (`translation`, `image`), so they never pollute a normal conversation binding.

## ❓ FAQ (short)

- **Proxy?** Export `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` before starting DSH, or set a per-account proxy in the console.
- **A model rejects `--effort`?** The plugin learns the refusal, replays once without the flag, and hides the effort levels for that model.
- **Quotas not updating?** They poll hourly by default; press “Sync” on the console card or run `/agy refresh-quota`.
- **Windows console flash?** See the Windows notes in the Chinese README's FAQ; the root causes and fixes are identical.

## ⚠️ Disclaimer

This plugin only invokes the official, unmodified `agy` CLI installed locally. Use of this plugin is subject to Google Antigravity's Terms of Service.

## License

MIT License.
