//! What giving and Gift Aid may know about a contact, and the contact
//! writes the record-gift save composes (`convex/contacts/donors.ts`).
//! Other modules use these functions, never the contact tables. Each
//! write runs the contacts contracts in the caller's transaction and
//! command group: a refusal fails the caller's whole command.

use contracts::{CommandGroup, ContractError, Ctx, Exec, Source, execute, new_id};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use ts_rs::TS;

use crate::acquisition::{ACQUISITION, Acquisition};
use crate::slices::{ADDRESSES, METHODS, load_addresses};
use crate::types::{
    AddressRow, ChannelLabel, CreateContact, Created, Details, EmailRow, Kind, Methods,
};

/// The primary (else first) address's line 1 and postcode, or empty
/// strings; `completable` when typing a postcode for it completes that row
/// in place ([`set_home_address`]) rather than adding a new one.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[ts(export, rename = "DonorHome")]
pub struct Home {
    pub line1: String,
    pub postcode: String,
    pub completable: bool,
}

/// A contact as a gift and its Gift Aid declaration need it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Donor {
    pub id: String,
    pub kind: Kind,
    pub display_name: String,
    pub first_name: String,
    pub last_name: String,
    pub acquisition_code_id: Option<String>,
    pub home: Home,
}

/// A stored kind; the column's CHECK allows only the three.
fn kind(s: &str) -> Kind {
    Kind::parse(s).unwrap_or(Kind::Individual)
}

/// A UK home address with no postcode: [`set_home_address`] completes it
/// in place.
fn completes_in_place(a: &AddressRow) -> bool {
    a.label == ChannelLabel::Home
        && a.country.trim().eq_ignore_ascii_case("GB")
        && a.postcode.trim().is_empty()
}

/// The row a declaration would snapshot: the primary, else the first.
fn home_row(rows: &[AddressRow]) -> Option<&AddressRow> {
    rows.iter().find(|a| a.is_primary).or_else(|| rows.first())
}

/// The donor, or `None` for an unknown id. Two reads.
pub fn describe_donor(conn: &Connection, id: &str) -> rusqlite::Result<Option<Donor>> {
    let found = conn
        .prepare_cached(
            "SELECT kind, display_name, first_name, last_name, acquisition_code_id
             FROM contacts WHERE id = ?1",
        )?
        .query_row([id], |r| {
            Ok((
                kind(&r.get::<_, String>(0)?),
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })
        .optional()?;
    let Some((kind, display_name, first_name, last_name, acquisition_code_id)) = found else {
        return Ok(None);
    };
    let rows = load_addresses(conn, id)?.addresses;
    let home = home_row(&rows).map_or_else(Home::default, |a| Home {
        line1: a.line1.clone(),
        postcode: a.postcode.clone(),
        completable: completes_in_place(a),
    });
    Ok(Some(Donor {
        id: id.to_owned(),
        kind,
        display_name,
        first_name,
        last_name,
        acquisition_code_id,
        home,
    }))
}

/// A contact as a Gift Aid claim line snapshots it: the donor's name and
/// home address now (the primary address, else the first; empty strings
/// when none). `country` is ISO 3166 alpha-2 (`GB` for the UK).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaimDonor {
    pub kind: Kind,
    pub title: String,
    pub first_name: String,
    pub last_name: String,
    pub line1: String,
    pub town: String,
    pub postcode: String,
    pub country: String,
}

/// The claim donor, or `None` for an unknown id. Two reads.
pub fn claim_donor(conn: &Connection, id: &str) -> rusqlite::Result<Option<ClaimDonor>> {
    let found = conn
        .prepare_cached("SELECT kind, title, first_name, last_name FROM contacts WHERE id = ?1")?
        .query_row([id], |r| {
            Ok((
                kind(&r.get::<_, String>(0)?),
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .optional()?;
    let Some((kind, title, first_name, last_name)) = found else {
        return Ok(None);
    };
    let rows = load_addresses(conn, id)?.addresses;
    let home = home_row(&rows);
    let field = |f: fn(&AddressRow) -> &String| home.map(|a| f(a).clone()).unwrap_or_default();
    Ok(Some(ClaimDonor {
        kind,
        title,
        first_name,
        last_name,
        line1: field(|a| &a.line1),
        town: field(|a| &a.town),
        postcode: field(|a| &a.postcode),
        country: field(|a| &a.country),
    }))
}

/// The contact's kind, or `None` for an unknown id: whether a gift or a
/// declaration may name it. One read.
pub fn kind_of(conn: &Connection, id: &str) -> rusqlite::Result<Option<Kind>> {
    conn.prepare_cached("SELECT kind FROM contacts WHERE id = ?1")?
        .query_row([id], |r| Ok(kind(&r.get::<_, String>(0)?)))
        .optional()
}

/// The contact's display name and kind as they read now, or `None`.
pub fn name_of(conn: &Connection, id: &str) -> rusqlite::Result<Option<(String, Kind)>> {
    conn.prepare_cached("SELECT display_name, kind FROM contacts WHERE id = ?1")?
        .query_row([id], |r| Ok((r.get(0)?, kind(&r.get::<_, String>(1)?))))
        .optional()
}

/// A new contact (`contacts.details`, which takes its contact number),
/// with its acquisition code when given, both in `group`. A `clientKey`
/// already on a contact is `Duplicate`.
pub fn create_contact(
    ctx: &Ctx,
    details: Details,
    acquisition_code_id: Option<String>,
    source: Source,
    group: &CommandGroup,
) -> Result<Created, ContractError> {
    let created = crate::form::create_in(
        ctx,
        CreateContact { id: None, details },
        source,
        Some(group),
    )?;
    if let Some(code_id) = acquisition_code_id {
        crate::acquisition::set_on_create(ctx, &created.id, code_id, source, group)?;
    }
    Ok(created)
}

/// A just-created contact's one email address (its primary).
pub fn add_first_email(
    ctx: &Ctx,
    id: &str,
    address: &str,
    source: Source,
    group: &CommandGroup,
) -> Result<(), ContractError> {
    execute(
        ctx,
        &METHODS,
        Methods {
            emails: vec![EmailRow {
                key: None,
                label: ChannelLabel::Home,
                address: address.to_owned(),
                is_primary: true,
            }],
            phones: vec![],
        },
        Exec::update(id, Some(0), source).in_group(group),
    )?;
    Ok(())
}

/// Line 1 and postcode as stored (tidied).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HomeTyped {
    pub line1: String,
    pub postcode: String,
}

/// Give the contact a UK home address (line 1 and postcode, what Gift Aid
/// needs), keeping the addresses it has. The row a declaration would
/// snapshot (primary, else first) is completed in place, by key, when it
/// is a UK home address with no postcode: it keeps its other fields and
/// stays where it was (addresses are editable in place, ADR 0014).
/// Anything else is left as it is, and the address is added as the new
/// primary, since claims use the current address (g2q7). Built from the
/// rows read in this transaction, so it needs no `expected`.
pub fn set_home_address(
    ctx: &Ctx,
    id: &str,
    line1: &str,
    postcode: &str,
    source: Source,
    group: &CommandGroup,
) -> Result<HomeTyped, ContractError> {
    let conn = ctx.tx.read();
    let counter: i64 = conn
        .query_row(
            "SELECT addresses_version FROM contacts WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| ContractError::rejected("unknown_contact", "Contact must exist"))?;
    let mut rows = load_addresses(conn, id)?.addresses;
    let partial = home_row(&rows)
        .filter(|a| completes_in_place(a))
        .and_then(|a| a.key.clone());
    let key = match &partial {
        Some(key) => {
            for a in rows.iter_mut().filter(|a| a.key.as_ref() == Some(key)) {
                a.line1 = line1.to_owned();
                a.postcode = postcode.to_owned();
            }
            key.clone()
        }
        None => {
            // An added address becomes the primary.
            for a in &mut rows {
                a.is_primary = false;
            }
            let key = new_id();
            rows.push(AddressRow {
                key: Some(key.clone()),
                label: ChannelLabel::Home,
                line1: line1.to_owned(),
                line2: String::new(),
                line3: String::new(),
                town: String::new(),
                postcode: postcode.to_owned(),
                country: "GB".into(),
                is_primary: true,
            });
            key
        }
    };
    execute(
        ctx,
        &ADDRESSES,
        crate::types::Addresses { addresses: rows },
        Exec::update(id, Some(counter), source).in_group(group),
    )?;
    Ok(ctx.tx.read().query_row(
        "SELECT line1, postcode FROM contact_addresses WHERE id = ?1",
        params![key],
        |r| {
            Ok(HomeTyped {
                line1: r.get(0)?,
                postcode: r.get(1)?,
            })
        },
    )?)
}

/// Give the contact `code_id` as its acquisition code if it has none (ADR
/// 0022: giving fills an empty acquisition code from the first gift). One
/// it already has stays, archived or not. Returns whether it was filled.
pub fn fill_acquisition(
    ctx: &Ctx,
    id: &str,
    code_id: &str,
    source: Source,
    group: &CommandGroup,
) -> Result<bool, ContractError> {
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
        return Err(ContractError::rejected(
            "unknown_contact",
            "Contact must exist",
        ));
    };
    if held.is_some() {
        return Ok(false);
    }
    execute(
        ctx,
        &ACQUISITION,
        Acquisition {
            code_id: Some(code_id.to_owned()),
        },
        Exec::update(id, Some(counter), source).in_group(group),
    )?;
    Ok(true)
}
