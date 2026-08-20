# Comprehensive Specification: Multi-Account Pool, Quota Statistics & Sequential Drain

> **Document Type**: Technical Specification & Architecture Design  
> **Status**: Approved for Implementation  
> **Scope**: Host Backend, Account Engine, Quota Statistics, Transparent Retry Pipeline, DSH Attached WebUI, CLI Family

---

## 1. Executive Summary & Core Tenets

### 1.1 Background & Motivation
In agentic coding workflows using Google Antigravity models (Gemini 3.7 Flash, Claude 4.6 Sonnet/Opus, GPT-OSS 120B), heavy usage can hit rate limits (`429 Too Many Requests`, `RESOURCE_EXHAUSTED`, or upstream capacity warnings).

This specification details a **Multi-Account Pool (号池系统)** that enables pooling multiple Google accounts (e.g. Accounts A, B, C) with **Live Quota Statistics (实时配额进度条)**, **Sticky Sequential Drain (按模型家族顺次耗尽)**, **Zero-Interruption In-Flight Fallback (零感知自动重试)**, and full integration into the **DSH Built-in Settings WebUI**.

### 1.2 Core Architectural Principles
1. **Zero Ban Risk via Official CLI Execution**: Execution runs through the official Google `agy` binary (`agy -p ...`). No reverse-engineered chat streaming, no fragile Protobuf schema translation, no spoofed fingerprinting. Full access to agy's 50+ native Agent tools.
2. **Multi-Profile Directory Isolation (Verified)**: Local process isolation via dedicated `HOME` directories (`~/.dsh/agy-accounts/<id>/`). Zero Docker containers or background daemons. Verified to boot isolated agy processes in ~50ms.
3. **Live Quota Inspection (实时额度统计)**: Direct upstream query of `v1internal:fetchAvailableModels` to extract `remainingFraction` (0.0~1.0) and `resetTime` per model family (`google`, `anthropic`, `openai`), visually rendered as colorful progress bars in the DSH settings panel.
4. **Zero-Config Proxy Inheritance (零配置开箱即用)**: All accounts default to inheriting the active system/terminal proxy (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`) from DSH. Single-proxy-port users (e.g. Clash on 7890) can use 3+ accounts seamlessly without configuring proxy settings.
5. **Family-Scoped Precise Cooldown (按模型家族精准冷却)**: Cooldowns are tracked per model family (`google`, `anthropic`, `openai`). A 429 on Claude only cools down Claude; Gemini requests remain active on that same account. Cooldown duration leverages the server's exact `resetTime`.
6. **Sticky Sequential Drain**: Always prioritize Account A until a specific model family is exhausted, then fail over to Account B, then C. Minimizes context thrashing and maximizes session token cache hits.
7. **Native DSH WebUI Attachment**: Fully integrated into the native DSH Web interface via `settings.section` slot — zero external ports or separate web servers needed.

---

## 2. Multi-Profile Isolation & OAuth Flow (Verified)

### 2.1 Directory Structure
```
~/.dsh/agy-accounts/
├── pool.json                         # Account registry, active mode, and cached quota metadata
├── acc_1700000000_a1/                # Account A (e.g. work@gmail.com)
│   └── .gemini/
│       └── antigravity-cli/
│           └── antigravity-oauth-token
├── acc_1700000000_b2/                # Account B (e.g. personal@gmail.com)
│   └── .gemini/
│       └── antigravity-cli/
│           └── antigravity-oauth-token
└── acc_1700000000_c3/                # Account C (e.g. backup@gmail.com)
    └── .gemini/
        └── antigravity-cli/
            └── antigravity-oauth-token
```

### 2.2 Verified Add-Account OAuth Workflow
```
[ User clicks: "➕ 添加新 Google 账号" ]
                 │
                 ▼
1. Backend allocates directory: ~/.dsh/agy-accounts/acc_<id>/
                 │
                 ▼
2. Generates Google OAuth PKCE authorization URL:
   - Client ID: 1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com
   - Scopes: cloud-platform, userinfo.email, userinfo.profile, cclog, experimentsandconfigs
                 │
                 ▼
3. WebUI renders:
   - 👉 Button: Open authorization page in browser (works through local proxy)
   - 📱 Inline Base64 QR code
   - 📋 Authorization code input field
                 │
                 ▼
[ User authorizes & pastes code back ]
                 │
                 ▼
4. Backend exchanges code at https://oauth2.googleapis.com/token:
   - Receives: { access_token, refresh_token, expires_in }
   - Resolves email via https://www.googleapis.com/oauth2/v1/userinfo
   - Fetches live quota stats via v1internal:fetchAvailableModels
                 │
                 ▼
5. Writes token into ~/.dsh/agy-accounts/acc_<id>/.gemini/antigravity-cli/antigravity-oauth-token
   and registers account in pool.json.
                 │
                 ▼
6. Account is live and immediately ready for use!
```

---

## 3. Real-Time Quota Statistics (实时配额统计)

### 3.1 Quota API Endpoint & Payload
- **Endpoint**: `https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` (Fallback: `https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`)
- **Headers**: `Authorization: Bearer <access_token>`, `User-Agent: antigravity/1.1.15 darwin/arm64`
- **Response Format**:
  ```json
  {
    "models": {
      "gemini-3.7-flash": {
        "displayName": "Gemini 3.7 Flash",
        "quotaInfo": {
          "remainingFraction": 0.85,
          "resetTime": "2026-08-20T16:00:00Z"
        }
      },
      "claude-3-7-sonnet": {
        "displayName": "Claude 3.7 Sonnet",
        "quotaInfo": {
          "remainingFraction": 0.40,
          "resetTime": "2026-08-20T18:30:00Z"
        }
      },
      "gpt-oss-120b-medium": {
        "displayName": "GPT-OSS 120B",
        "quotaInfo": {
          "remainingFraction": 1.0,
          "resetTime": "2026-08-21T00:00:00Z"
        }
      }
    }
  }
  ```

### 3.2 Family-Scoped Quota Aggregation
Each model maps to a family:
- **`google`**: `gemini-*`, `gemma-*`
- **`anthropic`**: `claude-*`
- **`openai`**: `gpt-*`, `openai/*`

For each family $F$:
$$\text{remainingFraction}(F) = \min_{m \in F} (\text{model.quotaInfo.remainingFraction})$$
$$\text{resetTime}(F) = \min_{m \in F} (\text{model.quotaInfo.resetTime})$$

---

## 4. Scheduling & Transparent Fallback Engine

### 4.1 Account Selection Algorithm (Sequential Drain)

```
[ Request: model = "claude-sonnet-4-6", family = "anthropic" ]
                            │
                            ▼
              Get candidate accounts in priority order:
              [ Account A, Account B, Account C ]
                            │
              Filter: enabled === true
                            │
              Filter: cooldowns['anthropic'].cooldownUntil <= Date.now()
                      AND remainingFraction['anthropic'] > 0.05
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
      Candidates Available?       All in Cooldown?
              │                           │
              ├── Yes: Pick first         └── No: Throw POOL_EXHAUSTED
              │   (Account A)                 (with earliest reset countdown)
              ▼
    Spawn agy with Account A (HOME=~/.dsh/agy-accounts/acc_A)
```

### 4.2 In-Flight Transparent Fallback (429 Zero-Interruption Retry)
- When Account A hits 429, `RESOURCE_EXHAUSTED`, or upstream capacity errors:
  1. Record cooldown on Account A for `anthropic`:
     $$\text{cooldownUntil} = \text{server.resetTime} \parallel (\text{Date.now()} + 600\,000)$$
  2. Select next healthy account (Account B).
  3. Re-spawn agy under Account B with the conversation digest prefix.
  4. Stream chunks directly to the caller. The user experiences zero interruption or error modals.

---

## 5. DSH Attached WebUI Specification

Attached via `settings.section` slot under DSH Settings $\rightarrow$ Antigravity.

### 5.1 Visual Mockup with Quota Bars

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 👥 Antigravity Account Pool (Google 多账号池)                           │
│ 调度模式: [ 顺次耗尽 (Sequential Drain) ▾ ]  |  [ 🔄 刷新全部额度 ]       │
│ 提示: 默认共用本地系统/代理环境，账号 A 额度耗尽自动无缝切换到账号 B    │
├──────────────────────────────────────────────────────────────────────────┤
│ 1. 🟢 Account A (work@gmail.com) [当前主用]                             │
│    📊 额度余量:                                                          │
│    • Gemini:  [████████████████████░░] 85%  (重置时间: 16:00)            │
│    • Claude:  [████████░░░░░░░░░░░░░░] 40%  (重置时间: 18:30)            │
│    • GPT-OSS: [██████████████████████] 100%                             │
│    [ 🔍 刷新额度 ] [ ⚙️ 代理设置 ] [ 🔄 重新认证 ]                      │
├──────────────────────────────────────────────────────────────────────────┤
│ 2. 🟡 Account B (personal@gmail.com)                                     │
│    📊 额度余量:                                                          │
│    • Gemini:  [██████████████████████] 100%                             │
│    • Claude:  [░░░░░░░░░░░░░░░░░░░░░░] 0% (已耗尽 · 7分12秒后重置)      │
│    • GPT-OSS: [██████████████████████] 100%                             │
│    [ 🔍 刷新额度 ] [ ⚙️ 代理设置 ] [ ⬆️ 设为主用 ] [ 🗑️ 移除 ]           │
├──────────────────────────────────────────────────────────────────────────┤
│ 3. ⚪ Account C (backup@gmail.com)                                       │
│    📊 额度余量:                                                          │
│    • Gemini:  [██████████████████████] 100%                             │
│    • Claude:  [██████████████████████] 100%                             │
│    • GPT-OSS: [██████████████████████] 100%                             │
│    [ 🔍 刷新额度 ] [ ⚙️ 代理设置 ] [ ⬆️ 设为主用 ] [ 🗑️ 移除 ]           │
├──────────────────────────────────────────────────────────────────────────┤
│  [ ➕ 添加新 Google 账号 (Add Account) ]                                │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Host Web Server Routes

All host routes are namespaced under `/plugins/agy-link/`:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/plugins/agy-link/pool` | Get all accounts, live quota bars, cooldown timers, mode |
| `POST` | `/plugins/agy-link/pool/add` | Allocate a new account slot and generate OAuth URL & QR |
| `POST` | `/plugins/agy-link/pool/auth-code` | Submit OAuth code, exchange tokens, fetch initial quota |
| `POST` | `/plugins/agy-link/pool/auth-cancel` | Cancel in-progress OAuth for a slot |
| `POST` | `/plugins/agy-link/pool/refresh-quota`| Refresh real-time quota for one or all accounts |
| `POST` | `/plugins/agy-link/pool/remove` | Delete an account directory and its records |
| `POST` | `/plugins/agy-link/pool/reorder` | Update account priority order |
| `POST` | `/plugins/agy-link/pool/proxy` | Update optional proxy override for an account |
| `POST` | `/plugins/agy-link/pool/test` | Test connectivity & quota health of an account slot |

---

## 7. CLI Family Commands

- `/agy pool` / `/agy accounts`: Print summary table of pooled accounts, live quota %, and family cooldowns.
- `/agy add-account [alias]`: Start terminal-guided OAuth login for a new account slot.
- `/agy refresh-quota [id]`: Fetch fresh quota percentages from Google backend.
- `/agy remove-account <id>`: Delete an account slot.
- `/agy clear-cooldown [id]`: Manually reset cooldown timers for accounts.
