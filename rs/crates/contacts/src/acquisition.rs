//! How the contact was recruited: a source code at version level, or none
//! (source codes plan, g1q7; Convex `contacts.acquisition`). Its own slice
//! and counter (`acquisition_version`), set at creation or later and
//! editable, every change in history.
//!
//! Convex kept the code's version, detail and category ids on the
//! `contactSearch` row for the list's filters; here the filter is a join
//! on `source_codes` ([`source_clause`]), so there is no projection.

use contracts::{
    Command, CommandGroup, Contract, ContractError, Ctx, Exec, Executed, OrgTx, Source, WriteTx,
    command_group, execute,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sources::{CodeDescription, Level, describe, mark_used};
use ts_rs::TS;

/// The org-schema step this slice owns, after `sources::MIGRATION`.
pub const MIGRATION: &str = "
ALTER TABLE contacts ADD COLUMN acquisition_code_id TEXT REFERENCES source_codes (id);
ALTER TABLE contacts ADD COLUMN acquisition_version INTEGER NOT NULL DEFAULT 0;
CREATE INDEX contacts_by_acquisition ON contacts (acquisition_code_id, sort_key, id);
";

/// The slice: a `source_codes` version id, or null for none.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "ContactAcquisition")]
pub struct Acquisition {
    pub code_id: Option<String>,
}

/// `POST contacts/{id}/acquisition`
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SetAcquisition {
    #[ts(type = "number")]
    pub expected: i64,
    pub code_id: Option<String>,
}

/// The slice as stored, plus whether this command is a restore (not
/// serialised: a stale refusal's `current` is just `{codeId}`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquisitionState {
    pub code_id: Option<String>,
    #[serde(skip)]
    restoring: bool,
}

pub struct ContactAcquisition;
pub static ACQUISITION: ContactAcquisition = ContactAcquisition;

pub(crate) fn load_acquisition(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    conn.prepare_cached("SELECT acquisition_code_id FROM contacts WHERE id = ?1")?
        .query_row([id], |r| r.get(0))
}

/// A new code must be a version of this organisation and not archived
/// (out of date is fine), and its first assignment marks it used. A kept
/// code stays even once archived, and a restore may bring one back (it
/// was assigned before, so it is already marked).
impl Contract for ContactAcquisition {
    const NAME: &'static str = "contacts.acquisition";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "contacts";
    const COUNTER: &'static str = "acquisition_version";
    type Payload = Acquisition;
    type State = AcquisitionState;

    fn load(&self, tx: &OrgTx, id: &str) -> Result<AcquisitionState, ContractError> {
        Ok(AcquisitionState {
            code_id: load_acquisition(tx.read(), id)?,
            restoring: false,
        })
    }

    fn apply(
        &self,
        current: Option<&AcquisitionState>,
        p: &Acquisition,
        command: &Command,
    ) -> Result<AcquisitionState, ContractError> {
        if current.is_none() {
            return Err(ContractError::rejected(
                "no_root",
                format!("{} targets an existing contact", Self::NAME),
            ));
        }
        Ok(AcquisitionState {
            code_id: p.code_id.clone(),
            restoring: command.source == Source::Restore,
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&AcquisitionState>,
        next: &AcquisitionState,
    ) -> Result<(), ContractError> {
        let held = before.and_then(|b| b.code_id.as_deref());
        if let Some(code_id) = next.code_id.as_deref()
            && Some(code_id) != held
        {
            let Some(code) = describe(tx, code_id)? else {
                return Err(ContractError::rejected(
                    "unknown_source_code",
                    "The source code must be a full code (category, detail and version)",
                ));
            };
            if !next.restoring {
                if !code.is_active {
                    return Err(ContractError::rejected(
                        "archived_source_code",
                        format!("{} is archived: choose another", code.code),
                    ));
                }
                mark_used(tx, code_id, false)?;
            }
        }
        tx.prepare_cached("UPDATE contacts SET acquisition_code_id = ?2 WHERE id = ?1")?
            .execute(params![id, next.code_id])?;
        Ok(())
    }
}

/// Set or clear the contact's acquisition code. A change runs in a group
/// named after the code, so history keeps the code as it read then, even
/// after a part is renamed; re-sending the current code is a no-op that
/// answers the counter as it is.
pub fn set_acquisition(
    ctx: &Ctx,
    id: &str,
    expected: i64,
    code_id: Option<String>,
) -> Result<Executed, ContractError> {
    let held: Option<(Option<String>, i64)> = ctx
        .tx
        .read()
        .query_row(
            "SELECT acquisition_code_id, acquisition_version FROM contacts WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((held, counter)) = held else {
        return Err(ContractError::NotFound);
    };
    if held == code_id {
        return Ok(Executed {
            id: id.to_owned(),
            counter,
        });
    }
    // A stale `expected` or a refused code fails the contract, and the
    // transaction (group included) rolls back with it.
    let name = match code_id.as_deref().map(|c| describe(ctx.tx.read(), c)) {
        Some(found) => match found? {
            Some(code) => format!("acquisition code {}", code.code),
            None => "acquisition code".to_owned(),
        },
        None => "acquisition code cleared".to_owned(),
    };
    let group = command_group(ctx, &name)?;
    execute(
        ctx,
        &ACQUISITION,
        Acquisition { code_id },
        Exec::update(id, Some(expected), Source::Ui).in_group(&group),
    )
}

/// The group a create with a code runs in: named after the code, so
/// history keeps it as it read then (as [`set_acquisition`] does).
pub(crate) fn create_group(ctx: &Ctx, code_id: &str) -> Result<CommandGroup, ContractError> {
    let name = match describe(ctx.tx.read(), code_id)? {
        Some(code) => format!("new contact, acquisition code {}", code.code),
        None => "new contact".to_owned(),
    };
    command_group(ctx, &name)
}

/// The acquisition step of a create: the new contact (counter 0) gets
/// its code.
pub(crate) fn set_on_create(
    ctx: &Ctx,
    id: &str,
    code_id: String,
    source: Source,
    group: &CommandGroup,
) -> Result<Executed, ContractError> {
    execute(
        ctx,
        &ACQUISITION,
        Acquisition {
            code_id: Some(code_id),
        },
        Exec::update(id, Some(0), source).in_group(group),
    )
}

/// The contact's acquisition code described (its three names, the full
/// code, whether it is archived), or `None` when uncoded. Names are read
/// now, so a renamed part shows its new name.
pub fn acquisition_of(conn: &Connection, id: &str) -> rusqlite::Result<Option<CodeDescription>> {
    match load_acquisition(conn, id).optional()?.flatten() {
        Some(code_id) => describe(conn, &code_id),
        None => Ok(None),
    }
}

/// The contacts list's source filter: one part of a code, at its level.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceFilter {
    pub level: Level,
    pub id: String,
}

/// Parse `category|detail|version:<id>`. An id that isn't a part of
/// this organisation (or not at that level) just matches nothing.
pub fn parse_source_filter(raw: Option<&str>) -> Result<Option<SourceFilter>, ContractError> {
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return Ok(None);
    };
    raw.split_once(':')
        .and_then(|(level, id)| {
            Some(SourceFilter {
                level: Level::parse(level)?,
                id: id.to_owned(),
            })
        })
        .filter(|f| !f.id.is_empty())
        .map(Some)
        .ok_or_else(|| {
            ContractError::invalid("source", "category:<id>, detail:<id> or version:<id>")
        })
}

/// The filter as SQL on `contacts c` (one parameter: the part's id): the
/// contact's code is that version, a version of that detail, or of a
/// detail of that category. A contact keeps matching once its code is
/// archived.
pub fn source_clause(f: &SourceFilter) -> &'static str {
    match f.level {
        Level::Version => " AND c.acquisition_code_id = ?",
        Level::Detail => {
            " AND c.acquisition_code_id IN (SELECT v.id FROM source_codes v
                WHERE v.parent_id = ? AND v.level = 'version')"
        }
        Level::Category => {
            " AND c.acquisition_code_id IN (SELECT v.id FROM source_codes v
                JOIN source_codes d ON d.id = v.parent_id
                WHERE d.parent_id = ? AND d.level = 'detail')"
        }
    }
}

/// `POST contacts`: a new contact, and the new-contact form's source code
/// when it picked one (a version id).
#[derive(Clone, Debug, Deserialize, TS)]
#[ts(export)]
pub struct NewContact {
    #[serde(flatten)]
    #[ts(flatten)]
    pub create: crate::types::CreateContact,
    #[serde(default, rename = "acquisitionCodeId")]
    #[ts(optional, rename = "acquisitionCodeId")]
    pub acquisition_code_id: Option<String>,
}

/// Create a contact, with its acquisition code when given: then both
/// slices run in one group named after the code. An unknown or archived
/// code refuses the whole create.
pub fn create_contact(
    ctx: &Ctx,
    req: NewContact,
    source: Source,
) -> Result<crate::types::Created, ContractError> {
    let Some(code_id) = req.acquisition_code_id else {
        return crate::form::create(ctx, req.create, source);
    };
    let group = create_group(ctx, &code_id)?;
    let created = crate::form::create_in(ctx, req.create, source, Some(&group))?;
    set_on_create(ctx, &created.id, code_id, source, &group)?;
    Ok(created)
}
