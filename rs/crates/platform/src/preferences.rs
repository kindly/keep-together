//! Per-organisation preferences: plain, non-secret switches an admin sets
//! on the Settings page (`convex/platform/preferences.ts`). One row at
//! most, in the org file, created by the first save; no row means every
//! default.
//!
//! `staffCanManageIdentifierTypes`, `staffCanManageSourceCodes` and
//! `staffCanManageFields` (each default off, independent): whether staff,
//! as well as admins, may manage that list (`convex/lib/lists.ts`). Each is
//! its own contract with its own counter, so switching one never conflicts
//! with another.

use contracts::{
    Command, Contract, ContractError, Ctx, Exec, Executed, OrgTx, Source, WriteTx, execute,
};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use store::Role;
use ts_rs::TS;

/// Org schema step: the preferences row. `singleton` keeps it to one.
pub const MIGRATION: &str = "
CREATE TABLE tenant_preferences (
    id TEXT PRIMARY KEY,
    singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
    staff_can_manage_identifier_types INTEGER NOT NULL DEFAULT 0
        CHECK (staff_can_manage_identifier_types IN (0, 1)),
    identifier_types_version INTEGER NOT NULL DEFAULT 0,
    staff_can_manage_source_codes INTEGER NOT NULL DEFAULT 0
        CHECK (staff_can_manage_source_codes IN (0, 1)),
    source_codes_version INTEGER NOT NULL DEFAULT 0,
    staff_can_manage_fields INTEGER NOT NULL DEFAULT 0
        CHECK (staff_can_manage_fields IN (0, 1)),
    fields_version INTEGER NOT NULL DEFAULT 0
) STRICT;
";

const ENTITY: &str = "tenant_preferences";

/// The lists an organisation's staff may be allowed to manage, one switch
/// each (`lib/lists.ts` `ListKind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ListKind {
    IdentifierTypes,
    SourceCodes,
    Fields,
}

impl ListKind {
    pub const ALL: [ListKind; 3] = [
        ListKind::IdentifierTypes,
        ListKind::SourceCodes,
        ListKind::Fields,
    ];

    fn switch_column(self) -> &'static str {
        match self {
            ListKind::IdentifierTypes => "staff_can_manage_identifier_types",
            ListKind::SourceCodes => "staff_can_manage_source_codes",
            ListKind::Fields => "staff_can_manage_fields",
        }
    }

    const fn counter_column(self) -> &'static str {
        match self {
            ListKind::IdentifierTypes => "identifier_types_version",
            ListKind::SourceCodes => "source_codes_version",
            ListKind::Fields => "fields_version",
        }
    }
}

/// Whether the organisation lets staff manage `kind` (no row: no).
/// `conn` is the org file's connection (an `OrgRead`, or `ctx.tx.read()`).
pub fn staff_may_manage(conn: &Connection, kind: ListKind) -> rusqlite::Result<bool> {
    Ok(conn
        .query_row(
            &format!("SELECT {} FROM {ENTITY}", kind.switch_column()),
            [],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(false))
}

/// Whether `role` may manage `kind` (`lib/lists.ts` `mayManageList`):
/// admins always, staff while that list's switch is on, viewers never.
pub fn may_manage_list(conn: &Connection, role: Role, kind: ListKind) -> rusqlite::Result<bool> {
    match role {
        Role::Admin => Ok(true),
        Role::Staff => staff_may_manage(conn, kind),
        Role::Viewer => Ok(false),
    }
}

/// One switch as the Settings page shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Switch {
    pub staff_can_manage: bool,
    /// The counter its save sends as `expected`; `null` before any
    /// preference was saved (the save then sends none).
    #[ts(type = "number | null")]
    pub version: Option<i64>,
}

/// Every switch, in `ListKind` order of fields.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Preferences {
    pub identifier_types: Switch,
    pub source_codes: Switch,
    pub fields: Switch,
}

impl Preferences {
    /// [`may_manage_list`] on preferences already read.
    pub fn may_manage(&self, role: Role, kind: ListKind) -> bool {
        match role {
            Role::Admin => true,
            Role::Staff => self.get(kind).staff_can_manage,
            Role::Viewer => false,
        }
    }

    pub fn get(&self, kind: ListKind) -> &Switch {
        match kind {
            ListKind::IdentifierTypes => &self.identifier_types,
            ListKind::SourceCodes => &self.source_codes,
            ListKind::Fields => &self.fields,
        }
    }
}

/// The organisation's preferences (every default when no row).
pub fn read(conn: &Connection) -> rusqlite::Result<Preferences> {
    let row = conn
        .query_row(
            "SELECT staff_can_manage_identifier_types, identifier_types_version,
                    staff_can_manage_source_codes, source_codes_version,
                    staff_can_manage_fields, fields_version
             FROM tenant_preferences",
            [],
            |r| {
                Ok([
                    (r.get::<_, bool>(0)?, r.get::<_, i64>(1)?),
                    (r.get(2)?, r.get(3)?),
                    (r.get(4)?, r.get(5)?),
                ])
            },
        )
        .optional()?;
    let switch = |i: usize| match row {
        Some(row) => Switch {
            staff_can_manage: row[i].0,
            version: Some(row[i].1),
        },
        None => Switch {
            staff_can_manage: false,
            version: None,
        },
    };
    Ok(Preferences {
        identifier_types: switch(0),
        source_codes: switch(1),
        fields: switch(2),
    })
}

fn row_id(conn: &Connection) -> rusqlite::Result<Option<String>> {
    conn.query_row(&format!("SELECT id FROM {ENTITY}"), [], |r| r.get(0))
        .optional()
}

/// Turn "staff can manage `kind`" on or off (the route checks admin).
/// `expected` is the switch's counter as last read, `None` if the caller
/// saw no row; seeing none when another admin has since saved one is
/// stale, as on Convex.
pub fn set(
    ctx: &Ctx,
    kind: ListKind,
    on: bool,
    expected: Option<i64>,
    source: Source,
) -> Result<Executed, ContractError> {
    let id = row_id(ctx.tx.read())?;
    let opts = match (&id, expected) {
        (None, _) => Exec::create(source),
        (Some(id), Some(expected)) => Exec::update(id, Some(expected), source),
        // A row the caller didn't see: stale, whatever it holds. As on
        // Convex (`staleIfUnseen`). It means one false conflict: on a
        // fresh organisation, a second admin's first save of *another*
        // switch is stale too (a created row's untouched counters read 0,
        // like a never-saved one), and costs that admin one retry.
        (Some(id), None) => Exec::update(id, Some(-1), source),
    };
    match kind {
        ListKind::IdentifierTypes => execute(
            ctx,
            &IDENTIFIER_TYPES,
            IdentifierTypesSwitch {
                staff_can_manage_identifier_types: on,
            },
            opts,
        ),
        ListKind::SourceCodes => execute(
            ctx,
            &SOURCE_CODES,
            SourceCodesSwitch {
                staff_can_manage_source_codes: on,
            },
            opts,
        ),
        ListKind::Fields => execute(
            ctx,
            &FIELDS,
            FieldsSwitch {
                staff_can_manage_fields: on,
            },
            opts,
        ),
    }
}

/// One contract per switch: payload = state = `{staffCanManage<List>}`.
macro_rules! switch_contract {
    ($contract:ident, $static:ident, $payload:ident, $field:ident, $name:literal, $kind:expr) => {
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
        #[serde(rename_all = "camelCase")]
        #[ts(export)]
        pub struct $payload {
            pub $field: bool,
        }

        pub struct $contract;
        pub static $static: $contract = $contract;

        impl Contract for $contract {
            const NAME: &'static str = $name;
            const VERSION: u32 = 1;
            const ENTITY: &'static str = ENTITY;
            const COUNTER: &'static str = $kind.counter_column();
            type Payload = $payload;
            type State = $payload;

            fn load(&self, tx: &OrgTx, id: &str) -> Result<$payload, ContractError> {
                Ok(tx.read().query_row(
                    &format!(
                        "SELECT {} FROM {ENTITY} WHERE id = ?1",
                        $kind.switch_column()
                    ),
                    [id],
                    |r| Ok($payload { $field: r.get(0)? }),
                )?)
            }

            fn apply(
                &self,
                _: Option<&$payload>,
                p: &$payload,
                _: &Command,
            ) -> Result<$payload, ContractError> {
                Ok(p.clone())
            }

            fn write(
                &self,
                tx: &WriteTx,
                id: &str,
                before: Option<&$payload>,
                next: &$payload,
            ) -> Result<(), ContractError> {
                let column = $kind.switch_column();
                if before.is_none() {
                    tx.execute(
                        &format!("INSERT INTO {ENTITY} (id, {column}) VALUES (?1, ?2)"),
                        rusqlite::params![id, next.$field],
                    )?;
                } else {
                    tx.execute(
                        &format!("UPDATE {ENTITY} SET {column} = ?2 WHERE id = ?1"),
                        rusqlite::params![id, next.$field],
                    )?;
                }
                Ok(())
            }
        }
    };
}

switch_contract!(
    IdentifierTypesContract,
    IDENTIFIER_TYPES,
    IdentifierTypesSwitch,
    staff_can_manage_identifier_types,
    "tenantPreferences.identifierTypes",
    ListKind::IdentifierTypes
);
switch_contract!(
    SourceCodesContract,
    SOURCE_CODES,
    SourceCodesSwitch,
    staff_can_manage_source_codes,
    "tenantPreferences.sourceCodes",
    ListKind::SourceCodes
);
switch_contract!(
    FieldsContract,
    FIELDS,
    FieldsSwitch,
    staff_can_manage_fields,
    "tenantPreferences.fields",
    ListKind::Fields
);
