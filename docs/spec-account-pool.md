# Feature Spec: Multi-Account Pool & Sequential Drain (号池系统规范)

> **Version**: 1.0.0  
> **Status**: Specification (Ready for Implementation)  
> **Related ADR**: [ADR-012: Multi-Account Pool & Sequential Drain Architecture](./adr-012-account-pool.md)

---

## 1. Executive Summary & Goals

### 1.1 Background & Motivation
In heavy agentic coding workflows (complex refactoring, subagent spawning, deep reasoning turns), users can trigger Google Antigravity rate limits (`429 Too Many Requests`, `RESOURCE_EXHAUSTED`, or upstream capacity warnings). 

For users who own multiple Google accounts (e.g. Account A, Account B, Account C), this specification defines a **Multi-Account Pool (号池系统)** that provides:
1. **Multi-Profile Isolation**: Local process-level isolation via dedicated `HOME` directories, requiring zero Docker containers or background daemons.
2. **Sticky Sequential Drain (按模型家族顺次耗尽)**: By default, always use Account A until its quota for a specific model family is exhausted, then transparently fail over to Account B, then Account C.
3. **Family-Scoped Cooldown (家族级精准冷却)**: A 429 on Claude models only cools down the account for Claude (`anthropic` family); Gemini models (`google` family) remain active on the same account.
4. **In-Flight Transparent Fallback (零感知自动重试)**: When an active request hits 429, the bridge automatically retries on the next available healthy account in the same turn without throwing an error to the user.
5. **Per-Account Proxy (防关联独立代理)**: Optional per-account proxy configuration (`ALL_PROXY`) to protect multi-account safety if desired.
6. **Unified Web & CLI Management**: Visual account cards, QR-code login per slot, and cooldown timers in the DSH settings panel.

### 1.2 Non-Goals
- **No Token Scraping / Reverse-Engineering**: All execution runs through the official `agy` CLI binary to preserve 100% official compliance, zero ban risk, and native tool execution.
- **No Heavy Containerization**: No Docker daemon requirements; isolation is purely file-system and environment-variable based.

---

## 2. Architecture & Domain Model

### 2.1 Directory Structure & Process Isolation

```
~/.dsh/agy-accounts/
├── pool.json                         # Pool configuration and account registry
├── acc_primary/                      # Default / primary account
│   └── .gemini/
│       └── oauth_credentials.json    # agy CLI auth storage
├── acc_secondary/                    # Secondary account (Account B)
│   └── .gemini/
│       └── oauth_credentials.json
└── acc_tertiary/                     # Tertiary account (Account C)
    └── .gemini/
        └── oauth_credentials.json
```

When spawning `agy` for a specific account `acc_id`, the process runner injects:
```ts
const env = {
  ...process.env,
  HOME: `/Users/zqy/.dsh/agy-accounts/${acc_id}`,
  GEMINI_CLI_HOME: `/Users/zqy/.dsh/agy-accounts/${acc_id}/.gemini`,
  // If account has dedicated proxy:
  ...(account.proxyUrl ? {
    ALL_PROXY: account.proxyUrl,
    HTTPS_PROXY: account.proxyUrl,
    HTTP_PROXY: account.proxyUrl,
  } : {}),
}
```

### 2.2 Domain Types (`src/common/pool-types.ts`)

```ts
export type ModelFamily = 'google' | 'anthropic' | 'openai' | 'unknown'

export interface FamilyCooldown {
  cooldownUntil: number
  reason: string
  consecutiveFailures: number
}

export interface ManagedAccount {
  id: string
  alias: string
  email?: string
  enabled: boolean
  proxyUrl?: string
  createdAt: number
  lastUsedAt?: number
  /** Cooldown tracked per model family */
  cooldowns: Partial<Record<ModelFamily, FamilyCooldown>>
}

export interface AccountPoolConfig {
  mode: 'sequential' | 'round-robin'
  defaultCooldownMs: number // Default 10 minutes (600,000ms)
  maxCooldownMs: number     // Cap at 60 minutes (3,600,000ms)
  accounts: ManagedAccount[]
}
```

---

## 3. Scheduling & Sequential Drain Logic

### 3.1 Model Family Mapping
Every model slug maps to a family:
- `gemini-*`, `gemma-*` $\rightarrow$ `'google'`
- `claude-*` $\rightarrow$ `'anthropic'`
- `gpt-*`, `openai/*` $\rightarrow$ `'openai'`
- Others $\rightarrow$ `'unknown'`

### 3.2 Account Selection Algorithm (Sequential Drain)

```
[ Incoming Request: model = "claude-sonnet-4-6" ]
                       │
                       ▼
            Family: "anthropic"
                       │
                       ▼
       Iterate accounts in priority order:
       [ Account A, Account B, Account C ]
                       │
       ┌───────────────┴───────────────┐
       ▼                               ▼
Account A healthy?               Account A in cooldown?
  ├── Yes: SELECT Account A        ├── Yes: Check Account B
  └── No: Check next account       └── (Recovers when now > cooldownUntil)
```

1. Given requested `model`, determine `family = modelFamilyOf(model)`.
2. Filter `pool.accounts` where `enabled === true`.
3. Filter out accounts where `cooldowns[family].cooldownUntil > Date.now()`.
4. In `sequential` mode, pick the **first** healthy account in priority order (e.g. Account A).
5. If all accounts are in cooldown for this family, throw `ALL_ACCOUNTS_IN_COOLDOWN` with the earliest recovery countdown (e.g. `All accounts are rate-limited for Claude. Next account resets in 4m 12s`).

### 3.3 In-Flight Transparent Fallback (429 Zero-Interruption Retry)

When `AgyAdapter.stream()` executes:
1. Attempt 1 spawns `agy` using Account A.
2. If `outcome.code !== 0` or stream output indicates rate-limiting (`429`, `RESOURCE_EXHAUSTED`, `overloaded`, `quota`):
   - Mark Account A in cooldown for `family`:
     ```ts
     const baseCooldown = 10 * 60 * 1000 // 10 minutes
     const failures = (account.cooldowns[family]?.consecutiveFailures ?? 0) + 1
     const cooldownMs = Math.min(baseCooldown * failures, pool.config.maxCooldownMs)
     account.cooldowns[family] = {
       cooldownUntil: Date.now() + cooldownMs,
       reason: '429 Rate Limit / Upstream Overloaded',
       consecutiveFailures: failures,
     }
     ```
   - Bridge automatically selects Account B.
   - Spawns Account B with the conversation history digest.
   - Pipes the stream directly into the active DSH stream chunk generator.
   - **Result**: The end user sees normal continuous output without error modals!

---

## 4. Cross-Account Session Continuity

When switching from Account A to Account B mid-session:
- The DSH session ID `sess_123` is preserved.
- `SessionStore` maps `[sessionId, accountId] -> conversationId`:
  - Account A had `conv_aaa`.
  - When switching to Account B, Account B has no `conv_aaa` on its Google profile.
  - The adapter detects new account binding, builds a concise history digest prefix (`[conversation so far] ...`), and establishes `conv_bbb` on Account B.
  - When Account A recovers from cooldown and resumes primary role in a later turn, Account A reuses its existing `conv_aaa` seamlessly.

---

## 5. Web GUI & User Interaction Spec

### 5.1 Account Cards in Settings Panel
In the DSH Web settings drawer for `dsh-agy-link`:

```
┌─────────────────────────────────────────────────────────────┐
│ 👥 Antigravity Account Pool (号池管理)                      │
│ 模式: [ 顺次耗尽 (Sequential Drain) ▾ ]                     │
├─────────────────────────────────────────────────────────────┤
│ 1. 🟢 主账号 (Account A - work@gmail.com) [默认主用]        │
│    状态: 就绪 (Ready)                                       │
│    代理: 跟随系统环境 (System Proxy)                        │
│    [ 测试连通性 ] [ 配置代理 ] [ 重新登录 ]                 │
├─────────────────────────────────────────────────────────────┤
│ 2. 🟡 备用账号 1 (Account B - personal@gmail.com)           │
│    状态: Claude 冷却中 (剩余 6分30秒) · Gemini 就绪          │
│    代理: socks5://127.0.0.1:7890                            │
│    [ 测试连通性 ] [ 配置代理 ] [ 设为主用 ] [ 移除 ]        │
├─────────────────────────────────────────────────────────────┤
│ 3. ⚪ 备用账号 2 (Account C - backup@gmail.com)             │
│    状态: 就绪 (Ready)                                       │
│    代理: socks5://127.0.0.1:7891                            │
│    [ 测试连通性 ] [ 配置代理 ] [ 设为主用 ] [ 移除 ]        │
├─────────────────────────────────────────────────────────────┤
│  [ ➕ 添加新 Google 账号 (Add Account) ]                    │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 Add Account Flow
1. User clicks **【➕ 添加新 Google 账号】**.
2. A new account slot `acc_<timestamp>` is allocated with its own directory.
3. System triggers Google OAuth login state machine for this slot:
   - Displays browser one-click link + Base64 QR code.
4. User completes authorization and pastes code.
5. Slot becomes active, joins the pool, and is immediately ready for sequential fallback!

---

## 6. Implementation Roadmap

| Phase | Milestone | Deliverables |
|---|---|---|
| **Phase 1** | **Core Pool & Storage Engine** | `AccountPoolManager`, directory initialization, `accounts.json` CRUD, test suite. |
| **Phase 2** | **Sequential Drain & Transparent Fallback** | Family mapping, cooldown tracking, in-flight automatic 429 retry in `adapter.ts`. |
| **Phase 3** | **Per-Account Proxy & Isolation** | Child process env injection (`HOME`, `ALL_PROXY`), proxy validation. |
| **Phase 4** | **Web GUI & CLI Family Commands** | Multi-account cards in settings UI, `/agy pool`, `/agy add-account`. |
