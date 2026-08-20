# Comprehensive Specification: Multi-Account Pool & Sequential Drain for dsh-agy-link

> **Document Type**: Technical Specification & Architecture Design  
> **Status**: Approved for Implementation  
> **Scope**: Host Backend, Account Engine, Transparent Retry Pipeline, DSH Attached WebUI, CLI Family

---

## 1. Overview & Core Tenets

### 1.1 Problem Statement
In agentic coding workflows using Google Antigravity models (Gemini 3.7 Flash, Claude 4.6 Sonnet/Opus, GPT-OSS 120B), users can exhaust per-model rate limits (`429 Too Many Requests`, `RESOURCE_EXHAUSTED`, or upstream capacity warnings). 

Single-account setups halt the entire workflow upon hitting a limit. This specification details a **Multi-Account Pool (号池系统)** that enables pooling multiple Google accounts (e.g. Accounts A, B, C) with **Sticky Sequential Drain (按模型家族顺次耗尽)**, **Zero-Interruption In-Flight Fallback (零感知自动重试)**, and full integration into the **DSH Built-in Settings WebUI**.

### 1.2 Core Architectural Principles
1. **Zero Ban Risk via Official CLI Execution**: We execute the official `agy` binary (`agy -p ...`). No reverse-engineered HTTP requests, no fragile Protobuf schema translation, no spoofed fingerprinting. Full access to agy's 50+ native Agent tools.
2. **Zero-Config Proxy Inheritance (零配置开箱即用)**: All accounts default to inheriting the active system/terminal proxy (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`) from DSH. Single-proxy-port users (e.g. Clash on 7890) can use 3+ accounts seamlessly without configuring proxy settings.
3. **Multi-Profile Process Isolation**: Physical credential isolation via isolated `HOME` directories (`~/.dsh/agy-accounts/<id>/`). Zero Docker containers or background daemons.
4. **Family-Scoped Precise Cooldown (按模型家族精准冷却)**: Cooldowns are tracked per model family (`google`, `anthropic`, `openai`). A 429 on Claude only cools down Claude; Gemini requests remain active on that same account.
5. **Sticky Sequential Drain**: Always prioritize Account A until a specific model family is exhausted, then fail over to Account B, then C. Minimizes context thrashing and maximizes session token cache hits.
6. **Native DSH WebUI Attachment**: Fully integrated into the native DSH Web interface via `settings.section` slot — zero external ports or separate web servers needed.

---

## 2. Proxy & Network Architecture (Zero-Config Assurance)

### 2.1 Why Zero-Config Works 100% in DSH
When DSH runs (CLI or Web profile), it inherits standard proxy environment variables. When `dsh-agy-link` spawns `agy` for any account, it merges the environment:

```
┌────────────────────────────────────────────────────────┐
│ DSH Host Process (Node.js)                              │
│ process.env: HTTP_PROXY / HTTPS_PROXY / ALL_PROXY      │
└──────────────────────────┬─────────────────────────────┘
                           │
       ┌───────────────────┴───────────────────┐
       ▼                                       ▼
 [ Account A Subprocess ]              [ Account B Subprocess ]
  - HOME: ~/.dsh/agy-accounts/acc_1      - HOME: ~/.dsh/agy-accounts/acc_2
  - ALL_PROXY: (Inherited 7890)          - ALL_PROXY: (Inherited 7890)
```

### 2.2 Environment Merge Priority
For any spawned `agy` process:
1. **Explicit Account Proxy** (if configured on this account): Overrides `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`.
2. **Global Plugin Proxy** (if configured in DSH settings): Overrides if present.
3. **Host System Environment** (`process.env.ALL_PROXY` / `HTTPS_PROXY`): Default fallback (covers 99% of user setups).

---

## 3. Storage & Multi-Profile Directory Model

### 3.1 Directory Layout
```
~/.dsh/agy-accounts/
├── pool.json                         # Account registry & cooldown states
├── acc_1700000000_a1/                # Account A (e.g. work@gmail.com)
│   └── .gemini/
│       └── oauth_credentials.json    # agy credentials managed by Google binary
├── acc_1700000000_b2/                # Account B (e.g. personal@gmail.com)
│   └── .gemini/
│       └── oauth_credentials.json
└── acc_1700000000_c3/                # Account C (e.g. backup@gmail.com)
    └── .gemini/
        └── oauth_credentials.json
```

### 3.2 Data Schema (`pool.json`)
```ts
export type ModelFamily = 'google' | 'anthropic' | 'openai' | 'unknown'

export interface FamilyCooldownState {
  cooldownUntil: number
  reason: string
  consecutiveFailures: number
}

export interface ManagedAccountRecord {
  id: string                          // e.g. "acc_1740000000_a1b2"
  alias: string                       // e.g. "Work Account", "Personal Account"
  email?: string                      // Captured from user or OAuth
  createdAt: number
  lastUsedAt?: number
  enabled: boolean
  proxyUrl?: string                   // Optional custom proxy override
  cooldowns: Partial<Record<ModelFamily, FamilyCooldownState>>
}

export interface AccountPoolState {
  version: 1
  mode: 'sequential' | 'round-robin'
  defaultCooldownMs: number           // 10 minutes (600,000 ms)
  maxCooldownMs: number               // 60 minutes (3,600,000 ms)
  primaryAccountId?: string           // Explicit pinned primary account
  accounts: ManagedAccountRecord[]
}
```

---

## 4. Scheduling & Transparent Fallback Engine

### 4.1 Model Family Classification
- `gemini-*`, `gemma-*` $\rightarrow$ `'google'`
- `claude-*` $\rightarrow$ `'anthropic'`
- `gpt-*`, `openai/*` $\rightarrow$ `'openai'`
- Others $\rightarrow$ `'unknown'`

### 4.2 Account Selection Algorithm (Sequential Drain)

```
[ Request: model = "claude-sonnet-4-6", family = "anthropic" ]
                            │
                            ▼
              Get candidate accounts in order:
              [ Account A, Account B, Account C ]
                            │
              Filter: enabled === true
                            │
              Filter: cooldowns['anthropic'].cooldownUntil <= Date.now()
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
      Candidates Available?       All in Cooldown?
              │                           │
              ├── Yes: Pick first         └── No: Throw POOL_EXHAUSTED
              │   (Account A)                 (with earliest reset timer)
              ▼
    Spawn agy with Account A
```

### 4.3 In-Flight Transparent Fallback (Zero User Error)

```
                       [ DSH User Turn Starts ]
                                  │
                                  ▼
                   Attempt 1: Spawn Account A
                                  │
             ┌────────────────────┴────────────────────┐
             ▼                                         ▼
        [ 200 OK ]                             [ 429 / Quota Error ]
    Stream to user                          Mark Account A Claude cooldown
                                                       │
                                                       ▼
                                            Attempt 2: Spawn Account B
                                            (with History Digest prefix)
                                                       │
                                                       ▼
                                             Stream to user smoothly!
```

- If Account A throws rate limit / 429 / capacity error during turn initialization or stream header:
  1. Record cooldown on Account A for requested family:
     $$\text{cooldownMs} = \min(600\,000 \times \text{failures}, 3\,600\,000)$$
  2. Select next healthy account (Account B).
  3. Re-spawn agy under Account B with the conversation digest.
  4. Stream chunks directly to the caller. The user experiences zero interruption or error modals.

---

## 5. DSH Attached WebUI Specification

The WebUI is attached directly into DSH via `settings.section` slot (`dsh-agy-link-client`).

### 5.1 Visual UI Layout Mockup

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 👥 Antigravity Account Pool (Google 多账号池)                           │
│ 调度模式: [ 顺次耗尽 (Sequential Drain) ▾ ]  |  [ 🔄 刷新状态 ]          │
│ 提示: 默认共用本地系统/代理环境，账号 A 额度耗尽自动无缝切换到账号 B    │
├──────────────────────────────────────────────────────────────────────────┤
│ 1. 🟢 Account A (work@gmail.com) [当前主用]                             │
│    状态: 全部就绪 (Ready)                                                │
│    代理: 默认跟随系统环境 (System Proxy)                                 │
│    [ 🔍 探活测试 ] [ ⚙️ 代理设置 ] [ 🔄 重新认证 ]                      │
├──────────────────────────────────────────────────────────────────────────┤
│ 2. 🟡 Account B (personal@gmail.com)                                     │
│    状态: Claude 冷却中 (剩余 7分12秒) · Gemini 就绪                      │
│    代理: 默认跟随系统环境 (System Proxy)                                 │
│    [ 🔍 探活测试 ] [ ⚙️ 代理设置 ] [ ⬆️ 上移 ] [ 🗑️ 移除 ]              │
├──────────────────────────────────────────────────────────────────────────┤
│ 3. ⚪ Account C (backup@gmail.com)                                       │
│    状态: 全部就绪 (Ready)                                                │
│    代理: 默认跟随系统环境 (System Proxy)                                 │
│    [ 🔍 探活测试 ] [ ⚙️ 代理设置 ] [ ⬆️ 上移 ] [ 🗑️ 移除 ]              │
├──────────────────────────────────────────────────────────────────────────┤
│  [ ➕ 添加新 Google 账号 (Add Account) ]                                │
└──────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Interactive Add-Account Modal / Drawer
When the user clicks **【➕ 添加新 Google 账号】**:
1. Host creates a new account slot `acc_<timestamp>_<random>` and its directory.
2. Starts the OAuth state machine scoped to this account directory:
   - Displays **【👉 点击在浏览器中打开 Google 授权登录页面】**;
   - Displays real-time **Base64 QR Code** (zero broken images);
   - Displays authorization code input box.
3. User pastes code and clicks **【提交激活】**.
4. Account is verified, auto-named, and appended to the active pool.

### 5.3 Live Cooldown Display
- Each account card shows real-time badge status:
  - 🟢 **Ready**: All models available.
  - 🟡 **Claude Cooldown (8m 32s)**: Claude rate-limited, Gemini active.
  - 🟡 **Gemini Cooldown (4m 10s)**: Gemini rate-limited, Claude active.
  - 🔴 **Unauthenticated**: Token missing or revoked.

---

## 6. Host Web Server Routes

All host routes are namespaced under `/plugins/agy-link/`:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/plugins/agy-link/pool` | Get all accounts, cooldown timers, active mode |
| `POST` | `/plugins/agy-link/pool/add` | Initialize a new account slot and start OAuth |
| `POST` | `/plugins/agy-link/pool/auth-code` | Submit OAuth code for a specific account slot |
| `POST` | `/plugins/agy-link/pool/auth-cancel` | Cancel in-progress OAuth for a slot |
| `POST` | `/plugins/agy-link/pool/remove` | Delete an account directory and its records |
| `POST` | `/plugins/agy-link/pool/reorder` | Update account priority order |
| `POST` | `/plugins/agy-link/pool/proxy` | Update optional proxy override for an account |
| `POST` | `/plugins/agy-link/pool/test` | Test connectivity & health of an account slot |

---

## 7. CLI Family Commands

In addition to the WebUI, the `/agy` command family is extended:

- `/agy accounts` / `/agy pool`: Print status table of all pooled accounts and family cooldowns.
- `/agy add-account [alias]`: Start terminal-guided OAuth login for a new account slot.
- `/agy remove-account <id>`: Delete an account slot.
- `/agy clear-cooldown [id]`: Manually reset cooldown timers for accounts.

---

## 8. Test & Verification Plan

1. **Storage Unit Tests**: Multi-profile directory creation, `pool.json` serialization, corrupt state recovery.
2. **Scheduling Unit Tests**:
   - `gemini` request selects Account A;
   - Account A 429 on Claude cools only `anthropic` family;
   - Subsequent `claude` request selects Account B;
   - Subsequent `gemini` request still selects Account A;
   - Expired cooldown allows Account A to resume primary role.
3. **Fallback Streaming Tests**: Mocked agy process exiting 429 triggers transparent retry on Account B without failing stream chunk generator.
4. **Proxy Forwarding Tests**: Process spawn asserts `ALL_PROXY` / `HOME` correctness.
