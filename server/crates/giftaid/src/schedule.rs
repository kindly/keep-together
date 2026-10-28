//! HMRC's Gift Aid donations schedule (`R68GAD_V1_00_0_EN`), filled: the
//! spreadsheet a group uploads with its claim in Charities Online. We
//! fill a copy of HMRC's own template (`assets/hmrc/`, both the Excel and
//! the LibreOffice one) rather than build a sheet, so the layout, sheet
//! name, styles and protection are HMRC's. Only the cells HMRC asks to be
//! typed into change, each keeping its style:
//!
//! - D13, Box 1: the earliest donation date in the claim (DD/MM/YY);
//! - D17, Box 2: tax previously over-claimed, blank if none;
//! - rows 25 to 1024, one per donation: C title, D first name, E last
//!   name, F house name or number, G postcode (`X` outside the UK), J
//!   date (a date cell, shown DD/MM/YY), K amount (a number, 2 places,
//!   no £); H (aggregated) and I (sponsored) left blank;
//! - the total's cached value (J20, its formula kept), so the sheet reads
//!   right before it recalculates.
//!
//! At most [`SCHEDULE_ROW_LIMIT`] donations a file: a longer claim is
//! split ([`crate::claims::schedule_parts`]).

use contracts::ContractError;

use crate::claim_rules::{SCHEDULE_ROW_LIMIT, pounds};
use crate::zip::{self, ZipError};

const EXCEL: &[u8] = include_bytes!("../assets/hmrc/Gift-Aid-Schedule-Excel.ods");
const LIBRE: &[u8] = include_bytes!("../assets/hmrc/gift_aid_schedule__libre_.ods");

pub const SHEET: &str = "R68GAD_V1_00_0_EN";
const FIRST_ROW: usize = 25;
const BOX1: (usize, usize) = (13, 3);
const BOX2: (usize, usize) = (17, 3);
const TOTAL: (usize, usize) = (20, 9);

/// Which of HMRC's two templates: HMRC asks for the one matching the
/// software the file is opened in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Template {
    Excel,
    LibreOffice,
}

impl Template {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "excel" => Some(Template::Excel),
            "libreoffice" => Some(Template::LibreOffice),
            _ => None,
        }
    }

    fn bytes(self) -> &'static [u8] {
        match self {
            Template::Excel => EXCEL,
            Template::LibreOffice => LIBRE,
        }
    }
}

/// One donation as the schedule shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub title: String,
    pub first_name: String,
    pub last_name: String,
    pub house: String,
    /// `X` for a donor outside the UK.
    pub postcode: String,
    /// ISO date.
    pub date: String,
    pub amount: i64,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ScheduleError {
    #[error(transparent)]
    Zip(#[from] ZipError),
    #[error("schedule template: {0}")]
    Template(&'static str),
    #[error("a schedule holds at most {SCHEDULE_ROW_LIMIT} donations")]
    TooManyRows,
}

/// `2015-03-24` → `24/03/15`.
fn dd_mm_yy(iso: &str) -> String {
    format!("{}/{}/{}", &iso[8..10], &iso[5..7], &iso[2..4])
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// What to put in a cell.
enum Value<'a> {
    Text(&'a str),
    Date(&'a str),
    Number(i64),
}

/// One `<table:table-cell …>` or covered cell, and how many columns it
/// stands for.
struct Cell {
    xml: String,
    repeat: usize,
}

const REPEAT: &str = "table:number-columns-repeated";

fn attr<'a>(open_tag: &'a str, name: &str) -> Option<&'a str> {
    let key = format!(" {name}=\"");
    let at = open_tag.find(&key)? + key.len();
    let end = open_tag[at..].find('"')?;
    Some(&open_tag[at..at + end])
}

fn without_attr(open_tag: &str, name: &str) -> String {
    let key = format!(" {name}=\"");
    match open_tag.find(&key) {
        Some(at) => {
            let end = at + key.len() + open_tag[at + key.len()..].find('"').unwrap_or(0) + 1;
            format!("{}{}", &open_tag[..at], &open_tag[end..])
        }
        None => open_tag.to_owned(),
    }
}

fn with_repeat(xml: &str, repeat: usize) -> String {
    // Only the open tag carries it.
    let close = xml.find('>').unwrap_or(xml.len());
    let (open, rest) = xml.split_at(close);
    let open = without_attr(open, REPEAT);
    let open = match open.strip_suffix('/') {
        Some(o) if repeat > 1 => format!("{o} {REPEAT}=\"{repeat}\"/"),
        _ if repeat > 1 => format!("{open} {REPEAT}=\"{repeat}\""),
        _ => open,
    };
    format!("{open}{rest}")
}

/// The cells of a row's inner XML. Cells never nest.
fn cells(inner: &str) -> Result<Vec<Cell>, ScheduleError> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(found) = inner[at..].find('<') {
        let start = at + found;
        let rest = &inner[start..];
        let tag = if rest.starts_with("<table:table-cell") {
            "table:table-cell"
        } else if rest.starts_with("<table:covered-table-cell") {
            "table:covered-table-cell"
        } else {
            return Err(ScheduleError::Template("unexpected element in a row"));
        };
        let open_end = start + rest.find('>').ok_or(ScheduleError::Template("open tag"))? + 1;
        let end = if inner[..open_end].ends_with("/>") {
            open_end
        } else {
            let close = format!("</{tag}>");
            open_end
                + inner[open_end..]
                    .find(&close)
                    .ok_or(ScheduleError::Template("unclosed cell"))?
                + close.len()
        };
        let xml = inner[start..end].to_owned();
        let repeat = attr(&inner[start..open_end], REPEAT)
            .and_then(|r| r.parse().ok())
            .unwrap_or(1);
        out.push(Cell { xml, repeat });
        at = end;
    }
    Ok(out)
}

/// Split the cells so column `col` is a cell of its own; its index.
fn isolate(cells: &mut Vec<Cell>, col: usize) -> Result<usize, ScheduleError> {
    let mut first = 0;
    for i in 0..cells.len() {
        let n = cells[i].repeat;
        if col < first + n {
            let before = col - first;
            let after = n - before - 1;
            let xml = cells[i].xml.clone();
            let mut parts = Vec::new();
            if before > 0 {
                parts.push(Cell {
                    xml: with_repeat(&xml, before),
                    repeat: before,
                });
            }
            let at = i + parts.len();
            parts.push(Cell {
                xml: with_repeat(&xml, 1),
                repeat: 1,
            });
            if after > 0 {
                parts.push(Cell {
                    xml: with_repeat(&xml, after),
                    repeat: after,
                });
            }
            cells.splice(i..=i, parts);
            return Ok(at);
        }
        first += n;
    }
    Err(ScheduleError::Template("no such column"))
}

/// An empty template cell, written with `value`, its style kept.
fn filled(empty: &str, value: &Value) -> Result<String, ScheduleError> {
    let open = empty
        .strip_suffix("/>")
        .filter(|o| o.starts_with("<table:table-cell") && !o.contains("office:value-type"))
        .ok_or(ScheduleError::Template("a cell to fill isn't empty"))?;
    let (attrs, text) = match value {
        Value::Text(t) => (" office:value-type=\"string\"".to_owned(), escape(t)),
        Value::Date(iso) => (
            format!(" office:value-type=\"date\" office:date-value=\"{iso}\""),
            dd_mm_yy(iso),
        ),
        Value::Number(pence) => {
            let p = pounds(*pence);
            (
                format!(" office:value-type=\"float\" office:value=\"{p}\""),
                p,
            )
        }
    };
    Ok(format!(
        "{open}{attrs}><text:p>{text}</text:p></table:table-cell>"
    ))
}

/// The total cell (its `SUM` formula kept) showing `total` until the
/// sheet recalculates.
fn with_total(cell: &str, total: i64) -> Result<String, ScheduleError> {
    let open_end = cell.find('>').map_or(cell.len(), |i| i + 1);
    let open = &cell[..open_end];
    if !(open.starts_with("<table:table-cell") && open.contains("table:formula")) {
        return Err(ScheduleError::Template("no total formula in J20"));
    }
    let open = without_attr(
        open.trim_end_matches('>').trim_end_matches('/'),
        "office:value",
    );
    let p = pounds(total);
    Ok(format!(
        "{open} office:value=\"{p}\"><text:p>£{p}</text:p></table:table-cell>"
    ))
}

/// One table row: where it is in content.xml.
struct RowAt {
    number: usize,
    start: usize,
    open_end: usize,
    end: usize,
}

/// The rows of the sheet up to `last`, numbered from 1 (repeats counted).
fn rows(content: &str, last: usize) -> Result<Vec<RowAt>, ScheduleError> {
    let sheet = content
        .find(&format!("<table:table table:name=\"{SHEET}\""))
        .ok_or(ScheduleError::Template("no R68GAD sheet"))?;
    let mut out = Vec::new();
    let mut at = sheet;
    let mut number = 1;
    while number <= last {
        let start = at
            + content[at..]
                .find("<table:table-row")
                .ok_or(ScheduleError::Template("too few rows"))?;
        let open_end = start + content[start..].find('>').unwrap_or(0) + 1;
        let end = if content[..open_end].ends_with("/>") {
            open_end
        } else {
            open_end
                + content[open_end..]
                    .find("</table:table-row>")
                    .ok_or(ScheduleError::Template("unclosed row"))?
                + "</table:table-row>".len()
        };
        let repeat: usize = attr(&content[start..open_end], "table:number-rows-repeated")
            .and_then(|r| r.parse().ok())
            .unwrap_or(1);
        out.push(RowAt {
            number,
            start,
            open_end,
            end,
        });
        number += repeat;
        at = end;
    }
    Ok(out)
}

/// The filled schedule (`.ods` bytes): `rows` from row 25, Box 1
/// `earliest`, Box 2 `adjustment` (pence; 0 leaves it blank).
pub fn fill(
    template: Template,
    rows_in: &[Row],
    earliest: Option<&str>,
    adjustment: i64,
) -> Result<Vec<u8>, ScheduleError> {
    if rows_in.len() > SCHEDULE_ROW_LIMIT {
        return Err(ScheduleError::TooManyRows);
    }
    let mut entries = zip::read(template.bytes())?;
    let content = entries
        .iter_mut()
        .find(|e| e.name == "content.xml")
        .ok_or(ScheduleError::Template("no content.xml"))?;
    let xml = String::from_utf8(std::mem::take(&mut content.data))
        .map_err(|_| ScheduleError::Template("content.xml not UTF-8"))?;

    // Each edit: (row, column, value); the total is its own.
    let mut edits: Vec<(usize, usize, Value)> = Vec::new();
    if let Some(e) = earliest {
        edits.push((BOX1.0, BOX1.1, Value::Date(e)));
    }
    if adjustment > 0 {
        edits.push((BOX2.0, BOX2.1, Value::Number(adjustment)));
    }
    for (i, r) in rows_in.iter().enumerate() {
        let row = FIRST_ROW + i;
        for (col, text) in [
            (2, &r.title),
            (3, &r.first_name),
            (4, &r.last_name),
            (5, &r.house),
            (6, &r.postcode),
        ] {
            if !text.is_empty() {
                edits.push((row, col, Value::Text(text)));
            }
        }
        edits.push((row, 9, Value::Date(&r.date)));
        edits.push((row, 10, Value::Number(r.amount)));
    }
    let total: i64 = rows_in.iter().map(|r| r.amount).sum();
    let last = FIRST_ROW + SCHEDULE_ROW_LIMIT - 1;
    let found = rows(&xml, last)?;

    let mut out = String::with_capacity(xml.len() + rows_in.len() * 600);
    let mut copied = 0;
    for row in &found {
        let mine: Vec<&(usize, usize, Value)> =
            edits.iter().filter(|(n, _, _)| *n == row.number).collect();
        if mine.is_empty() && row.number != TOTAL.0 {
            continue;
        }
        let close = row.end - "</table:table-row>".len();
        if xml[..row.open_end].ends_with("/>")
            || attr(&xml[row.start..row.open_end], "table:number-rows-repeated").is_some()
        {
            return Err(ScheduleError::Template("a row to fill is repeated"));
        }
        let mut cs = cells(&xml[row.open_end..close])?;
        for (_, col, value) in mine {
            let i = isolate(&mut cs, *col)?;
            cs[i].xml = filled(&cs[i].xml, value)?;
        }
        if row.number == TOTAL.0 {
            let i = isolate(&mut cs, TOTAL.1)?;
            cs[i].xml = with_total(&cs[i].xml, total)?;
        }
        out.push_str(&xml[copied..row.open_end]);
        for c in &cs {
            out.push_str(&c.xml);
        }
        out.push_str(&xml[close..row.end]);
        copied = row.end;
    }
    out.push_str(&xml[copied..]);
    content.data = out.into_bytes();
    Ok(zip::write(&entries))
}

/// Part `part` (from 1) of a stored claim's schedule: its next 1,000
/// lines, Box 1 the earliest of them, Box 2 the claim's adjustment on
/// part 1 only. `None` for an unknown or deleted claim or a part it
/// doesn't have.
pub fn for_claim(
    conn: &rusqlite::Connection,
    claim_id: &str,
    part: usize,
    template: Template,
) -> Result<Option<Vec<u8>>, ContractError> {
    let Some(claim) = crate::claims::summary(conn, claim_id)?
        .filter(|c| c.status != crate::claim_types::ClaimStatus::Deleted)
    else {
        return Ok(None);
    };
    let lines = crate::claims::lines(conn, claim_id)?;
    let Some(chunk) = part
        .checked_sub(1)
        .and_then(|i| lines.chunks(SCHEDULE_ROW_LIMIT).nth(i))
    else {
        return Ok(None);
    };
    let rows: Vec<Row> = chunk
        .iter()
        .map(|l| Row {
            title: l.title.clone(),
            first_name: l.first_name.clone(),
            last_name: l.last_name.clone(),
            house: l.house.clone(),
            postcode: if l.overseas {
                "X".into()
            } else {
                l.postcode.clone()
            },
            date: l.received_on.clone(),
            amount: l.amount,
        })
        .collect();
    let earliest = rows.iter().map(|r| r.date.as_str()).min();
    let adjustment = if part == 1 {
        claim.totals.adjustment
    } else {
        0
    };
    fill(template, &rows, earliest, adjustment)
        .map(Some)
        .map_err(|e| ContractError::rejected("schedule", e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claim_rules::uk_postcode;

    /// A filled sheet's cells, read back: (row, column) → (value type,
    /// value attribute, text).
    fn read_back(
        ods: &[u8],
    ) -> std::collections::BTreeMap<(usize, usize), (String, String, String)> {
        let entries = zip::read(ods).unwrap();
        assert_eq!(entries[0].name, "mimetype");
        let content = entries.iter().find(|e| e.name == "content.xml").unwrap();
        let xml = std::str::from_utf8(&content.data).unwrap();
        let mut out = std::collections::BTreeMap::new();
        for row in rows(xml, FIRST_ROW + SCHEDULE_ROW_LIMIT - 1).unwrap() {
            if xml[..row.open_end].ends_with("/>") {
                continue;
            }
            let close = row.end - "</table:table-row>".len();
            let mut col = 0;
            for c in cells(&xml[row.open_end..close]).unwrap() {
                let open = &c.xml[..c.xml.find('>').unwrap() + 1];
                if let Some(ty) = attr(open, "office:value-type") {
                    let value = attr(open, "office:date-value")
                        .or_else(|| attr(open, "office:value"))
                        .unwrap_or("")
                        .to_owned();
                    let text = c
                        .xml
                        .split("<text:p>")
                        .nth(1)
                        .map(|t| t.split("</text:p>").next().unwrap().to_owned())
                        .unwrap_or_default();
                    out.insert((row.number, col), (ty.to_owned(), value, text));
                }
                col += c.repeat;
            }
        }
        out
    }

    fn row(i: usize) -> Row {
        Row {
            title: if i.is_multiple_of(2) {
                "Mrs".into()
            } else {
                String::new()
            },
            first_name: "Ann".into(),
            last_name: format!("Smith & Sons {i}"),
            house: "12A".into(),
            postcode: if i == 1 { "X".into() } else { "LS1 1AA".into() },
            date: "2026-03-04".into(),
            amount: 2000 + i as i64,
        }
    }

    /// HMRC's guidance as checks on one schedule row: title ≤ 4, names ≤
    /// 35 (the first one word), house ≤ 40, postcode in capitals with its
    /// space or `X`, date a date shown DD/MM/YY, amount a number with two
    /// places and no £.
    fn hmrc_row_ok(
        cells: &std::collections::BTreeMap<(usize, usize), (String, String, String)>,
        r: usize,
    ) {
        let text = |c| {
            cells
                .get(&(r, c))
                .map(|v: &(String, String, String)| v.2.clone())
                .unwrap_or_default()
        };
        assert!(text(2).chars().count() <= 4);
        assert!(!text(3).is_empty() && text(3).chars().count() <= 35 && !text(3).contains(' '));
        assert!(!text(4).is_empty() && text(4).chars().count() <= 35 + "&amp;".len());
        assert!(!text(5).is_empty() && text(5).chars().count() <= 40);
        let pc = text(6);
        assert!(
            pc == "X" || uk_postcode(&pc).as_deref() == Some(pc.as_str()),
            "{pc}"
        );
        let (ty, value, shown) = &cells[&(r, 9)];
        assert_eq!(ty, "date");
        assert_eq!(shown, &dd_mm_yy(value));
        let (ty, value, shown) = &cells[&(r, 10)];
        assert_eq!(ty, "float");
        assert_eq!(value, shown);
        assert!(!shown.contains('£') && shown.split('.').nth(1).is_some_and(|d| d.len() == 2));
    }

    #[test]
    fn both_templates_fill_hmrcs_cells_and_nothing_else() {
        for template in [Template::Excel, Template::LibreOffice] {
            let rows_in: Vec<Row> = (0..3).map(row).collect();
            let ods = fill(template, &rows_in, Some("2025-01-02"), 262).unwrap();
            let cells = read_back(&ods);
            assert_eq!(
                cells[&(13, 3)],
                ("date".into(), "2025-01-02".into(), "02/01/25".into())
            );
            assert_eq!(
                cells[&(17, 3)],
                ("float".into(), "2.62".into(), "2.62".into())
            );
            assert_eq!(cells[&(20, 9)].1, "60.03");
            assert_eq!(cells[&(20, 9)].2, "£60.03");
            assert_eq!(cells[&(25, 2)].2, "Mrs");
            assert_eq!(cells[&(25, 4)].2, "Smith &amp; Sons 0");
            assert_eq!(cells[&(26, 6)].2, "X");
            assert!(!cells.contains_key(&(26, 2)), "no title, no cell");
            assert_eq!(
                cells[&(27, 10)],
                ("float".into(), "20.02".into(), "20.02".into())
            );
            for r in 25..28 {
                hmrc_row_ok(&cells, r);
            }
            assert!(!cells.contains_key(&(28, 10)));
            // The example rows (7–10) and the item numbers are HMRC's.
            assert_eq!(cells[&(7, 3)].2, "Henry");
            assert_eq!(cells[&(25, 1)].1, "1");
        }
    }

    #[test]
    fn a_full_schedule_and_one_too_many() {
        let rows_in: Vec<Row> = (0..SCHEDULE_ROW_LIMIT).map(row).collect();
        let ods = fill(Template::Excel, &rows_in, None, 0).unwrap();
        let cells = read_back(&ods);
        hmrc_row_ok(&cells, 1024);
        assert!(!cells.contains_key(&(13, 3)) && !cells.contains_key(&(17, 3)));
        let more: Vec<Row> = (0..=SCHEDULE_ROW_LIMIT).map(row).collect();
        assert_eq!(
            fill(Template::Excel, &more, None, 0),
            Err(ScheduleError::TooManyRows)
        );
    }

    #[test]
    fn everything_but_content_is_the_template() {
        let ods = fill(Template::LibreOffice, &[row(0)], None, 0).unwrap();
        let ours = zip::read(&ods).unwrap();
        let theirs = zip::read(LIBRE).unwrap();
        assert_eq!(ours.len(), theirs.len());
        for (a, b) in ours.iter().zip(&theirs) {
            assert_eq!(a.name, b.name);
            if a.name != "content.xml" {
                assert_eq!(a.data, b.data, "{}", a.name);
            }
        }
    }
}
