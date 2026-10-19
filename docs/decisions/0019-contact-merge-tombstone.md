# 0019 — Contact merge: tombstone and the reference rule

Status: accepted (2026-10-17) · amended 2026-10-18 (external identifiers re-parented on merge, from `factory/plans/external-ids.sv` g1q8) · from the contact-model plan
(`factory/plans/contact-model.sv`, g1q5; open questions settled in grill
round 4).

## Context

Duplicates are certain. Small groups import spreadsheets, supporters sign
up through donation forms and the portal under a second address, and
staff type people in twice. CiviCRM merges by moving the loser's linked
records (contributions, activities, groups, tags, memberships) onto the
survivor. It then trashes the loser (`is_deleted = 1`) and attaches a
"Contact Deleted by Merge" activity to it
([user guide](https://docs.civicrm.org/user/en/latest/common-workflows/deduping-and-merging/),
[CRM-5758](https://issues.civicrm.org/jira/browse/CRM-5758),
[CRM-18106](https://issues.civicrm.org/jira/browse/CRM-18106)).
Merged duplicates "are not recoverable, unless you have database logging
enabled".

We can't copy that, because our records are not all re-pointable:

- **Rule 1:** a Gift Aid declaration is a dated chain belonging to a
  person. **Rule 2:** the consent log is immutable. **Revisions** are
  immutable history (ADR 0013). Re-pointing any of them rewrites
  evidence.
- **Rule 3** and ADR 0014: nothing is hard-deleted from a contact, and
  there is no generic soft-delete flag.
- Giving, giftaid, consent and comms are about to be built. Whatever
  `contactId` means after a merge has to be decided before they store
  one.

## Decision

**1. Merge is a staff action, never automatic.** It runs as one command
group ("merge *loser* into *survivor*"), only between contacts of the
same kind. Dedupe rules produce *candidates*: CiviCRM-style unsupervised
auto-merge is rejected. A kind change ("this is really an organisation")
is create-new-then-merge, which needs cross-kind merge and is deferred.

**2. The survivor takes the chosen values through its normal contracts.**
The merge UI produces full-state payloads for the survivor's `details`,
`methods`, `addresses` and `tags` slices. Each runs through
`executeContract` like any save, so revisions and counters stay honest.
Email, phone and identifier rows from the loser are **re-parented with
their keys** rather than copied. That keeps identity-field state with
the row: email `onHold`, the supporter login that binds to an email
row, and an external identifier's uniqueness (a (type, value) pair
belongs to one contact, so a copy would clash with the original). This
is the one operation allowed to move a child row between roots. It
lives in the merge contract, not in `reconcile`, which keeps rejecting
foreign keys.

**3. The loser becomes a tombstone.** It is not deleted or trashed. A new
contract `contacts.merge` (counter `mergeVersion`) sets
`mergedInto: Id<'contacts'>` and `archived: true` on the loser. Its name
fields stay, so history can show "merged from Ann Smyth" and search
finds the person by an old name or spelling (settled in review, below). Tombstones are
read-only: every contact contract rejects a root with `mergedInto` set,
except `contacts.merge` itself.

**4. Chains are kept flat.** When Y is merged into Z, every tombstone
whose `mergedInto` is Y is re-pointed to Z in the same command group. So
`mergedInto` always names a live contact, and the identity set of a
contact is one indexed read: the contact plus every contact with
`mergedInto = id` (index `by_tenant_mergedInto`). The contacts module
exports this as `identitySet(contactId)`. Other modules call it and never
read `mergedInto` themselves.

**5. The reference rule.** Every entity that stores a `contactId` is in
one of two classes. Each module's plan says which class each of its
entities is in.

| Class | Meaning | On merge | On read |
|---|---|---|---|
| **History** | a record of what happened to that person | keeps the original `contactId`, never rewritten | "for contact X" reads the whole `identitySet(X)` |
| **Live** | something that drives future behaviour | re-pointed to the survivor by the merge action, through the owning module's contract | plain `contactId` |

Initial classification:
- **History:** revisions, consent records, Gift Aid declarations,
  contributions, Gift Aid claim lines, activities.
- **Live:** relationships (a relationship that would become
  self-referential is ended, not moved), notes, recurring
  contributions / mandates, pledges, memberships, supporter login,
  contact identifiers (re-parented, see decision 2; lookup by an old id
  lands on the survivor directly).
- **Tags** are merged by union into the survivor's `tags` slice.
- **The acquisition code** (`contacts.acquisitionCodeId`, ADR 0022) is
  a field on the contact, not a referencing entity: staff choose which
  code the survivor keeps in the merge UI (default: the code of whichever
  contact was created first), and it goes through the survivor's
  `contacts.acquisition` contract. The dedupe/merge plan carries it.

**6. Domain consequences.**
- **Gift Aid (rule 1):** a contribution's eligibility is evaluated
  against the declarations of the donor's whole identity set. Same
  person, so HMRC-valid. No declaration row is rewritten.
- **Consent (rule 2):** current preferences are derived from the
  identity set's combined log. The latest event per channel and purpose
  wins. Merge records no synthetic consent events.
- **Suppression (rule 5):** comms never sends to a tombstone. A send
  addressed to one resolves to the survivor, and suppression is
  evaluated there.
- **Erasure (rule 3):** anonymising a contact anonymises its tombstones
  and scrubs their revisions too.
- **Restore:** `restoreEntityTo` refuses tombstones. Unmerge is out of
  scope for v1 (CiviCRM has none either). The merge's command group is
  the audit record.

## Alternatives rejected

- **Re-point everything to the survivor** (CiviCRM). This rewrites
  consent and declaration rows, breaking rules 1 and 2, and makes
  revision history refer to a contact that didn't exist when it was
  written.
- **Delete or trash the loser.** That breaks rule 3 and ADR 0014 (no
  generic soft delete), and leaves history records pointing at nothing.
- **Unbounded `mergedInto` chains, resolved recursively.** Reads get
  harder for no gain. Flattening on merge is cheap.

## Consequences

- **Schema** (two-phase): `contacts.mergedInto` optional (one-phase
  loosening, stays optional), plus `mergeVersion` (loosen → backfill
  0 → tighten) and index `by_tenant_mergedInto`. This happens in the
  dedupe/merge plan, not now.
- **Every module** must provide a `forContact` read that takes an
  identity set for history-class entities. Giving and consent design
  their indexes for "contactId in a small set" (one indexed read per id).
- **`contacts.get` on a tombstone** returns `{ mergedInto }` so the UI
  can redirect.
- Dedupe exceptions ("not a duplicate" pairs) and candidate rules belong
  to the dedupe plan.

## Settled in review

The human answered both in grill round 4 of the contact-model plan
(`factory/plans/contact-model.sv`, 2026-10-17):

1. **Combining consent: the latest event wins**, per channel and purpose,
   across the identity set. It is the same person, so their most recent
   statement stands: a later withdrawal beats an earlier grant, and a
   genuine later grant beats an earlier withdrawal. Most-restrictive-wins
   was rejected because it ignores a real later grant.
2. **A tombstone keeps its name fields.** History shows "merged from Ann
   Smyth", and contact search includes tombstones and redirects to the
   survivor, so old names and spellings still find the person. Erasure
   of the survivor anonymises its tombstones (decision 6), so no personal
   data outlives the person's erasure.
