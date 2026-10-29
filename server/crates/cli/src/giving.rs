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

/// `keep expected <slug> <YYYY-MM>`: each regular gift's period in that
/// month (ADR 0026), expected against what happened, one line each, and
/// the totals. Read-only.
pub fn expected(data: &Path, slug: &str, month: &str) -> Result<Vec<String>, String> {
    if month.len() != 7 || giving::terms_rules::month_index(month).is_none() {
        return Err(format!("{month}: months are YYYY-MM"));
    }
    let conn = crate::sql::open(data, slug).map_err(|e| e.to_string())?;
    let today = giving::terms_rules::date_of_ms(contracts::now_ms());
    let lines = giving::expected::month(&conn, month, &today).map_err(|e| e.to_string())?;
    let (mut expected, mut received) = (0i64, 0i64);
    let mut out = Vec::new();
    for l in &lines {
        expected += l.row.expected;
        if l.row.status == giving::expected::PeriodStatus::Collected {
            received += l.row.amount.unwrap_or(0);
        }
        let gift = match (&l.row.gift_id, l.row.amount) {
            (Some(g), Some(a)) => format!(" gift {g} {}", giving::format_pence(a)),
            _ => String::new(),
        };
        out.push(format!(
            "{} {} due {} expected {} {:?}{gift}",
            l.regular_gift_id,
            l.contact_id,
            l.row.due_on,
            giving::format_pence(l.row.expected),
            l.row.status,
        ));
    }
    out.push(format!(
        "{slug} {month}: {} regular gifts expected {}, received {}",
        lines.len(),
        giving::format_pence(expected),
        giving::format_pence(received)
    ));
    Ok(out)
}
