# 0007 — Non-negotiable domain invariants

Status: accepted (2026-07)

## Context

These encode UK charity compliance reality, distilled from the CiviCRM
analysis (research.md §B4, §B5, §B7). They are structural: getting them
wrong is a data-model rewrite, not a bug fix.

## Decision

1. **A Gift Aid declaration is a dated chain, not a boolean.** Eligibility
   of a contribution = its receive date vs the declaration windows
   (including negative periods). Never a flag on the contact.
2. **Consent is an immutable per-channel, per-purpose log** (who, when,
   how, exact wording shown, source). Current communication preferences
   are *derived* from the log, never stored as the source of truth.
3. **Erasure = anonymise, don't delete.** "Forget me" strips personal data
   but preserves financial/tax history (Gift Aid claims legally require
   it). No hard-delete cascades from Contact.
4. **The Gift Aid reclaim is a real financial record** — its own related
   transaction, queryable in totals. Never a custom field or derived-only
   value.
5. **Transactional-vs-marketing suppression is centralised.** Marketing
   opt-out never blocks transactional email (receipts, confirmations); the
   split lives in one place in `comms`, not per-send.
6. Money amounts are integer pence (or `Decimal`) — never floats.

## Consequences

- Schema reviews check against this list before migration.
- Batch + pending/failed/completed is the Gift Aid claim state machine to
  copy (research.md §B4.4).
- Anything compliance-relevant is a real modelled column — never in an
  extension's convenience JSON or a "custom field" (see ADR 0010).
