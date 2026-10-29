//! `keep giving-consistency <slug>`: ADR 0025's check that every
//! provider payment the organisation matched to a donor has exactly one
//! gift, with its amount, date and status (a claimed gift's own amount
//! and date; a staff void), and that no provider gift lacks its payment.
//! Opens the file as `keep sql` does: read-only, `SELECT` only.

use std::path::Path;

/// Every disagreement, one line each; empty when consistent.
pub fn consistency(data: &Path, slug: &str) -> Result<Vec<String>, String> {
    let conn = crate::sql::open(data, slug).map_err(|e| e.to_string())?;
    giving::regular::consistency(&conn).map_err(|e| e.to_string())
}
