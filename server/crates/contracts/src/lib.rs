//! Contracts: the single write path for domain state (ADR 0013 / 0017),
//! the SQLite counterpart of `convex/lib/contracts.ts`.
//!
//! A contract owns a disjoint slice of an aggregate root and one integer
//! counter column on it. [`execute`] runs, inside the caller's
//! `BEGIN IMMEDIATE` transaction on one org file:
//!
//!   prepare (normalise + invariant checks)
//!     → read the root's counter (fresh, in-transaction)
//!     → check `expected` (stale ⇒ `Stale` carrying the slice's current
//!       state, nothing written)
//!     → load the slice; on restore, the contract's `restore_payload`
//!     → run the pure `apply(current, payload) -> next`
//!     → `write` the next state, bump the counter
//!     → append a revision (prepared payload + contract name + version)
//!     → run the `project` hook (derived rows, same transaction)
//!
//! Restore re-executes a stored payload as a NEW command, chaining
//! upcasters by declared version. Nothing is ever rewound.
//!
//! **Sealed write path.** This crate is the only way to write an org file
//! (domain crates don't depend on `store`). [`transact`] opens the
//! transaction and hands domain code an [`OrgTx`], which has no `Deref` to
//! a connection and no write method: [`OrgTx::read`] gives a connection
//! that is `query_only` for the whole transaction. The only writable
//! connections are the [`WriteTx`] a contract's `write` gets and the
//! [`ProjectionTx`] its `project` hook gets, which only [`execute`] (and
//! [`reproject`]) can construct. Each executed contract emits an
//! [`OrgEvent`], published after commit.

mod children;
pub mod history;
mod restore;

use std::collections::HashMap;
use std::ops::Deref;

use rusqlite::{Connection, OptionalExtension, params};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use store::{OrgDb, OrgEvent, RawTx};
use ts_rs::TS;

pub use children::{ChildRow, Reconciled, is_client_id, mint_ids, reconcile};
pub use restore::{
    Revision, Upto, canonical, history, restore, restore_entity_to, restore_entity_upto,
};

/// The org-schema migration this crate owns. Composed into the org
/// migration list (`api::schema`) before any domain table.
pub const MIGRATION: &str = "
CREATE TABLE command_groups (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    actor INTEGER,
    at INTEGER NOT NULL
) STRICT;
CREATE TABLE revisions (
    id INTEGER PRIMARY KEY,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    contract TEXT NOT NULL,
    version INTEGER NOT NULL,
    counter INTEGER NOT NULL,
    payload TEXT NOT NULL,
    actor INTEGER,
    source TEXT NOT NULL,
    group_id INTEGER REFERENCES command_groups(id),
    group_name TEXT,
    restored_from INTEGER REFERENCES revisions(id),
    at INTEGER NOT NULL
) STRICT;
CREATE INDEX revisions_by_entity ON revisions (entity, entity_id, id);
CREATE INDEX revisions_by_entity_contract ON revisions (entity, entity_id, contract, id);
";

/// Where a command came from (the same values as Convex's `revisionSource`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Source {
    Ui,
    Autosave,
    Import,
    Restore,
    Seed,
    System,
    Test,
    /// Provider events (a hard bounce).
    Comms,
}

impl Source {
    fn as_str(self) -> &'static str {
        match self {
            Source::Ui => "ui",
            Source::Autosave => "autosave",
            Source::Import => "import",
            Source::Restore => "restore",
            Source::Seed => "seed",
            Source::System => "system",
            Source::Test => "test",
            Source::Comms => "comms",
        }
    }

    /// A stored `revisions.source`; unknown values read as `System`.
    pub fn parse(s: &str) -> Self {
        serde_json::from_value(Value::String(s.into())).unwrap_or(Source::System)
    }
}

/// A blocking validation failure on one field (ADR 0015 tier 1).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Problem {
    pub field: String,
    pub message: String,
}

impl Problem {
    pub fn new(field: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            field: field.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ContractError {
    /// `expected` didn't match. `current` is the slice's state now, so the
    /// caller can merge without another read.
    #[error("{contract}: stale (counter is {counter})")]
    Stale {
        contract: &'static str,
        counter: i64,
        current: Value,
    },
    #[error("not found")]
    NotFound,
    /// A create with a pre-generated id that already exists (ADR 0014:
    /// idempotent creates).
    #[error("{id} already exists")]
    Duplicate { id: String },
    #[error("invalid: {0:?}")]
    Invalid(Vec<Problem>),
    /// The handler refused the command (kind change, immutable child …).
    #[error("rejected ({reason}): {message}")]
    Rejected { reason: String, message: String },
    #[error("unknown contract {0}")]
    UnknownContract(String),
    #[error("{contract}: stored version {stored} is newer than code version {code}")]
    NewerThanCode {
        contract: String,
        stored: u32,
        code: u32,
    },
    #[error("{contract}: no upcaster from version {from}")]
    MissingUpcaster { contract: String, from: u32 },
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl ContractError {
    pub fn invalid(field: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Invalid(vec![Problem::new(field, message)])
    }

    pub fn rejected(reason: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Rejected {
            reason: reason.into(),
            message: message.into(),
        }
    }
}

/// A write transaction on one organisation's file, as domain code sees
/// it: reads through [`OrgTx::read`], writes only through [`execute`].
///
/// Sealed (M3). Each `compile_fail` case below has a twin that does
/// compile and differs only in the forbidden part: stable rustdoc doesn't
/// check a `compile_fail` block's error code, so the twin is what proves
/// the failure is the seal (not, say, a missing import).
///
/// Domain code holding a transaction can't run raw SQL on it …
/// ```compile_fail
/// fn handler(ctx: &contracts::Ctx) -> rusqlite::Result<usize> {
///     ctx.tx.execute("DELETE FROM contacts", [])
/// }
/// ```
/// ```
/// fn handler(ctx: &contracts::Ctx) -> rusqlite::Result<usize> {
///     ctx.tx.read().execute("DELETE FROM contacts", []) // compiles; query_only refuses it
/// }
/// ```
/// … can't treat it as a connection …
/// ```compile_fail
/// fn handler(ctx: &contracts::Ctx) {
///     let _conn: &rusqlite::Connection = ctx.tx;
/// }
/// ```
/// ```
/// fn handler(ctx: &contracts::Ctx) {
///     let _conn: &rusqlite::Connection = ctx.tx.read();
/// }
/// ```
/// … can't forge a writable connection from the read view …
/// ```compile_fail
/// fn handler(ctx: &contracts::Ctx) {
///     let _ = contracts::WriteTx(ctx.tx.read());
/// }
/// ```
/// ```compile_fail
/// fn handler(ctx: &contracts::Ctx) {
///     let _ = contracts::ProjectionTx(ctx.tx.read());
/// }
/// ```
/// ```
/// fn handler(_: &contracts::Ctx, w: &contracts::WriteTx, p: &contracts::ProjectionTx) {
///     let _: (&rusqlite::Connection, &rusqlite::Connection) = (w, p);
/// }
/// ```
/// … and can't wrap some other transaction in an `OrgTx`.
/// ```compile_fail
/// fn forge<'a>(raw: &'a store::RawTx<'a>) -> contracts::OrgTx<'a> {
///     contracts::OrgTx { raw }
/// }
/// ```
/// ```
/// fn forge<'a>(raw: &'a store::RawTx<'a>) -> &'a rusqlite::Connection {
///     raw.conn()
/// }
/// ```
pub struct OrgTx<'a> {
    raw: &'a RawTx<'a>,
}

impl OrgTx<'_> {
    /// The transaction's connection, `query_only`: it sees this
    /// transaction's own writes, and any write through it fails.
    pub fn read(&self) -> &Connection {
        self.raw.conn()
    }

    /// Lift `query_only` for `f` (a contract's write, its revision, its
    /// projection), then put it back, whatever `f` returned.
    fn writes<R>(
        &self,
        f: impl FnOnce(&Connection) -> Result<R, ContractError>,
    ) -> Result<R, ContractError> {
        self.raw.set_query_only(false)?;
        let out = f(self.raw.conn());
        self.raw.set_query_only(true)?;
        out
    }
}

/// The writable connection a contract's `write` gets. Only [`execute`]
/// constructs one.
pub struct WriteTx<'a>(&'a Connection);

impl Deref for WriteTx<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.0
    }
}

impl WriteTx<'_> {
    /// The next value of a single-row sequence table
    /// (`id INTEGER PRIMARY KEY, next INTEGER NOT NULL`), starting at
    /// `first`. For system-owned numbers a create hands out.
    pub fn take_sequence(&self, table: &str, first: i64) -> rusqlite::Result<i64> {
        let next: Option<i64> = self
            .0
            .query_row(&format!("SELECT next FROM {table} WHERE id = 1"), [], |r| {
                r.get(0)
            })
            .optional()?;
        let value = next.unwrap_or(first);
        self.0.execute(
            &format!(
                "INSERT INTO {table} (id, next) VALUES (1, ?1)
                 ON CONFLICT (id) DO UPDATE SET next = excluded.next"
            ),
            [value + 1],
        )?;
        Ok(value)
    }
}

/// The connection a contract's `project` hook gets: for derived rows
/// (search) rebuilt from the root's state. Only [`execute`] and
/// [`reproject`] construct one, and while it is in use the connection may
/// write only the contract's `PROJECTIONS` tables: a write to a domain
/// table (which would skip its counter and revision) is refused when the
/// statement is prepared.
pub struct ProjectionTx<'a>(&'a Connection);

impl Deref for ProjectionTx<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.0
    }
}

/// Run `f` in one `BEGIN IMMEDIATE` transaction on `db`, as `actor`:
/// commit on `Ok`, roll back on `Err`; the events of the contracts it
/// executed are published after the commit. Blocking.
pub fn transact<T, E>(
    db: &OrgDb,
    actor: Option<i64>,
    f: impl FnOnce(&Ctx) -> Result<T, E>,
) -> Result<T, E>
where
    E: From<rusqlite::Error>,
{
    db.write_raw(|raw| {
        raw.set_query_only(true)?;
        let tx = OrgTx { raw };
        f(&Ctx::new(&tx, actor))
    })
}

/// Who and when, fixed once per command (so apply stays pure: restore
/// re-runs it with the restore's own time).
#[derive(Clone, Debug)]
pub struct Command {
    pub at: i64,
    pub actor: Option<i64>,
    pub source: Source,
}

/// The transaction a set of commands runs in, and who runs them.
/// `at` is ms since the epoch.
pub struct Ctx<'t, 'c> {
    pub tx: &'t OrgTx<'c>,
    pub actor: Option<i64>,
    pub at: i64,
}

impl<'t, 'c> Ctx<'t, 'c> {
    pub fn new(tx: &'t OrgTx<'c>, actor: Option<i64>) -> Self {
        Self {
            tx,
            actor,
            at: now_ms(),
        }
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A fresh entity or child-row id: UUIDv7, simple form.
pub fn new_id() -> String {
    uuid::Uuid::now_v7().simple().to_string()
}

pub trait Contract: Sync + 'static {
    /// Stable dotted name, e.g. "contacts.details".
    const NAME: &'static str;
    /// Bump whenever the payload shape or semantics change; add an upcaster.
    const VERSION: u32;
    /// The root table. Its `id` column is TEXT; every counter column on it
    /// is `INTEGER NOT NULL DEFAULT 0`.
    const ENTITY: &'static str;
    /// The counter column this contract owns on the root.
    const COUNTER: &'static str;
    /// The derived tables `project` writes (e.g. an FTS table). Inside the
    /// hook every other write is refused.
    const PROJECTIONS: &'static [&'static str] = &[];

    /// The full state of the slice, as the client sends it.
    type Payload: Serialize + DeserializeOwned;
    /// The slice as stored; also what a stale refusal returns.
    type State: Serialize;

    /// Pure normalisation + blocking checks. Returns the payload that is
    /// applied AND stored in the revision (minted child ids, trimmed
    /// strings are what history replays).
    fn prepare(&self, payload: Self::Payload) -> Result<Self::Payload, ContractError> {
        Ok(payload)
    }

    /// The slice's current state. Called only when the root exists.
    fn load(&self, tx: &OrgTx, id: &str) -> Result<Self::State, ContractError>;

    /// Pure state application: nothing time-dependent beyond `command.at`.
    /// `current` is `None` on create.
    fn apply(
        &self,
        current: Option<&Self::State>,
        payload: &Self::Payload,
        command: &Command,
    ) -> Result<Self::State, ContractError>;

    /// Persist `next`. On create (`before` is `None`) this inserts the root
    /// row; it must touch only this slice's columns and child tables, and
    /// preserve system-owned fields no payload carries.
    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&Self::State>,
        next: &Self::State,
    ) -> Result<(), ContractError>;

    /// Rebuild derived rows (search) from the root's new state.
    fn project(&self, _tx: &ProjectionTx, _id: &str) -> Result<(), ContractError> {
        Ok(())
    }

    /// One upcast step: a payload at `from` to `from + 1`. `None` = no
    /// upcaster registered for that step.
    fn upcast(&self, _from: u32, _payload: Value) -> Option<Value> {
        None
    }

    /// The slice's payload before anything was written to it, if it has
    /// one (child rows: none). A restore to a moment before the slice's
    /// first revision writes this; a slice without one (written at
    /// create) is left as it is.
    fn empty(&self) -> Option<Self::Payload> {
        None
    }

    /// Restore only: what can be written back now (e.g. a retired dropdown
    /// option dropped), which is applied *and* recorded. `restored_at` is
    /// when the restored revision was written (ms; `command.at` when the
    /// command names none).
    fn restore_payload(
        &self,
        _tx: &OrgTx,
        payload: Self::Payload,
        _current: &Self::State,
        _restored_at: i64,
    ) -> Result<Self::Payload, ContractError> {
        Ok(payload)
    }
}

/// A named group of commands ("contact form save", "restore to …").
#[derive(Clone, Debug)]
pub struct CommandGroup {
    pub id: i64,
    pub name: String,
}

pub fn command_group(ctx: &Ctx, name: &str) -> Result<CommandGroup, ContractError> {
    let id = ctx.tx.writes(|conn| {
        conn.execute(
            "INSERT INTO command_groups (name, actor, at) VALUES (?1, ?2, ?3)",
            params![name, ctx.actor, ctx.at],
        )?;
        Ok(conn.last_insert_rowid())
    })?;
    Ok(CommandGroup {
        id,
        name: name.into(),
    })
}

#[derive(Clone, Debug)]
enum Target<'a> {
    Create(Option<&'a str>),
    Update(&'a str),
}

/// How to execute one command.
#[derive(Clone, Debug)]
pub struct Exec<'a> {
    target: Target<'a>,
    expected: Option<i64>,
    source: Source,
    group: Option<&'a CommandGroup>,
    restored_from: Option<i64>,
    /// A restore naming no revision (a slice back to empty): the moment
    /// it restores to, for `restore_payload`.
    restored_at: Option<i64>,
}

impl<'a> Exec<'a> {
    /// Create a new root, with a fresh id.
    pub fn create(source: Source) -> Self {
        Self {
            target: Target::Create(None),
            expected: None,
            source,
            group: None,
            restored_from: None,
            restored_at: None,
        }
    }

    /// Create a new root with a pre-generated id (form render, import);
    /// an existing id is `Duplicate`.
    pub fn create_with_id(id: &'a str, source: Source) -> Self {
        Self {
            target: Target::Create(Some(id)),
            ..Self::create(source)
        }
    }

    /// Update an existing root. Forms always pass `expected`; `None` is
    /// for trusted internal callers (seeds, migrations) only.
    pub fn update(id: &'a str, expected: Option<i64>, source: Source) -> Self {
        Self {
            target: Target::Update(id),
            expected,
            ..Self::create(source)
        }
    }

    pub fn in_group(mut self, group: &'a CommandGroup) -> Self {
        self.group = Some(group);
        self
    }
}

/// What a command produced: the root id and this slice's new counter.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Executed {
    pub id: String,
    #[ts(type = "number")]
    pub counter: i64,
}

fn read_counter<C: Contract>(tx: &OrgTx, id: &str) -> rusqlite::Result<Option<i64>> {
    tx.read()
        .query_row(
            &format!("SELECT {} FROM {} WHERE id = ?1", C::COUNTER, C::ENTITY),
            [id],
            |r| r.get(0),
        )
        .optional()
}

pub fn execute<C: Contract>(
    ctx: &Ctx,
    contract: &C,
    payload: C::Payload,
    opts: Exec,
) -> Result<Executed, ContractError> {
    let tx = ctx.tx;
    let mut payload = contract.prepare(payload)?;
    let command = Command {
        at: ctx.at,
        actor: ctx.actor,
        source: opts.source,
    };

    let (id, before, counter) = match opts.target {
        Target::Create(id) => {
            if let Some(id) = id
                && !is_client_id(id)
            {
                return Err(ContractError::invalid("id", "32 lower-case hex characters"));
            }
            let id = id.map(str::to_owned).unwrap_or_else(new_id);
            let exists: bool = tx.read().query_row(
                &format!("SELECT EXISTS (SELECT 1 FROM {} WHERE id = ?1)", C::ENTITY),
                [&id],
                |r| r.get(0),
            )?;
            if exists {
                return Err(ContractError::Duplicate { id });
            }
            (id, None, 0)
        }
        Target::Update(id) => {
            let current = read_counter::<C>(tx, id)?.ok_or(ContractError::NotFound)?;
            let state = contract.load(tx, id)?;
            if let Some(expected) = opts.expected
                && expected != current
            {
                return Err(ContractError::Stale {
                    contract: C::NAME,
                    counter: current,
                    current: serde_json::to_value(&state)?,
                });
            }
            if opts.source == Source::Restore {
                let restored_at = match opts.restored_from {
                    Some(revision) => tx
                        .read()
                        .query_row("SELECT at FROM revisions WHERE id = ?1", [revision], |r| {
                            r.get(0)
                        })
                        .optional()?
                        .unwrap_or(command.at),
                    None => opts.restored_at.unwrap_or(command.at),
                };
                payload = contract.restore_payload(tx, payload, &state, restored_at)?;
            }
            (id.to_owned(), Some(state), current + 1)
        }
    };

    let next = contract.apply(before.as_ref(), &payload, &command)?;
    let seq = tx.writes(|conn| {
        atomically(conn, || {
            contract.write(&WriteTx(conn), &id, before.as_ref(), &next)?;
            let bumped = conn.execute(
                &format!("UPDATE {} SET {} = ?1 WHERE id = ?2", C::ENTITY, C::COUNTER),
                params![counter, id],
            )?;
            if bumped != 1 {
                // A create whose `write` didn't insert the root.
                return Err(ContractError::NotFound);
            }
            conn.execute(
                "INSERT INTO revisions (entity, entity_id, contract, version, counter, payload,
                 actor, source, group_id, group_name, restored_from, at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    C::ENTITY,
                    id,
                    C::NAME,
                    C::VERSION,
                    counter,
                    serde_json::to_string(&payload)?,
                    command.actor,
                    command.source.as_str(),
                    opts.group.map(|g| g.id),
                    opts.group.map(|g| g.name.as_str()),
                    opts.restored_from,
                    command.at,
                ],
            )?;
            let seq = conn.last_insert_rowid();
            project(tx, contract, conn, &id)?;
            Ok(seq)
        })
    })?;
    tx.raw.emit(OrgEvent {
        seq,
        entity: C::ENTITY.into(),
        id: id.clone(),
        contract: C::NAME.into(),
        counter,
    });
    Ok(Executed { id, counter })
}

/// Run `f` under a savepoint: on error, everything it wrote is undone, so
/// a caller that catches the error and carries on (a form saving the
/// slices that can save) commits none of a half-run command. Convex gets
/// this from a throw aborting the mutation.
fn atomically<T>(
    conn: &Connection,
    f: impl FnOnce() -> Result<T, ContractError>,
) -> Result<T, ContractError> {
    conn.execute_batch("SAVEPOINT contract_execute")?;
    match f() {
        Ok(out) => {
            conn.execute_batch("RELEASE contract_execute")?;
            Ok(out)
        }
        Err(err) => {
            conn.execute_batch("ROLLBACK TO contract_execute; RELEASE contract_execute")?;
            Err(err)
        }
    }
}

/// Rebuild one root's derived rows outside a command (a projection's
/// backfill). No counter, no revision, no event.
pub fn reproject<C: Contract>(ctx: &Ctx, contract: &C, id: &str) -> Result<(), ContractError> {
    ctx.tx.writes(|conn| project(ctx.tx, contract, conn, id))
}

/// Run `project` with writes narrowed to the contract's projections.
fn project<C: Contract>(
    tx: &OrgTx,
    contract: &C,
    conn: &Connection,
    id: &str,
) -> Result<(), ContractError> {
    /// Ends the scope however `project` ends, a panic included: the
    /// unwinding transaction's ROLLBACK must not run inside the scope.
    struct Scoped<'r>(&'r RawTx<'r>);
    impl Drop for Scoped<'_> {
        fn drop(&mut self) {
            self.0.narrow_writes_to(None);
        }
    }
    tx.raw.narrow_writes_to(Some(C::PROJECTIONS));
    let _scoped = Scoped(tx.raw);
    contract.project(&ProjectionTx(conn), id)
}

/// A contract with its types erased, for restore (which finds the
/// contract by the name stored on a revision).
pub trait DynContract: Sync {
    fn name(&self) -> &'static str;
    fn version(&self) -> u32;
    fn entity(&self) -> &'static str;
    fn counter(&self) -> &'static str;
    fn upcast_step(&self, from: u32, payload: Value) -> Option<Value>;
    /// [`Contract::empty`], as a payload at the code's version.
    fn empty_value(&self) -> Option<Value>;
    fn execute_value(
        &self,
        ctx: &Ctx,
        payload: Value,
        opts: Exec,
    ) -> Result<Executed, ContractError>;
}

impl<C: Contract> DynContract for C {
    fn name(&self) -> &'static str {
        C::NAME
    }
    fn version(&self) -> u32 {
        C::VERSION
    }
    fn entity(&self) -> &'static str {
        C::ENTITY
    }
    fn counter(&self) -> &'static str {
        C::COUNTER
    }
    fn upcast_step(&self, from: u32, payload: Value) -> Option<Value> {
        self.upcast(from, payload)
    }
    fn empty_value(&self) -> Option<Value> {
        self.empty().and_then(|p| serde_json::to_value(p).ok())
    }
    fn execute_value(
        &self,
        ctx: &Ctx,
        payload: Value,
        opts: Exec,
    ) -> Result<Executed, ContractError> {
        let payload = serde_json::from_value(payload)
            .map_err(|e| ContractError::invalid("", format!("{}: {e}", C::NAME)))?;
        execute(ctx, self, payload, opts)
    }
}

/// Every contract restore may meet, by name.
pub struct Registry(HashMap<&'static str, &'static dyn DynContract>);

impl Registry {
    pub fn new(contracts: &[&'static dyn DynContract]) -> Self {
        let mut map = HashMap::new();
        for c in contracts {
            assert!(
                map.insert(c.name(), *c).is_none(),
                "duplicate contract {}",
                c.name()
            );
        }
        Self(map)
    }

    pub fn get(&self, name: &str) -> Option<&'static dyn DynContract> {
        self.0.get(name).copied()
    }

    /// Every registered contract, by name.
    pub fn contracts(&self) -> impl Iterator<Item = &'static dyn DynContract> + '_ {
        let mut all: Vec<_> = self.0.values().copied().collect();
        all.sort_by_key(|c| c.name());
        all.into_iter()
    }

    /// Upcast steps a contract's version needs and doesn't have: each
    /// `(name, from)`. Empty when every stored version can be restored.
    pub fn missing_upcasters(&self) -> Vec<(&'static str, u32)> {
        let probe = Value::Object(Default::default());
        let mut missing = Vec::new();
        for c in self.contracts() {
            for from in 1..c.version() {
                if c.upcast_step(from, probe.clone()).is_none() {
                    missing.push((c.name(), from));
                }
            }
        }
        missing
    }
}

/// Bring a stored payload forward to the code's version.
pub fn upcast(
    contract: &dyn DynContract,
    mut payload: Value,
    from: u32,
) -> Result<Value, ContractError> {
    if from > contract.version() {
        return Err(ContractError::NewerThanCode {
            contract: contract.name().into(),
            stored: from,
            code: contract.version(),
        });
    }
    for version in from..contract.version() {
        payload = contract.upcast_step(version, payload).ok_or_else(|| {
            ContractError::MissingUpcaster {
                contract: contract.name().into(),
                from: version,
            }
        })?;
    }
    Ok(payload)
}

pub(crate) fn source_from_db(s: &str) -> Source {
    Source::parse(s)
}
