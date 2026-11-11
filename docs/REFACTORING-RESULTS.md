# Refactoring results

Branch `refactor/modular-monolith` (git worktree), based on `main` @ v0.6.18.

## Before / after

| Metric | Before | After |
| --- | ---: | ---: |
| `src/index.ts` | 1,634 | **414** |
| `src/client/index.ts` | 3,031 | **219** |
| `src/host/adapter.ts` | 3,152 | **1,089** |
| `src/host/pool.ts` | 1,179 | **546** |
| `src/host/quota.ts` | 1,455 | **462** |
| Longest function (`streamAttempt`) | 1,673 | **391** |
| Modules | 54 | **118** |
| Import cycles | 0 | **0** |
| Tests | 754 | **791** |
| Coverage (lines / branches / functions) | 78.79 / 75.73 / 75.82 | **80.50 / 76.79 / 76.04** |

New modules:
- `provider/`: call-context, purpose-policy, account-selection, failure, prompt,
  prompt-text, finalize, span, attempt, attempt-outcome, notices.
- `transport/http/`: respond, router, routes/{status,pool,auth,config,translate,media}.
- `domain/`: quota/{buckets,identity,parse}, accounts/{selection,paths,store,admin},
  credentials/{mutex,lock,docs,platform,lease,handoff,resolve,slot,errors}.
- `features/quota/`: refresh, http, token.
- `client/`: api, status, icons, styles, global-css, react, ui/*, hooks/*, sections/*.
- `host/services.ts` + `host/boot-hygiene.ts` (composition factory).

## Verification commands
```bash
npm run check          # tsc --noEmit
npm run lint:arch      # 103 modules, 0 cycles, 0 direction violations
npm run lint:budget    # 103 files, 17 legacy ratchet entries
npm run build          # host + client + bridge + image CLI
npm test               # 788 pass / 0 fail
npm run test:coverage  # Node coverage thresholds
npm run verify         # check + arch + budget + build + test
```

## Still intentionally in place
- `src/host/adapter.ts` (1,089) still owns model/effort choice, rate-limit
  spacing and the thin `streamAttempt` orchestrator (391 lines); the spawn,
  parser, dispatch and outcome machinery now live in `provider/attempt*.ts`.
- Legacy files above 600 lines (client toolview/mermaid/images/translate,
  host runner/translate/image/commands/mirror-tool/mapper/warmup/agy-db,
  common types) are tracked in `scripts/budgets-allowlist.json`; the ratchet
  prevents them from growing and each can be split in a follow-up.
- `client/index.ts` split is guarded by `test/client-architecture.test.ts`.
