//! `keep giftaid-xml`: a Gift Aid claim as HMRC's claim XML, for the
//! operator to check or to send HMRC as evidence. Generated, never sent.
//!
//! - `keep giftaid-xml <slug> <claim-id>`: a stored claim, as the api's
//!   `GET giftaid/claims/{id}/xml` makes it (the organisation's HMRC
//!   details must be complete);
//! - `keep giftaid-xml --hmrc-sample`: HMRC's sample data through the
//!   same builder: byte for byte HMRC's `GAValidSample.xml`, the
//!   evidence HMRC's recognition process asks for.
//!
//! Both open the files read-only.

use std::path::Path;

use giftaid::irmark::Irmark;
use giftaid::xml::{Envelope, claim_message, for_claim, hmrc_sample};
use rusqlite::{Connection, OpenFlags, OptionalExtension};

fn read_only(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "query_only", "ON")
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// A stored claim's XML and IRmark.
pub fn claim_xml(data: &Path, slug: &str, claim: &str) -> Result<(String, Irmark), String> {
    let platform = read_only(&data.join("platform.db"))?;
    let found: Option<(String, String)> = platform
        .query_row(
            "SELECT id, name FROM tenants WHERE slug = ?1",
            [slug],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    // A slug never becomes a path: the id is 32 lower-case hex.
    let (id, name) = found
        .filter(|(id, _)| {
            id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        })
        .ok_or_else(|| format!("no organisation {slug:?}"))?;
    let org = read_only(&data.join("orgs").join(format!("{id}.db")))?;
    for_claim(
        &org,
        claim,
        &name,
        &Envelope::generated(contracts::now_ms()),
    )
    .map_err(|e| match e {
        contracts::ContractError::NotFound => format!("no claim {claim:?} in {slug}"),
        other => other.to_string(),
    })
}

/// HMRC's sample data as claim XML.
pub fn sample_xml() -> Result<(String, Irmark), String> {
    let (env, claim) = hmrc_sample();
    claim_message(&env, &claim).map_err(|e| e.to_string())
}
