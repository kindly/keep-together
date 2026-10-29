//! Scanned paper Gift Aid declarations (plan `declaration-scans.sv`): the
//! image is the record (HMRC 3.7.2: "a scanned image that's an exact
//! replica of a declaration"; typed fields are not). One
//! `declaration_scans` root per scan, 1–[`MAX_PAGES`] pages as child rows
//! carrying ids. The page images are blobs in the organisation's files
//! db, which this crate never sees: a page row names its blob by SHA-256,
//! and the api puts and deletes blobs around these contracts (blob first
//! on the way in, contract first on the way out).
//!
//! Three contracts partition the root:
//!
//! ```text
//!   giftaid.scan          — where it came from (phone pairing or a signed-in
//!                           phone, who, when) and its pages; the pages are
//!                           reordered, removed or added only while a draft
//!   giftaid.scanReview    — accepted onto a declaration (a `paperForm` one
//!                           of the contact on screen, not void, holding no
//!                           other scan) or discarded; once, from a draft
//!   giftaid.scanRetention — the images went (a discarded scan after 30
//!                           days, an admin from the "can be deleted"
//!                           report, erasure); the row stays forever
//! ```
//!
//! Declarations stay create-only: accepting a scan writes nothing on the
//! declaration, and a scan never changes coverage (rule 1). None of the
//! three can be restored: the pages name blobs that may have gone, and a
//! review or deletion only moves forward.

use std::collections::HashSet;

use contracts::{ChildRow, mint_ids, reconcile};
use contracts::{
    Command, CommandGroup, Contract, ContractError, Ctx, Exec, Executed, OrgTx, Source, WriteTx,
    command_group, execute, is_client_id,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::declarations;
use crate::rules::{GiftRef, covering_declaration, uk_date};
use crate::types::{DeclarationPayload, Method};

pub const TABLE: &str = "declaration_scans";
pub const PAGES: &str = "declaration_scan_pages";

/// Pages in one scan (g1q3).
pub const MAX_PAGES: usize = 6;
/// A stored page, after the server's re-encode (g1q7): 400 KB.
pub const MAX_PAGE_BYTES: i64 = 400 * 1024;
/// A discarded scan's images go this long after the discard (g1q4).
pub const DISCARD_PURGE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// "Can be deleted": the declaration has covered no gift for this long
/// (g1q9). Longer than HMRC's 6 years, whichever legal form the charity
/// has, because we don't know it.
pub const RETENTION_YEARS: i32 = 7;

/// The org-schema step this module owns (scans, after claims'). New
/// tables only: nothing to backfill.
pub const MIGRATION: &str = "
CREATE TABLE declaration_scans (
    id TEXT PRIMARY KEY,
    via TEXT NOT NULL CHECK (via IN ('phone', 'direct')),
    pairing_id TEXT,
    scanned_by INTEGER,
    scanned_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'accepted', 'discarded')),
    declaration_id TEXT REFERENCES gift_aid_declarations (id),
    reviewed_by INTEGER,
    reviewed_at INTEGER,
    discard_reason TEXT,
    image_deleted_at INTEGER,
    deleted_by INTEGER,
    deletion_reason TEXT,
    scan_version INTEGER NOT NULL DEFAULT 0,
    review_version INTEGER NOT NULL DEFAULT 0,
    retention_version INTEGER NOT NULL DEFAULT 0,
    CHECK ((status = 'accepted') = (declaration_id IS NOT NULL))
) STRICT;
CREATE INDEX declaration_scans_by_status ON declaration_scans (status, scanned_at);
CREATE INDEX declaration_scans_by_declaration ON declaration_scans (declaration_id);
CREATE INDEX declaration_scans_by_pairing ON declaration_scans (pairing_id, scanned_at);
CREATE TABLE declaration_scan_pages (
    id TEXT PRIMARY KEY,
    scan_id TEXT NOT NULL REFERENCES declaration_scans (id),
    page_no INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    size INTEGER NOT NULL
) STRICT;
CREATE INDEX declaration_scan_pages_by_scan ON declaration_scan_pages (scan_id, page_no);
CREATE INDEX declaration_scan_pages_by_blob ON declaration_scan_pages (sha256);
";

// ── types ─────────────────────────────────────────────────────────────────

/// How a scan reached us: a phone paired by QR code (no sign-in on it),
/// or a phone signed in as staff.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "ScanVia")]
pub enum Via {
    Phone,
    Direct,
}

impl Via {
    pub fn as_str(self) -> &'static str {
        match self {
            Via::Phone => "phone",
            Via::Direct => "direct",
        }
    }

    fn parse(s: &str) -> Self {
        if s == "phone" {
            Via::Phone
        } else {
            Via::Direct
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "ScanStatus")]
pub enum Status {
    Draft,
    Accepted,
    Discarded,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Draft => "draft",
            Status::Accepted => "accepted",
            Status::Discarded => "discarded",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "accepted" => Status::Accepted,
            "discarded" => Status::Discarded,
            _ => Status::Draft,
        }
    }
}

/// One page of a scan: its blob (by SHA-256, the identity of the row:
/// another image is another page) and its stored size. Its position in
/// the list is its page number.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "ScanPagePayload")]
pub struct Page {
    #[serde(default)]
    #[ts(optional)]
    pub id: Option<String>,
    pub sha256: String,
    pub width: i64,
    pub height: i64,
    #[ts(type = "number")]
    pub size: i64,
}

impl ChildRow for Page {
    fn id(&self) -> &str {
        self.id.as_deref().unwrap_or_default()
    }
    fn identity(&self) -> Option<&str> {
        Some(&self.sha256)
    }
}

/// The `giftaid.scan` slice. `via` and `pairingId` are set at create and
/// never change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "ScanPayload")]
pub struct ScanPayload {
    pub via: Via,
    #[serde(default)]
    #[ts(optional)]
    pub pairing_id: Option<String>,
    pub pages: Vec<Page>,
}

/// The `giftaid.scanReview` command.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, rename = "ScanReviewPayload")]
pub enum ReviewPayload {
    /// The scan is the evidence for this declaration of `contactId` (the
    /// contact on screen: a mismatched id is refused, not guessed).
    Accept {
        declaration_id: String,
        contact_id: String,
    },
    Discard {
        #[serde(default)]
        #[ts(optional)]
        reason: Option<String>,
    },
}

/// Why a scan's images went.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "ScanDeletionReason")]
pub enum DeletionReason {
    /// Discarded 30 days ago (the purge job).
    Discarded,
    /// An admin, from the "can be deleted" report.
    Retention,
    /// The contact was erased and the scan is not needed as a tax record.
    Erasure,
}

impl DeletionReason {
    fn as_str(self) -> &'static str {
        match self {
            DeletionReason::Discarded => "discarded",
            DeletionReason::Retention => "retention",
            DeletionReason::Erasure => "erasure",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "retention" => DeletionReason::Retention,
            "erasure" => DeletionReason::Erasure,
            _ => DeletionReason::Discarded,
        }
    }
}

/// The `giftaid.scanRetention` command.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "ScanRetentionPayload")]
pub struct RetentionPayload {
    pub reason: DeletionReason,
}

/// A page as the laptop shows it (the image is `…/pages/{pageNo}`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "ScanPage")]
pub struct PageView {
    pub id: String,
    pub page_no: i64,
    pub width: i64,
    pub height: i64,
    #[ts(type = "number")]
    pub size: i64,
}

/// One scan, as staff see it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "ScanView")]
pub struct ScanView {
    pub id: String,
    pub status: Status,
    pub via: Via,
    pub pairing_id: Option<String>,
    #[ts(type = "number | null")]
    pub scanned_by: Option<i64>,
    #[ts(type = "number")]
    pub scanned_at: i64,
    pub declaration_id: Option<String>,
    #[ts(type = "number | null")]
    pub reviewed_by: Option<i64>,
    #[ts(type = "number | null")]
    pub reviewed_at: Option<i64>,
    pub discard_reason: Option<String>,
    /// The images went (the row stays): no page can be shown.
    #[ts(type = "number | null")]
    pub image_deleted_at: Option<i64>,
    pub deletion_reason: Option<DeletionReason>,
    pub pages: Vec<PageView>,
    #[ts(type = "number")]
    pub scan_version: i64,
    #[ts(type = "number")]
    pub review_version: i64,
    #[ts(type = "number")]
    pub retention_version: i64,
}

/// A row of the "can be deleted" report: an accepted scan whose
/// declaration has covered no gift for [`RETENTION_YEARS`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "DeletableScan")]
pub struct DeletableScan {
    pub scan: ScanView,
    pub contact_id: String,
    pub declaration_made_on: String,
    /// The last gift it covered; `None` if it covered none.
    pub last_covered_on: Option<String>,
}

// ── reads ─────────────────────────────────────────────────────────────────

const COLUMNS: &str = "id, status, via, pairing_id, scanned_by, scanned_at, declaration_id, \
     reviewed_by, reviewed_at, discard_reason, image_deleted_at, deletion_reason, scan_version, \
     review_version, retention_version";

fn root(r: &rusqlite::Row) -> rusqlite::Result<ScanView> {
    Ok(ScanView {
        id: r.get(0)?,
        status: Status::parse(&r.get::<_, String>(1)?),
        via: Via::parse(&r.get::<_, String>(2)?),
        pairing_id: r.get(3)?,
        scanned_by: r.get(4)?,
        scanned_at: r.get(5)?,
        declaration_id: r.get(6)?,
        reviewed_by: r.get(7)?,
        reviewed_at: r.get(8)?,
        discard_reason: r.get(9)?,
        image_deleted_at: r.get(10)?,
        deletion_reason: r
            .get::<_, Option<String>>(11)?
            .map(|s| DeletionReason::parse(&s)),
        pages: vec![],
        scan_version: r.get(12)?,
        review_version: r.get(13)?,
        retention_version: r.get(14)?,
    })
}

/// A scan's pages in order, with their blobs.
fn page_rows(conn: &Connection, scan_id: &str) -> rusqlite::Result<Vec<(Page, i64)>> {
    conn.prepare_cached(
        "SELECT id, sha256, width, height, size, page_no FROM declaration_scan_pages
         WHERE scan_id = ?1 ORDER BY page_no, id",
    )?
    .query_map([scan_id], |r| {
        Ok((
            Page {
                id: Some(r.get(0)?),
                sha256: r.get(1)?,
                width: r.get(2)?,
                height: r.get(3)?,
                size: r.get(4)?,
            },
            r.get(5)?,
        ))
    })?
    .collect()
}

fn with_pages(conn: &Connection, mut scan: ScanView) -> rusqlite::Result<ScanView> {
    scan.pages = page_rows(conn, &scan.id)?
        .into_iter()
        .map(|(p, page_no)| PageView {
            id: p.id.unwrap_or_default(),
            page_no,
            width: p.width,
            height: p.height,
            size: p.size,
        })
        .collect();
    Ok(scan)
}

fn list(
    conn: &Connection,
    filter: &str,
    param: &dyn rusqlite::ToSql,
) -> rusqlite::Result<Vec<ScanView>> {
    let roots: Vec<ScanView> = conn
        .prepare_cached(&format!(
            "SELECT {COLUMNS} FROM {TABLE} WHERE {filter} ORDER BY scanned_at, id LIMIT 500"
        ))?
        .query_map([param], root)?
        .collect::<rusqlite::Result<_>>()?;
    roots.into_iter().map(|s| with_pages(conn, s)).collect()
}

/// One scan, or `None`.
pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<ScanView>> {
    let found = conn
        .prepare_cached(&format!("SELECT {COLUMNS} FROM {TABLE} WHERE id = ?1"))?
        .query_row([id], root)
        .optional()?;
    found.map(|s| with_pages(conn, s)).transpose()
}

/// "Scans to match" (g1q4): every draft, oldest first, whoever scanned
/// it and whichever sitting it came from. At most 500.
pub fn inbox(conn: &Connection) -> rusqlite::Result<Vec<ScanView>> {
    list(conn, "status = ?1", &Status::Draft.as_str())
}

/// One sitting's stack: the scans a pairing sent, oldest first (the
/// laptop's live list, and all the phone may know of).
pub fn by_pairing(conn: &Connection, pairing_id: &str) -> rusqlite::Result<Vec<ScanView>> {
    list(conn, "pairing_id = ?1", &pairing_id)
}

/// The scans accepted onto a declaration (its evidence).
pub fn by_declaration(conn: &Connection, declaration_id: &str) -> rusqlite::Result<Vec<ScanView>> {
    list(conn, "declaration_id = ?1", &declaration_id)
}

/// The blob of page `page_no` of a scan, if the scan has that page and
/// its images haven't gone. `None` otherwise: the caller answers 404.
pub fn page_blob(
    conn: &Connection,
    scan_id: &str,
    page_no: i64,
) -> rusqlite::Result<Option<String>> {
    conn.prepare_cached(
        "SELECT p.sha256 FROM declaration_scan_pages p
         JOIN declaration_scans s ON s.id = p.scan_id
         WHERE p.scan_id = ?1 AND p.page_no = ?2 AND s.image_deleted_at IS NULL",
    )?
    .query_row(params![scan_id, page_no], |r| r.get(0))
    .optional()
}

/// Every blob a page still needs: pages of scans whose images haven't
/// gone. The api's sweep deletes any other blob in the files db (with a
/// grace for writes in flight).
pub fn referenced_blobs(conn: &Connection) -> rusqlite::Result<HashSet<String>> {
    conn.prepare_cached(
        "SELECT DISTINCT p.sha256 FROM declaration_scan_pages p
         JOIN declaration_scans s ON s.id = p.scan_id
         WHERE s.image_deleted_at IS NULL",
    )?
    .query_map([], |r| r.get(0))?
    .collect()
}

/// Discarded scans whose images are due to go at `now` (ms): discarded
/// [`DISCARD_PURGE_MS`] ago or more, images still held. Never an
/// accepted scan: nothing deletes one automatically (g1q9).
pub fn discarded_due(conn: &Connection, now: i64) -> rusqlite::Result<Vec<String>> {
    conn.prepare_cached(
        "SELECT id FROM declaration_scans
         WHERE status = 'discarded' AND image_deleted_at IS NULL AND reviewed_at <= ?1
         ORDER BY reviewed_at, id",
    )?
    .query_map([now - DISCARD_PURGE_MS], |r| r.get(0))?
    .collect()
}

/// The day `years` before an ISO date (29 February → 28 February).
fn years_before(date: &str, years: i32) -> String {
    let (y, rest) = date.split_at(4);
    let y: i32 = y.parse().unwrap_or(0) - years;
    let rest = if rest == "-02-29" { "-02-28" } else { rest };
    format!("{y:04}{rest}")
}

/// The last gift (money received) `declaration` covered, as an ISO date.
pub fn last_covered_on(
    conn: &Connection,
    declaration_id: &str,
) -> rusqlite::Result<Option<String>> {
    let Some(d) = declarations::load(conn, declaration_id)? else {
        return Ok(None);
    };
    let chain = declarations::chain(conn, &d.payload.contact_id)?;
    let gifts = giving::received_gifts(conn, &d.payload.contact_id)?;
    Ok(gifts
        .iter()
        .rev()
        .find(|(id, date)| {
            covering_declaration(
                &chain,
                GiftRef {
                    date,
                    gift_id: Some(id),
                },
            )
            .is_some_and(|c| c.id == declaration_id)
        })
        .map(|(_, date)| date.clone()))
}

/// Whether an accepted scan's declaration has covered no gift for
/// [`RETENTION_YEARS`] on `today`: counted from the last gift it covered,
/// or from when it was made if it covered none. Only then may an admin
/// delete it (3.30: kept while it covers ongoing donations, then 6 years
/// after the last).
fn retention_ended(
    conn: &Connection,
    declaration_id: &str,
    today: &str,
) -> rusqlite::Result<Option<DeletableFacts>> {
    let Some(d) = declarations::load(conn, declaration_id)? else {
        return Ok(None);
    };
    let last = last_covered_on(conn, declaration_id)?;
    let since = last.clone().unwrap_or_else(|| d.payload.made_on.clone());
    let ended = since.max(d.payload.made_on.clone()) < years_before(today, RETENTION_YEARS);
    Ok(ended.then_some(DeletableFacts {
        contact_id: d.payload.contact_id,
        made_on: d.payload.made_on,
        last_covered_on: last,
    }))
}

struct DeletableFacts {
    contact_id: String,
    made_on: String,
    last_covered_on: Option<String>,
}

/// The "can be deleted" report (admin, g1q9): accepted scans with their
/// images whose declaration has covered no gift for [`RETENTION_YEARS`]
/// on `today`, oldest scan first.
pub fn deletable(conn: &Connection, today: &str) -> rusqlite::Result<Vec<DeletableScan>> {
    let mut out = vec![];
    for scan in list(
        conn,
        "status = ?1 AND image_deleted_at IS NULL",
        &Status::Accepted.as_str(),
    )? {
        let Some(declaration_id) = scan.declaration_id.clone() else {
            continue;
        };
        if let Some(f) = retention_ended(conn, &declaration_id, today)? {
            out.push(DeletableScan {
                scan,
                contact_id: f.contact_id,
                declaration_made_on: f.made_on,
                last_covered_on: f.last_covered_on,
            });
        }
    }
    Ok(out)
}

/// What erasing the contact must do to this scan (g1q10, for when
/// erasure is built): `true` = delete its images now, `false` = keep it
/// (admin-only from then on) until its retention ends. Kept while its
/// declaration covered a gift a live Gift Aid claim claims: the image is
/// that claim's evidence.
pub fn erasure_deletes(conn: &Connection, scan: &ScanView, today: &str) -> rusqlite::Result<bool> {
    let Some(declaration_id) = scan.declaration_id.as_deref() else {
        return Ok(true);
    };
    if crate::claims::claimed_under(conn, declaration_id)?.is_empty() {
        return Ok(true);
    }
    Ok(retention_ended(conn, declaration_id, today)?.is_some())
}

// ── giftaid.scan ──────────────────────────────────────────────────────────

/// A scan's origin and pages, plus what the contract checks but doesn't
/// own (not serialised: a stale refusal's `current` is the slice).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanState {
    #[serde(flatten)]
    pub payload: ScanPayload,
    #[serde(skip)]
    status: Status,
    #[serde(skip)]
    images_gone: bool,
    #[serde(skip)]
    scanned_by: Option<i64>,
    #[serde(skip)]
    scanned_at: i64,
}

/// The scan as uploaded: created by the first page's upload, and while
/// it is a draft its pages may be reordered, removed (at least one stays)
/// or added (at most [`MAX_PAGES`]). Refused once reviewed. `via`,
/// `pairingId`, who scanned and when are the create's.
pub struct ScanContract;
pub static SCAN: ScanContract = ScanContract;

fn prepare_scan(mut p: ScanPayload) -> Result<ScanPayload, ContractError> {
    mint_ids(&mut p.pages, |page| &mut page.id);
    let mut problems = vec![];
    if p.pages.is_empty() {
        problems.push(contracts::Problem::new(
            "pages",
            "A scan has at least one page",
        ));
    }
    if let Some(pairing) = p.pairing_id.as_deref()
        && !is_client_id(pairing)
    {
        problems.push(contracts::Problem::new(
            "pairingId",
            "32 lower-case hex characters",
        ));
    }
    if p.via == Via::Phone && p.pairing_id.is_none() {
        problems.push(contracts::Problem::new(
            "pairingId",
            "A phone scan names its pairing",
        ));
    }
    for (i, page) in p.pages.iter().enumerate() {
        let sha_ok = page.sha256.len() == 64
            && page
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !sha_ok {
            problems.push(contracts::Problem::new(
                format!("pages.{i}.sha256"),
                "a SHA-256",
            ));
        }
        if page.width <= 0 || page.height <= 0 {
            problems.push(contracts::Problem::new(
                format!("pages.{i}"),
                "no image size",
            ));
        }
        if page.size <= 0 || page.size > MAX_PAGE_BYTES {
            problems.push(contracts::Problem::new(
                format!("pages.{i}.size"),
                format!("a page is at most {MAX_PAGE_BYTES} bytes"),
            ));
        }
    }
    if !problems.is_empty() {
        return Err(ContractError::Invalid(problems));
    }
    if p.pages.len() > MAX_PAGES {
        return Err(ContractError::rejected(
            "page_limit",
            format!("A scan has at most {MAX_PAGES} pages"),
        ));
    }
    Ok(p)
}

fn not_restorable(command: &Command) -> Result<(), ContractError> {
    if command.source == Source::Restore {
        return Err(ContractError::rejected(
            "not_restorable",
            "A scan's history can't be restored: its images may have gone",
        ));
    }
    Ok(())
}

impl Contract for ScanContract {
    const NAME: &'static str = "giftaid.scan";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "scan_version";
    type Payload = ScanPayload;
    type State = ScanState;

    fn prepare(&self, p: ScanPayload) -> Result<ScanPayload, ContractError> {
        prepare_scan(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<ScanState, ContractError> {
        let conn = tx.read();
        let (via, pairing_id, status, deleted, by, at): (
            String,
            Option<String>,
            String,
            Option<i64>,
            Option<i64>,
            i64,
        ) = conn.query_row(
            "SELECT via, pairing_id, status, image_deleted_at, scanned_by, scanned_at
                 FROM declaration_scans WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )?;
        Ok(ScanState {
            payload: ScanPayload {
                via: Via::parse(&via),
                pairing_id,
                pages: page_rows(conn, id)?.into_iter().map(|(p, _)| p).collect(),
            },
            status: Status::parse(&status),
            images_gone: deleted.is_some(),
            scanned_by: by,
            scanned_at: at,
        })
    }

    fn apply(
        &self,
        current: Option<&ScanState>,
        p: &ScanPayload,
        command: &Command,
    ) -> Result<ScanState, ContractError> {
        not_restorable(command)?;
        let Some(current) = current else {
            return Ok(ScanState {
                payload: p.clone(),
                status: Status::Draft,
                images_gone: false,
                scanned_by: command.actor,
                scanned_at: command.at,
            });
        };
        if current.status != Status::Draft || current.images_gone {
            return Err(ContractError::rejected(
                "not_draft",
                "This scan has been reviewed: its pages can’t change",
            ));
        }
        if p.via != current.payload.via || p.pairing_id != current.payload.pairing_id {
            return Err(ContractError::rejected(
                "scan_origin",
                "Where a scan came from can’t change",
            ));
        }
        Ok(ScanState {
            payload: p.clone(),
            ..current.clone()
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&ScanState>,
        next: &ScanState,
    ) -> Result<(), ContractError> {
        let p = &next.payload;
        if before.is_none() {
            tx.prepare_cached(
                "INSERT INTO declaration_scans (id, via, pairing_id, scanned_by, scanned_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )?
            .execute(params![
                id,
                p.via.as_str(),
                p.pairing_id,
                next.scanned_by,
                next.scanned_at
            ])?;
        }
        let old = before
            .map(|b| b.payload.pages.as_slice())
            .unwrap_or_default();
        let diff = reconcile("pages", old, &p.pages)?;
        for page in &diff.removed {
            tx.prepare_cached("DELETE FROM declaration_scan_pages WHERE id = ?1 AND scan_id = ?2")?
                .execute(params![page.id(), id])?;
        }
        let added: HashSet<&str> = diff.added.iter().map(|page| page.id()).collect();
        for (i, page) in p.pages.iter().enumerate() {
            let page_no = i as i64 + 1;
            if added.contains(page.id()) {
                // A plain insert: an id another scan's page holds fails
                // here, never moves that page.
                tx.prepare_cached(
                    "INSERT INTO declaration_scan_pages (id, scan_id, page_no, sha256, width, height, size)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                )?
                .execute(params![page.id(), id, page_no, page.sha256, page.width, page.height, page.size])?;
            } else {
                tx.prepare_cached(
                    "UPDATE declaration_scan_pages SET page_no = ?3, width = ?4, height = ?5, size = ?6
                     WHERE id = ?1 AND scan_id = ?2",
                )?
                .execute(params![page.id(), id, page_no, page.width, page.height, page.size])?;
            }
        }
        Ok(())
    }
}

// ── giftaid.scanReview ────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewState {
    pub status: Status,
    pub declaration_id: Option<String>,
    pub discard_reason: Option<String>,
    /// The contact the accept named (checked in `write`).
    #[serde(skip)]
    contact_id: Option<String>,
    #[serde(skip)]
    reviewed_by: Option<i64>,
    #[serde(skip)]
    reviewed_at: Option<i64>,
}

/// Accept a draft onto a declaration, or discard it. Once: a reviewed
/// scan isn't reviewed again. The declaration must be the named
/// contact's, `paperForm` (the scan is the paper), not void, and hold no
/// other accepted scan. Nothing is written on the declaration.
pub struct ReviewContract;
pub static REVIEW: ReviewContract = ReviewContract;

impl Contract for ReviewContract {
    const NAME: &'static str = "giftaid.scanReview";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "review_version";
    type Payload = ReviewPayload;
    type State = ReviewState;

    fn prepare(&self, p: ReviewPayload) -> Result<ReviewPayload, ContractError> {
        Ok(match p {
            ReviewPayload::Discard { reason } => ReviewPayload::Discard {
                reason: reason
                    .map(|r| r.trim().to_owned())
                    .filter(|r| !r.is_empty()),
            },
            accept => accept,
        })
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<ReviewState, ContractError> {
        Ok(tx.read().query_row(
            "SELECT status, declaration_id, discard_reason, reviewed_by, reviewed_at
             FROM declaration_scans WHERE id = ?1",
            [id],
            |r| {
                Ok(ReviewState {
                    status: Status::parse(&r.get::<_, String>(0)?),
                    declaration_id: r.get(1)?,
                    discard_reason: r.get(2)?,
                    contact_id: None,
                    reviewed_by: r.get(3)?,
                    reviewed_at: r.get(4)?,
                })
            },
        )?)
    }

    fn apply(
        &self,
        current: Option<&ReviewState>,
        p: &ReviewPayload,
        command: &Command,
    ) -> Result<ReviewState, ContractError> {
        not_restorable(command)?;
        let Some(current) = current else {
            return Err(ContractError::rejected(
                "no_root",
                "giftaid.scanReview targets an existing scan",
            ));
        };
        if current.status != Status::Draft {
            return Err(ContractError::rejected(
                "reviewed",
                "This scan has already been accepted or discarded",
            ));
        }
        let (status, declaration_id, discard_reason, contact_id) = match p {
            ReviewPayload::Accept {
                declaration_id,
                contact_id,
            } => (
                Status::Accepted,
                Some(declaration_id.clone()),
                None,
                Some(contact_id.clone()),
            ),
            ReviewPayload::Discard { reason } => (Status::Discarded, None, reason.clone(), None),
        };
        Ok(ReviewState {
            status,
            declaration_id,
            discard_reason,
            contact_id,
            reviewed_by: command.actor,
            reviewed_at: Some(command.at),
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&ReviewState>,
        next: &ReviewState,
    ) -> Result<(), ContractError> {
        if let Some(declaration_id) = next.declaration_id.as_deref() {
            check_accept(
                tx,
                id,
                declaration_id,
                next.contact_id.as_deref().unwrap_or_default(),
            )?;
        }
        tx.prepare_cached(
            "UPDATE declaration_scans SET status = ?2, declaration_id = ?3, discard_reason = ?4,
                 reviewed_by = ?5, reviewed_at = ?6
             WHERE id = ?1",
        )?
        .execute(params![
            id,
            next.status.as_str(),
            next.declaration_id,
            next.discard_reason,
            next.reviewed_by,
            next.reviewed_at
        ])?;
        Ok(())
    }
}

fn check_accept(
    conn: &Connection,
    scan_id: &str,
    declaration_id: &str,
    contact_id: &str,
) -> Result<(), ContractError> {
    let d = declarations::load(conn, declaration_id)?
        .filter(|d| d.payload.contact_id == contact_id)
        .ok_or_else(|| {
            ContractError::rejected(
                "unknown_declaration",
                "A scan can only be matched to one of this contact’s declarations",
            )
        })?;
    if d.voided_at.is_some() {
        return Err(ContractError::rejected(
            "voided_declaration",
            "This declaration was made in error and voided",
        ));
    }
    if d.payload.method != Method::PaperForm {
        return Err(ContractError::rejected(
            "not_paper_form",
            "A scan is evidence for a declaration made on a paper form",
        ));
    }
    let held: Option<String> = conn
        .query_row(
            "SELECT id FROM declaration_scans WHERE declaration_id = ?1 AND id <> ?2 LIMIT 1",
            params![declaration_id, scan_id],
            |r| r.get(0),
        )
        .optional()?;
    if held.is_some() {
        return Err(ContractError::rejected(
            "declaration_has_scan",
            "This declaration already has a scan: merge the pages into it instead",
        ));
    }
    Ok(())
}

// ── giftaid.scanRetention ─────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionState {
    pub image_deleted_at: Option<i64>,
    pub deletion_reason: Option<DeletionReason>,
    #[serde(skip)]
    deleted_by: Option<i64>,
    #[serde(skip)]
    status: Status,
    #[serde(skip)]
    reviewed_at: Option<i64>,
}

/// Record that a scan's images go. Once. The api deletes the blobs only
/// after this commits; the row and its pages' sizes stay (rule 3). By
/// reason:
///
/// - `discarded`: a discarded scan, [`DISCARD_PURGE_MS`] after the discard;
/// - `retention`: an accepted scan in the "can be deleted" report
///   ([`deletable`]) on the command's day;
/// - `erasure`: what [`erasure_deletes`] allows.
pub struct RetentionContract;
pub static RETENTION: RetentionContract = RetentionContract;

impl Contract for RetentionContract {
    const NAME: &'static str = "giftaid.scanRetention";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "retention_version";
    type Payload = RetentionPayload;
    type State = RetentionState;

    fn load(&self, tx: &OrgTx, id: &str) -> Result<RetentionState, ContractError> {
        Ok(tx.read().query_row(
            "SELECT image_deleted_at, deletion_reason, deleted_by, status, reviewed_at
             FROM declaration_scans WHERE id = ?1",
            [id],
            |r| {
                Ok(RetentionState {
                    image_deleted_at: r.get(0)?,
                    deletion_reason: r
                        .get::<_, Option<String>>(1)?
                        .map(|s| DeletionReason::parse(&s)),
                    deleted_by: r.get(2)?,
                    status: Status::parse(&r.get::<_, String>(3)?),
                    reviewed_at: r.get(4)?,
                })
            },
        )?)
    }

    fn apply(
        &self,
        current: Option<&RetentionState>,
        p: &RetentionPayload,
        command: &Command,
    ) -> Result<RetentionState, ContractError> {
        not_restorable(command)?;
        let Some(current) = current else {
            return Err(ContractError::rejected(
                "no_root",
                "giftaid.scanRetention targets an existing scan",
            ));
        };
        if current.image_deleted_at.is_some() {
            return Err(ContractError::rejected(
                "already_deleted",
                "This scan’s images have already gone",
            ));
        }
        match p.reason {
            DeletionReason::Discarded => {
                let due = current.status == Status::Discarded
                    && current
                        .reviewed_at
                        .is_some_and(|at| at + DISCARD_PURGE_MS <= command.at);
                if !due {
                    return Err(ContractError::rejected(
                        "not_due",
                        "Only a scan discarded 30 days ago goes this way",
                    ));
                }
            }
            DeletionReason::Retention => {
                if current.status != Status::Accepted {
                    return Err(ContractError::rejected(
                        "not_due",
                        "Only an accepted scan is in the “can be deleted” report",
                    ));
                }
            }
            DeletionReason::Erasure => {}
        }
        Ok(RetentionState {
            image_deleted_at: Some(command.at),
            deletion_reason: Some(p.reason),
            deleted_by: command.actor,
            ..current.clone()
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&RetentionState>,
        next: &RetentionState,
    ) -> Result<(), ContractError> {
        let at = next.image_deleted_at.unwrap_or_default();
        let today = uk_date(at);
        let allowed = match next.deletion_reason {
            Some(DeletionReason::Retention) => {
                let declaration: Option<String> = tx.query_row(
                    "SELECT declaration_id FROM declaration_scans WHERE id = ?1",
                    [id],
                    |r| r.get(0),
                )?;
                match declaration {
                    Some(d) => retention_ended(tx, &d, &today)?.is_some(),
                    None => false,
                }
            }
            Some(DeletionReason::Erasure) => {
                let scan = get(tx, id)?.ok_or(ContractError::NotFound)?;
                erasure_deletes(tx, &scan, &today)?
            }
            _ => true,
        };
        if !allowed {
            return Err(ContractError::rejected(
                "retention_running",
                "This scan is still needed as Gift Aid evidence",
            ));
        }
        tx.prepare_cached(
            "UPDATE declaration_scans SET image_deleted_at = ?2, deletion_reason = ?3, deleted_by = ?4
             WHERE id = ?1",
        )?
        .execute(params![
            id,
            next.image_deleted_at,
            next.deletion_reason.map(|r| r.as_str()),
            next.deleted_by
        ])?;
        Ok(())
    }
}

// ── commands ──────────────────────────────────────────────────────────────

/// A new draft with its first page (an upload). `id`: the phone's own
/// key, so a retried upload is the same scan (`409 duplicate` the second
/// time); minted otherwise.
pub fn create_scan(
    ctx: &Ctx,
    id: Option<&str>,
    via: Via,
    pairing_id: Option<String>,
    page: Page,
    source: Source,
) -> Result<Executed, ContractError> {
    let payload = ScanPayload {
        via,
        pairing_id,
        pages: vec![page],
    };
    let opts = match id {
        Some(id) => Exec::create_with_id(id, source),
        None => Exec::create(source),
    };
    execute(ctx, &SCAN, payload, opts)
}

/// Add a page at the end of a draft (an upload). A page whose id the
/// scan already has is the same upload retried: nothing changes, and
/// the scan's counter is returned.
pub fn add_page(
    ctx: &Ctx,
    scan_id: &str,
    page: Page,
    source: Source,
) -> Result<Executed, ContractError> {
    let current = SCAN.load(ctx.tx, scan_id).map_err(not_found)?;
    if let Some(id) = page.id.as_deref()
        && current.payload.pages.iter().any(|p| p.id() == id)
    {
        let counter: i64 = ctx.tx.read().query_row(
            "SELECT scan_version FROM declaration_scans WHERE id = ?1",
            [scan_id],
            |r| r.get(0),
        )?;
        return Ok(Executed {
            id: scan_id.to_owned(),
            counter,
        });
    }
    if let Some(id) = page.id.as_deref() {
        let taken: bool = ctx.tx.read().query_row(
            "SELECT EXISTS (SELECT 1 FROM declaration_scan_pages WHERE id = ?1)",
            [id],
            |r| r.get(0),
        )?;
        if taken {
            return Err(ContractError::Duplicate { id: id.to_owned() });
        }
    }
    let mut payload = current.payload;
    payload.pages.push(page);
    execute(ctx, &SCAN, payload, Exec::update(scan_id, None, source))
}

/// Reorder or remove a draft's pages: `order` names the pages to keep, in
/// their new order (at least one; only this scan's).
pub fn set_pages(
    ctx: &Ctx,
    scan_id: &str,
    expected: i64,
    order: &[String],
    source: Source,
) -> Result<Executed, ContractError> {
    let current = SCAN.load(ctx.tx, scan_id).map_err(not_found)?;
    let mut pages = vec![];
    for id in order {
        let page = current
            .payload
            .pages
            .iter()
            .find(|p| p.id() == id)
            .ok_or_else(|| ContractError::invalid("order", "Name only this scan’s pages"))?;
        if pages.iter().any(|p: &Page| p.id() == id) {
            return Err(ContractError::invalid("order", "Name each page once"));
        }
        pages.push(page.clone());
    }
    let payload = ScanPayload {
        pages,
        ..current.payload
    };
    execute(
        ctx,
        &SCAN,
        payload,
        Exec::update(scan_id, Some(expected), source),
    )
}

/// Merge draft `from`'s pages onto the end of draft `into` (g1q3: two
/// photos of one form sent as two scans), and discard `from` ("merged"),
/// in one command group. `into_expected` is `into`'s `scanVersion`,
/// `from_review_expected` `from`'s `reviewVersion`.
pub fn merge_scans(
    ctx: &Ctx,
    into: &str,
    into_expected: i64,
    from: &str,
    from_review_expected: i64,
    source: Source,
) -> Result<Executed, ContractError> {
    if into == from {
        return Err(ContractError::invalid("from", "Merge two different scans"));
    }
    let target = SCAN.load(ctx.tx, into).map_err(not_found)?;
    let other = SCAN.load(ctx.tx, from).map_err(not_found)?;
    if other.status != Status::Draft || other.images_gone {
        return Err(ContractError::rejected(
            "not_draft",
            "Only a scan not yet matched can be merged",
        ));
    }
    let mut payload = target.payload;
    payload.pages.extend(
        other
            .payload
            .pages
            .into_iter()
            .map(|p| Page { id: None, ..p }),
    );
    let group = command_group(ctx, "Scans merged")?;
    let out = execute(
        ctx,
        &SCAN,
        payload,
        Exec::update(into, Some(into_expected), source).in_group(&group),
    )?;
    execute(
        ctx,
        &REVIEW,
        ReviewPayload::Discard {
            reason: Some("Merged into another scan".into()),
        },
        Exec::update(from, Some(from_review_expected), source).in_group(&group),
    )?;
    Ok(out)
}

/// What a scan is matched to on accept.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, rename = "ScanMatch")]
pub enum Match {
    /// A declaration already recorded without a scan.
    Existing { declaration_id: String },
    /// A new declaration from the form beside the scan (`paperForm`).
    New { declaration: DeclarationPayload },
}

/// Accept a scan as the evidence for a declaration (g1q5): an existing
/// one, or a new one recorded from the form beside it, both in one
/// command group, so both or neither. Returns the declaration's id.
pub fn accept_scan(
    ctx: &Ctx,
    scan_id: &str,
    expected: i64,
    contact_id: &str,
    with: Match,
    source: Source,
) -> Result<String, ContractError> {
    let group: CommandGroup = command_group(ctx, "Gift Aid declaration scan matched")?;
    let declaration_id = match with {
        Match::Existing { declaration_id } => declaration_id,
        Match::New { declaration } => {
            if declaration.contact_id != contact_id {
                return Err(ContractError::invalid(
                    "declaration.contactId",
                    "The contact on screen",
                ));
            }
            crate::make_declaration(ctx, declaration, source, Some(&group))?.id
        }
    };
    execute(
        ctx,
        &REVIEW,
        ReviewPayload::Accept {
            declaration_id: declaration_id.clone(),
            contact_id: contact_id.to_owned(),
        },
        Exec::update(scan_id, Some(expected), source).in_group(&group),
    )?;
    Ok(declaration_id)
}

/// Discard a draft (g1q4): its row stays, its images go after 30 days.
pub fn discard_scan(
    ctx: &Ctx,
    scan_id: &str,
    expected: i64,
    reason: Option<String>,
    source: Source,
) -> Result<Executed, ContractError> {
    execute(
        ctx,
        &REVIEW,
        ReviewPayload::Discard { reason },
        Exec::update(scan_id, Some(expected), source),
    )
}

/// Record that a scan's images go (see [`RetentionContract`]). The
/// caller deletes the blobs after the commit.
pub fn delete_images(
    ctx: &Ctx,
    scan_id: &str,
    expected: Option<i64>,
    reason: DeletionReason,
    source: Source,
) -> Result<Executed, ContractError> {
    execute(
        ctx,
        &RETENTION,
        RetentionPayload { reason },
        Exec::update(scan_id, expected, source),
    )
}

/// `load` on a missing root fails with "no rows"; a command names it as
/// not found.
fn not_found(e: ContractError) -> ContractError {
    match e {
        ContractError::Sqlite(rusqlite::Error::QueryReturnedNoRows) => ContractError::NotFound,
        other => other,
    }
}
