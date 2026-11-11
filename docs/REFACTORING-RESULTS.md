# Refactoring results

Branch `refactor/modular-monolith` (git worktree), based on `main` @ v0.6.18.

## Before / after

| Metric | Before | After |
| --- | ---: | ---: |
| `src/index.ts` | 1,634 | **414** |
| `src/client/index.ts` | 3,031 | **219** |
| `src/host/adapter.ts` | 3,152 | **593** |
| `src/host/pool.ts` | 1,179 | **546** |
| `src/host/quota.ts` | 1,455 | **462** |
| Longest function (`streamAttempt`) | 1,673 | **384** |
| Modules | 54 | **205** |
| Import cycles | 0 | **0** |
| Tests | 754 | **1021** |
| Coverage (lines / branches / functions) | 78.79 / 75.73 / 75.82 | **88.44 / 80.94 / 84.09** |
| Files > 600 lines | 19 | **0** (largest: 597) |

New modules:
- `provider/`: call-context, purpose-policy, account-selection, failure, prompt,
  prompt-text, finalize, span, attempt, attempt-outcome, notices.
- `transport/http/`: respond, router, routes/{status,pool,auth,config,translate,media}.
- `domain/`: quota/{buckets,identity,parse}, accounts/{selection,paths,store,admin},
  credentials/{mutex,lock,docs,platform,lease,handoff,resolve,slot,errors}.
- `features/quota/`: refresh, http, token.
- `client/`: api, status, icons, styles, global-css, react, ui/*, hooks/*, sections/*,
  toolview/*, images/*, translate-*.ts, mermaid-*.ts.
- `runtime/agy/`: bin, env, keychain, process, console, db/*.
- `host/commands/`, `provider/mapper/`, `provider/mirror/`.
- `host/services.ts` + `host/boot-hygiene.ts` (composition factory).

## Verification commands
```bash
npm run check          # tsc --noEmit
npm run lint:arch      # 103 modules, 0 cycles, 0 direction violations
npm run lint:budget    # 103 files, 17 legacy ratchet entries
npm run build          # host + client + bridge + image CLI
npm test               # 788 pass / 0 fail
npm run test:coverage  # Node coverage gate (85/80/80)
npm run verify         # check + arch + budget + build + test
```

## Size status
- **Every source file is ≤ 600 lines** (largest: `src/host/services.ts` 597).
  `scripts/budgets-allowlist.json` is now empty: the budget gate is strict for
  all files, no legacy exceptions.
- `streamAttempt` is 384 lines; the adapter is a 593-line composition/delegate
  layer. Spawn/parse/outcome, prompt, account selection, failure, finalize and
  span streaming are separate provider modules.
- Client split is guarded by `test/client-architecture.test.ts`.
