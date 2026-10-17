# 0013 — Model layer: aggregates, contract revisions, restore, concurrency

Status: accepted (2026-07)

## Context

Versioning must be baked in before the first domain model. Requirements:
inspectable history at the level users think in ("what did this form say
at time T"), typed payloads that stay interpretable across schema changes,
per-client extension awareness, and concurrent-edit protection. Table-level
tools (django-pghistory et al.) capture row deltas but reconstructing a
multi-table form state from them is painful; untyped JSON snapshot tables
drift after migrations. The contracts layer (ADR 0012) gives a single
validated write path — so history is recorded there, at **command**
granularity.

## Decision

### Aggregates and identity

- `BaseModel` (every table): **UUIDv7** pk (time-ordered — no index
  penalty, non-enumerable URLs, pipeline-friendly), created/updated
  timestamps.
- `EntityModel` marks aggregate roots — the things contracts target.
  Child tables are plain `BaseModel`: only ever written through a command
  against their root, never FK'd from outside the aggregate. Human-facing
  reference numbers, where needed, are explicit domain fields — never pks.

### Contracts partition the aggregate

**No two contracts touch the same fields.** Each contract owns a disjoint
slice of its entity (columns and/or child tables) and declares an integer
**counter column** on the entity (`@contract(..., counter="details_version")`)
— finite, known at code time, plain typed columns, one per contract.
System-managed columns (computed names, bounce flags, timestamps,
counters) belong to no contract.

Operations spanning slices are **actions**, not contracts: a service
function using `command_group(name)` to execute several section contracts
in one transaction. A named `CommandGroup` row (with actor) is created and
every revision inside points to it, so a multi-contract operation (e.g.
anonymise = details + methods + addresses) reads as one named event while
each section's history stream stays linear and complete. Child rows with
independently owned state (e.g. an email's comms-owned `on_hold`) must be
carried across replace-sets by the handler — id-less children only work
when handlers preserve system-owned columns.

### Command log (the history mechanism)

- `ContractSchema` (core): registry of every composed contract shape ever
  used on this instance. The identity hash fingerprints
  **{name, entity, declared version, JSON Schema}** — a version bump for
  validator/semantic changes gets a new identity even when the field
  shape is unchanged, so restore never skips a migration.
- One **revision table per entity type** subclassing
  `ContractRevisionBase`: real FK to the entity, cleaned `model_dump`
  payload, schema FK, actor, source, `counter` (the value the command
  produced), `group`, timestamp.
- `execute_contract()` (`apps/core/commands.py`) is **the single write
  path**: validate → `SELECT FOR UPDATE` and **re-fetch the entity**
  (handlers must never see an instance loaded before another command
  landed — a stale full save would regress other sections' state) → bump
  the contract's counter (checked against `expected=N` when the caller
  passes it; views always do) → run the registered pure handler → run
  extension persistence hooks → append revision, in one transaction.
- Extensions persist their contract field groups via
  `@applies_extension(name, extension=...)` hooks (writing to
  extension-owned tables), dispatched inside `execute_contract` so saves
  and restores behave identically. Extension groups whose fields all have
  defaults compose as optional — stock payloads keep validating and
  enable/disable stays bridgeable. (Per-group versioning/upcasters for
  extension field groups: future work, tracked here.)
- Handlers (`@applies`) are **pure state application** — no side effects,
  nothing time-dependent. Contracts are **full-state** for their slice,
  so any single revision is independently restorable; child rows are
  id-less replace-sets.

### Restore and contract migrations

- `restore(revision)` re-executes a stored payload as a **new command**
  (`source="restore"`, `restored_from` pointing at the source revision) —
  history is append-only, nothing rewinds. Migration is decided by
  comparing declared versions (never schema hashes); revisions newer than
  the running code are rejected.
- Contract shape changes bump the code version and register an upcaster
  (`@contract_migration(name, from_version=N)`); restore chains them.
  Extension-set differences are auto-bridged. `manage.py
  check_contract_migrations` **statically** verifies every stored version
  has a complete upcaster chain (no upcasters are executed) — run before
  upgrades.

### Scope: operational history, not an audit log

This layer is a **versioned command/snapshot log**: user-facing history,
undo, and conflict handling. It is deliberately *not* compliance-grade
audit — revisions cascade with their entity (GDPR-friendly), actor FKs
null on user deletion (convention: deactivate staff, never delete), and
append-only-ness is enforced by code paths, not the database. Financial
and consent records (per the domain invariants) are explicit append-only
domain rows with no generic restore; whether a separate tamper-evident
audit trail is needed is decided with the giving slice.

### Concurrency UX

- Forms carry their contract's counter; `expected=` makes the bump
  conditional — `StaleVersionError` re-renders with the user's values and
  a conflict notice. Different sections of the same entity **never
  falsely conflict** (separate counters by construction).
- Edit screens add an htmx poll fragment comparing the form's counter to
  current, warning early with the diff from the latest revision (built
  with the first edit screen). Per-field autosave is explicitly out.

### Boundaries and rejections

- Extensions may extend existing contracts (field groups — same counter);
  a new contract on a **core** entity needs a counter column it can't
  add, so extension-defined contracts target extension-owned entities
  (or the operation gets upstreamed).
- **Rejected:** django-pghistory / simple-history / reversion (row deltas
  don't answer form-level questions; pghistory remains the fallback if a
  bypass path ever needs auditing — instead domain admin is read-only via
  `ReadOnlyAdmin`); a JSONB counter map on the root (real columns are
  simpler and typed); whole-aggregate untyped JSON snapshots (the GEM
  pattern — kept the one-row inspectability, fixed the drift).

## Consequences

- Every new entity ships as a set: `EntityModel` subclass + counter
  column per contract + revision model + `register_entity` + contracts +
  handlers — the meta-tests in `tests/test_commands.py` enforce it.
- GDPR erasure must scrub the entity's revision rows as well as its
  domain rows (anonymisation is irreversible by design).
- Financial/Gift Aid revisions are kept forever; other entities get a
  documented retention policy when they arrive.
- Contract shape changes without a version bump are a review error.
