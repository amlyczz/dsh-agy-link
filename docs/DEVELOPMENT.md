# Development guardrails

## Before a PR
```bash
npm run check
npm run lint:arch
npm run lint:budget
npm run build
npm test
```
`npm run verify` runs the first four plus the full suite.

## Refactoring rules
1. One phase per commit; moves are behavior-preserving. A "move" commit may
   change imports/types only — reviewers compare with `git diff -M`.
2. Add a characterization test before touching a God function.
3. Freeze the public surface: `AgyAdapter.stream`, `apply`, route paths/status/
   JSON, command names, config keys, CLI flags.
4. Keep new files under 600 lines and top-level functions under 120 (the budget
   script enforces the target modules immediately and ratchets legacy files).
5. Do not mass-format the repository; format changed files only.

## Where things live
- New provider stage: `src/provider/` (see ADR-002).
- New HTTP route: `src/transport/http/routes/` and add it to `test/http-contract.test.ts`.
- New UI row: `src/client/sections/`, using `src/client/ui/` primitives (ADR-004).
- New pure rule: `src/domain/`; never import node I/O there.
