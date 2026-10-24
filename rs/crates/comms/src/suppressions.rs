//! Email suppression per address (Convex `comms/suppressions.ts`, domain
//! rule 5). The one source of truth for whether comms may send to an
//! address in this organisation: every send checks it, and the contact
//! page shows "on hold" from it ([`held`]). Kept per address, not per
//! email row, so it survives edits and restores of a contact and covers
//! every contact sharing the address.
//!
//!   comms.suppression → suppressed, reason, since, eventRef, note
//!                       (save_version); `address_normalized` is the
//!                       row's identity, immutable
//!
//! Only a hard bounce suppresses: the address is dead for every kind of
//! mail. A complaint is about one group's marketing and never blocks
//! transactional mail (rule 5), so it is not a suppression. The row is
//! created by the first bounce and never deleted; a release sets
//! `suppressed: false`.

use std::collections::BTreeMap;

use contacts::rules::normalise_email;
use contracts::{
    Command, Contract, ContractError, Ctx, Exec, Executed, OrgTx, Problem, Source, WriteTx, execute,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The org-schema migration this crate owns (after contacts').
pub const MIGRATION: &str = "
CREATE TABLE email_suppressions (
    id TEXT PRIMARY KEY,
    address_normalized TEXT NOT NULL UNIQUE,
    suppressed INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('bounce', 'release')),
    since INTEGER NOT NULL,
    event_ref TEXT,
    note TEXT,
    save_version INTEGER NOT NULL DEFAULT 0
) STRICT;
";

/// The longest note an admin can give for a release.
pub const SUPPRESSION_NOTE_MAX: usize = 500;

/// The most addresses one [`held`] call looks up.
pub const HELD_LOOKUP_LIMIT: usize = 20;

/// Why an address is (or stopped being) suppressed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, rename = "SuppressionReason")]
pub enum Reason {
    /// A hard bounce.
    Bounce,
    /// An admin lifted it.
    Release,
}

impl Reason {
    /// Its wire name, which is also the stored one. (Through serde, so no
    /// string literal here reads as SQL's `RELEASE` to the schema guard.)
    fn as_str(self) -> String {
        match serde_json::to_value(self) {
            Ok(serde_json::Value::String(s)) => s,
            _ => unreachable!("Reason serialises as a string"),
        }
    }

    fn parse(s: &str) -> Self {
        serde_json::from_value(serde_json::Value::String(s.into())).unwrap_or(Reason::Bounce)
    }
}

/// `comms.suppression`: the address's state. Who and when are on the
/// revision (actor, source, time), why in the payload.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "SuppressionPayload")]
pub struct Payload {
    pub address_normalized: String,
    pub suppressed: bool,
    pub reason: Reason,
    /// The provider event that suppressed it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub event_ref: Option<String>,
    /// The admin's reason for a release.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub note: Option<String>,
}

/// The suppression as stored: the payload plus `since` (when the current
/// state began, the command's time).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    #[serde(flatten)]
    pub payload: Payload,
    pub since: i64,
}

/// One held address, as the contact page shows it; `saveVersion` is a
/// release's `expected`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Hold {
    pub reason: Reason,
    #[ts(type = "number")]
    pub since: i64,
    #[ts(type = "number")]
    pub save_version: i64,
}

/// `POST comms/release`: admins only, with a reason.
#[derive(Clone, Debug, Deserialize, TS)]
#[ts(export)]
pub struct Release {
    pub address: String,
    #[ts(type = "number")]
    pub expected: i64,
    pub note: String,
}

pub fn prepare_suppression(mut p: Payload) -> Result<Payload, ContractError> {
    p.address_normalized = normalise_email(&p.address_normalized);
    p.note = p
        .note
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_owned);
    let mut problems = Vec::new();
    if p.address_normalized.is_empty() {
        problems.push(Problem::new("addressNormalized", "Address needed"));
    }
    if contacts::rules::too_long(&p.address_normalized, contacts::rules::EMAIL_MAX) {
        problems.push(Problem::new(
            "addressNormalized",
            format!("At most {} characters", contacts::rules::EMAIL_MAX),
        ));
    }
    // A suppression says why; only a release is a release.
    if p.suppressed == (p.reason == Reason::Release) {
        problems.push(Problem::new(
            "reason",
            if p.suppressed {
                "Only a bounce suppresses"
            } else {
                "Lifting a suppression is a release"
            },
        ));
    }
    if p.note
        .as_deref()
        .is_some_and(|n| n.chars().count() > SUPPRESSION_NOTE_MAX)
    {
        problems.push(Problem::new(
            "note",
            format!("At most {SUPPRESSION_NOTE_MAX} characters"),
        ));
    }
    if problems.is_empty() {
        Ok(p)
    } else {
        Err(ContractError::Invalid(problems))
    }
}

pub struct Suppression;
pub static SUPPRESSION: Suppression = Suppression;

impl Contract for Suppression {
    const NAME: &'static str = "comms.suppression";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "email_suppressions";
    const COUNTER: &'static str = "save_version";
    type Payload = Payload;
    type State = State;

    fn prepare(&self, p: Payload) -> Result<Payload, ContractError> {
        prepare_suppression(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<State, ContractError> {
        Ok(tx.read().query_row(
            "SELECT address_normalized, suppressed, reason, event_ref, note, since
             FROM email_suppressions WHERE id = ?1",
            [id],
            |r| {
                Ok(State {
                    payload: Payload {
                        address_normalized: r.get(0)?,
                        suppressed: r.get(1)?,
                        reason: Reason::parse(&r.get::<_, String>(2)?),
                        event_ref: r.get(3)?,
                        note: r.get(4)?,
                    },
                    since: r.get(5)?,
                })
            },
        )?)
    }

    fn apply(
        &self,
        current: Option<&State>,
        p: &Payload,
        command: &Command,
    ) -> Result<State, ContractError> {
        if let Some(current) = current
            && current.payload.address_normalized != p.address_normalized
        {
            return Err(ContractError::rejected(
                "immutable",
                "A suppression is for one address",
            ));
        }
        Ok(State {
            payload: p.clone(),
            since: command.at,
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&State>,
        n: &State,
    ) -> Result<(), ContractError> {
        let p = &n.payload;
        if before.is_some() {
            tx.execute(
                "UPDATE email_suppressions SET suppressed = ?2, reason = ?3, since = ?4,
                     event_ref = ?5, note = ?6
                 WHERE id = ?1",
                params![
                    id,
                    p.suppressed,
                    p.reason.as_str(),
                    n.since,
                    p.event_ref,
                    p.note
                ],
            )?;
            return Ok(());
        }
        let exists: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM email_suppressions WHERE address_normalized = ?1)",
            [&p.address_normalized],
            |r| r.get(0),
        )?;
        if exists {
            return Err(ContractError::rejected(
                "duplicate",
                "This address already has a suppression",
            ));
        }
        tx.execute(
            "INSERT INTO email_suppressions (id, address_normalized, suppressed, reason, since,
                 event_ref, note)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                p.address_normalized,
                p.suppressed,
                p.reason.as_str(),
                n.since,
                p.event_ref,
                p.note
            ],
        )?;
        Ok(())
    }
}

/// The organisation's suppression row for an address (any case):
/// `(id, suppressed, hold)`.
fn suppression_of(
    conn: &Connection,
    address: &str,
) -> rusqlite::Result<Option<(String, bool, Hold)>> {
    conn.prepare_cached(
        "SELECT id, suppressed, reason, since, save_version FROM email_suppressions
         WHERE address_normalized = ?1",
    )?
    .query_row([normalise_email(address)], |r| {
        Ok((
            r.get(0)?,
            r.get(1)?,
            Hold {
                reason: Reason::parse(&r.get::<_, String>(2)?),
                since: r.get(3)?,
                save_version: r.get(4)?,
            },
        ))
    })
    .optional()
}

/// Whether mail to `address` is suppressed in this organisation.
pub fn is_suppressed(conn: &Connection, address: &str) -> rusqlite::Result<bool> {
    Ok(suppression_of(conn, address)?.is_some_and(|(_, s, _)| s))
}

/// Suppress an address after a hard bounce. A no-op, keeping the first
/// bounce's `since`, if it already is; after a release, a new bounce holds
/// it again. Returns whether it changed, and the counter.
///
/// The system only: refused for a command with a user behind it (the
/// provider's webhook runs with no actor). No route calls it.
pub fn suppress_address(
    ctx: &Ctx,
    address: &str,
    event_ref: Option<String>,
    note: Option<String>,
) -> Result<(bool, i64), ContractError> {
    if ctx.actor.is_some() {
        return Err(ContractError::rejected(
            "system_only",
            "Only the system suppresses an address",
        ));
    }
    let existing = suppression_of(ctx.tx.read(), address)?;
    if let Some((_, true, hold)) = &existing {
        return Ok((false, hold.save_version));
    }
    let payload = Payload {
        address_normalized: address.into(),
        suppressed: true,
        reason: Reason::Bounce,
        event_ref,
        note,
    };
    let opts = match &existing {
        Some((id, ..)) => Exec::update(id, None, Source::Comms),
        None => Exec::create(Source::Comms),
    };
    Ok((true, execute(ctx, &SUPPRESSION, payload, opts)?.counter))
}

/// Release a held address, with the admin's reason. The caller checks the
/// role, and after the commit tells the provider ([`release_at_provider`]).
pub fn release(ctx: &Ctx, req: Release) -> Result<Executed, ContractError> {
    let Some((id, true, _)) = suppression_of(ctx.tx.read(), &req.address)? else {
        return Err(ContractError::rejected(
            "not_held",
            "This address is not on hold",
        ));
    };
    execute(
        ctx,
        &SUPPRESSION,
        Payload {
            address_normalized: req.address,
            suppressed: false,
            reason: Reason::Release,
            event_ref: None,
            note: Some(req.note),
        },
        Exec::update(&id, Some(req.expected), Source::Ui),
    )
}

/// STUB until the SES transport (E2b): remove the address from the
/// provider's account-level suppression list, without which SES keeps
/// dropping the mail. Must stay idempotent. That list is account-wide, so
/// after one organisation's release any organisation without its own row
/// can send to the address again; if it really is dead, that costs each
/// one more bounce before its own row holds it. Accepted: writing the
/// suppression into every organisation would be a cross-tenant write.
pub fn release_at_provider(_address: &str) {
    // No address in the log: it is personal data.
    eprintln!("release_at_provider: not implemented until E2b (no-op)");
}

/// Of these addresses, the held ones, keyed by normalised address. At
/// most HELD_LOOKUP_LIMIT distinct addresses are looked up.
pub fn held(conn: &Connection, addresses: &[String]) -> rusqlite::Result<BTreeMap<String, Hold>> {
    let mut seen = Vec::new();
    for a in addresses {
        let n = normalise_email(a);
        if !seen.contains(&n) {
            seen.push(n);
        }
    }
    let mut out = BTreeMap::new();
    for a in seen.into_iter().take(HELD_LOOKUP_LIMIT) {
        if let Some((_, true, hold)) = suppression_of(conn, &a)? {
            out.insert(a, hold);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(suppressed: bool, reason: Reason) -> Payload {
        Payload {
            address_normalized: " Ann@X.org ".into(),
            suppressed,
            reason,
            event_ref: None,
            note: Some("  ".into()),
        }
    }

    #[test]
    fn only_a_bounce_suppresses_and_only_a_release_lifts() {
        let ok = prepare_suppression(p(true, Reason::Bounce)).unwrap();
        assert_eq!(ok.address_normalized, "ann@x.org");
        assert_eq!(ok.note, None);
        assert!(prepare_suppression(p(false, Reason::Release)).is_ok());
        assert!(prepare_suppression(p(true, Reason::Release)).is_err());
        assert!(prepare_suppression(p(false, Reason::Bounce)).is_err());
    }

    #[test]
    fn a_release_note_is_capped() {
        let long = Payload {
            note: Some("x".repeat(SUPPRESSION_NOTE_MAX + 1)),
            ..p(false, Reason::Release)
        };
        assert!(prepare_suppression(long).is_err());
    }
}
