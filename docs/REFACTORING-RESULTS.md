# Refactoring results

Branch `refactor/modular-monolith` (git worktree), based on `main` @ v0.6.18.

## Before / after

| Metric | Before | After |
| --- | ---: | ---: |
| `src/index.ts` | 1,634 | **414** |
| `src/client/index.ts` | 3,031 | **219** |
| `src/host/adapter.ts` | 3,152 | **1,820** |
| `src/host/pool.ts` | 1,179 | **850** |
| `src/host/quota.ts` | 1,455 | **825** |
| Longest function (`streamAttempt`) | 1,673 | **~969** |
| Modules | 54 | **103** |
| Import cycles | 0 | **0** |
| Tests | 754 | **788** |
| Coverage (lines / branches / functions) | 78.79 / 75.73 / 75.82 | **≥79 / ≥76 / ≥75 (gate)** |

New modules:
- `provider/`: call-context, purpose-policy, account-selection, failure, prompt,
  prompt-text, finalize, span.
- `transport/http/`: respond, router, routes/{status,pool,auth,config,translate,media}.
- `domain/`: quota/{buckets,identity,parse}, accounts/{selection,paths,store}.
- `features/quota/refresh.ts`.
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
- `AgyAdapter.streamAttempt` still hosts the spawn + parser loop (~500 lines).
  It is the only stage left in the adapter; all pure stages and side-effect
  finalization are extracted. Further extraction needs a process-handle
  abstraction and is a separate, higher-risk change.
- `QuotaService` / `AccountPoolManager` / credential-slot keep their I/O
  methods; persistence and pure rules are already extracted.
- Legacy files above 600 lines are tracked in `scripts/budgets-allowlist.json`;
  the ratchet prevents them from growing.
