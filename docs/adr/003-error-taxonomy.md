# ADR-003: One failure classifier with scope and retryability

Status: accepted (2026-11-11)

## Context
Error codes were matched as strings in the adapter, quota, image and ask paths;
each had its own branch for "rotate account", "cool down" and "retry".

## Decision
`src/provider/failure.ts` turns one attempt's evidence into a single
`AttemptFailure { kind, code, message, retryAfterMs? }`. Account-level codes
(`RATE_LIMIT`, `ELIGIBILITY`, `AUTH`) drive pool rotation; request-level codes
(`BAD_PARAMS`, `CONTEXT_WINDOW_EXCEEDED`) never rotate; transport codes carry a
backoff.

## Consequences
- The classifier is table-tested for every branch.
- New agy error shapes are added in one place, with one test.
