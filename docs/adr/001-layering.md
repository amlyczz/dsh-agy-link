# ADR-001: Modular monolith with a one-way dependency rule

Status: accepted (2026-11-11)

## Context
The plugin is one npm package with a host entry, a client bundle and a CLI. At
30k lines the entry files had become God closures (`apply` 1,521 lines in the
host, 1,466 in the client) and duplicated runtime assembly existed in ~20 places.

## Decision
Keep one package and one build, but enforce this dependency direction:

```
common  <- domain <- runtime <- provider <- features <- transport <- index
client  -> common only (never host/provider/transport/index)
```

`index.ts` and `host/services.ts` are the only composition points. The rule is
checked by `scripts/check-architecture.mjs` (cycles + forbidden edges) in
`npm run verify`.

## Consequences
- New features get a natural home without a monorepo split.
- `common` stays importable by the browser bundle.
- A violation fails CI instead of being discovered in review.
