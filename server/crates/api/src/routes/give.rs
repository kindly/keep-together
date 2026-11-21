//! The donor's page (`factory/plans/stripe.sv`, step S4): the two public
//! routes behind `/give/{slug}`. Nobody is signed in: the slug is the
//! only thing a request names, and it reaches one organisation's file,
//! for its page's settings and for one new submission.
//!
//! | route | |
//! |---|---|
//! | `GET /api/give/{slug}` | [`GivePage`]: the group's name, its amounts, whether it offers Gift Aid (and under which wording) |
//! | `POST /api/give/{slug}/donations` | [`GiveDonation`] → [`GiveStarted`]: stores what the donor typed (`giving.donationSubmission`), makes a Stripe Checkout Session on the group's account and answers its address |
//!
//! Registered in `lib.rs` (as the QC seed's are): the tenant route table
//! (`tests/roles.rs`) reads this directory, and these aren't tenant routes.
//!
//! **A page exists** when Stripe is on here, the slug is a group's, the
//! group is connected to a Stripe account that takes card payments, and
//! its page has a live source code. Anything less answers `404
//! not_found`, the same for every reason, so a slug can't be probed for a
//! group that hasn't published a page.
//!
//! **Never optimistic.** `POST` writes a submission and nothing else: no
//! contact, no gift, no declaration. Those are made when Stripe reports
//! the payment (`stripe::process`, S3). The page Stripe sends the donor
//! back to writes nothing and asks nothing.
//!
//! **The donor is never looked up.** Nothing here reads a contact, so the
//! answer is the same whether or not the group knows the donor: matching
//! happens when the payment arrives.
//!
//! **The declaration is the server's.** A donor who ticks Gift Aid sends
//! their house name or number, their postcode and the wording version
//! their page showed. The scope is always HMRC's enduring one
//! (`futureAndPast4y`, the plan's round 1) and the wording always
//! [`giftaid::HMRC_MODEL_WORDING_VERSION`]: the form can't choose either
//! (an unknown field such as `scope` is `422 invalid`), and a page that
//! showed any other wording is refused (`422 rejected wording_changed`),
//! because the submission is the evidence of what the donor agreed to.
//!
//! **One donation per `id`, and it is what was on screen.** `id` (32 hex)
//! is the page's key for the attempt. A repeat while the first is still
//! being answered waits for it. A repeat is the same attempt only if it
//! says exactly what the first said and that attempt has no Checkout
//! Session yet (Stripe failed last time): then it carries on. Anything
//! else is `409 duplicate` and the page starts another under a new id:
//! an attempt that has its session, one that is over, and one whose body
//! differs from what is stored. A stored submission is never replayed for
//! a body that says something else, so the declaration, name, address and
//! email recorded are the ones the donor pressed Give on. An attempt whose
//! email Stripe refused is spent (marked `expired`): the corrected one is
//! a new submission.
//!
//! **Rate limits** ([`Limits`], in memory like auth's): pages per
//! address, donations per address, and donations per group. Over any:
//! `429 rate_limited`. A group's limit is spent only for a page that
//! exists (connected *and* published), so it says nothing more about a
//! slug than the page does.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ::auth::limits::{Limiter, allow, limiter};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderValue;
use axum::http::header::CACHE_CONTROL;
use axum::response::{IntoResponse, Response};
use contracts::Problem;
use giving::stripe::{
    DeclarationScope, DonationSubmissionPayload, DonorForm, SubmissionGiftAid, SubmissionStatus,
};
use serde::{Deserialize, Serialize};
use store::{OrgDb, Store};
use ts_rs::TS;

use crate::auth::ClientIp;
use crate::stripe::{accounts, checkout};
use crate::{ApiError, AppState, Body, blocking};

pub const PREFIX: &str = "/api/give/";
/// Bodies of `/api/give/*`: a name, an email, an address line.
pub const BODY_LIMIT: usize = 16 * 1024;
/// The scope of every declaration made on the page: HMRC's enduring
/// wording (plan, round 1).
pub const DECLARATION_SCOPE: DeclarationScope = DeclarationScope::FutureAndPast4y;
/// The longest slug looked up.
const SLUG_MAX: usize = 100;

/// The page's rate limits. Numbers are a first guess at "a busy
/// fundraising evening on one venue's wifi passes, a script doesn't".
pub struct Limits {
    /// `GET` per client address: 60 at once, then one a second.
    pub page_ip: Limiter,
    /// Donations per client address: 20 at once, then one every 15 s.
    pub donate_ip: Limiter,
    /// Donations per group, from anywhere: 60 at once, then one every
    /// 5 s (720 an hour).
    pub donate_group: Limiter,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            page_ip: limiter(60, Duration::from_secs(1)),
            donate_ip: limiter(20, Duration::from_secs(15)),
            donate_group: limiter(60, Duration::from_secs(5)),
        }
    }
}

/// The page's process state (`AppState::give`): its limits, and the
/// donations being answered now.
#[derive(Default)]
pub struct Give {
    pub limits: Limits,
    /// Organisation and submission id → the lock its requests take in
    /// turn. One machine per environment, so in-process is the whole
    /// story.
    in_flight: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Give {
    pub fn with_limits(limits: Limits) -> Self {
        Self {
            limits,
            in_flight: Mutex::default(),
        }
    }

    /// `key`'s lock, to be taken in turn. Dropping the [`Turn`] forgets
    /// the lock unless another request holds it too, whether the request
    /// finished or was dropped part way (the client went away).
    fn turn(self: &Arc<Self>, key: String) -> Turn {
        let lock = self
            .in_flight
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(key.clone())
            .or_default()
            .clone();
        Turn {
            give: self.clone(),
            key,
            lock,
        }
    }
}

/// One request's hold on its attempt's lock ([`Give::turn`]).
struct Turn {
    give: Arc<Give>,
    key: String,
    lock: Arc<tokio::sync::Mutex<()>>,
}

impl Drop for Turn {
    fn drop(&mut self) {
        let mut map = self
            .give
            .in_flight
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // The map's and ours: nobody else is waiting.
        if Arc::strong_count(&self.lock) <= 2 {
            map.remove(&self.key);
        }
    }
}

/// Hourly: forget rate-limit keys that have fully replenished.
pub struct LimitSweep(pub Arc<Give>);

impl crate::jobs::Job for LimitSweep {
    fn name(&self) -> &'static str {
        "give-limit-sweep"
    }
    fn every(&self) -> Duration {
        Duration::from_secs(60 * 60)
    }
    fn run(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async move {
            let l = &self.0.limits;
            l.page_ip.retain_recent();
            l.donate_ip.retain_recent();
            l.donate_group.retain_recent();
            Ok(())
        })
    }
}

/// `GET /api/give/{slug}`: what the donor's page shows. Amounts are pence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GivePage {
    /// The group's name.
    pub name: String,
    /// The three buttons, as the group ordered them.
    #[ts(type = "[number, number, number]")]
    pub amounts: [i64; 3],
    /// The least and the most "other amount" takes.
    #[ts(type = "number")]
    pub minimum: i64,
    #[ts(type = "number")]
    pub maximum: i64,
    /// Present when the group claims Gift Aid: offer the declaration.
    pub gift_aid: Option<GiveGiftAid>,
}

/// The declaration the page offers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GiveGiftAid {
    /// The wording to show, by version. A page that doesn't have this
    /// version's text offers no Gift Aid.
    pub wording_version: String,
}

/// `POST /api/give/{slug}/donations`: what the donor typed.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct GiveDonation {
    /// The page's key for this attempt: 32 lower-case hex.
    pub id: String,
    /// Pence.
    #[ts(type = "number")]
    pub amount: i64,
    pub first_name: String,
    pub last_name: String,
    pub email: String,
    /// Present = the donor ticked Gift Aid.
    #[serde(default)]
    #[ts(optional)]
    pub gift_aid: Option<GiveDeclaration>,
}

/// The Gift Aid declaration a donor ticked: their home address and which
/// wording they were shown. Not its scope: that is the server's.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct GiveDeclaration {
    /// The wording the page showed: it must be the one the server pins.
    pub wording_version: String,
    /// House name or number.
    pub address_line1: String,
    pub postcode: String,
}

/// Where to send the donor's browser: Stripe's payment page.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GiveStarted {
    pub url: String,
}

#[derive(Deserialize)]
pub struct SlugParam {
    slug: String,
}

/// A group whose page exists as far as `platform.db` says.
struct Group {
    tenant: store::Tenant,
    /// Its Stripe account, connected and taking card payments.
    account: String,
    db: Arc<OrgDb>,
}

/// The group behind `slug`, if it is connected to a Stripe account that
/// takes card payments. Blocking.
fn group(store: &Store, slug: &str) -> Result<Group, ApiError> {
    if slug.is_empty() || slug.len() > SLUG_MAX {
        return Err(ApiError::NotFound);
    }
    let tenant = store
        .platform()
        .tenant_by_slug(slug)?
        .ok_or(ApiError::NotFound)?;
    let account = accounts::account(store, &tenant.id)?
        .filter(|row| row.charges_enabled)
        .and_then(|row| row.live_account().map(str::to_owned))
        .ok_or(ApiError::NotFound)?;
    let db = store.org(&tenant.id)?;
    Ok(Group {
        tenant,
        account,
        db,
    })
}

/// [`group`], and its page published (a live source code): the page
/// exists. Blocking.
fn published(store: &Store, slug: &str) -> Result<Group, ApiError> {
    let group = group(store, slug)?;
    let taking = group
        .db
        .read(|r| Ok::<_, rusqlite::Error>(giving::stripe::page(r)?.taking_donations))?;
    if !taking {
        return Err(ApiError::NotFound);
    }
    Ok(group)
}

fn no_store(mut res: Response) -> Response {
    res.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// `GET /api/give/{slug}`.
pub(crate) async fn page(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Path(SlugParam { slug }): Path<SlugParam>,
) -> Result<Response, ApiError> {
    if !allow(&state.give.limits.page_ip, &ip) {
        return Err(ApiError::RateLimited);
    }
    if state.stripe.is_none() {
        return Err(ApiError::NotFound);
    }
    let store = state.store.clone();
    let page = blocking(move || {
        let group = group(&store, &slug)?;
        let (settings, claims) = group.db.read(|r| {
            Ok::<_, rusqlite::Error>((
                giving::stripe::page(r)?,
                platform::preferences::claims_gift_aid(r)?,
            ))
        })?;
        if !settings.taking_donations {
            return Err(ApiError::NotFound);
        }
        Ok(GivePage {
            name: group.tenant.name,
            amounts: settings.page.amounts,
            minimum: settings.page.minimum,
            maximum: settings.page.maximum,
            gift_aid: claims.then(|| GiveGiftAid {
                wording_version: giftaid::HMRC_MODEL_WORDING_VERSION.into(),
            }),
        })
    })
    .await?;
    Ok(no_store(Json(page).into_response()))
}

/// Whether `email` could be an address: something, `@`, a dotted domain,
/// no spaces. Stripe is sent it (its receipt goes there) and refuses
/// anything less, so here, unlike on a contact, it is unstorable.
pub fn plausible_email(email: &str) -> bool {
    !email.contains(|c: char| c.is_whitespace() || c.is_control())
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && !domain.contains('@')
                && domain
                    .split_once('.')
                    .is_some_and(|(a, b)| !a.is_empty() && !b.is_empty())
        })
}

fn invalid(field: &str, message: &str) -> ApiError {
    ApiError::Invalid {
        problems: vec![Problem::new(field, message)],
    }
}

/// What the route itself refuses before anything is stored, and the form
/// the contract takes: the declaration's scope and wording are set here.
fn checked(d: GiveDonation) -> Result<(String, DonorForm), ApiError> {
    if !contracts::is_client_id(&d.id) {
        return Err(invalid("id", "32 lower-case hex characters"));
    }
    if !plausible_email(d.email.trim()) {
        return Err(invalid("email", "Enter your email address"));
    }
    let gift_aid = match d.gift_aid {
        None => None,
        Some(g) => {
            if g.wording_version.trim() != giftaid::HMRC_MODEL_WORDING_VERSION {
                return Err(ApiError::Rejected {
                    reason: "wording_changed".into(),
                    message: "This page is out of date.".into(),
                });
            }
            Some(SubmissionGiftAid {
                scope: DECLARATION_SCOPE,
                wording_version: giftaid::HMRC_MODEL_WORDING_VERSION.into(),
                address_line1: g.address_line1,
                postcode: g.postcode,
            })
        }
    };
    Ok((
        d.id,
        DonorForm {
            amount: d.amount,
            first_name: d.first_name,
            last_name: d.last_name,
            email: d.email,
            gift_aid,
        },
    ))
}

/// `POST /api/give/{slug}/donations`.
pub(crate) async fn donate(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Path(SlugParam { slug }): Path<SlugParam>,
    Body(donation): Body<GiveDonation>,
) -> Result<Response, ApiError> {
    if !allow(&state.give.limits.donate_ip, &ip) {
        return Err(ApiError::RateLimited);
    }
    let stripe = state.stripe.clone().ok_or(ApiError::NotFound)?;
    let (id, form) = checked(donation)?;
    let store = state.store.clone();
    // The whole of "a page exists" before the group's limit is spent:
    // a connected group that hasn't published reads as an unknown slug.
    let group = Arc::new(blocking(move || published(&store, &slug)).await?);
    if !allow(&state.give.limits.donate_group, group.tenant.id.as_str()) {
        return Err(ApiError::RateLimited);
    }

    let turn = state
        .give
        .turn(format!("{}/{id}", group.tenant.id.as_str()));
    let _mine = turn.lock.lock().await;
    let out = start(&stripe, &group, &id, form).await?;
    Ok(no_store(Json(out).into_response()))
}

/// One attempt, alone: the submission stored, its Checkout Session made
/// and recorded on it.
async fn start(
    stripe: &crate::stripe::Stripe,
    group: &Arc<Group>,
    id: &str,
    form: DonorForm,
) -> Result<GiveStarted, ApiError> {
    let (g, sid) = (group.clone(), id.to_owned());
    let held = blocking(move || {
        contracts::transact(&g.db, None, |ctx| {
            let conn = ctx.tx.read();
            // The page exists only while its source code is live: the
            // same 404 as every other reason (`submit` would say why).
            if !giving::stripe::page(conn)?.taking_donations {
                return Err(ApiError::NotFound);
            }
            // A repeat of an attempt on record is that attempt only if
            // it says what the record says: what the donor typed is
            // never replaced by, or answered for, something else.
            if let Some(held) = giving::stripe::submission(conn, &sid)? {
                let again = giving::stripe::prepare_submission(DonationSubmissionPayload {
                    amount: form.amount,
                    first_name: form.first_name,
                    last_name: form.last_name,
                    email: form.email,
                    gift_aid: form.gift_aid,
                    source_code_id: held.typed.source_code_id.clone(),
                });
                return match again {
                    Ok(again) if again == held.typed => Ok(held),
                    _ => Err(ApiError::Duplicate { id: held.id }),
                };
            }
            let claims = platform::preferences::claims_gift_aid(conn)?;
            Ok(giving::stripe::submit(ctx, &sid, form, claims)?)
        })
    })
    .await?;
    // An attempt that already has its session (or is over) is finished
    // with: the page starts another under a new id.
    if held.outcome.checkout_session_id.is_some()
        || held.outcome.state != SubmissionStatus::Started
        || held.outcome.personal_cleared_at.is_some()
    {
        return Err(ApiError::Duplicate { id: held.id });
    }

    let slug = &group.tenant.slug;
    let description = format!("Donation to {}", group.tenant.name);
    let made = checkout::create(
        &stripe.api,
        &checkout::NewSession {
            account: &group.account,
            submission_id: id,
            amount: held.typed.amount,
            email: &held.typed.email,
            description: &description,
            success_url: &stripe.give_url(slug, "/thanks"),
            cancel_url: &stripe.give_url(slug, ""),
            expires_at: contracts::now_ms() / 1000 + checkout::SESSION_SECS,
        },
    )
    .await;
    let session = match made {
        Ok(session) => session,
        Err(e) if checkout::email_refused(&e) => {
            // Stripe will never take this attempt as typed: it is spent,
            // and the corrected address is a new one.
            let (g, sid) = (group.clone(), id.to_owned());
            blocking(move || {
                contracts::transact(&g.db, None, |ctx| giving::stripe::mark_expired(ctx, &sid))
            })
            .await?;
            return Err(invalid("email", "Enter your email address"));
        }
        Err(e) => {
            // The status and Stripe's error code only.
            crate::observe::warning(&format!("give ({slug}): making the checkout session: {e}"));
            return Err(ApiError::StripeUnavailable);
        }
    };
    let url = session.url.clone().ok_or_else(|| {
        ApiError::internal(format!("give ({slug}): a checkout session with no url"))
    })?;
    let (g, sid) = (group.clone(), id.to_owned());
    blocking(move || {
        contracts::transact(&g.db, None, |ctx| {
            giving::stripe::set_checkout_session(ctx, &sid, &session.id)
        })
    })
    .await?;
    Ok(GiveStarted { url })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_email_stripe_would_take() {
        for ok in ["a@b.org", "jane.smith+give@example.co.uk", "ü@exämple.org"] {
            assert!(plausible_email(ok), "{ok}");
        }
        for bad in [
            "",
            "jane",
            "jane@",
            "@example.org",
            "jane@example",
            "jane@.org",
            "jane@example.",
            "jane smith@example.org",
            "a@b@c.org",
            "jane@exam ple.org",
        ] {
            assert!(!plausible_email(bad), "{bad}");
        }
    }

    fn donation(gift_aid: Option<GiveDeclaration>) -> GiveDonation {
        GiveDonation {
            id: "0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0".into(),
            amount: 2500,
            first_name: "Jane".into(),
            last_name: "Smith".into(),
            email: "jane@example.org".into(),
            gift_aid,
        }
    }

    #[test]
    fn the_declarations_scope_and_wording_are_the_servers() {
        let (_, form) = checked(donation(Some(GiveDeclaration {
            wording_version: giftaid::HMRC_MODEL_WORDING_VERSION.into(),
            address_line1: "12".into(),
            postcode: "ab1 2cd".into(),
        })))
        .unwrap();
        let aid = form.gift_aid.unwrap();
        assert_eq!(aid.scope, DeclarationScope::FutureAndPast4y);
        assert_eq!(aid.wording_version, giftaid::HMRC_MODEL_WORDING_VERSION);
        // A page that showed some other wording made no declaration we
        // can stand behind.
        let other = checked(donation(Some(GiveDeclaration {
            wording_version: "hmrc-2012".into(),
            address_line1: "12".into(),
            postcode: "AB1 2CD".into(),
        })));
        assert!(
            matches!(other, Err(ApiError::Rejected { ref reason, .. }) if reason == "wording_changed")
        );
        // The form has no field for either.
        for extra in [
            r#""scope":"thisGift""#,
            r#""wordingVersion":"x","scope":"thisGift""#,
        ] {
            let body = format!(
                r#"{{"id":"0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0","amount":2500,"firstName":"J",
                    "lastName":"S","email":"j@s.org","giftAid":{{"addressLine1":"1",
                    "postcode":"AB1 2CD","wordingVersion":"hmrc-2016-04",{extra}}}}}"#
            );
            assert!(
                serde_json::from_str::<GiveDonation>(&body).is_err(),
                "{extra}"
            );
        }
        assert!(checked(donation(None)).unwrap().1.gift_aid.is_none());
    }

    #[test]
    fn a_lock_is_forgotten_when_nobody_holds_it_however_the_request_ended() {
        let give = Arc::new(Give::default());
        let first = give.turn("a/1".into());
        let second = give.turn("a/1".into());
        drop(first);
        assert_eq!(give.in_flight.lock().unwrap().len(), 1, "one still waits");
        // Dropped without ever taking its turn: a request that went away.
        drop(second);
        assert!(give.in_flight.lock().unwrap().is_empty());
    }
}
