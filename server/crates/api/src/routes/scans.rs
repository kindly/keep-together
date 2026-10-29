//! `/api/t/{slug}/…scans…`: scanned paper Gift Aid declarations on the
//! laptop side (plan `declaration-scans.sv`; the phone's routes are
//! `crate::scans::phone`). Staff and admins see scans and their images;
//! viewers see only that a declaration holds one, and when
//! (`giftaid/{id}/scans`, g2q1). The "can be deleted" report and its
//! deletion are admin only, within the step-up hour.

use axum::body::Bytes;
use axum::extract::Path;
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use contracts::Source;
use giftaid::scans::{self as domain, DeletableScan, DeletionReason, Match, ScanView};
use serde::{Deserialize, Serialize};
use store::Role;
use ts_rs::TS;

use super::Params;
use crate::scans::phone::Keys;
use crate::scans::{Pairing, Purpose, Target, Uploaded};
use crate::{ApiError, Body, IdParam, Tenant};

pub fn router() -> Router {
    Router::new()
        .route("/scan-pairings", post(start_pairing))
        .route("/scan-pairings/{id}", get(pairing).delete(end_pairing))
        .route("/scans", get(inbox).post(upload))
        .route("/scans/{id}", get(one))
        .route("/scans/{id}/pages", post(upload_page))
        .route("/scans/{id}/pages/{page}", get(page_image))
        .route("/scans/{id}/reorder", post(reorder))
        .route("/scans/{id}/merge", post(merge))
        .route("/scans/{id}/accept", post(accept))
        .route("/scans/{id}/discard", post(discard))
        .route("/scans/{id}/delete-images", post(delete_images))
        .route("/giftaid/scans/deletable", get(deletable))
        .route("/giftaid/{id}/scans", get(by_declaration))
        .route("/files-usage", get(files_usage))
}

/// Scans and their images: staff and admins (g2q1).
fn require_staff(t: &Tenant) -> Result<(), ApiError> {
    if t.role < Role::Staff {
        return Err(ApiError::Forbidden);
    }
    Ok(())
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StartScanPairing {
    pub purpose: Purpose,
}

/// `POST scan-pairings` answers this once: the token is not kept.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScanPairingStarted {
    pub pairing: ScanPairingView,
    /// For the QR code: the phone's page, the token in its fragment (so
    /// it is never sent in a page request or a `Referer`).
    pub path: String,
}

/// A pairing as the laptop shows it, with its sitting's scans.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScanPairingView {
    pub id: String,
    pub purpose: Purpose,
    #[ts(type = "number")]
    pub started_by: i64,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub expires_at: i64,
    /// When it ends if the phone sends nothing before then.
    #[ts(type = "number")]
    pub idle_expires_at: i64,
    /// A phone has opened the link (and holds it).
    pub claimed: bool,
    #[ts(type = "number | null")]
    pub ended_at: Option<i64>,
    #[ts(type = "number")]
    pub uploads: i64,
    pub scans: Vec<ScanView>,
}

fn view(p: Pairing, scans: Vec<ScanView>) -> ScanPairingView {
    let now = contracts::now_ms();
    let timed_out = now >= p.idle_expires_at();
    ScanPairingView {
        id: p.id.clone(),
        purpose: p.purpose,
        started_by: p.user_id,
        created_at: p.created_at,
        expires_at: p.expires_at,
        idle_expires_at: p.idle_expires_at(),
        claimed: p.device_hash.is_some(),
        ended_at: p.ended_at.or(timed_out.then(|| p.idle_expires_at())),
        uploads: p.uploads,
        scans,
    }
}

/// `POST scan-pairings {purpose}`: a new phone pairing (staff or admin,
/// a sign-in or step-up within the hour, else `403 step_up_required`).
async fn start_pairing(
    Extension(t): Extension<Tenant>,
    Body(req): Body<StartScanPairing>,
) -> Result<Json<ScanPairingStarted>, ApiError> {
    let (pairing, token) = t.start_scan_pairing(req.purpose).await?;
    Ok(Json(ScanPairingStarted {
        pairing: view(pairing, vec![]),
        path: format!("/scan.html#{token}"),
    }))
}

async fn with_scans(t: &Tenant, p: Pairing) -> Result<ScanPairingView, ApiError> {
    let id = p.id.clone();
    let scans = t.read(move |r| Ok(domain::by_pairing(r, &id)?)).await?;
    Ok(view(p, scans))
}

/// `GET scan-pairings/{id}`: the pairing and its sitting's scans (the
/// laptop refetches on `declaration_scans` events).
async fn pairing(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<ScanPairingView>, ApiError> {
    require_staff(&t)?;
    let p = t.scan_pairing(id).await?;
    Ok(Json(with_scans(&t, p).await?))
}

/// `DELETE scan-pairings/{id}`: end it now; the phone gets `410`.
async fn end_pairing(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<ScanPairingView>, ApiError> {
    let p = t.end_scan_pairing(id).await?;
    Ok(Json(with_scans(&t, p).await?))
}

/// `GET scans`: "Scans to match" (every draft, oldest first).
async fn inbox(Extension(t): Extension<Tenant>) -> Result<Json<Vec<ScanView>>, ApiError> {
    require_staff(&t)?;
    t.read(|r| Ok(domain::inbox(r)?)).await.map(Json)
}

/// `POST scans?id=` (body: one page's image): a signed-in phone's new
/// draft, `via: direct`.
async fn upload(
    Extension(t): Extension<Tenant>,
    Params(keys): Params<Keys>,
    body: Bytes,
) -> Result<Json<Uploaded>, ApiError> {
    let keys = keys.checked()?;
    t.upload_scan_page(Target::New { id: keys.id }, body)
        .await
        .map(Json)
}

/// `POST scans/{id}/pages?pageId=` (body: one page's image): the next
/// page of a direct draft.
async fn upload_page(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Params(keys): Params<Keys>,
    body: Bytes,
) -> Result<Json<Uploaded>, ApiError> {
    let keys = keys.checked()?;
    if body.is_empty() {
        return Err(ApiError::Invalid {
            problems: vec![contracts::Problem::new("image", "No image was sent")],
        });
    }
    let target = Target::Page {
        scan_id: id,
        page_id: keys.page_id,
    };
    t.upload_scan_page(target, body).await.map(Json)
}

/// `GET scans/{id}`
async fn one(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<ScanView>, ApiError> {
    require_staff(&t)?;
    t.read(move |r| domain::get(r, &id)?.ok_or(ApiError::NotFound))
        .await
        .map(Json)
}

#[derive(Deserialize)]
struct PageParam {
    id: String,
    page: i64,
}

/// `GET scans/{id}/pages/{n}`: the page's image (`image/jpeg`,
/// `Cache-Control: private`). Its images gone, or no such page: `404`.
async fn page_image(
    Extension(t): Extension<Tenant>,
    Path(PageParam { id, page }): Path<PageParam>,
) -> Result<Response, ApiError> {
    let blob = t
        .scan_page_image(id, page)
        .await?
        .ok_or(ApiError::NotFound)?;
    let mut res = blob.bytes.into_response();
    let headers = res.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&blob.content_type).map_err(ApiError::internal)?,
    );
    // Immutable (content-addressed), but a donor's signature: never in a
    // shared cache.
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=3600"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(res)
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReorderScanPages {
    /// `scanVersion` as last read.
    #[ts(type = "number")]
    pub expected: i64,
    /// The pages to keep, in their new order (page ids).
    pub order: Vec<String>,
}

/// `POST scans/{id}/reorder {expected, order}`: reorder or remove a
/// draft's pages → the scan.
async fn reorder(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<ReorderScanPages>,
) -> Result<Json<ScanView>, ApiError> {
    t.write(move |ctx| {
        domain::set_pages(ctx, &id, req.expected, &req.order, Source::Ui)?;
        domain::get(ctx.tx.read(), &id)?.ok_or(ApiError::NotFound)
    })
    .await
    .map(Json)
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MergeScans {
    /// This scan's `scanVersion`.
    #[ts(type = "number")]
    pub expected: i64,
    /// The draft whose pages move here (then discarded, "merged").
    pub from: String,
    /// `from`'s `reviewVersion`.
    #[ts(type = "number")]
    pub from_expected: i64,
}

/// `POST scans/{id}/merge {expected, from, fromExpected}` → this scan.
async fn merge(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<MergeScans>,
) -> Result<Json<ScanView>, ApiError> {
    t.write(move |ctx| {
        domain::merge_scans(
            ctx,
            &id,
            req.expected,
            &req.from,
            req.from_expected,
            Source::Ui,
        )?;
        domain::get(ctx.tx.read(), &id)?.ok_or(ApiError::NotFound)
    })
    .await
    .map(Json)
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AcceptScan {
    /// `reviewVersion` as last read.
    #[ts(type = "number")]
    pub expected: i64,
    /// The contact on screen.
    pub contact_id: String,
    #[serde(rename = "match")]
    #[ts(rename = "match")]
    pub with: Match,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScanAccepted {
    pub declaration_id: String,
    pub scan: ScanView,
}

/// `POST scans/{id}/accept {expected, contactId, match}`: the scan as a
/// declaration's evidence, an existing one or a new one from the form
/// beside it, in one command group (g1q5).
async fn accept(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<AcceptScan>,
) -> Result<Json<ScanAccepted>, ApiError> {
    t.write(move |ctx| {
        let declaration_id = domain::accept_scan(
            ctx,
            &id,
            req.expected,
            &req.contact_id,
            req.with,
            Source::Ui,
        )?;
        let scan = domain::get(ctx.tx.read(), &id)?.ok_or(ApiError::NotFound)?;
        Ok(ScanAccepted {
            declaration_id,
            scan,
        })
    })
    .await
    .map(Json)
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiscardScan {
    /// `reviewVersion` as last read.
    #[ts(type = "number")]
    pub expected: i64,
    #[serde(default)]
    #[ts(optional)]
    pub reason: Option<String>,
}

/// `POST scans/{id}/discard {expected, reason?}`: its row stays, its
/// images go after 30 days.
async fn discard(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<DiscardScan>,
) -> Result<Json<ScanView>, ApiError> {
    t.write(move |ctx| {
        domain::discard_scan(ctx, &id, req.expected, req.reason, Source::Ui)?;
        domain::get(ctx.tx.read(), &id)?.ok_or(ApiError::NotFound)
    })
    .await
    .map(Json)
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeleteScanImages {
    /// `retentionVersion` as last read.
    #[ts(type = "number")]
    pub expected: i64,
}

/// `POST scans/{id}/delete-images {expected}` (admin, step-up hour): from
/// the "can be deleted" report. The row stays; the deletion commits,
/// then the blobs go.
async fn delete_images(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<DeleteScanImages>,
) -> Result<Json<ScanView>, ApiError> {
    t.require_admin()?;
    let scan = t
        .write(move |ctx| {
            domain::delete_images(
                ctx,
                &id,
                Some(req.expected),
                DeletionReason::Retention,
                Source::Ui,
            )?;
            domain::get(ctx.tx.read(), &id)?.ok_or(ApiError::NotFound)
        })
        .await?;
    t.sweep_scan_blobs().await?;
    Ok(Json(scan))
}

#[derive(Deserialize)]
struct TodayQuery {
    today: String,
}

/// `GET giftaid/scans/deletable?today` (admin, step-up hour): accepted
/// scans whose declaration has covered no gift for 7 years.
async fn deletable(
    Extension(t): Extension<Tenant>,
    Params(q): Params<TodayQuery>,
) -> Result<Json<Vec<DeletableScan>>, ApiError> {
    t.require_admin()?;
    super::giftaid::iso_date("today", &q.today)?;
    t.read(move |r| Ok(domain::deletable(r, &q.today)?))
        .await
        .map(Json)
}

/// What a declaration's evidence is, for anyone who can see the
/// declaration: a viewer learns "✓ scan held" and when, nothing more.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeclarationScans {
    pub held: Vec<ScanHeld>,
    /// Staff and admins: the scans themselves.
    pub scans: Option<Vec<ScanView>>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScanHeld {
    pub id: String,
    #[ts(type = "number")]
    pub scanned_at: i64,
    #[ts(type = "number | null")]
    pub reviewed_at: Option<i64>,
    pub images_held: bool,
}

/// `GET giftaid/{id}/scans`: a declaration's scans (any member; scans
/// themselves for staff and admins only). Unknown declaration: `404`.
async fn by_declaration(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<DeclarationScans>, ApiError> {
    let staff = t.role >= Role::Staff;
    t.read(move |r| {
        if giftaid::declarations::load(r, &id)?.is_none() {
            return Err(ApiError::NotFound);
        }
        let scans = domain::by_declaration(r, &id)?;
        Ok(DeclarationScans {
            held: scans
                .iter()
                .map(|s| ScanHeld {
                    id: s.id.clone(),
                    scanned_at: s.scanned_at,
                    reviewed_at: s.reviewed_at,
                    images_held: s.image_deleted_at.is_none(),
                })
                .collect(),
            scans: staff.then_some(scans),
        })
    })
    .await
    .map(Json)
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FilesUsage {
    #[ts(type = "number")]
    pub bytes: i64,
    #[ts(type = "number")]
    pub cap_bytes: i64,
}

/// `GET files-usage`: how much of the organisation's 2 GB its scans use
/// (Settings).
async fn files_usage(Extension(t): Extension<Tenant>) -> Result<Json<FilesUsage>, ApiError> {
    Ok(Json(FilesUsage {
        bytes: t.files_usage().await?,
        cap_bytes: store::files::CAP_BYTES,
    }))
}
