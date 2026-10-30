# 0027: Statement lines are the outside record for gifts entered by hand

Status: accepted (2026-10-30). From the plan
`factory/plans/bank-transfers.sv` (design tree b1, contracts b4, steps
b5, tests b6; rounds 1–3), confirmed by the human 2026-10-29; written by
builder-rgt. Research: `factory/out/planner-bank-research.md`.

Extends [ADR 0025](0025-gifts-are-every-payment-attempt.md): decision 1
(every gift has one origin) gains a third, a statement line, and
decision 6 (a paying-in batch table "when banking reconciliation is
built") is built here. Uses [ADR 0026](0026-regular-gift-terms-are-a-dated-chain.md)'s
chain for standing orders. Within [ADR 0024](0024-rust-sqlite-per-org.md):
one org-schema step, contracts as there.

## Context

Money reaches a small group's bank account without any payment provider:
one-off bank transfers (the way to give more than GoCardless's £1,000
one-off cap), standing orders the donor set up in their own bank, and
cash and cheques paid in together on one slip. Today none of it can be
recorded except as a cash gift typed in by hand, and nothing checks a
hand-entered gift against the bank.

A GoCardless payment has an outside record (`direct_debit_payments`):
what the provider said, mirrored and checked against its gift. For money
that arrives at the bank, the bank statement is the only outside record.
HMRC asks for the date the donation was received, and auditors check
transfers and standing orders against the statements.

There's no free read-only bank feed for small UK accounts any more
(GoCardless Bank Account Data closed to new sign-ups in July 2025; the
others are sales-led and need 90-day consent reconfirmation), so
statements come in as files: CSV, OFX and QIF. Most UK CSVs carry no
transaction id.

## Decision

1. **A statement line is the outside record** for money that reaches
   the bank, as `direct_debit_payments` is for GoCardless. Its content
   (account, posted date, amount, payer, reference, narrative, the
   bank's id when there is one) is written once, by the import, and
   never edited. Its match state (`unmatched`, `matched`,
   `not_donation`, with a note) is a separate slice
   (`banking.lineMatch`). **Credits only**: debits are dropped while the
   file is read and never stored.
2. **A gift has one origin**: a provider (`provider`,
   `provider_payment_id`), a statement line (`gifts.bank_line_id`), or
   staff. A gift made from a line takes its amount and date (the posted
   date: when the money reached the bank) from the line, locked against
   edits as a provider gift's are. Staff can still void it, which frees
   the line. A database CHECK keeps a provider's gift off a line.
3. **New methods**: `bank_transfer` and `cheque` join `cash`, `card` and
   `direct_debit`. A reference is allowed on both. A standing-order
   payment is a `bank_transfer` on a regular gift of kind
   `standing_order` (`regular_gifts.kind`, default `direct_debit`).
4. **A transfer entered by hand is `completed` at once** (someone saw
   the money arrive), and is "not on a statement yet" until a line is
   matched to it. That's derived (a `bank_transfer` with no line), never
   stored. Matching a line to it links the two. Unmatching a line voids
   the gifts that were *made* from it, and only unlinks the ones entered
   by hand.
5. **A cheque counts only once it clears.** It is `pending` until its
   paying-in batch is matched to a statement line, then `completed`. A
   bounce marks it `failed`. A cheque outside a batch can be marked
   cleared by hand. Cash is `completed` on entry. As everywhere,
   `giving::RECEIVED` (`status = 'completed'`) is the only "money
   received", so a pending cheque never counts and is never claimable.
6. **Paying-in batches** (`paying_in_batches`, `giving.payingInBatch`,
   counter `version`): open (account, slip number), its cash and cheque
   gifts entered into it (`gifts.paying_in_batch_id`), closed with its
   total, then matched to its one statement line. The batch names the
   line (`line_id`); a difference against the line is shown, never
   forced. Batches are optional: a cash gift outside one works as now.
7. **Duplicates across overlapping imports are found by content.** A
   line is keyed by account, date, amount, payer and narrative
   (`dedupe_key`), and `occurrence` counts identical lines within a key:
   when a file holds a key *n* times and we hold it *m* times, *n − m*
   are new, so two identical £10 standing orders on one day both
   survive. The bank's id is used as well when the format has one.
8. **Matching suggests; staff confirm.** Suggestions are computed on
   read by pluggable suggesters, never stored, and none of them writes:
   every match goes through the same confirm path. Remembered payers
   (`bank_payers`, derived from confirmed matches) are personal data held
   on the contact's behalf and go with the contact on erasure (rule 3);
   the lines themselves keep their amounts and dates.
9. **Who**: admins set up bank accounts; staff and admins import and
   match; viewers never see statement lines.

## Consequences

- `gifts` is rebuilt once more (org schema step 21) to widen the
  method's CHECK, carrying every column and index it has by step 20.
- Gift Aid needs nothing new: transfers and standing orders are valid
  Gift Aid gifts, dated by the line; a cheque is claimable only once
  `completed`.
- Reports and claims keep reading `gifts` only. A statement line that
  isn't matched counts for nothing.
- A line that turns out not to be ours (a grant, a refund, a GoCardless
  payout) is marked "not a donation", by hand or by a saved rule
  (`bank_rules`).
- Open banking can be added later as one more way lines arrive; the line
  stays the outside record whichever way it came.

## Decided during the build (2026-10-30)

Steps 1–5 and their reviews settled these. The code and its tests are
the reference; `server/README.md` "Bank transfers" says where each lives.

1. **Dedupe: content beats an unheld fresh bank id** (review bk2r L2). A
   file line whose bank id the account doesn't hold is still a duplicate
   when the account holds a line with the same content whose id this
   file doesn't carry. That keeps re-downloads from banks that issue a
   new `FITID` each time from doubling every line. The cost falls on
   banks whose ids are stable: a genuine second identical payment on the
   same day is dropped if the file carries it but not the first one's id.
   That's rare, and a held id is never imported twice
   (`banking::dedupe`'s module doc).
2. **A Luhn-valid contact number in a line's reference or narrative is
   a strong match on its own** (review b4r L1). The reference names the
   donor, and a gift made from the line takes the line's own amount and
   date. A number whose check digit fails is never strong. For a
   standing order, the number makes its instalment strong only when it is
   that standing order's own donor's.
3. **A standing order's expected payment is strong only when the line
   names the donor** (review b5r; confirmed by the human, 2026-10-30). Either the
   line's payer is a known payer of that standing order's donor (matched
   to them before), or the line carries a Luhn-valid contact number that
   is theirs. Either way it needs the exact amount, and the line must
   arrive from 5 days before the due date to 15 after.
   - The first payment from a payer is always staff's to confirm; once
     it is, later ones pre-tick.
   - The standing order's bank reference, found in the line as whole
     tokens, ranks the suggestion first and says so in its reason, but
     never makes it strong: references are too often generic ("MONTHLY",
     "DONATION 2026") or another person's name.
4. **Paying-in batches**:
   - A batch is `open` or `closed`. "Matched" means closed and naming its
     statement line, a slice of its own (`giving.batchLine`) that only
     matching and unmatching move, so the cheques' statuses always follow.
   - A closed batch holds its gifts: their amount, date and method, and
     whether they are void, stay as the slip says until the batch is
     reopened.
5. **A split line is undone whole.** Voiding one part of a line's split
   (made from the line or matched to it by hand) is refused
   (`line_split`): unmatch the line instead. Voiding a line's only gift
   frees the line, in the same command group.
6. **A gift matched to a line keeps the line's terms.**
   - A gift made from a line has its amount, date, method and reference
     locked, as a provider's gift does.
   - A transfer entered by hand and matched to a line has its amount,
     date and method fixed while it's matched and not void
     (`line_matched_fixed`), because Gift Aid claims on them.
   - Voiding a hand-matched transfer unlinks it from the line.
7. **One payment per standing-order period** (`period_paid`, enforced on
   the gift), and a line pays no period due more than 5 days after it
   (`period_not_due`). A late payment still pays its own missed period.
   A standing order expects payments from its first row, paid or not, so
   a payment missed before the first one that came is still missed.
8. **Forgetting a contact's remembered payers is recorded**
   (`bank_payer_forgets`, org schema step 22), because `bank_payers` is
   derived and a rebuild would otherwise bring them back. Lines matched
   before the forget are skipped for that contact, and a match after it
   is remembered again. Erasure itself isn't built yet; when it is, it
   calls `banking::forget_payers`.
9. **A line command checks the line's counter first.** A line someone
   matched meanwhile is `409 stale` with its match as it now is, before
   any other refusal. "Accept ticked" runs one transaction per line, so
   one stale line fails alone.
10. **A blank payer is never a known payer** (follow-up b). The payer
    key is the payer and the reference, and a line with a blank payer
    gets none: it never creates a `bank_payers` row nor matches one, in
    the known-payer suggester, a standing order's match or the "make this
    a standing order" offer. Otherwise a generic reference ("DONATION",
    "MONTHLY") would act as a payer, and anyone quoting it would pre-tick
    as a donor matched before. Rows already kept with a blank payer are
    skipped when read; no migration.
11. **Erasure leaves a statement line's payer and reference as the bank
    wrote them** (the human, 2026-10-30). A line is the bank's record of
    money received (decision 1), kept with the financial history rule 3
    preserves. Erasing a contact anonymises the contact and forgets their
    remembered payers (decision 8); the line's text is not edited.
