//! Scanning paper Gift Aid declarations with a phone (plan
//! `declaration-scans.sv`, step 3): phone pairings, the upload path into
//! the org's files db and `giftaid::scans`, and the jobs that tidy up.
//!
//! **Pairing.** Staff on a laptop start a pairing (`POST
//! /api/t/{slug}/scan-pairings`, staff or admin, a sign-in or step-up
//! within the hour under `strict`). It is a 256-bit token shown as a QR
//! code; `platform.db` (`scan_pairings`) keeps only its SHA-256, with the
//! org, the user, the laptop's session and the expiry. The phone opens
//! `/scan.html#<token>` and talks to `/api/scan/{token}` ([`phone`]),
//! outside the tenant prefix: the row's `tenant_id` is the only way to a
//! file, as with GoCardless's webhook. A token can do nothing but upload
//! to that org and read its own sitting's scans.
//!
//! A pairing is live while all of these hold ([`resolve`]):
//! - not ended (the laptop's `DELETE`, or its session gone: sign-out,
//!   revoke-all, expiry; `platform.db` triggers on `auth_sessions` end it
//!   in the same transaction, whatever deleted the row);
//! - under [`HARD_CAP_MS`] old and used within [`IDLE_MS`];
//! - its user still staff or admin of the org;
//! - opened by this device: the first `GET` claims it with an
//!   `HttpOnly; SameSite=Strict; Secure` cookie, and any other device is
//!   refused (`403`).
//!
//! Dead or unknown: `410 {kind: "gone"}`, the same answer for both, so a
//! token can't be probed. The token is never logged: errors name the
//! pairing by its id.
//!
//! **Upload** ([`store_page`], [`upload`]): the image is decoded under
//! dimension and pixel limits and re-encoded as a greyscale JPEG with no
//! metadata ([`image`]), put into the files db (idempotent by SHA-256,
//! refused past the org's 2 GB cap), then the scan's contract commits.
//! Two files, no shared transaction: a blob whose contract was refused is
//! an orphan, which the blob sweep removes after a day. Deletion goes the
//! other way: `giftaid.scanRetention` commits, then the blobs go.

pub mod image;
pub mod phone;

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use contracts::Source;
use giftaid::scans::{self as domain, DeletionReason, Page, Via};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use store::files::{CAP_BYTES, FilesError};
use store::{OrgDb, PlatformSchema, Role, Store, StoreError, TenantId, UserId};
use ts_rs::TS;

use crate::error::ApiError;

/// A pairing ends this long after it was started, however busy (g1q6's
/// "hard cap of about 2 hours").
pub const HARD_CAP_MS: i64 = 2 * 60 * 60 * 1000;
/// ... or after this long without a request from the phone.
pub const IDLE_MS: i64 = 15 * 60 * 1000;
/// Uploads (pages) one pairing may send (g1q7).
pub const MAX_UPLOADS: i64 = 300;
/// The body of an upload: one page as the phone encoded it. The server
/// stores at most [`domain::MAX_PAGE_BYTES`] after its own re-encode.
pub const UPLOAD_BODY_LIMIT: usize = 1024 * 1024;
/// The phone's device cookie (`kt_scan` on a loopback host, like the
/// session cookie).
pub const DEVICE_COOKIE: &str = "__Host-kt_scan";
pub const DEV_DEVICE_COOKIE: &str = "kt_scan";

/// `platform.db`'s pairings. Run after `auth`'s schema: the triggers end
/// a pairing when its session goes and follow a session's token
/// rotation (step-up, a role change), so every path that deletes or
/// rotates a session is covered, `keep`'s included.
pub const SCHEMA: PlatformSchema = PlatformSchema {
    name: "scans",
    steps: &[
        // 1: pairings, and their tie to the laptop's session
        "CREATE TABLE scan_pairings (
             id TEXT PRIMARY KEY,
             token_hash TEXT NOT NULL UNIQUE,
             tenant_id TEXT NOT NULL REFERENCES tenants (id),
             user_id INTEGER NOT NULL REFERENCES users (id),
             session_id TEXT NOT NULL,
             purpose TEXT NOT NULL CHECK (purpose IN ('stack', 'contact', 'gift')),
             created_at INTEGER NOT NULL,
             last_used_at INTEGER NOT NULL,
             expires_at INTEGER NOT NULL,
             device_hash TEXT,
             ended_at INTEGER,
             ended_why TEXT,
             uploads INTEGER NOT NULL DEFAULT 0
         ) STRICT;
         CREATE INDEX scan_pairings_by_session ON scan_pairings (session_id);
         CREATE INDEX scan_pairings_by_tenant ON scan_pairings (tenant_id, created_at);
         CREATE TRIGGER scan_pairings_end_with_session AFTER DELETE ON auth_sessions
         BEGIN
             UPDATE scan_pairings
             SET ended_at = CAST(unixepoch('subsec') * 1000 AS INTEGER), ended_why = 'session'
             WHERE session_id = OLD.token_hash AND ended_at IS NULL;
         END;
         CREATE TRIGGER scan_pairings_follow_rotation AFTER UPDATE OF token_hash ON auth_sessions
         BEGIN
             UPDATE scan_pairings SET session_id = NEW.token_hash
             WHERE session_id = OLD.token_hash;
         END;",
    ],
};

/// What the laptop starts a pairing for (g2q3): the contact's Gift Aid
/// panel, the record-gift page, or a stack sitting from the Gift Aid
/// menu. A label for the laptop; the scans all go to the org's drafts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "ScanPurpose")]
pub enum Purpose {
    Stack,
    Contact,
    Gift,
}

impl Purpose {
    fn as_str(self) -> &'static str {
        match self {
            Purpose::Stack => "stack",
            Purpose::Contact => "contact",
            Purpose::Gift => "gift",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "contact" => Purpose::Contact,
            "gift" => Purpose::Gift,
            _ => Purpose::Stack,
        }
    }
}

/// A `scan_pairings` row. Never holds the token.
#[derive(Clone, Debug)]
pub struct Pairing {
    pub id: String,
    pub tenant_id: String,
    pub user_id: i64,
    pub session_id: String,
    pub purpose: Purpose,
    pub created_at: i64,
    pub last_used_at: i64,
    pub expires_at: i64,
    pub device_hash: Option<String>,
    pub ended_at: Option<i64>,
    pub uploads: i64,
}

impl Pairing {
    /// When it ends if nothing else ends it first.
    pub fn idle_expires_at(&self) -> i64 {
        (self.last_used_at + IDLE_MS).min(self.expires_at)
    }

    fn timed_out(&self, now: i64) -> bool {
        now >= self.expires_at || now >= self.last_used_at + IDLE_MS
    }
}

const COLUMNS: &str = "id, tenant_id, user_id, session_id, purpose, created_at, last_used_at, \
     expires_at, device_hash, ended_at, uploads";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Pairing> {
    Ok(Pairing {
        id: r.get(0)?,
        tenant_id: r.get(1)?,
        user_id: r.get(2)?,
        session_id: r.get(3)?,
        purpose: Purpose::parse(&r.get::<_, String>(4)?),
        created_at: r.get(5)?,
        last_used_at: r.get(6)?,
        expires_at: r.get(7)?,
        device_hash: r.get(8)?,
        ended_at: r.get(9)?,
        uploads: r.get(10)?,
    })
}

/// A new pairing for `user`'s `session` at `tenant`: its id and the
/// token (returned once, never stored).
pub fn start(
    store: &Store,
    tenant: &TenantId,
    user: i64,
    session_id: &str,
    purpose: Purpose,
    now: i64,
) -> Result<(Pairing, String), StoreError> {
    let token = ::auth::secret::token();
    let id = contracts::new_id();
    store.platform().with_write(|tx| {
        tx.execute(
            "INSERT INTO scan_pairings (id, token_hash, tenant_id, user_id, session_id, purpose,
                 created_at, last_used_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)",
            params![
                id,
                ::auth::secret::hash(&token),
                tenant.as_str(),
                user,
                session_id,
                purpose.as_str(),
                now,
                now + HARD_CAP_MS
            ],
        )
        .map(|_| ())
    })?;
    let pairing =
        by_id(store, &id)?.ok_or(StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows))?;
    Ok((pairing, token))
}

/// A pairing by id, live or not.
pub fn by_id(store: &Store, id: &str) -> Result<Option<Pairing>, StoreError> {
    store.platform().with_read(|c| {
        Ok(c.query_row(
            &format!("SELECT {COLUMNS} FROM scan_pairings WHERE id = ?1"),
            [id],
            row,
        )
        .optional()?)
    })
}

/// End a pairing (the laptop's "Done", or found dead). Idempotent.
pub fn end(store: &Store, id: &str, why: &str, now: i64) -> Result<(), StoreError> {
    store.platform().with_write(|tx| {
        tx.execute(
            "UPDATE scan_pairings SET ended_at = ?2, ended_why = ?3
             WHERE id = ?1 AND ended_at IS NULL",
            params![id, now, why],
        )
        .map(|_| ())
    })?;
    Ok(())
}

/// Why a phone's request is refused.
#[derive(Debug)]
pub enum Refused {
    /// Unknown, ended, timed out, its session or membership gone: `410`.
    Gone,
    /// Another device holds it: `403`.
    OtherDevice,
    Store(StoreError),
}

impl From<StoreError> for Refused {
    fn from(e: StoreError) -> Self {
        Refused::Store(e)
    }
}

impl From<Refused> for ApiError {
    fn from(r: Refused) -> Self {
        match r {
            Refused::Gone => ApiError::Gone,
            Refused::OtherDevice => ApiError::Forbidden,
            Refused::Store(e) => e.into(),
        }
    }
}

/// A live pairing, its org resolved from `platform.db`.
#[derive(Clone, Debug)]
pub struct Live {
    pub pairing: Pairing,
    pub tenant: TenantId,
    pub org_name: String,
}

/// How a request may use a pairing.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Use {
    /// The phone's first `GET`: claims it for `device` if unclaimed.
    Claim,
    /// Anything else: only the device that claimed it.
    Upload,
}

/// The live pairing `token` names, for the device whose cookie hashes to
/// `device` (module docs). On `Use::Claim` an unclaimed pairing becomes
/// `device`'s. Counts as use (the idle clock restarts). A pairing found
/// dead is ended here, so the laptop sees it end.
pub fn resolve(
    store: &Store,
    token: &str,
    device: Option<&str>,
    how: Use,
    now: i64,
) -> Result<Live, Refused> {
    if !::auth::secret::well_formed(token) {
        return Err(Refused::Gone);
    }
    let hash = ::auth::secret::hash(token);
    let found: Option<Pairing> = store.platform().with_read(|c| {
        Ok::<_, StoreError>(
            c.query_row(
                &format!("SELECT {COLUMNS} FROM scan_pairings WHERE token_hash = ?1"),
                [&hash],
                row,
            )
            .optional()?,
        )
    })?;
    let Some(p) = found else {
        return Err(Refused::Gone);
    };
    if p.ended_at.is_some() {
        return Err(Refused::Gone);
    }
    if p.timed_out(now) {
        end(store, &p.id, "timeout", now)?;
        return Err(Refused::Gone);
    }
    // The laptop's session (the triggers end the pairing when it goes;
    // this is belt and braces) and the user's role there, re-read.
    let session = store
        .platform()
        .with_read(|c| ::auth::sessions::by_id(c, &p.session_id, now))
        .map_err(StoreError::from)?;
    if !session.is_some_and(|s| s.user == p.user_id && s.stage == ::auth::Stage::Full) {
        end(store, &p.id, "session", now)?;
        return Err(Refused::Gone);
    }
    let tenant = store
        .platform()
        .tenants()?
        .into_iter()
        .find(|t| t.id.as_str() == p.tenant_id)
        .ok_or(Refused::Gone)?;
    match store.platform().member(UserId(p.user_id), &tenant.slug)? {
        Some(m) if m.role >= Role::Staff && m.tenant.id == tenant.id => {}
        _ => {
            end(store, &p.id, "membership", now)?;
            return Err(Refused::Gone);
        }
    }
    let Some(device) = device else {
        return Err(Refused::OtherDevice);
    };
    let mine = match p.device_hash.as_deref() {
        Some(held) => ::auth::secret::same(held, device),
        None => false,
    };
    // Claimed and used in one statement: two phones opening the link at
    // once can't both win.
    let claimed = store.platform().with_write(|tx| {
        let n = if mine {
            tx.execute(
                "UPDATE scan_pairings SET last_used_at = max(last_used_at, ?2)
                 WHERE id = ?1 AND ended_at IS NULL",
                params![p.id, now],
            )?
        } else if how == Use::Claim {
            tx.execute(
                "UPDATE scan_pairings SET device_hash = ?3, last_used_at = max(last_used_at, ?2)
                 WHERE id = ?1 AND ended_at IS NULL AND device_hash IS NULL",
                params![p.id, now, device],
            )?
        } else {
            0
        };
        Ok::<_, rusqlite::Error>(n == 1)
    });
    if !claimed.map_err(StoreError::from)? {
        return Err(Refused::OtherDevice);
    }
    let pairing = by_id(store, &p.id)?.ok_or(Refused::Gone)?;
    Ok(Live {
        pairing,
        tenant: tenant.id,
        org_name: tenant.name,
    })
}

/// Count one upload against the pairing's [`MAX_UPLOADS`], before the
/// work: an attempt that fails still counts. Refused past the limit.
pub fn take_upload(store: &Store, pairing_id: &str) -> Result<i64, ApiError> {
    let left: Option<i64> = store.platform().with_write(|tx| {
        let n = tx.execute(
            "UPDATE scan_pairings SET uploads = uploads + 1 WHERE id = ?1 AND uploads < ?2",
            params![pairing_id, MAX_UPLOADS],
        )?;
        if n == 0 {
            return Ok::<_, rusqlite::Error>(None);
        }
        let used: i64 = tx.query_row(
            "SELECT uploads FROM scan_pairings WHERE id = ?1",
            [pairing_id],
            |r| r.get(0),
        )?;
        Ok(Some(MAX_UPLOADS - used))
    })?;
    left.ok_or_else(|| ApiError::Rejected {
        reason: "upload_limit".into(),
        message: format!("A sitting can send at most {MAX_UPLOADS} pages: start another"),
    })
}

/// Delete pairings that ended (or timed out) more than a day ago. They
/// are worthless after: kept a day for the laptop's "link ended" view.
pub fn sweep(store: &Store, now: i64) -> Result<usize, StoreError> {
    let day = 24 * 60 * 60 * 1000;
    store.platform().with_write(|tx| {
        Ok(tx.execute(
            "DELETE FROM scan_pairings
             WHERE coalesce(ended_at, min(expires_at, last_used_at + ?2)) < ?1",
            params![now - day, IDLE_MS],
        )?)
    })
}

// ── the upload path ───────────────────────────────────────────────────────

/// Decode, re-encode and put one page's image in `db`'s files db.
/// Blocking. The page row is the caller's to commit.
pub fn store_page(db: &OrgDb, raw: &[u8], now: i64) -> Result<Page, ApiError> {
    let processed = image::reencode(raw)?;
    let put = db
        .files()?
        .put(&processed.bytes, "image/jpeg", now, CAP_BYTES)
        .map_err(|e| match e {
            FilesError::Full { .. } => ApiError::Rejected {
                reason: "files_full".into(),
                message: "Your group's scans are using all their space: contact us".into(),
            },
            FilesError::Store(e) => e.into(),
        })?;
    Ok(Page {
        id: None,
        sha256: put.sha256,
        width: processed.width.into(),
        height: processed.height.into(),
        size: put.size,
    })
}

/// Where an upload goes.
#[derive(Clone, Debug)]
pub enum Target {
    /// A new draft, under the phone's own id if it sent one.
    New { id: Option<String> },
    /// The next page of an existing draft, under the phone's page id if
    /// it sent one.
    Page {
        scan_id: String,
        page_id: Option<String>,
    },
}

/// What an upload answers.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "ScanUploaded")]
pub struct Uploaded {
    pub scan_id: String,
    pub pages: usize,
    /// `null` for a signed-in phone's direct upload (no pairing).
    #[ts(type = "number | null")]
    pub uploads_left: Option<i64>,
}

/// Commit an uploaded page: a new draft or a draft's next page, as
/// `actor`, from `pairing` (a phone) or none (a signed-in phone). A
/// page goes only onto a draft from the same pairing (or, direct, onto
/// any draft that came direct): anything else is `404`. Blocking.
pub fn upload(
    db: &OrgDb,
    actor: i64,
    pairing: Option<&str>,
    target: Target,
    page: Page,
) -> Result<String, ApiError> {
    let via = if pairing.is_some() {
        Via::Phone
    } else {
        Via::Direct
    };
    contracts::transact(db, Some(actor), |ctx| match target {
        Target::New { id } => {
            if let Some(id) = id.as_deref() {
                // A retried create (the answer was lost): the same scan,
                // if it is this sitting's.
                if let Some(held) = domain::get(ctx.tx.read(), id)? {
                    return if held.via == via && held.pairing_id.as_deref() == pairing {
                        Ok(held.id)
                    } else {
                        Err(ApiError::Duplicate { id: id.to_owned() })
                    };
                }
            }
            Ok(domain::create_scan(
                ctx,
                id.as_deref(),
                via,
                pairing.map(str::to_owned),
                page,
                Source::Ui,
            )?
            .id)
        }
        Target::Page { scan_id, page_id } => {
            let held = domain::get(ctx.tx.read(), &scan_id)?
                .filter(|s| s.via == via && s.pairing_id.as_deref() == pairing)
                .ok_or(ApiError::NotFound)?;
            let page = Page {
                id: page_id,
                ..page
            };
            Ok(domain::add_page(ctx, &held.id, page, Source::Ui)?.id)
        }
    })
}

/// The pages a scan now has (after an upload).
pub fn page_count(db: &OrgDb, scan_id: &str) -> Result<usize, ApiError> {
    let id = scan_id.to_owned();
    db.read(move |r| Ok::<_, ApiError>(domain::get(r, &id)?.map_or(0, |s| s.pages.len())))
}

/// Delete the blobs no live page names, put before `put_before`.
/// Blocking. Returns how many went.
pub fn sweep_blobs(db: &OrgDb, put_before: i64) -> Result<usize, ApiError> {
    let Some(files) = db.files_if_any()? else {
        return Ok(0);
    };
    let referenced: HashSet<String> = db.read(|r| domain::referenced_blobs(r))?;
    Ok(files.delete_unreferenced(&referenced, put_before)?.len())
}

/// How long a put blob is safe from the sweep: a write in flight puts its
/// blob, then commits its page row within seconds.
pub const PUT_GRACE_MS: i64 = 60 * 60 * 1000;
/// An orphan (a blob whose contract was refused) is swept after this.
pub const ORPHAN_AFTER_MS: i64 = 24 * 60 * 60 * 1000;

/// A discarded scan's images, 30 days on: `giftaid.scanRetention` as the
/// system for each one due, then the blobs no page names. Blocking.
pub fn purge_discarded(db: &OrgDb, now: i64) -> Result<usize, ApiError> {
    let due = db.read(|r| domain::discarded_due(r, now))?;
    let mut purged = 0;
    for id in &due {
        let out = contracts::transact(db, None, |ctx| {
            // At the run's own time, which decides what is due.
            let ctx = contracts::Ctx { at: now, ..*ctx };
            domain::delete_images(&ctx, id, None, DeletionReason::Discarded, Source::System)
        });
        match out {
            Ok(_) => purged += 1,
            Err(e) => eprintln!("scan purge: scan {id}: {e}"),
        }
    }
    if purged > 0 {
        sweep_blobs(db, now - PUT_GRACE_MS)?;
    }
    Ok(purged)
}

// ── jobs ──────────────────────────────────────────────────────────────────

const DAY: Duration = Duration::from_secs(24 * 60 * 60);

/// Daily: forget pairings that ended more than a day ago.
pub struct PairingSweep(pub Arc<Store>);

impl crate::jobs::Job for PairingSweep {
    fn name(&self) -> &'static str {
        "scan-pairing-sweep"
    }
    fn every(&self) -> Duration {
        DAY
    }
    fn run(&self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        let store = self.0.clone();
        Box::pin(async move {
            crate::blocking(move || sweep(&store, contracts::now_ms()))
                .await
                .map(|_| ())
                .map_err(|e| format!("{e:?}"))
        })
    }
}

/// Daily: in each org with a files db, the blobs no page names that were
/// put over a day ago (uploads whose contract was refused).
pub struct OrphanSweep(pub Arc<Store>);

impl crate::jobs::Job for OrphanSweep {
    fn name(&self) -> &'static str {
        "scan-orphan-sweep"
    }
    fn every(&self) -> Duration {
        DAY
    }
    fn run(&self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(crate::jobs::each_org(&self.0, |_, db| {
            sweep_blobs(db, contracts::now_ms() - ORPHAN_AFTER_MS)
                .map(|_| ())
                .map_err(|e| format!("{e:?}"))
        }))
    }
}

/// Daily: discarded scans' images, 30 days after the discard (g1q4).
pub struct DiscardPurge(pub Arc<Store>);

impl crate::jobs::Job for DiscardPurge {
    fn name(&self) -> &'static str {
        "scan-discard-purge"
    }
    fn every(&self) -> Duration {
        DAY
    }
    fn run(&self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(crate::jobs::each_org(&self.0, |_, db| {
            purge_discarded(db, contracts::now_ms())
                .map(|_| ())
                .map_err(|e| format!("{e:?}"))
        }))
    }
}
