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

---

## 🔁 Fork PR CI（维护者必读）

GitHub 默认对 **outside collaborator / first-time contributor** 的 fork PR 暂停 workflow，状态为 `action_required`，界面上看起来像 “no checks / UNSTABLE”，其实只是在等人点批准。

维护者处理新 PR 时：

1. 打开 PR → Checks（或 Actions 列表）→ **Approve and run**。
2. 或 CLI：`gh run list --event pull_request` 找到 `action_required` 的 run，然后  
   `gh api -X POST repos/amlyczz/dsh-agy-link/actions/runs/<id>/approve`。
3. 批准后 CI 会跑 `check` + `build` + `test`；全部 `success` 才是可合并信号。

此策略只能在仓库 Settings → Actions → General 里调整，没有公开 API 可关。CI 不读 secrets（`permissions: contents: read`），批准即代表允许在 GitHub-hosted runner 上执行该 PR 的未信任代码。
