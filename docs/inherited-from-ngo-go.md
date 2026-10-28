# Inherited from ngo-go: what the code proved, and what to re-prove here

ngo-go (`../ngo-go`, Django) got as far as a working Contact slice on
the command layer before this repo replaced it (ADR 0017). The ADRs
carry the decisions; this page carries the **behaviour the code and
tests had pinned down** that the ADRs only imply. Treat it as the
acceptance checklist for spikes 2–4 in ADR 0017 and for the first
`convex/contacts/` module. Where this page and an ADR disagree, the ADR
wins; where this page and `docs/decisions/0013` disagree on child rows,
**ADR 0014 wins** (it revised 0013 after review).

## Where ngo-go's material went

| ngo-go | keep-together |
|---|---|
| `docs/research.md`, `docs/competition.md` | identical copies |
| `community-crm-brief.md` | `docs/product-brief.md` |
| ADRs 0001–0016 | copied; superseded ones carry a status line pointing at 0017 |
| `docs/hosting.md` | copied with a superseded header (0016/0017 cite it) |
| `docs/pi-extension-investigation.md` | copied with a "what still applies" header |
| `CLAUDE.md` rules | rewritten for Convex in `CLAUDE.md`, then for Rust (ADR 0024); domain rules unchanged |
| `backend/apps/core/{contracts,commands}.py` | not ported — behaviour listed below, rebuilt as `convex/lib/contracts.ts`, now `server/crates/contracts` |
| `backend/apps/contacts/*` | not ported — behaviour listed below |
| `backend/tests/*` | not ported — test inventory below |
| `extensions/example/` | not ported; extensions become a different bundle (0017) |

## Command layer (`execute_contract` → `executeContract`)

Order of operations inside one transaction, as ngo-go settled it after
an external review ("Harden the command layer", 2026-07-10):

1. Validate the payload against the contract (full state of its slice).
2. **Re-read the root document inside the transaction.** The handler
   must never see an instance loaded before another command landed, or a
   full-state save regresses other slices' counters and flags. On Convex
   every mutation is serializable so this is the default, but the
   handler must still work from `ctx.db.get(id)` inside the mutation, not
   from a document passed in by the client.
3. Check `expected` against the slice's counter; on mismatch fail with
   `{ kind: "stale", current }` and **leave no trace** (no revision, no
   counter bump).
4. Bump the counter, run the pure apply function, write root and
   children.
5. Append the revision: payload as stored, contract name, declared
   version, actor, `source` (`web` / `autosave` / `restore` / `import`
   / `test`), the counter value this command produced (0 = create),
   the command-group id if any, `restoredFrom` if a restore.

Other behaviour to keep:

- **Pre-generated root ids.** Creates accept an optional id minted at
  form render or by an import; a duplicate id is a distinct error
  (double submit, retried import) and the UI redirects to the existing
  entity. On update the payload id must equal the target's id. Convex
  mints `_id` itself, so the equivalent is a client-generated
  `clientKey` on creates with a `by_tenant_clientKey` index, or the
  create mutation being idempotent on it.
- **Child row ids and ownership.** Child rows in a payload carry ids.
  Reconcile by id: removed ids delete, new ids create, kept ids update
  in place **except identity fields** (email `address`, phone `number`),
  which are immutable per id; changing one is remove + add (the UI drops
  the row's id on the first keystroke into an identity field). Addresses
  have no identity field; every address field is correctable in place.
  A payload row id that belongs to a different root is rejected.
  Duplicate row ids in one payload are rejected. System-owned child
  fields (email `onHold`, owned by comms) survive every reconcile and
  every restore.
- **Named command groups.** An action runs several contracts in one
  mutation under a named group with an actor; revisions inside point to
  it. Restore, anonymise, merge and "contact form save" all use this.
  The history UI collapses a group into one timeline entry listing the
  slices it touched.
- **Schema identity.** A revision is interpretable only by its contract
  name + declared version. A version bump for a validator-only change
  (same fields) is still a new version, and restore of older revisions
  is gated on upcasters by declared version, never by field shape.
  Revisions newer than the running code are rejected.
- **Static upcaster check.** ngo-go had `check_contract_migrations`: for
  every (contract, version) present in stored revisions, verify a
  complete upcaster chain to the current version without executing
  anything. Here this is a test over the revisions table (or an internal
  query run before deploy).
- **Point-in-time restore of a whole aggregate** (`restore_entity_to`).
  Because contracts are full-state, no replay is needed: take the latest
  revision of each contract with `createdAt <= T`, skip any whose
  normalised payload equals the current latest (so the history entry
  shows only what changed), optionally exclude contracts (archive has
  its own toggle), re-execute the rest in one named group "restore to
  <moment>". Each re-executed revision records `source: "restore"` and
  `restoredFrom`. Restoring to the current moment is a no-op.
  Normalisation for comparison: child-row lists sorted by id, root id
  ignored.
- **Scope**: this is an operational command/snapshot log, not a
  compliance audit trail (ADR 0013 "Scope"). Erasure scrubs an entity's
  revisions as well as its documents.

## Contact slice (ADR 0014) — rules the validators and handlers enforced

Blocking (contract validator or apply function):

- Kind is one of individual / organization / household and is
  **immutable after creation** (CiviCRM allows changing it; bug farm).
- Individual: needs `lastName`; must not set `name`. Organization /
  household: needs `name`; must not set `firstName`, `lastName`,
  `birthDate`, `isDeceased`. `deceasedDate` requires `isDeceased`.
- Computed, system-owned: `displayName` ("First Last" or `name`),
  `sortName` ("Last, First" or `name`).
- Emails: duplicate addresses (case-insensitive) rejected; at most one
  primary; if none is primary the first becomes primary. Same primary
  rule for phones and addresses.
- Address: country is ISO 3166-1 alpha-2, upper-cased, default `GB`;
  postcode upper-cased and trimmed but **never rejected**.
- `externalIdentifier` unique per tenant when non-empty (import
  idempotency key). Here it became external identifiers (X1–X3): any
  number of `{type, value}` rows per contact in their own slice
  (`contacts.identifiers`); a (type, value) pair, matched trimmed and
  case-insensitively, belongs to at most one contact per tenant. Import
  retries are guarded by `clientKey`; identifiers are the matching key.
- Relationship is its own aggregate (spans two contacts): the two
  contacts must differ; `endDate` not before `startDate`; the type must
  be active; each side's kind must match the type's `kindA` / `kindB`
  when set. Recording a donation against a contact never bumps a
  contact counter.
- Four partitioned contracts and counters on Contact: details, methods
  (emails + phones), addresses, archive. Relationship has `save`.

Advisory (`warnings(contact)`, never blocks, shown amber; ADR 0015):

- No email, phone or address at all.
- An email that does not look like one (`@` and a dot after it).
- A `GB` postcode that fails `^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$`.
- Each warning is `{ anchor, label, message }`; anchors are field keys
  like `emails.0`, empty anchor = whole-entity notice.

Seeded relationship types (per tenant, editable later):

| A → B | B → A | kind A | kind B |
|---|---|---|---|
| Employee of | Employer of | individual | organization |
| Member of household | Household member is | individual | household |
| Head of household for | Head of household is | individual | household |
| Trustee of | Has trustee | individual | organization |
| Spouse/partner of | Spouse/partner of | individual | individual |
| Parent of | Child of | individual | individual |
| Volunteer for | Has volunteer | individual | organization |

## Form and conflict UX — what worked

ADR 0017 replaces htmx autosave with a live form doing a per-field
three-way merge, but these findings are independent of the transport:

- **One form, one endpoint, server decides what changed.** The whole
  form is submitted; the server splits it by contract field-set, diffs
  each slice's validated, normalised payload against current state and
  executes only changed slices. A no-op save creates nothing. On Convex
  the split can happen client-side only if the slice shapes come from
  the shared contract validators, never from hand-written lists.
- **Partial saves are correct behaviour.** A blocking error in one
  slice must not stop the other slices saving; a stale slice reports
  *who* changed it (actor of its latest revision) and never overwrites.
- **Errors and warnings share one inline slot per field; the error
  wins.** Both still reach the save pane. Field-less messages (whole-
  entity warnings, slice-level conflicts) need a dedicated placeholder
  at the top of the form, or they vanish.
- **Disable native HTML5 validation** (`noValidate`) — `type=email`
  inputs silently blocked submission so server validation never ran.
  Same trap exists in React forms.
- Forms send `""` for empty optional inputs; map to `undefined` / `null`
  at the boundary, once, not per field.
- A blank new child row and rows marked for removal are not part of the
  command; the removal marker never reaches a contract.
- After a structural change (row added / removed), re-render the row
  containers with server-minted ids; after a details change, update the
  header (display name). Never re-render the field the user is typing
  in. With live queries, ignore subscription echoes of your own last
  save by counter (ADR 0017).
- A "watch" signal while editing (ngo-go polled; here it is the live
  query) warns early that someone else saved a slice, naming them.
- Create flow: the form carries a pre-generated id so a double submit
  lands on the existing record.

## Test inventory (ngo-go had 80 tests; re-proved on `convex-test`, then as named Rust tests)

Command layer: create saves entity + revision (counter 0, source, no
group) · update bumps only its counter · stale `expected` conflicts ·
stale command leaves no trace · group shares a named group, later
commands do not · restore is a new command with `restoredFrom` and
counter +1 · version bump with same fields needs an upcaster · revision
newer than code rejected · missing upcaster steps listed statically ·
upcasters chain · every registered contract has a counter field on its
root and no two contracts share one (meta-test against the schema) ·
every root ships with its revision wiring.

Contacts: names computed per kind · per-kind requirement errors ·
deceased date requires flag · kind cannot change · replace-set ·
first entry promoted to primary · two primaries rejected · duplicate
emails rejected · postcode normalised · bad UK postcode saved and warned
· non-GB postcode not checked · **stale instance cannot regress other
slices** · kept ids leave rows untouched and `onHold` survives · identity
fields immutable per id · row id of another contact rejected · duplicate
row ids rejected · address fields update in place by id · restore
recreates removed rows with their ids · create with pre-generated id ·
duplicate create rejected · update with mismatched id rejected · nothing
references a child row (meta-test) · slices do not conflict with each
other · same slice conflicts · one revision stream per slice · archive
toggles · relationship: seeded types present, create, kind compatibility,
self-relationship rejected.

Form: list requires login · search by sort name or email, archived
hidden by default · create is idempotent · validation errors re-render
with values kept · no-op save creates no revisions · one changed slice =
one command · multi-slice save shares a group · new row returns ids ·
remove row · blocking error in one slice still saves the others ·
error in pane and inline · invalid email saves with warning inline and
in pane · error wins the inline slot · whole-contact warning in pane and
placeholder · bad postcode warns, not blocks · `noValidate` present ·
stale slice reports conflict · add-row reshape does not save · archive
toggle · restore to moment reverts whole contact · restore creates one
grouped entry · restore to current moment is a no-op · history groups a
multi-slice save.

Plus, new here: every fixture has two tenants and asserts tenant B sees
nothing (ADR 0017).

## Not carried, on purpose

Django admin as back-office (Convex dashboard + platform routes),
Jinja/htmx fragments, Pydantic composition of extension field groups
(`extend_contract` / `applies_extension`), `NGO_EXTENSIONS` env
composition, schema-per-tenant Postgres, DigitalOcean. Their reasoning
stays in the superseded ADRs.
