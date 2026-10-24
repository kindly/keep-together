//! A contact's history panel (Convex `contacts/history.ts`,
//! `mutations.restoreTo`): moments, a page at a time
//! ([`contracts::history`]), how contact slices read to staff, and
//! "Restore to here".

use contracts::history::{MomentPage, SliceLabel};
use contracts::{ContractError, Ctx, restore, restore_entity_to};
use rusqlite::{Connection, OptionalExtension};

use crate::REGISTRY;
use crate::queries::counters;
pub use crate::slices::{FieldRestoreNote, FieldRestoreReason};
use crate::slices::field_restore_notes;
use crate::types::{RestoreRequest, Restored};

/// Revisions per history page (Convex's panel asks for 10).
pub const HISTORY_PAGE: usize = 10;

/// Contact contracts that no longer exist (Convex `RETIRED_CONTRACTS`:
/// tags, dropped by the dropdown fields plan), with how history names
/// their slice. Their revisions stay in history, read-only: restoring one
/// is refused, a restore to a moment steps over them, and the panel
/// offers no restore to a moment made only of them. Rust never wrote
/// them; revisions imported from Convex may carry them.
pub const RETIRED_CONTRACTS: &[(&str, &str)] = &[
    ("contacts.tags", "tags (retired)"),
    ("contacts.tag", "tag (retired)"),
];

pub fn is_retired(contract: &str) -> bool {
    RETIRED_CONTRACTS.iter().any(|(c, _)| *c == contract)
}

/// How a moment names a contact slice: the contract's name within its
/// module, unless it reads badly to staff or the contract is retired.
pub struct ContactSlices;

impl SliceLabel for ContactSlices {
    fn label(&self, contract: &str) -> String {
        if let Some((_, label)) = RETIRED_CONTRACTS.iter().find(|(c, _)| *c == contract) {
            return (*label).to_owned();
        }
        match contract {
            "contacts.acquisition" => "acquisition code".to_owned(),
            c => c.strip_prefix("contacts.").unwrap_or(c).to_owned(),
        }
    }

    fn retired(&self, contract: &str) -> bool {
        is_retired(contract)
    }
}

/// One page of the contact's moments, newest first, older than revision
/// `before`.
pub fn page(
    conn: &Connection,
    id: &str,
    before: Option<i64>,
    limit: usize,
) -> Result<MomentPage, ContractError> {
    contracts::history::page(conn, "contacts", id, before, limit, &ContactSlices)
}

/// `ms` since the epoch as `YYYY-MM-DDTHH:MM:SS.sssZ` (UTC), as Convex's
/// `new Date(at).toISOString()` names a restore's group.
pub fn iso(ms: i64) -> String {
    let (days, rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )
}

/// The contracts a restore to a moment never runs: archive (its own
/// switch) and the retired ones.
fn restore_to_excludes() -> Vec<&'static str> {
    let mut out = vec!["contacts.archive"];
    out.extend(RETIRED_CONTRACTS.iter().map(|(c, _)| *c));
    out
}

/// Restore one of this contact's revisions, or the whole contact (archive
/// and retired contracts excluded) to its state at `at` ("Restore to
/// here"), as new commands. Only the slices that differ run. The answer
/// says which, and which field values were left as they are.
pub fn restore_contact(
    ctx: &Ctx,
    id: &str,
    req: RestoreRequest,
) -> Result<Restored, ContractError> {
    let restored = match req {
        RestoreRequest::Revision { revision_id } => {
            let owner: Option<(String, String, String)> = ctx
                .tx
                .read()
                .query_row(
                    "SELECT entity, entity_id, contract FROM revisions WHERE id = ?1",
                    [revision_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            let Some((entity, entity_id, contract)) = owner else {
                return Err(ContractError::NotFound);
            };
            if entity != "contacts" || entity_id != id {
                return Err(ContractError::NotFound);
            }
            if is_retired(&contract) {
                return Err(ContractError::rejected(
                    "retired_contract",
                    "This is history only: it can't be restored",
                ));
            }
            restore(ctx, &REGISTRY, revision_id, None)?;
            vec![contract]
        }
        RestoreRequest::At { at } => {
            if counters(ctx.tx.read(), id)?.is_none() {
                return Err(ContractError::NotFound);
            }
            restore_entity_to(
                ctx,
                &REGISTRY,
                "contacts",
                id,
                at,
                &restore_to_excludes(),
                Some(&format!("restore to {}", iso(at))),
            )?
        }
    };
    // The fields revision this restore just wrote names the one it
    // restored: what that left as it was.
    let skipped_fields = if restored.iter().any(|c| c == "contacts.fields") {
        let from: Option<i64> = ctx
            .tx
            .read()
            .query_row(
                "SELECT restored_from FROM revisions
                 WHERE entity = 'contacts' AND entity_id = ?1 AND contract = 'contacts.fields'
                 ORDER BY id DESC LIMIT 1",
                [id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        match from {
            Some(from) => field_restore_notes(ctx.tx.read(), id, from)?,
            None => vec![],
        }
    } else {
        vec![]
    };
    Ok(Restored {
        restored,
        skipped_fields,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_formats_like_to_iso_string() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_761_301_234_567), "2025-10-24T10:20:34.567Z");
        assert_eq!(iso(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn slices_read_as_staff_read_them() {
        assert_eq!(ContactSlices.label("contacts.details"), "details");
        assert_eq!(ContactSlices.label("contacts.acquisition"), "acquisition code");
        assert_eq!(ContactSlices.label("contacts.tags"), "tags (retired)");
        assert!(ContactSlices.retired("contacts.tag"));
        assert!(!ContactSlices.retired("contacts.fields"));
    }
}
