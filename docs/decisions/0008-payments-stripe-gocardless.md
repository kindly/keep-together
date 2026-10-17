# 0008 — Payments: Stripe (cards) + GoCardless (Direct Debit)

Status: accepted (2026-07) — implementation deferred to a later phase

## Context

Direct Debit is the backbone of UK regular giving; GoCardless is the
standard Bacs provider. Card storage must stay out of scope (lightest PCI
bracket, SAQ-A territory).

## Decision

GoCardless for Direct Debit mandates and collections; Stripe for cards.
Never store card or bank details — provider tokens/references only.
Webhook-driven reconciliation: what *actually cleared* updates
contribution status; a mandate/subscription in `giving` spawns
contributions rather than being one.

## Consequences

- `giving` models must carry provider references and a
  provider-agnostic status enum from the first migration that touches
  money.
- Webhook endpoints will need instance-level secrets in env (12-factor,
  ADR 0001).
- Not in the scaffold; first payment slice starts with GoCardless (the UK
  wedge), Stripe second.
