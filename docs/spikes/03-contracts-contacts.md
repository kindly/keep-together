# Spike 3 — `executeContract`, revisions, restore, and the Contact aggregate

Date: 2026-10-17 · Status: **done** — 61 tests over the command layer and
the Contact module, all green; acceptance list was
`docs/inherited-from-ngo-go.md`.

## Command layer (`convex/lib/contracts.ts`)

A contract is `defineContract({ name, entity, version, counter, fields,
prepare?, apply, upcasters? })`:

- `fields` is the payload validator (the full state of the slice) and is
  spread straight into the mutation's `args`.
- `prepare` is pure normalisation + blocking checks; what it returns is
  what is applied **and stored in the revision** (minted row keys,
  upper-cased postcodes, trimmed strings — history replays exactly what
  was applied).
- `apply` is pure state application over the scoped db, returning the root
  id. `root` is re-read inside the mutation, never taken from the client.

`executeContract(ctx, contract, payload, { entityId?, expected?, source,
group?, restoredFrom? })` validates, prepares, checks `expected` against
the slice's counter (`ConvexError { kind: 'stale', contract, current }`
— and because a mutation is one transaction, a stale command leaves no
trace), applies, bumps the counter, appends the revision.

One shared `revisions` table (decision from the round): `entity` +
`entityId` (string), `contract`, `version`, `counter`, `payload: v.any()`,
`actor`, `source`, `group`, `restoredFrom`. `commandGroups` names an
action; `restore` re-executes a revision as a new command via the upcaster
chain (declared version decides, never shape; newer-than-code and missing
steps are errors); `restoreEntityTo(at)` re-executes the latest revision
of each contract at or before `at`, skipping unchanged slices and excluded
contracts, inside one named group. `canonical()` is the order-independent
payload comparison (keyed child rows sorted).

Meta-test: every registered contract's counter is a `v.number()` field on
its root table and no two contracts share one.

## Contact module (`convex/contacts/`)

| File | Holds |
|---|---|
| `validators.ts` | payload validators (loose: types + references) |
| `rules.ts` | pure `prepare*` functions: per-kind rules, primaries, duplicates, postcode/country normalisation, dates |
| `warnings.ts` | advisory tier, shared with the UI |
| `contracts.ts` | `details`, `methods`, `addresses`, `archive`, `relationshipType`, `relationship`; child-row reconciliation |
| `queries.ts` | `list` (search index or sort index, ≤100), `get` (aggregate + warnings), `history` (moments) |
| `mutations.ts` | `create`, `save*`, `setArchived`, `saveForm`, `restoreRevision`, `restoreTo` |
| `relationships.ts`, `seed.ts` | relationship aggregate; per-tenant seeded UK types |

### Decisions made while porting

- **Child rows carry a client-minted `key`** (UUID), not `_id`: Convex
  mints `_id` itself and never twice, and ngo-go's test "restore recreates
  removed rows with their ids" only holds if the identity is ours. `key`
  is unique per tenant (`by_tenant_key`), so a payload row belonging to
  another contact is caught. Identity fields (email `address`, phone
  `number`) are immutable per key; addresses are fully editable in place.
- **Idempotent creates** use `clientKey` + `by_tenant_clientKey` (the
  round's choice); a repeat returns `rejected / duplicate` carrying the
  existing id for the UI to redirect to.
- **`saveForm` does the diffing server-side**, per ngo-go's lesson: each
  submitted slice is prepared, compared canonically against current
  state, and only changed slices execute; a slice that fails blocking
  validation or is stale is reported (`problems` / `stale`) and the rest
  still save; >1 changed slices share a `contact form save` group.
  Apply-level rejections (immutable child, ownership) still abort the
  whole save — they are client bugs, not user input.
- `source` gained `autosave`, `seed`, `test`; `birthDate` and friends are
  ISO strings, optional = absent.
- Actor names: domain code cannot read `users`; `platform.tenants.members`
  gives the UI `{userId, name}` to render "changed by …".

### What the 61 tests cover

Command layer: create/update counters, stale conflicts leaving no trace,
restore as a new command with `restoredFrom`, newer-than-code and missing
upcasters, upcaster chaining, canonical ordering, registry meta-test.
Contacts: names per kind, per-kind validation, deceased date, kind
immutability, clientKey idempotency, external identifier uniqueness per
tenant (and allowed across tenants), replace-set, primary promotion, two
primaries, duplicate emails, malformed email warned not blocked, `onHold`
survives, identity immutability, foreign row key, duplicate keys, postcode
normalisation and warning, non-GB untouched, in-place address edits,
slice independence, same-slice conflict, archive, every `saveForm`
behaviour, restore of removed rows by key, point-in-time restore grouped
and badged, no-op restore, seeded types, relationship direction labels,
kind compatibility, self-relationship, and tenant isolation.

## Not done

- Relationship *types* have no UI mutation beyond `saveType`; dedupe/merge
  and anonymisation (actions over the slices + revision scrubbing) are
  the next slices, as ADR 0014 lists.
- The static "every stored version has an upcaster chain" check exists as
  `missingUpcasterSteps` but is not yet run as a pre-deploy test over a
  real deployment's revisions.
