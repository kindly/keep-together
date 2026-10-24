//! The search projection (the `contactSearch` rule): one FTS row per
//! contact, rebuilt from the contact's current state by the `project` hook
//! of every contract that changes its text, in the same transaction, and
//! written nowhere else. Kind, archived and field values are not in it:
//! search joins `contacts` for those filters.

use rusqlite::{Connection, OptionalExtension};

use crate::rules::{SearchAddress, SearchContact, search_text};

/// The two FTS5 tables, maintained side by side so one seed measures both.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FtsVariant {
    /// `unicode61` words with prefix indexes: Convex's matching rules
    /// (every term a whole word, the last a prefix) are a plain MATCH.
    #[default]
    Words,
    /// `trigram`: substring matches of 3+ characters; the word rules are
    /// then checked per row, and shorter entries scan.
    Trigram,
}

impl FtsVariant {
    pub fn table(self) -> &'static str {
        match self {
            FtsVariant::Words => "contact_search_words",
            FtsVariant::Trigram => "contact_search_trigram",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "words" | "unicode61" => Some(FtsVariant::Words),
            "trigram" => Some(FtsVariant::Trigram),
            _ => None,
        }
    }
}

const VARIANTS: [FtsVariant; 2] = [FtsVariant::Words, FtsVariant::Trigram];

/// The search text of one contact, from its rows now.
pub(crate) fn contact_text(conn: &Connection, id: &str) -> rusqlite::Result<Option<(i64, String)>> {
    let root = conn
        .query_row(
            "SELECT number, first_name, last_name, nickname, name, sort_name
             FROM contacts WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    [
                        r.get::<_, String>(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ],
                ))
            },
        )
        .optional()?;
    let Some((number, [first, last, nick, name, sort])) = root else {
        return Ok(None);
    };
    let column = |sql: &str| -> rusqlite::Result<Vec<String>> {
        conn.prepare_cached(sql)?
            .query_map([id], |r| r.get(0))?
            .collect()
    };
    let emails = column("SELECT address FROM contact_emails WHERE contact_id = ?1 ORDER BY position")?;
    let phones = column("SELECT number FROM contact_phones WHERE contact_id = ?1 ORDER BY position")?;
    let addresses: Vec<[String; 3]> = conn
        .prepare_cached(
            "SELECT line1, town, postcode FROM contact_addresses
             WHERE contact_id = ?1 ORDER BY position",
        )?
        .query_map([id], |r| Ok([r.get(0)?, r.get(1)?, r.get(2)?]))?
        .collect::<rusqlite::Result<_>>()?;
    let text = search_text(
        &SearchContact {
            first_name: &first,
            last_name: &last,
            nickname: &nick,
            name: &name,
            sort_name: &sort,
        },
        &emails.iter().map(String::as_str).collect::<Vec<_>>(),
        &phones.iter().map(String::as_str).collect::<Vec<_>>(),
        &addresses
            .iter()
            .map(|[line1, town, postcode]| SearchAddress {
                line1,
                town,
                postcode,
            })
            .collect::<Vec<_>>(),
    );
    Ok(Some((number, text)))
}

/// Rebuild one contact's FTS rows; writes only when the text changed.
pub fn rebuild_search(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    let Some((rowid, text)) = contact_text(conn, id)? else {
        return Ok(());
    };
    for v in VARIANTS {
        let table = v.table();
        let existing: Option<String> = conn
            .prepare_cached(&format!("SELECT text FROM {table} WHERE rowid = ?1"))?
            .query_row([rowid], |r| r.get(0))
            .optional()?;
        if existing.as_deref() == Some(text.as_str()) {
            continue;
        }
        if existing.is_some() {
            conn.prepare_cached(&format!("DELETE FROM {table} WHERE rowid = ?1"))?
                .execute([rowid])?;
        }
        conn.prepare_cached(&format!("INSERT INTO {table} (rowid, text) VALUES (?1, ?2)"))?
            .execute(rusqlite::params![rowid, text])?;
    }
    Ok(())
}
