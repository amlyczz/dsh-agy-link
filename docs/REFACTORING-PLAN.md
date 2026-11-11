# Refactoring plan (modular monolith, behavior-preserving)

Status: **implemented** on branch `refactor/modular-monolith` (worktree). Results: [REFACTORING-RESULTS.md](./REFACTORING-RESULTS.md).
Rules: one phase per commit, moves must not change behavior, public surface frozen
(`AgyAdapter.stream`, `apply`, route paths/status/JSON, command names, config keys, CLI flags).

## Guardrails (done)
- `scripts/check-architecture.mjs`: dependency direction + zero cycles.
- `scripts/check-budgets.mjs` + `scripts/budgets-allowlist.json`: size ratchet.
- `npm run verify` = check + architecture + budgets + build + test.
- `npm run test:coverage`: Node's built-in coverage with thresholds.

## Phase 1 (done)
- `src/common/protocol.ts`: typed `AgyGenerateOptions` (removes option casts).
- `src/runtime/net/account-env.ts`: one proxy precedence + env assembly.
- `src/provider/call-context.ts`: purpose/permission/session/workspace resolution.
- `src/provider/purpose-policy.ts`: aux/tools/binding/effort policy table.

## Phase 3 — routes (done)
`src/index.ts` is 1,634 lines; `apply` is 1,521 and inlines 29 HTTP routes.
Target:
- `src/host/services.ts`: `createHostServices(ctx, entryConfig)` returning the shared
  services (cfg/log/bin/store/pool/quota/warmup/translation/adapter/auth/poolAuth/catalog/lastRun).
- `src/transport/http/respond.ts`: `sendJson`, `methodOf`, `queryParam`, `readBody`.
- `src/transport/http/router.ts`: `registerRoutes(webServer, services)`.
- `src/transport/http/routes/{status,pool,auth,config,translate,media}.ts`: move the
  handlers verbatim; each exports `register(reg, services)`.
- `src/index.ts` keeps: config, service construction, commands/tools, lifecycle, and
  calls `registerRoutes`.
Acceptance: route paths/methods/status/JSON unchanged; `apply` ≤ 400 lines; 29 routes
covered by `test/http-contract.test.ts`; `pnpm check` + affected tests green.

## Phase 4 — client (done)
`src/client/index.ts` is 3,031 lines; `apply` is 1,466 and contains the whole settings
panel + account console. Target files:
- `api.ts` (postJson/getJson), `status.ts` (cache/poll/useAgyStatus), `icons.ts`,
  `styles.ts` (tokens + global CSS), `hooks/{useConfig,useAccounts,useAuthFlow}.ts`,
  `ui/{Button,Row,Select,Toggle,Modal,Toast,Spinner}.ts`,
  `sections/{SettingsSection,AccountsPanel,ModelsPanel,QuotaPanel}.ts`.
- `index.ts` only: styles + locale + slot registration (≤ 250 lines).
Acceptance: same UI behavior; `pnpm check` + `pnpm build`; client tests green; no
inline button style outside `ui/`.

## Phase 2 — adapter (done: spawn/parse/outcome extracted)
Extracted `call-context` + `purpose-policy`. Remaining: prompt assembly, attempt
(spawn/parse), finalize (failure classification/rotation), continuation. Target
`streamAttempt` ≤ 250 lines, `adapter.ts` ≤ 1,800.

## Phase 5 — stateful domain (done: store/admin/refresh/http/token/credentials extracted)
`pool.ts` → store/selection/admin; `quota.ts` → fetch/parse/buckets; `credential-slot.ts`
→ state machine. Public methods unchanged; do last, separate release.
