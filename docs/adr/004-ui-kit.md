# ADR-004: One UI kit, no inline button styling

Status: accepted (2026-11-11)

## Context
The settings panel had 100+ inline style objects and four button recipes. A new
copy button shipped without `S.btnSm` and looked like plain text — the class of
bug this ADR removes.

## Decision
`src/client/ui/*` owns Button/Row/Select/Toggle/Modal/Toast/Spinner. Variants and
sizes map to the existing tokens (`S.btn`, `S.btnSm`, `S.btnPrimary`,
`S.btnDanger`). Sections compose primitives; `index.ts` only wires slots and
locale.

## Consequences
- Style changes happen once.
- A source test rejects inline `<button style=...>` outside `ui/`.
