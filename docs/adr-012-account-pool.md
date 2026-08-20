# ADR-012: Multi-Account Pool & Sequential Drain Architecture

## Status
Proposed (2026-08-20)

## Context
Google Antigravity (via agy CLI) provides access to Gemini, Claude (Sonnet/Opus), and GPT-OSS models with generous rate limits. However, heavy agentic workflows (large code refactors, multi-step tool loops, reasoning-heavy turns) can hit per-model rate limits (`429 Too Many Requests`, `RESOURCE_EXHAUSTED`, or upstream capacity warnings).

Single-account users face blocking interruptions when an account hits quota. Users with multiple Google accounts (e.g. A, B, C) want to pool their accounts so that when Account A's quota for a model family is exhausted, the system automatically falls back to Account B, then Account C, without manual switching or disrupting active conversations.

### Architectural Approaches Considered

1. **Reverse-Engineering HTTP/SSE Protocol (The `chaos-03x/dsh-agy` approach)**:
   - *Pros*: Pure TypeScript HTTP requests, sub-millisecond account switching in memory.
   - *Cons*: High ban/risk profile (needs manual fingerprint spoofing), brittle Tool Calling schema translation (frequent 400 Bad Request crashes on Protobuf / JSON-Schema mismatch, as seen in dsh-agy issues #1, #2, #4), loss of agy's 50+ native tools and subagent execution sandbox.

2. **Multi-Profile agy CLI Process Isolation (Our chosen approach)**:
   - *Pros*: 100% official Google agy binary execution (zero account ban risk, zero schema translation issues, full native tool execution); clean physical process-level credential isolation via `HOME=~/.dsh/agy-accounts/<id>/`; optional per-account proxy via `ALL_PROXY` injection.
   - *Cons*: Light process spawn overhead (~50-100ms), requires directory management.

## Decisions

### 1. Multi-Profile Storage Structure
Each managed account has an isolated home directory under the DSH state directory:
```
~/.dsh/agy-accounts/
├── accounts.json                     # Metadata index (accounts, proxies, aliases, active order)
├── acc_a1b2c3/                       # Account A isolated environment
│   └── .gemini/
│       └── antigravity-cli/          # agy CLI credentials, tokens, settings for Account A
├── acc_d4e5f6/                       # Account B isolated environment
│   └── .gemini/
│       └── antigravity-cli/
```
Spawning agy for Account $X$ simply injects `HOME=/path/to/~/.dsh/agy-accounts/acc_X/` into `env`. No Docker containers or root privileges required.

### 2. Sticky Sequential Drain Strategy (按模型家族顺次耗尽)
- **Family-Scoped Cooldown**: Quota is tracked per model family (`google`, `anthropic`, `openai`). If Account A hits 429 on Claude 4.6, only Account A's `anthropic` family is marked in cooldown. Account A can still serve Gemini 3.7 Flash requests.
- **Sticky Affinity**: Requests stick to the first healthy account (e.g., Account A) to maximize conversation continuity and token caching.
- **Transparent Fallback**: When an in-flight request on Account A receives 429 / quota exceeded, the adapter records cooldown on Account A for that family and immediately transparently retries on Account B in the same streaming span. The user experiences zero interruption.

### 3. Cooldown & Reset Handling
- If the error contains a server reset time (or `Retry-After`), cooldown is set to `Date.now() + resetMs`.
- Default cooldown window is 10 minutes (tiered up to 60 minutes on consecutive 429s).
- Cooldown expires automatically; when Account A recovers, it resumes primary position.

### 4. Optional Per-Account Proxy (防关联支持)
Each account can optionally specify a dedicated proxy URL (`socks5://...` or `http://...`). When set, `ALL_PROXY` / `HTTPS_PROXY` / `HTTP_PROXY` are scoped exclusively to that account's child process. If unconfigured, it inherits the global host environment proxy.

## Consequences

- **Reliability**: No 400 schema crashes, full native tools support.
- **Smooth UX**: Multiple accounts can be registered via Web QR codes or CLI, providing 3x-5x continuous quota.
- **Safety**: Safe for single-user multiple accounts without requiring heavy containerization.
