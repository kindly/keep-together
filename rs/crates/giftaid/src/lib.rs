//! Gift Aid declarations (a dated chain, rule 1) and the IRmark: the Rust
//! counterpart of `convex/giftaid/`. A domain crate: depends on
//! `contracts`, and on `contacts` and `giving` through their public
//! functions, never on `store` or `platform`; it can't name an
//! organisation.
//!
//! Recording declarations, cancellations and voids is for staff and
//! admins (the tenant middleware refuses a viewer's write); viewers read.

pub mod declarations;
pub mod irmark;
pub mod rules;
pub mod types;
pub mod warnings;

use std::sync::LazyLock;

use contracts::{
    CommandGroup, ContractError, Ctx, Exec, Executed, Registry, Source, command_group, execute,
};
use rusqlite::Connection;

pub use declarations::{CANCELLATION, DECLARATION, VOID, chain, coverage, current_declaration};
pub use rules::{HMRC_MODEL_WORDING_VERSION, is_iso_date, open_at, uk_date};
pub use types::{
    CancellationPayload, Cancelled, DeclarationPayload, DeclarationRow, DeclarationSummary,
    Declarations, Method, Scope, VoidPayload,
};

/// The org-schema step this crate owns, after giving's. Prefix
/// `contact_id` = a contact's chain, in date order.
pub const MIGRATION: &str = "
CREATE TABLE gift_aid_declarations (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts (id),
    scope TEXT NOT NULL CHECK (scope IN ('thisGift', 'future', 'futureAndPast4y')),
    gift_id TEXT REFERENCES gifts (id),
    made_on TEXT NOT NULL,
    method TEXT NOT NULL
        CHECK (method IN ('staffTickedNoEvidence', 'paperForm', 'onScreenByDonor', 'oral')),
    wording_version TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    address_line1 TEXT NOT NULL,
    postcode TEXT NOT NULL,
    cancelled_from TEXT,
    cancellation_note TEXT,
    void_reason TEXT,
    voided_at INTEGER,
    voided_by INTEGER,
    entered_by INTEGER,
    entered_at INTEGER NOT NULL,
    declaration_version INTEGER NOT NULL DEFAULT 0,
    cancellation_version INTEGER NOT NULL DEFAULT 0,
    void_version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX gift_aid_declarations_by_contact ON gift_aid_declarations (contact_id, made_on);
";

/// Every contract restore may meet in an org file's declaration history.
pub static REGISTRY: LazyLock<Registry> =
    LazyLock::new(|| Registry::new(&[&DECLARATION, &CANCELLATION, &VOID]));

/// A new declaration; giving's one-save command runs it inside its group.
pub fn make_declaration(
    ctx: &Ctx,
    payload: DeclarationPayload,
    source: Source,
    group: Option<&CommandGroup>,
) -> Result<Executed, ContractError> {
    let opts = match group {
        Some(g) => Exec::create(source).in_group(g),
        None => Exec::create(source),
    };
    execute(ctx, &DECLARATION, payload, opts)
}

/// "Record cancellation" on the contact page: cancels from
/// `cancelled_from` every declaration of the contact open at that date
/// ([`open_at`]), in one command group. Built from each declaration's
/// fresh state inside the transaction, so it needs no `expected`. Refused
/// if none is open.
pub fn cancel_declarations(
    ctx: &Ctx,
    contact_id: &str,
    cancelled_from: &str,
    note: Option<String>,
    source: Source,
) -> Result<Cancelled, ContractError> {
    let date = cancelled_from.trim();
    // Checked here as well as by the contract: `open_at` compares strings.
    if !is_iso_date(date) {
        return Err(ContractError::invalid(
            "cancelledFrom",
            "Enter a date (YYYY-MM-DD)",
        ));
    }
    let open: Vec<String> = chain(ctx.tx.read(), contact_id)?
        .into_iter()
        .filter(|d| open_at(d, date))
        .map(|d| d.id)
        .collect();
    if open.is_empty() {
        return Err(ContractError::invalid(
            "cancelledFrom",
            "No declaration was in force on that date",
        ));
    }
    let group = command_group(ctx, &format!("Gift Aid cancelled from {date}"))?;
    for id in &open {
        execute(
            ctx,
            &CANCELLATION,
            CancellationPayload {
                cancelled_from: Some(date.to_owned()),
                note: note.clone(),
            },
            Exec::update(id, None, source).in_group(&group),
        )?;
    }
    Ok(Cancelled { cancelled: open })
}

/// "Made in error" on one declaration of the Gift Aid panel: it never
/// applied, to any gift. Refused if already voided.
pub fn void_declaration(
    ctx: &Ctx,
    id: &str,
    reason: String,
    source: Source,
) -> Result<Executed, ContractError> {
    execute(ctx, &VOID, VoidPayload { reason }, Exec::update(id, None, source))
}

/// The contact page's Gift Aid panel: a contact's declarations, newest
/// made first, each with its warnings (none on a voided one), and which
/// is current on `today` (the caller's date), if any. At most
/// DECLARATION_LIMIT, which the contract enforces, so nothing is cut off.
pub fn by_contact(conn: &Connection, contact_id: &str, today: &str) -> rusqlite::Result<Declarations> {
    let chain = chain(conn, contact_id)?;
    let current_id = rules::current_of(&chain, today).map(|d| d.id.clone());
    let declarations = chain
        .into_iter()
        .rev()
        .map(|d| DeclarationRow {
            warnings: if d.voided_at.is_none() {
                warnings::declaration_warnings(&d.payload)
            } else {
                vec![]
            },
            declaration: d,
        })
        .collect();
    Ok(Declarations {
        declarations,
        current_id,
    })
}
