# Agent Guidelines for dsh-agy-link

## 🚨 Release & Publishing Rules (Strictly Enforced)

1. **No Automatic Publishing (禁止自动发布)**
   - **NEVER** publish to npm (`npm publish`) or create GitHub Releases (`gh release create` / git tags triggering release CI) automatically.
   - All release actions **MUST** receive explicit user confirmation and permission beforehand.

2. **Standard Workflow Before Release Request**
   - Implement changes and ensure local code quality gates pass:
     - `pnpm run check` (TypeScript typecheck)
     - `pnpm run build` (Bundle and compilation)
     - `pnpm test` (100% test suite passing)
   - Update `CHANGELOG.md` and bump `package.json` version accordingly.
   - Present a clear summary of changes, test results, and status to the user.
   - **STOP and wait for the user's explicit command** (e.g. "发布", "可以发布", "release") before creating any release or publishing package.

---

## 🛠️ Project Architecture & Constraints

- **Engine & Bridge**: `dsh-agy-link` bridges Google Antigravity (`agy` CLI) into DeepSeek Harness (DSH).
- **Tool Mirroring**: Tools executed by agy are mirrored as native DSH tool cards via `agy_tool` dispatched inside `run_code`.
- **Idle Activity Watchdog**: Timeout management uses an activity-based idle watchdog (`refreshWatchdog`), rearming on stdout/stderr data, with a generous print-mode budget passed to the agy CLI.
- **Protocol Fidelity**: Maintain lossless JSON chunks (no undefined properties), accurate reasoning annotations, and resilient event mapping across multi-turn continuations.
