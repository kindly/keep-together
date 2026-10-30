//! `/api/t/{slug}/gifts…`: recording, reading, correcting, voiding and
//! un-voiding gifts, and the record-gift page's donor. Gifts are never
//! optimistic: every write answers the gift as it now is, read in the
//! same transaction, and the SPA shows only that.

use axum::extract::Path;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use contacts::donors::{
    Donor, Home, add_first_email, create_contact, describe_donor, fill_acquisition,
    set_home_address,
};
use contacts::types::{Details, Kind};
use contracts::history::MomentPage;
use contracts::{ContractError, Ctx, Exec, Source, command_group, execute};
use giftaid::{
    DeclarationPayload, DeclarationSummary, HMRC_MODEL_WORDING_VERSION, make_declaration, uk_date,
};
use giving::types::{
    AllocationRow, GiftPage, GiftPayload, GiftSaved, GiftView, Method, RecentGift, SaveGift,
    SetGiftStatus,
};
use serde::{Deserialize, Serialize};
use sources::CodeDescription;
use ts_rs::TS;

use super::Params;
use crate::{ApiError, Body, IdParam, Tenant};

pub fn router() -> Router {
    Router::new()
        .route("/gifts/recent", get(recent))
        .route("/gifts/record", post(record))
        .route("/gifts/{id}", get(one))
        .route("/gifts/{id}/history", get(history))
        .route("/gifts/{id}/save", post(save))
        .route("/gifts/{id}/status", post(status))
        .route("/contacts/{id}/gifts", get(by_contact))
        .route("/contacts/{id}/donor", get(donor))
}

/// `GET gifts/recent`: the caller's last 10 gifts, newest entered first,
/// void ones included and marked.
async fn recent(Extension(t): Extension<Tenant>) -> Result<Json<Vec<RecentGift>>, ApiError> {
    let user = t.user;
    t.read(move |r| Ok(giving::my_recent(r, user)?))
        .await
        .map(Json)
}

/// `GET gifts/{id}`: the gift, its donor and each allocation's code.
async fn one(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<GiftView>, ApiError> {
    t.read(move |r| giving::get(r, &id)?.ok_or(ApiError::NotFound))
        .await
        .map(Json)
}

#[derive(Deserialize)]
struct HistoryQuery {
    before: Option<i64>,
    limit: Option<usize>,
}

/// `GET gifts/{id}/history?before&limit`: moments, newest first, 10 at
/// most per page.
async fn history(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Params(q): Params<HistoryQuery>,
) -> Result<Json<MomentPage>, ApiError> {
    t.read(move |r| {
        if giving::describe_gift(r, &id)?.is_none() {
            return Err(ApiError::NotFound);
        }
        Ok(giving::history(
            r,
            &id,
            q.before,
            q.limit.unwrap_or(giving::HISTORY_PAGE_LIMIT),
        )?)
    })
    .await
    .map(Json)
}

/// The gift as it now is, in the write's own transaction.
fn view(ctx: &Ctx, id: &str) -> Result<GiftView, ApiError> {
    giving::get(ctx.tx.read(), id)?.ok_or(ApiError::NotFound)
}

/// `POST gifts/{id}/save {expected, …gift}`: correct a gift. Stale only
/// if the gift's fields changed since `expected` (a void never conflicts).
async fn save(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<SaveGift>,
) -> Result<Json<GiftSaved>, ApiError> {
    t.write(move |ctx| {
        let done = execute(
            ctx,
            &giving::GIFT,
            req.payload,
            Exec::update(&id, Some(req.expected), Source::Ui),
        )?;
        Ok(GiftSaved {
            view: view(ctx, &done.id)?,
            id: done.id,
            counter: done.counter,
        })
    })
    .await
    .map(Json)
}

/// `POST gifts/{id}/status {expected, status}`: void or un-void.
/// Re-sending the current status changes nothing.
async fn status(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<SetGiftStatus>,
) -> Result<Json<GiftSaved>, ApiError> {
    t.write(move |ctx| {
        let done = giving::set_status(ctx, &id, req.expected, req.status, req.reason, Source::Ui)?;
        Ok(GiftSaved {
            view: view(ctx, &done.id)?,
            id: done.id,
            counter: done.counter,
        })
    })
    .await
    .map(Json)
}

#[derive(Deserialize)]
struct PageQuery {
    cursor: Option<String>,
    limit: Option<usize>,
}

/// `GET contacts/{id}/gifts?cursor&limit`: newest date first, 50 at most
/// per page.
async fn by_contact(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Params(q): Params<PageQuery>,
) -> Result<Json<GiftPage>, ApiError> {
    t.read(move |r| {
        if contacts::donors::kind_of(r, &id)?.is_none() {
            return Err(ApiError::NotFound);
        }
        Ok(giving::by_contact(
            r,
            &id,
            q.cursor.as_deref(),
            q.limit.unwrap_or(giving::BY_CONTACT_LIMIT),
        )?)
    })
    .await
    .map(Json)
}

// ── the record-gift page ───────────────────────────────────────────────────

#[derive(Deserialize)]
struct DonorQuery {
    date: String,
}

/// `GET contacts/{id}/donor?date`: what the record-gift page needs once a
/// donor is picked.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DonorView {
    pub id: String,
    pub kind: Kind,
    pub display_name: String,
    pub first_name: String,
    pub last_name: String,
    /// The home address a declaration would snapshot.
    pub home: Home,
    /// The acquisition code described: the gift's default code when not
    /// archived (g2q1).
    pub acquisition: Option<CodeDescription>,
    /// The declaration that would cover a gift dated `date` (the gift
    /// being entered; not yet saved, so never a "this gift only" one),
    /// for "✓ covered" instead of the tick (g2q6). Judged on the gift's
    /// date, not today.
    pub covering: Option<DeclarationSummary>,
}

async fn donor(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Params(q): Params<DonorQuery>,
) -> Result<Json<DonorView>, ApiError> {
    super::giftaid::iso_date("date", &q.date)?;
    t.read(move |r| {
        let Donor {
            id,
            kind,
            display_name,
            first_name,
            last_name,
            acquisition_code_id,
            home,
        } = describe_donor(r, &id)?.ok_or(ApiError::NotFound)?;
        let acquisition = match acquisition_code_id {
            Some(code) => sources::describe(r, &code)?,
            None => None,
        };
        let covering = giftaid::coverage(r, &id, &q.date, None)?;
        Ok(DonorView {
            id,
            kind,
            display_name,
            first_name,
            last_name,
            home,
            acquisition,
            covering,
        })
    })
    .await
    .map(Json)
}

/// The record-gift page's inline new contact (g1q3): the minimum fields.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NewDonor {
    pub kind: Kind,
    /// People.
    pub first_name: String,
    pub last_name: String,
    /// Organisations and households.
    pub name: String,
    #[serde(default)]
    #[ts(optional)]
    pub email: Option<String>,
}

/// An existing contact's id, or a new contact.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(untagged)]
#[ts(export)]
pub enum DonorRef {
    Existing(String),
    New(NewDonor),
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HomeAddress {
    pub line1: String,
    pub postcode: String,
}

/// The tick's declaration; each field defaults (see [`record_gift`]).
#[derive(Clone, Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GiftAidTick {
    #[serde(default)]
    #[ts(optional)]
    pub scope: Option<giftaid::Scope>,
    #[serde(default)]
    #[ts(optional)]
    pub method: Option<giftaid::Method>,
    #[serde(default)]
    #[ts(optional)]
    pub made_on: Option<String>,
}

/// `POST gifts/record`: the record-gift page's one save.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RecordGift {
    pub client_key: String,
    pub contact: DonorRef,
    #[serde(default)]
    #[ts(optional)]
    pub home: Option<HomeAddress>,
    pub received_on: String,
    #[ts(type = "number")]
    pub amount: i64,
    pub method: Method,
    #[serde(default)]
    #[ts(optional)]
    pub reference: Option<String>,
    pub allocations: Vec<AllocationRow>,
    #[serde(default)]
    #[ts(optional)]
    pub gift_aid: Option<GiftAidTick>,
    /// The open paying-in batch a cash gift or cheque goes into (ADR
    /// 0027, g2q5): optional.
    #[serde(default)]
    #[ts(optional)]
    pub paying_in_batch_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RecordedGift {
    pub contact_id: String,
    pub gift_id: String,
    pub declaration_id: Option<String>,
}

/// The record-gift page's one save (g1q4): one transaction and one
/// command group named like a gift ("gift £20 cash, Street-Wesser-001"):
///
///   1. `contact` is an existing contact's id, or a new contact, created
///      with the gift's code as its acquisition code (and its email);
///      `home` (line 1 and postcode) completes its UK home address in
///      place when that has no postcode, else is added as the primary
///      (g3q3, `set_home_address`);
///   2. the gift (`giving.gift`, then `giving.status` completed);
///   3. an existing contact with no acquisition code gets the gift's code
///      (g2q1); one it already has stays;
///   4. with `giftAid`, a declaration (individuals only) naming the gift
///      (so it covers it, whatever the scope), whose snapshot is the
///      contact's name and the `home` just typed, else its primary
///      address. Defaults: method `staffTickedNoEvidence`, scope
///      `futureAndPast4y` (g2q5), made today (UK date: a declaration is
///      dated when the donor makes it, never back-dated to the gift),
///      HMRC's current wording.
///
/// `clientKey` is minted once per form: a repeat (double click, retry) is
/// `409 duplicate` with the gift's id, before anything is written. A new
/// contact carries the same key. The gift's code is its first
/// allocation's (the page sends one). Any refusal fails the transaction,
/// so nothing of the save is left behind: no contact, no contact number,
/// no gift, no group.
pub fn record_gift(
    ctx: &Ctx,
    req: RecordGift,
    source: Source,
) -> Result<RecordedGift, ContractError> {
    if req.client_key.trim().is_empty() {
        return Err(ContractError::invalid(
            "clientKey",
            "A client key is required",
        ));
    }
    // Stored on the gift: as wide as a name at most.
    if contacts::rules::too_long(&req.client_key, giving::CLIENT_KEY_MAX) {
        return Err(ContractError::invalid(
            "clientKey",
            format!("At most {} characters", giving::CLIENT_KEY_MAX),
        ));
    }
    // Checked first so a repeat names the gift, not the new contact.
    if let Some(id) = giving::by_client_key(ctx.tx.read(), &req.client_key)? {
        return Err(ContractError::Duplicate { id });
    }
    let Some(code_id) = req.allocations.first().map(|a| a.source_code_id.clone()) else {
        return Err(ContractError::invalid("allocations", "Pick a source code"));
    };
    let mut gift = GiftPayload {
        contact_id: String::new(),
        received_on: req.received_on,
        amount: req.amount,
        method: req.method,
        reference: req.reference,
        allocations: req.allocations,
        client_key: Some(req.client_key.clone()),
        from_line: None,
        paying_in_batch_id: req.paying_in_batch_id.filter(|b| !b.is_empty()),
        origin: None,
    };
    let group = command_group(ctx, &giving::gift_group_name(ctx.tx.read(), &gift)?)?;

    let existing = matches!(req.contact, DonorRef::Existing(_));
    gift.contact_id = match req.contact {
        DonorRef::Existing(id) => {
            if contacts::donors::kind_of(ctx.tx.read(), &id)?.is_none() {
                return Err(ContractError::rejected(
                    "unknown_contact",
                    "Contact must exist",
                ));
            }
            id
        }
        DonorRef::New(new) => {
            let created = create_contact(
                ctx,
                Details {
                    client_key: Some(req.client_key.clone()),
                    kind: new.kind,
                    title: String::new(),
                    first_name: new.first_name,
                    last_name: new.last_name,
                    nickname: String::new(),
                    name: new.name,
                    birth_date: None,
                    is_deceased: false,
                    deceased_date: None,
                },
                Some(code_id.clone()),
                source,
                &group,
            )?;
            if let Some(email) = new
                .email
                .as_deref()
                .map(str::trim)
                .filter(|e| !e.is_empty())
            {
                add_first_email(ctx, &created.id, email, source, &group)?;
            }
            created.id
        }
    };
    let contact_id = gift.contact_id.clone();
    let typed = match req.home {
        Some(h) if !h.line1.trim().is_empty() || !h.postcode.trim().is_empty() => Some(
            set_home_address(ctx, &contact_id, &h.line1, &h.postcode, source, &group)?,
        ),
        _ => None,
    };

    let gift_id = giving::create_gift(ctx, gift, source, Some(&group))?;
    if existing {
        fill_acquisition(ctx, &contact_id, &code_id, source, &group)?;
    }

    let declaration_id = match req.gift_aid {
        None => None,
        Some(tick) => {
            let donor =
                describe_donor(ctx.tx.read(), &contact_id)?.ok_or(ContractError::NotFound)?;
            let (line1, postcode) = match typed {
                Some(t) => (t.line1, t.postcode),
                None => (donor.home.line1, donor.home.postcode),
            };
            let made = make_declaration(
                ctx,
                DeclarationPayload {
                    contact_id: contact_id.clone(),
                    scope: tick.scope.unwrap_or(giftaid::Scope::FutureAndPast4y),
                    gift_id: Some(gift_id.clone()),
                    made_on: tick.made_on.unwrap_or_else(|| uk_date(ctx.at)),
                    method: tick
                        .method
                        .unwrap_or(giftaid::Method::StaffTickedNoEvidence),
                    wording_version: HMRC_MODEL_WORDING_VERSION.into(),
                    first_name: donor.first_name,
                    last_name: donor.last_name,
                    address_line1: line1,
                    postcode,
                },
                source,
                Some(&group),
            )?;
            Some(made.id)
        }
    };
    Ok(RecordedGift {
        contact_id,
        gift_id,
        declaration_id,
    })
}

async fn record(
    Extension(t): Extension<Tenant>,
    Body(req): Body<RecordGift>,
) -> Result<Json<RecordedGift>, ApiError> {
    t.write(move |ctx| Ok(record_gift(ctx, req, Source::Ui)?))
        .await
        .map(Json)
}
