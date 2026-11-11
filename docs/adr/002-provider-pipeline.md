# ADR-002: The provider is a pipeline, not one generator

Status: accepted (2026-11-11)

## Context
`AgyAdapter.streamAttempt` was 1,673 lines: purpose flags, prompt assembly,
account selection, spawn/parse, tool mirroring, failure classification and
binding persistence all shared one closure. The behaviour is well covered
(≈88% lines, 2,691-line adapter test), which makes extraction safe but not free.

## Decision
Split the attempt into named stages with narrow inputs:

```
resolveCallContext -> purposePolicy -> buildPrompt -> acquireAccount
  -> runAttempt (spawn + parse) -> classifyFailure -> finalize
```

`stream()` keeps the host-facing signature and the effort-refusal replay. Stages
are pure where possible; the spawn stage owns the only process handle.

## Consequences
- A new purpose is a policy row, not five edits.
- Failure classification is unit-testable without agy.
- Generator/yield ordering is the main risk: every extraction is validated by
  the existing adapter tests plus a chunk-sequence golden test.
