//! Reads: the contacts list (keyset pages in name order, kind / archived /
//! dropdown filters), search (exact matches first, then FTS5), one
//! contact's whole view, and its history. Each takes a plain `Connection`
//! on one org file: a reader's snapshot, or the writer inside a command.

use std::collections::{BTreeMap, HashSet};

use contracts::{ContractError, Revision, Source};
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params_from_iter};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::acquisition::{SourceFilter, acquisition_of, parse_source_filter, source_clause};
use crate::fields::{field_row, option_row};
use crate::identifiers::{contacts_with_identifier, identifier_views};
use crate::number::{ParsedNumber, parse_number};
use crate::projection::SEARCH_TABLE;
use crate::rules::{looks_like_email, looks_like_uk_postcode, normalise_email, parse_search};
use crate::slices::{load_addresses, load_details, load_field_values, load_methods};
use crate::types::{
    Addresses, ContactPage, ContactRow, ContactView, Counters, FieldValues, HistoryPage, Kind,
    Methods, SearchResult, Warning,
};

/// The most rows a list page or a search window holds.
pub const LIST_LIMIT: usize = 100;
/// The most contacts one exact email or phone lookup reads.
pub const EXACT_LOOKUP_LIMIT: usize = 50;
/// Revisions one history page holds at most.
pub const HISTORY_PAGE_LIMIT: usize = 50;

/// `GET contacts` query string.
#[derive(Clone, Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ListQuery {
    #[serde(default)]
    #[ts(optional)]
    pub include_archived: Option<bool>,
    #[serde(default)]
    #[ts(optional)]
    pub kind: Option<Kind>,
    /// Dropdown filters, comma-separated `fieldId:optionId`, or
    /// `fieldId:none` for "not set". Each field at most once.
    #[serde(default)]
    #[ts(optional)]
    pub fields: Option<String>,
    /// One part of a source code: `category|detail|version:<id>`.
    #[serde(default)]
    #[ts(optional)]
    pub source: Option<String>,
    /// A page's `nextCursor`.
    #[serde(default)]
    #[ts(optional)]
    pub cursor: Option<String>,
    /// At most LIST_LIMIT (the default).
    #[serde(default)]
    #[ts(optional)]
    pub limit: Option<u32>,
}

/// `GET contacts/search` query string.
#[derive(Clone, Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SearchQuery {
    #[serde(default)]
    pub q: String,
    #[serde(default)]
    #[ts(optional)]
    pub include_archived: Option<bool>,
    #[serde(default)]
    #[ts(optional)]
    pub kind: Option<Kind>,
    #[serde(default)]
    #[ts(optional)]
    pub fields: Option<String>,
    /// One part of a source code: `category|detail|version:<id>`.
    #[serde(default)]
    #[ts(optional)]
    pub source: Option<String>,
}

/// A dropdown filter: the field holds this option, or (None) nothing.
#[derive(Clone, Debug, PartialEq)]
pub struct FieldFilter {
    pub field_id: String,
    pub option_id: Option<String>,
}

/// Parse and check `fieldId:optionId|none,…`: the field must exist, the
/// option be its own, each field once. Anything else is refused, never
/// silently matched against nothing.
pub fn field_filters(
    conn: &Connection,
    raw: Option<&str>,
) -> Result<Vec<FieldFilter>, ContractError> {
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for part in raw.split(',') {
        let Some((field_id, option)) = part.split_once(':') else {
            return Err(ContractError::invalid(
                "fields",
                "fieldId:optionId or fieldId:none",
            ));
        };
        if !seen.insert(field_id.to_owned()) {
            return Err(ContractError::invalid(
                "fields",
                "Filter each field at most once",
            ));
        }
        let Some(field) = field_row(conn, field_id)? else {
            return Err(ContractError::rejected(
                "unknown_field",
                "That field does not exist",
            ));
        };
        let option_id = (option != "none").then(|| option.to_owned());
        if let Some(o) = &option_id
            && option_row(conn, o)?.is_none_or(|o| o.field_id != field.id)
        {
            return Err(ContractError::rejected(
                "unknown_option",
                format!("That option is not one of {}'s", field.label),
            ));
        }
        out.push(FieldFilter {
            field_id: field_id.to_owned(),
            option_id,
        });
    }
    Ok(out)
}

/// The list row's columns, on `contacts c`: the first email and the field
/// values are subqueries on their indexes, not a second round of reads.
const ROW_COLUMNS: &str = "c.id, c.kind, c.display_name, c.sort_name, c.number, c.archived,
    (SELECT e.address FROM contact_emails e WHERE e.contact_id = c.id
        ORDER BY e.is_primary DESC, e.position LIMIT 1),
    (SELECT group_concat(v.option_id, ',') FROM contact_field_values v
        WHERE v.contact_id = c.id)";

fn row(r: &rusqlite::Row) -> rusqlite::Result<ContactRow> {
    let options: Option<String> = r.get(7)?;
    Ok(ContactRow {
        id: r.get(0)?,
        kind: Kind::parse(&r.get::<_, String>(1)?).unwrap_or(Kind::Individual),
        display_name: r.get(2)?,
        sort_name: r.get(3)?,
        number: r.get(4)?,
        archived: r.get(5)?,
        email: r.get(6)?,
        field_option_ids: options
            .map(|o| o.split(',').map(str::to_owned).collect())
            .unwrap_or_default(),
    })
}

/// The filters every read shares, as SQL on `contacts c`.
struct Filters {
    sql: String,
    params: Vec<Value>,
}

fn filters(
    include_archived: bool,
    kind: Option<Kind>,
    fields: &[FieldFilter],
    source: Option<&SourceFilter>,
) -> Filters {
    let mut sql = String::new();
    let mut params = Vec::new();
    if let Some(source) = source {
        sql.push_str(source_clause(source));
        params.push(Value::Text(source.id.clone()));
    }
    if !include_archived {
        sql.push_str(" AND c.archived = 0");
    }
    if let Some(kind) = kind {
        sql.push_str(" AND c.kind = ?");
        params.push(Value::Text(kind.as_str().into()));
    }
    for f in fields {
        match &f.option_id {
            Some(option) => {
                sql.push_str(
                    " AND EXISTS (SELECT 1 FROM contact_field_values v
                        WHERE v.contact_id = c.id AND v.field_id = ? AND v.option_id = ?)",
                );
                params.push(Value::Text(f.field_id.clone()));
                params.push(Value::Text(option.clone()));
            }
            None => {
                sql.push_str(
                    " AND NOT EXISTS (SELECT 1 FROM contact_field_values v
                        WHERE v.contact_id = c.id AND v.field_id = ?)",
                );
                params.push(Value::Text(f.field_id.clone()));
            }
        }
    }
    Filters { sql, params }
}

fn hex(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<String> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let bytes = (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect::<Option<Vec<u8>>>()?;
    String::from_utf8(bytes).ok()
}

/// A keyset cursor: the last row's `(sort_key, id)`, opaque to clients.
fn encode_cursor(sort_key: &str, id: &str) -> String {
    format!("{}.{}", hex(sort_key), id)
}

fn decode_cursor(cursor: &str) -> Result<(String, String), ContractError> {
    cursor
        .split_once('.')
        .and_then(|(k, id)| Some((unhex(k)?, id.to_owned())))
        .ok_or_else(|| ContractError::invalid("cursor", "Not a cursor from this list"))
}

/// One page of the contacts list in name order: archived hidden unless
/// asked, optionally one kind and any number of dropdown filters. Every
/// filter is in the one query, so a page is always full while more match.
pub fn list(conn: &Connection, q: &ListQuery) -> Result<ContactPage, ContractError> {
    let fields = field_filters(conn, q.fields.as_deref())?;
    let source = parse_source_filter(q.source.as_deref())?;
    let limit = q
        .limit
        .map_or(LIST_LIMIT, |l| (l as usize).clamp(1, LIST_LIMIT));
    let Filters {
        mut sql,
        mut params,
    } = filters(
        q.include_archived.unwrap_or(false),
        q.kind,
        &fields,
        source.as_ref(),
    );
    if let Some(cursor) = &q.cursor {
        let (key, id) = decode_cursor(cursor)?;
        sql.push_str(" AND (c.sort_key, c.id) > (?, ?)");
        params.push(Value::Text(key));
        params.push(Value::Text(id));
    }
    params.push(Value::Integer(limit as i64 + 1));
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {ROW_COLUMNS}, c.sort_key FROM contacts c WHERE 1 = 1{sql}
         ORDER BY c.sort_key, c.id LIMIT ?"
    ))?;
    let mut rows = Vec::new();
    let mut keys = Vec::new();
    let mut found = stmt.query(params_from_iter(params))?;
    while let Some(r) = found.next()? {
        rows.push(row(r)?);
        keys.push(r.get::<_, String>(8)?);
    }
    let is_done = rows.len() <= limit;
    rows.truncate(limit);
    let next_cursor = (!is_done).then(|| {
        let last = rows.len() - 1;
        encode_cursor(&keys[last], &rows[last].id)
    });
    Ok(ContactPage {
        rows,
        next_cursor,
        is_done,
    })
}

/// Rows for `ids`, in that order, keeping only those that pass `f`.
fn rows_by_ids(
    conn: &Connection,
    ids: &[String],
    f: &Filters,
) -> rusqlite::Result<Vec<ContactRow>> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {ROW_COLUMNS} FROM contacts c WHERE c.id = ?{}",
        f.sql
    ))?;
    let mut out = Vec::new();
    for id in ids {
        let params = std::iter::once(Value::Text(id.clone())).chain(f.params.iter().cloned());
        if let Some(r) = stmt.query_row(params_from_iter(params), row).optional()? {
            out.push(r);
        }
    }
    Ok(out)
}

fn ids(conn: &Connection, sql: &str, param: &dyn rusqlite::ToSql) -> rusqlite::Result<Vec<String>> {
    conn.prepare_cached(sql)?
        .query_map([param], |r| r.get(0))?
        .collect()
}

/// An FTS5 string literal: the terms are letters and digits already, but
/// user input never reaches MATCH unquoted.
fn quote(term: &str) -> String {
    format!("\"{}\"", term.replace('"', "\"\""))
}

/// Full-text hits in rank order (bm25, then name), each passing the
/// filters and holding every term (whole words, the last as a prefix).
/// Returns the rows and how many FTS rows were read.
fn fts_hits(
    conn: &Connection,
    terms: &[String],
    f: &Filters,
    want: usize,
) -> rusqlite::Result<(Vec<ContactRow>, u32)> {
    if terms.is_empty() {
        return Ok((vec![], 0));
    }
    let table = SEARCH_TABLE;
    // Convex's rules exactly: AND of whole words, the last a prefix.
    let expr = terms
        .iter()
        .enumerate()
        .map(|(i, t)| {
            if i + 1 == terms.len() {
                format!("{}*", quote(t))
            } else {
                quote(t)
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    let params = std::iter::once(Value::Text(expr))
        .chain(f.params.iter().cloned())
        .chain(std::iter::once(Value::Integer(want as i64)));
    let rows: Vec<ContactRow> = conn
        .prepare_cached(&format!(
            "SELECT {ROW_COLUMNS} FROM {table} s JOIN contacts c ON c.number = s.rowid
             WHERE {table} MATCH ?{}
             ORDER BY s.rank, c.sort_key, c.id LIMIT ?",
            f.sql
        ))?
        .query_map(params_from_iter(params), row)?
        .collect::<rusqlite::Result<_>>()?;
    let read = rows.len() as u32;
    Ok((rows, read))
}

/// The contacts list with search text: one window of at most LIST_LIMIT
/// rows. Exact matches first: a written contact number (check digit
/// holds), an email address, an identifier, a bare five-digit sequence,
/// then a phone
/// number (normalised), then full-text hits in rank order. Without text,
/// the first page of the list. The same rules as Convex's
/// `contacts/queries:search`: an identifier of any type matches exactly,
/// after an email and before a bare five-digit sequence.
pub fn search(conn: &Connection, q: &SearchQuery) -> Result<SearchResult, ContractError> {
    let term = q.q.trim();
    let include_archived = q.include_archived.unwrap_or(false);
    if term.is_empty() {
        let page = list(
            conn,
            &ListQuery {
                include_archived: Some(include_archived),
                kind: q.kind,
                fields: q.fields.clone(),
                source: q.source.clone(),
                cursor: None,
                limit: None,
            },
        )?;
        return Ok(SearchResult {
            truncated: !page.is_done,
            too_broad: false,
            checked: 0,
            rows: page.rows,
            number_match: None,
            invalid_number: None,
        });
    }
    let fields = field_filters(conn, q.fields.as_deref())?;
    let source = parse_source_filter(q.source.as_deref())?;
    let f = filters(include_archived, q.kind, &fields, source.as_ref());
    let parsed = parse_search(term);
    let number = parse_number(term);

    let by_number = match &number {
        Some(ParsedNumber::Sequence { sequence, .. }) => {
            ids(conn, "SELECT id FROM contacts WHERE number = ?1", sequence)?
        }
        _ => vec![],
    };
    let email = normalise_email(term);
    let by_email = ids(
        conn,
        &format!(
            "SELECT contact_id FROM contact_emails WHERE address_normalized = ?1
             GROUP BY contact_id ORDER BY min(rowid) LIMIT {EXACT_LOOKUP_LIMIT}"
        ),
        &email,
    )?;
    let by_phone = match &parsed.phone {
        Some(phone) => ids(
            conn,
            &format!(
                "SELECT contact_id FROM contact_phones WHERE number_normalized = ?1
                 GROUP BY contact_id ORDER BY min(rowid) LIMIT {EXACT_LOOKUP_LIMIT}"
            ),
            phone,
        )?,
        None => vec![],
    };

    let by_identifier = contacts_with_identifier(conn, term)?;

    // A written number (Luhn-checked) leads. A bare five-digit sequence is
    // weaker: an old system's member number, kept as an identifier, is
    // often five digits in the same range, so identifiers go first.
    let written = matches!(number, Some(ParsedNumber::Sequence { written: true, .. }));
    let candidates: Vec<String> = if written {
        by_number
            .iter()
            .chain(&by_email)
            .chain(&by_identifier)
            .cloned()
            .collect()
    } else {
        by_email
            .iter()
            .chain(&by_identifier)
            .chain(&by_number)
            .cloned()
            .collect()
    };
    let mut seen = HashSet::new();
    let mut rows: Vec<ContactRow> = rows_by_ids(conn, &candidates, &f)?
        .into_iter()
        .filter(|r| seen.insert(r.id.clone()))
        .collect();
    let number_match = match (by_number.first(), rows.first()) {
        (Some(n), Some(first)) if *n == first.id => Some(n.clone()),
        _ => None,
    };
    let exact = rows.len();
    for r in rows_by_ids(conn, &by_phone, &f)? {
        if seen.insert(r.id.clone()) {
            rows.push(r);
        }
    }
    let want = (LIST_LIMIT + 1).saturating_sub(rows.len());
    let (hits, checked) = fts_hits(conn, &parsed.terms, &f, want + exact)?;
    let hit_count = hits.len();
    for r in hits {
        if seen.insert(r.id.clone()) {
            rows.push(r);
        }
    }
    // Six digits are as often a phone tail as a mistyped number: the hint
    // only when nothing matched exactly or by phone.
    let invalid_number = match number {
        Some(ParsedNumber::Invalid { hint }) if exact == 0 && rows.is_empty() => Some(hint),
        _ => None,
    };
    let truncated = rows.len() > LIST_LIMIT || hit_count >= want + exact;
    rows.truncate(LIST_LIMIT);
    Ok(SearchResult {
        too_broad: truncated && rows.is_empty(),
        truncated,
        checked,
        rows,
        number_match,
        invalid_number,
    })
}

pub(crate) fn counters(conn: &Connection, id: &str) -> rusqlite::Result<Option<Counters>> {
    conn.prepare_cached(
        "SELECT details_version, methods_version, addresses_version, archive_version,
                fields_version, identifiers_version, acquisition_version
         FROM contacts WHERE id = ?1",
    )?
    .query_row([id], |r| {
        Ok(Counters {
            details: r.get(0)?,
            methods: r.get(1)?,
            addresses: r.get(2)?,
            archive: r.get(3)?,
            fields: r.get(4)?,
            identifiers: r.get(5)?,
            acquisition: r.get(6)?,
        })
    })
    .optional()
}

/// Up to this many other contacts' rows for an address are read.
const SHARERS_READ: usize = 50;
const NAMED_SHARERS: usize = 3;

/// Another contact using one of this contact's addresses.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Sharer {
    pub id: String,
    pub display_name: String,
    pub archived: bool,
}

/// The other contacts using one address, oldest row first; `truncated`:
/// more exist than were read, so any count is a lower bound.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct Sharers {
    pub contacts: Vec<Sharer>,
    pub truncated: bool,
}

/// For each of the contact's saved email rows (by key), the other contacts
/// using its address: the "also used by" warning's input. Approximate by
/// design (ADR 0015, advisory): at most SHARERS_READ rows per address, on
/// the normalised-address index. Rows nobody else uses are left out.
pub fn also_used_by(
    conn: &Connection,
    id: &str,
    methods: &Methods,
) -> rusqlite::Result<BTreeMap<String, Sharers>> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT c.id, c.display_name, c.archived FROM contact_emails e
         JOIN contacts c ON c.id = e.contact_id
         WHERE e.address_normalized = ?1 AND e.contact_id != ?2
         ORDER BY e.rowid LIMIT {}",
        SHARERS_READ + 1
    ))?;
    let mut out = BTreeMap::new();
    for email in &methods.emails {
        let rows: Vec<Sharer> = stmt
            .query_map(
                rusqlite::params![normalise_email(&email.address), id],
                |r| {
                    Ok(Sharer {
                        id: r.get(0)?,
                        display_name: r.get(1)?,
                        archived: r.get(2)?,
                    })
                },
            )?
            .collect::<rusqlite::Result<_>>()?;
        let truncated = rows.len() > SHARERS_READ;
        let mut seen = HashSet::new();
        let contacts: Vec<Sharer> = rows
            .into_iter()
            .take(SHARERS_READ)
            .filter(|s| seen.insert(s.id.clone()))
            .collect();
        if !contacts.is_empty() || truncated {
            out.insert(
                email.key.clone().unwrap_or_default(),
                Sharers {
                    contacts,
                    truncated,
                },
            );
        }
    }
    Ok(out)
}

fn shared_email_message(s: &Sharers) -> String {
    let names: Vec<String> = s
        .contacts
        .iter()
        .map(|c| {
            if c.archived {
                format!("{} (archived)", c.display_name)
            } else {
                c.display_name.clone()
            }
        })
        .collect();
    let shown = &names[..names.len().min(NAMED_SHARERS)];
    let rest = names.len() - shown.len();
    if rest == 0 && !s.truncated {
        return format!("Also used by {}", shown.join(", "));
    }
    let count = if s.truncated {
        format!("at least {rest}")
    } else {
        rest.to_string()
    };
    let others = if rest == 1 && !s.truncated {
        "other"
    } else {
        "others"
    };
    format!("Also used by {} and {count} {others}", shown.join(", "))
}

/// Advisory warnings over the saved contact (ADR 0015 tier 2), including
/// "also used by" for an email another contact holds.
fn warnings(
    conn: &Connection,
    id: &str,
    methods: &Methods,
    addresses: &Addresses,
) -> rusqlite::Result<Vec<Warning>> {
    let mut out = Vec::new();
    if methods.emails.is_empty() && methods.phones.is_empty() && addresses.addresses.is_empty() {
        out.push(Warning {
            anchor: String::new(),
            label: "Contact".into(),
            message: "No email, phone or address yet".into(),
        });
    }
    let shared = also_used_by(conn, id, methods)?;
    for (i, email) in methods.emails.iter().enumerate() {
        let label = format!("email {}", i + 1);
        if !looks_like_email(&email.address) {
            out.push(Warning {
                anchor: format!("emails.{i}"),
                label: label.clone(),
                message: format!("“{}” doesn’t look like an email address", email.address),
            });
        }
        let key = email.key.as_deref().unwrap_or("");
        if let Some(s) = shared.get(key) {
            // Anchored by key: the form's rows can be reordered or removed
            // before a save, and this warning names a person.
            out.push(Warning {
                anchor: format!("emails#{key}"),
                label,
                message: shared_email_message(s),
            });
        }
    }
    for (i, a) in addresses.addresses.iter().enumerate() {
        if a.country == "GB" && !a.postcode.is_empty() && !looks_like_uk_postcode(&a.postcode) {
            out.push(Warning {
                anchor: format!("addresses.{i}"),
                label: format!("address {}", i + 1),
                message: format!("“{}” doesn’t look like a UK postcode", a.postcode),
            });
        }
    }
    Ok(out)
}

/// The whole contact: every slice, its counters and its warnings.
pub fn get(conn: &Connection, id: &str) -> Result<Option<ContactView>, ContractError> {
    let root = conn
        .prepare_cached(
            "SELECT number, kind, display_name, sort_name, archived FROM contacts WHERE id = ?1",
        )?
        .query_row([id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, bool>(4)?,
            ))
        })
        .optional()?;
    let Some((number, kind, display_name, sort_name, archived)) = root else {
        return Ok(None);
    };
    let methods = load_methods(conn, id)?;
    let addresses = load_addresses(conn, id)?;
    let warnings = warnings(conn, id, &methods, &addresses)?;
    Ok(Some(ContactView {
        id: id.to_owned(),
        number,
        kind: Kind::parse(&kind).unwrap_or(Kind::Individual),
        display_name,
        sort_name,
        archived,
        details: load_details(conn, id)?,
        methods,
        addresses,
        fields: FieldValues {
            values: load_field_values(conn, id)?,
        },
        acquisition: acquisition_of(conn, id)?,
        counters: counters(conn, id)?.unwrap_or_default(),
        warnings,
        identifiers: identifier_views(conn, id)?,
    }))
}

/// A contact's revisions, newest first, `limit` at most, older than
/// `before` (a revision id) when given.
pub fn history(
    conn: &Connection,
    id: &str,
    before: Option<i64>,
    limit: usize,
) -> Result<HistoryPage, ContractError> {
    let limit = limit.clamp(1, HISTORY_PAGE_LIMIT);
    let mut stmt = conn.prepare_cached(
        "SELECT id, contract, version, counter, payload, actor, source, group_id, group_name,
                restored_from, at
         FROM revisions WHERE entity = 'contacts' AND entity_id = ?1 AND id < ?2
         ORDER BY id DESC LIMIT ?3",
    )?;
    let mut revisions = stmt
        .query_map(
            rusqlite::params![id, before.unwrap_or(i64::MAX), limit as i64 + 1],
            |r| {
                let payload: String = r.get(4)?;
                let source: String = r.get(6)?;
                Ok(Revision {
                    id: r.get(0)?,
                    contract: r.get(1)?,
                    version: r.get(2)?,
                    counter: r.get(3)?,
                    payload: serde_json::from_str(&payload).unwrap_or_default(),
                    actor: r.get(5)?,
                    source: serde_json::from_value(serde_json::Value::String(source))
                        .unwrap_or(Source::System),
                    group: r.get(7)?,
                    group_name: r.get(8)?,
                    restored_from: r.get(9)?,
                    at: r.get(10)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let more = revisions.len() > limit;
    revisions.truncate(limit);
    Ok(HistoryPage {
        next_before: more.then(|| revisions.last().map(|r| r.id)).flatten(),
        revisions,
    })
}

/// The most email rows one address lookup reads.
pub const EMAIL_LOOKUP_LIMIT: usize = 50;

/// Contacts using an email address (case- and whitespace-insensitive).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct EmailMatches {
    /// Contact ids, oldest row first, archived contacts included.
    pub ids: Vec<String>,
    /// More rows exist than were read: a caller that needs "exactly one
    /// match" must treat it as ambiguous.
    pub truncated: bool,
}

/// For imports and webhooks: the contacts using this address, at most
/// EMAIL_LOOKUP_LIMIT rows read. A blank address finds nothing.
pub fn find_by_email(conn: &Connection, address: &str) -> rusqlite::Result<EmailMatches> {
    let normalized = normalise_email(address);
    if normalized.is_empty() {
        return Ok(EmailMatches::default());
    }
    let rows: Vec<String> = conn
        .prepare_cached(&format!(
            "SELECT contact_id FROM contact_emails WHERE address_normalized = ?1
             ORDER BY rowid LIMIT {}",
            EMAIL_LOOKUP_LIMIT + 1
        ))?
        .query_map([normalized], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let truncated = rows.len() > EMAIL_LOOKUP_LIMIT;
    let mut seen = HashSet::new();
    let ids = rows
        .into_iter()
        .take(EMAIL_LOOKUP_LIMIT)
        .filter(|id| seen.insert(id.clone()))
        .collect();
    Ok(EmailMatches { ids, truncated })
}

/// The contact a new-contact form created, by the form's `clientKey`.
pub fn by_client_key(conn: &Connection, client_key: &str) -> rusqlite::Result<Option<String>> {
    conn.prepare_cached("SELECT id FROM contacts WHERE client_key = ?1")?
        .query_row([client_key], |r| r.get(0))
        .optional()
}

/// The contact's saved email addresses, as typed: what its holds are
/// looked up by (comms).
pub fn email_addresses(conn: &Connection, id: &str) -> rusqlite::Result<Vec<String>> {
    conn.prepare_cached(
        "SELECT address FROM contact_emails WHERE contact_id = ?1 ORDER BY position",
    )?
    .query_map([id], |r| r.get(0))?
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sharers(n: usize, truncated: bool) -> Sharers {
        Sharers {
            contacts: (1..=n)
                .map(|i| Sharer {
                    id: i.to_string(),
                    display_name: format!("P{i}"),
                    archived: false,
                })
                .collect(),
            truncated,
        }
    }

    #[test]
    fn names_the_first_three_then_counts_the_rest() {
        let m = |n, t| shared_email_message(&sharers(n, t));
        assert_eq!(m(1, false), "Also used by P1");
        assert_eq!(m(3, false), "Also used by P1, P2, P3");
        assert_eq!(m(4, false), "Also used by P1, P2, P3 and 1 other");
        assert_eq!(m(6, false), "Also used by P1, P2, P3 and 3 others");
        assert_eq!(m(6, true), "Also used by P1, P2, P3 and at least 3 others");
    }
}
