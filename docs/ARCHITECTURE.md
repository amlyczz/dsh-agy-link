# Architecture

`dsh-agy-link` is a **modular monolith**: one npm package, one host entry, one
client bundle and one CLI, with a one-way dependency rule.

## Layers

```
common/      pure types, protocol extensions, config schema, errors
  ↑
domain/      pure business rules (quota bucket math, account paths/eligibility)
  ↑
runtime/     process and platform I/O (agy runner/parser/mapper, proxy/env)
  ↑
provider/    the LlmAdapter pipeline (call context, purpose policy, prompt,
             account selection, failure classification, attempt/finalize)
  ↑
features/    translation, image, warmup, diagnostics, commands
  ↑
transport/   HTTP routes, respond helpers, tool registration
  ↑
host/services.ts   composition factory
index.ts           composition root (apply): wire services, commands, routes
```

`src/client/**` may import **only** `src/common/**`; it never imports host,
provider, transport or `index.ts`.

The rule is enforced by `scripts/check-architecture.mjs` (import graph + cycle
detection); size budgets are enforced by `scripts/check-budgets.mjs` with a
ratchet in `scripts/budgets-allowlist.json`.

## Provider pipeline

```
resolveCallContext  (purpose, permission, session, workspace, tool mode)
  -> purposePolicy  (aux / tools / binding / effort as data)
  -> selectSessionAccount (sticky affinity, cross-family fallback, diagnostics)
  -> buildPromptPlan (trailing messages, binding, digest, image staging, text)
  -> runAttempt (spawn agy, parse NDJSON, map StreamChunks)
  -> classifyFailure (pure: code/message/retryability)
  -> finalize (pool success/failure/rotation, binding persistence, usage)
```

`AgyAdapter.stream()` remains the host-facing surface and owns the
effort-refusal replay. `prepareCall()` binds model metadata for newer hosts.

## HTTP surface

29 routes are registered by `transport/http/router.ts` from six modules
(status, pool, auth, config, translate, media). Route paths, methods and JSON
shapes are frozen and covered by `test/http-contract.test.ts`.

## Client

`client/index.ts` only injects styles, registers locale dictionaries and mounts
slots. `sections/*` compose `ui/*` primitives; `hooks/*` own actions; `api.ts`
owns fetch. No inline button styling outside `ui/`.

## Verification

```bash
npm run check        # tsc --noEmit
npm run lint:arch    # dependency direction + cycles
npm run lint:budget  # file/function size ratchet
npm run build        # tsdown (host, client, bridge, image CLI)
npm test             # full suite
npm run test:coverage# Node built-in coverage with thresholds
npm run verify       # all of the above except coverage
```
