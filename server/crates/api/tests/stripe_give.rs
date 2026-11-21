//! The donor's page (plan stripe.sv, S4): `GET /api/give/{slug}` and
//! `POST /api/give/{slug}/donations`, on the fake Stripe, under two
//! organisations. Nobody is signed in on these routes; the staff cookies
//! here only set the world up.

mod common;
mod stripe_world;

use std::sync::Arc;

use api::routes::give::Limits;
use api::{AppState, app, routes};
use auth::limits::limiter;
use axum::body::Body as HttpBody;
use axum::http::{Request, StatusCode, header};
use contracts::{ContractError, Ctx, Source};
use giving::stripe::DonationPagePayload;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sources::SourceCodePayload;
use store::{OrgDb, TenantId};
use stripe_world::{T, setup};
use tower::ServiceExt;

const ID1: &str = "000000000000000000000000000000d1";
const ID2: &str = "000000000000000000000000000000d2";
const WORDING: &str = "hmrc-2016-04";

fn org(t: &T, tenant: &TenantId) -> Arc<OrgDb> {
    t.w.store.org(tenant).unwrap()
}

fn tx<T2>(db: &OrgDb, f: impl FnOnce(&Ctx) -> Result<T2, ContractError>) -> T2 {
    contracts::transact(db, Some(1), f).unwrap()
}

fn count(db: &OrgDb, table: &str) -> i64 {
    db.read(|c| c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0)))
        .map_err(|e: rusqlite::Error| e)
        .unwrap()
}

/// A live source code in `db`, and the page set to it with `amounts`.
fn publish(db: &OrgDb, amounts: [i64; 3], minimum: i64, maximum: i64) -> String {
    let has_tree = db
        .read(|c| sources::tree(c))
        .map_err(|e: rusqlite::Error| e)
        .unwrap();
    if has_tree.is_empty() {
        tx(db, api::schema::seed_new_org);
    }
    let category = db
        .read(|c| sources::tree(c))
        .map_err(|e: rusqlite::Error| e)
        .unwrap()
        .into_iter()
        .find(|p| p.parent_id.is_none())
        .unwrap()
        .id;
    let code = tx(db, |ctx| {
        sources::create_part(
            ctx,
            SourceCodePayload {
                parent_id: Some(category),
                name: format!("Web {}", uuid::Uuid::new_v4().simple()),
                description: None,
                start_date: None,
                end_date: None,
                is_active: true,
            },
            Source::Ui,
            None,
        )
    })
    .version_id
    .unwrap();
    tx(db, |ctx| {
        let held = giving::stripe::page(ctx.tx.read())?;
        giving::stripe::save_page(
            ctx,
            DonationPagePayload {
                amounts,
                minimum,
                maximum,
                source_code_id: Some(code.clone()),
            },
            held.version,
            Source::Ui,
        )
    });
    code
}

/// Alpha connected to Stripe with its page published (the defaults), and
/// its source code.
async fn alpha_ready(t: &T) -> String {
    t.connect("alpha", &t.ann).await;
    publish(&org(t, &t.w.alpha.id), [1000, 2500, 5000], 200, 100_000)
}

fn donation(id: &str) -> Value {
    json!({
        "id": id, "amount": 2500, "firstName": " Jane ", "lastName": "Smith",
        "email": "jane@example.org"
    })
}

fn with_gift_aid(id: &str) -> Value {
    let mut d = donation(id);
    d["giftAid"] = json!({
        "wordingVersion": WORDING, "addressLine1": "12  Mill Lane", "postcode": "ab1 2cd"
    });
    d
}

/// A request as the page's browser sends it: no cookie.
async fn send(t: &T, req: Request<HttpBody>) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let res = t.w.app.clone().oneshot(req).await.unwrap();
    let (status, headers) = (res.status(), res.headers().clone());
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (status, headers, bytes.to_vec())
}

fn get(path: &str) -> Request<HttpBody> {
    Request::get(path).body(HttpBody::empty()).unwrap()
}

fn post(path: &str, body: &Value) -> Request<HttpBody> {
    Request::post(path)
        .header(header::CONTENT_TYPE, "application/json")
        .body(HttpBody::from(body.to_string()))
        .unwrap()
}

async fn page(t: &T, slug: &str) -> (StatusCode, Value) {
    let (s, _, b) = send(t, get(&format!("/api/give/{slug}"))).await;
    (s, serde_json::from_slice(&b).unwrap_or(Value::Null))
}

async fn give(t: &T, slug: &str, body: &Value) -> (StatusCode, Value) {
    let (s, _, b) = send(t, post(&format!("/api/give/{slug}/donations"), body)).await;
    (s, serde_json::from_slice(&b).unwrap_or(Value::Null))
}

/// The `cs_…` at the end of a fake Checkout address.
fn session_of(url: &str) -> &str {
    url.rsplit('/').next().unwrap()
}

fn sessions_made(t: &T) -> usize {
    t.fake.calls("POST /v1/checkout/sessions")
}

type SubmissionRow = (
    i64,
    String,
    String,
    String,
    bool,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    Option<String>,
    String,
);

/// amount, first, last, email, gift_aid, scope, wording, line1, postcode,
/// source code, session, state.
fn submission(db: &OrgDb, id: &str) -> SubmissionRow {
    db.read(|c| {
        c.query_row(
            "SELECT amount, first_name, last_name, email, gift_aid, declaration_scope,
                    wording_version, address_line1, postcode, source_code_id,
                    checkout_session_id, state
             FROM donation_submissions WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                    r.get(9)?,
                    r.get(10)?,
                    r.get(11)?,
                ))
            },
        )
    })
    .map_err(|e: rusqlite::Error| e)
    .unwrap()
}

/// Nothing a payment would make exists: no contact, gift, declaration or
/// payment row.
fn nothing_but_submissions(db: &OrgDb) {
    for table in [
        "contacts",
        "gifts",
        "gift_aid_declarations",
        "stripe_payments",
    ] {
        assert_eq!(count(db, table), 0, "{table}");
    }
}

// ── the page exists, or it doesn't ─────────────────────────────────────────

#[tokio::test]
async fn a_page_exists_only_for_a_connected_group_with_a_source_code() {
    // Stripe off: no page for anyone.
    let off = common::world();
    let res = off
        .app
        .clone()
        .oneshot(get("/api/give/alpha"))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);

    let t = setup().await;
    let alpha = org(&t, &t.w.alpha.id);
    let not_found = json!({ "kind": "not_found" });
    let absent = |why: &'static str| {
        let (t, not_found) = (&t, not_found.clone());
        async move {
            for slug in ["alpha", "nobody"] {
                assert_eq!(
                    page(t, slug).await,
                    (StatusCode::NOT_FOUND, not_found.clone()),
                    "{why}"
                );
                assert_eq!(
                    give(t, slug, &donation(ID1)).await,
                    (StatusCode::NOT_FOUND, not_found.clone()),
                    "{why}"
                );
            }
        }
    };
    absent("not connected").await;

    // Connected, Stripe's form not finished: it can't take payments.
    let start = t.start("alpha", &t.ann).await;
    publish(&alpha, [1000, 2500, 5000], 200, 100_000);
    absent("charges not enabled").await;

    t.onboard(start["url"].as_str().unwrap(), "complete").await;
    t.settle().await;
    let (s, p) = page(&t, "alpha").await;
    assert_eq!(s, StatusCode::OK, "{p}");
    assert_eq!(
        p,
        json!({
            "name": "Alpha", "amounts": [1000, 2500, 5000], "minimum": 200,
            "maximum": 100_000, "giftAid": { "wordingVersion": WORDING }
        })
    );
    // Beta is connected to nothing and has no code: still no page, and
    // an unknown slug reads the same.
    assert_eq!(
        page(&t, "beta").await,
        (StatusCode::NOT_FOUND, not_found.clone())
    );
    assert_eq!(
        page(&t, "nobody").await,
        (StatusCode::NOT_FOUND, not_found.clone())
    );

    // No source code (never picked): no page.
    tx(&alpha, |ctx| {
        let held = giving::stripe::page(ctx.tx.read())?;
        giving::stripe::save_page(
            ctx,
            DonationPagePayload {
                source_code_id: None,
                ..held.page
            },
            held.version,
            Source::Ui,
        )
    });
    absent("no source code").await;
    publish(&alpha, [1000, 2500, 5000], 200, 100_000);
    assert_eq!(page(&t, "alpha").await.0, StatusCode::OK);

    // Stripe stops taking payments for the account: the page goes.
    let account = t.fake.account_ids()[0].clone();
    t.simulate(&account, json!({ "charges_enabled": false }))
        .await;
    t.settle().await;
    absent("charges disabled").await;
    t.simulate(&account, json!({ "charges_enabled": true }))
        .await;
    t.settle().await;
    assert_eq!(page(&t, "alpha").await.0, StatusCode::OK);

    // Disconnected: gone again.
    stripe_world::ok(&t.w, "POST", "/api/t/alpha/stripe/disconnect", &t.ann, None).await;
    absent("disconnected").await;
    assert_eq!(count(&alpha, "donation_submissions"), 0);
    assert_eq!(sessions_made(&t), 0);
}

#[tokio::test]
async fn the_page_answer_is_never_cached() {
    let t = setup().await;
    alpha_ready(&t).await;
    let (s, headers, _) = send(&t, get("/api/give/alpha")).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    let (s, headers, _) = send(&t, post("/api/give/alpha/donations", &donation(ID1))).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
}

// ── a donation ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_donation_stores_what_was_typed_and_sends_the_donor_to_stripe() {
    let t = setup().await;
    let code = alpha_ready(&t).await;
    let alpha = org(&t, &t.w.alpha.id);

    let (s, out) = give(&t, "alpha", &with_gift_aid(ID1)).await;
    assert_eq!(s, StatusCode::OK, "{out}");
    let url = out["url"].as_str().unwrap();
    assert!(
        url.starts_with(&format!("{}/api/fake-stripe/checkout/cs_test_", t.base)),
        "{url}"
    );
    assert_eq!(
        out.as_object().unwrap().len(),
        1,
        "the address and nothing else"
    );

    // What the donor typed, tidied, with the page's source code; the
    // session Stripe made is recorded on it.
    let session = session_of(url);
    assert_eq!(
        submission(&alpha, ID1),
        (
            2500,
            "Jane".into(),
            "Smith".into(),
            "jane@example.org".into(),
            true,
            Some("futureAndPast4y".into()),
            Some(WORDING.into()),
            "12 Mill Lane".into(),
            "AB1 2CD".into(),
            code,
            Some(session.to_owned()),
            "started".into(),
        )
    );
    // Never optimistic: a submission is not a gift and makes nothing else.
    nothing_but_submissions(&alpha);

    // The session: a donation of that amount on Alpha's own account,
    // traced back to the submission, and carrying no more of the donor
    // than their email.
    let s = t.fake.checkout_session(session).unwrap();
    let account = t.fake.account_ids()[0].clone();
    assert_eq!(s["account"], json!(account));
    assert_eq!(s["mode"], "payment");
    assert_eq!(s["submit_type"], "donate");
    assert_eq!(s["amount_total"], 2500);
    assert_eq!(s["currency"], "gbp");
    assert_eq!(s["customer_email"], "jane@example.org");
    assert_eq!(s["client_reference_id"], ID1);
    assert_eq!(s["metadata"], json!({ "keep_submission": ID1 }));
    assert_eq!(s["description"], "Donation to Alpha");
    assert_eq!(
        s["success_url"],
        json!(format!("{}/give/alpha/thanks", t.base))
    );
    assert_eq!(s["cancel_url"], json!(format!("{}/give/alpha", t.base)));
    let life = s["expires_at"].as_i64().unwrap() - s["created"].as_i64().unwrap();
    assert!((30 * 60..=32 * 60).contains(&life), "{life}");
    let sent = s.to_string();
    for private in ["Smith", "Mill Lane", "AB1 2CD", WORDING] {
        assert!(!sent.contains(private), "{private} went to Stripe");
    }

    // Without Gift Aid: no declaration fields at all.
    let (s, out) = give(&t, "alpha", &donation(ID2)).await;
    assert_eq!(s, StatusCode::OK, "{out}");
    let row = submission(&alpha, ID2);
    assert_eq!(
        (row.4, row.5, row.6, row.7.as_str()),
        (false, None, None, "")
    );
}

#[tokio::test]
async fn a_donation_to_one_group_touches_nothing_of_another() {
    let t = setup().await;
    alpha_ready(&t).await;
    t.connect("beta", &t.bob).await;
    let (alpha, beta) = (org(&t, &t.w.alpha.id), org(&t, &t.w.beta.id));
    let beta_code = publish(&beta, [500, 1500, 3000], 300, 50_000);

    // Each page is its own group's.
    let (_, a) = page(&t, "alpha").await;
    let (_, b) = page(&t, "beta").await;
    assert_eq!(
        (&a["name"], &a["amounts"]),
        (&json!("Alpha"), &json!([1000, 2500, 5000]))
    );
    assert_eq!(
        (&b["name"], &b["amounts"], &b["minimum"], &b["maximum"]),
        (
            &json!("Beta"),
            &json!([500, 1500, 3000]),
            &json!(300),
            &json!(50_000)
        )
    );

    let (s, out) = give(&t, "alpha", &with_gift_aid(ID1)).await;
    assert_eq!(s, StatusCode::OK, "{out}");
    assert_eq!(count(&alpha, "donation_submissions"), 1);
    assert_eq!(count(&beta, "donation_submissions"), 0);
    let alpha_session = session_of(out["url"].as_str().unwrap()).to_owned();

    // Alpha's id is nothing in Beta's file: the same id there is Beta's
    // own new submission, under Beta's range, code and Stripe account.
    let mut d = donation(ID1);
    d["amount"] = json!(60_000);
    let (s, out) = give(&t, "beta", &d).await;
    assert_eq!(
        s,
        StatusCode::UNPROCESSABLE_ENTITY,
        "over Beta's maximum: {out}"
    );
    assert_eq!(count(&beta, "donation_submissions"), 0);
    d["amount"] = json!(300);
    d["email"] = json!("bo@example.org");
    let (s, out) = give(&t, "beta", &d).await;
    assert_eq!(s, StatusCode::OK, "{out}");
    let beta_session = session_of(out["url"].as_str().unwrap()).to_owned();
    let row = submission(&beta, ID1);
    assert_eq!(
        (row.0, row.3.as_str(), row.9.as_str()),
        (300, "bo@example.org", beta_code.as_str())
    );
    assert_eq!(
        submission(&alpha, ID1).3,
        "jane@example.org",
        "Alpha's is untouched"
    );
    assert_eq!(count(&alpha, "donation_submissions"), 1);

    let accounts = t.fake.account_ids();
    assert_eq!(
        t.fake.checkout_session(&alpha_session).unwrap()["account"],
        json!(accounts[0])
    );
    assert_eq!(
        t.fake.checkout_session(&beta_session).unwrap()["account"],
        json!(accounts[1])
    );
    // £3 is under Alpha's minimum only because Alpha's page says so.
    let mut low = donation(ID2);
    low["amount"] = json!(150);
    assert_eq!(
        give(&t, "alpha", &low).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

#[tokio::test]
async fn the_form_cannot_choose_the_declarations_scope_or_wording() {
    let t = setup().await;
    alpha_ready(&t).await;
    let alpha = org(&t, &t.w.alpha.id);

    // No field for a scope, anywhere in the body.
    let mut scoped = with_gift_aid(ID1);
    scoped["giftAid"]["scope"] = json!("thisGift");
    let (s, out) = give(&t, "alpha", &scoped).await;
    assert_eq!(
        (s, &out["kind"]),
        (StatusCode::UNPROCESSABLE_ENTITY, &json!("invalid")),
        "{out}"
    );
    let mut scoped = with_gift_aid(ID1);
    scoped["scope"] = json!("thisGift");
    assert_eq!(
        give(&t, "alpha", &scoped).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let mut coded = donation(ID1);
    coded["sourceCodeId"] = json!("000000000000000000000000000000c1");
    assert_eq!(
        give(&t, "alpha", &coded).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );

    // A page that showed another wording made no declaration we can
    // stand behind: refused, nothing stored.
    for other in ["hmrc-2012", "", "anything"] {
        let mut worded = with_gift_aid(ID1);
        worded["giftAid"]["wordingVersion"] = json!(other);
        let (s, out) = give(&t, "alpha", &worded).await;
        assert_eq!(
            (s, &out["kind"], &out["reason"]),
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                &json!("rejected"),
                &json!("wording_changed")
            ),
            "{other:?}: {out}"
        );
    }
    assert_eq!(count(&alpha, "donation_submissions"), 0);
    assert_eq!(sessions_made(&t), 0);

    // What is stored is always the enduring scope under the pinned wording.
    assert_eq!(
        give(&t, "alpha", &with_gift_aid(ID1)).await.0,
        StatusCode::OK
    );
    let row = submission(&alpha, ID1);
    assert_eq!(
        (row.5.as_deref(), row.6.as_deref()),
        (Some("futureAndPast4y"), Some(WORDING))
    );
}

#[tokio::test]
async fn gift_aid_is_offered_only_by_a_group_that_claims_it() {
    let t = setup().await;
    alpha_ready(&t).await;
    let alpha = org(&t, &t.w.alpha.id);
    assert_eq!(
        page(&t, "alpha").await.1["giftAid"],
        json!({ "wordingVersion": WORDING })
    );

    tx(&alpha, |ctx| {
        platform::preferences::set_claims_gift_aid(ctx, false, None, Source::Ui)
    });
    let (s, p) = page(&t, "alpha").await;
    assert_eq!((s, &p["giftAid"]), (StatusCode::OK, &Value::Null));
    let (s, out) = give(&t, "alpha", &with_gift_aid(ID1)).await;
    assert_eq!(
        (s, &out["reason"]),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            &json!("gift_aid_not_offered")
        ),
        "{out}"
    );
    assert_eq!(count(&alpha, "donation_submissions"), 0);
    assert_eq!(sessions_made(&t), 0);
    // The gift itself is still welcome.
    assert_eq!(give(&t, "alpha", &donation(ID1)).await.0, StatusCode::OK);
}

#[tokio::test]
async fn what_cannot_be_stored_is_refused_before_stripe_is_asked() {
    let t = setup().await;
    alpha_ready(&t).await;
    let alpha = org(&t, &t.w.alpha.id);
    let change = |field: &str, value: Value| {
        let mut d = with_gift_aid(ID1);
        match field.split_once('.') {
            Some((a, b)) => d[a][b] = value,
            None => d[field] = value,
        }
        d
    };
    for (field, value, anchor) in [
        ("amount", json!(199), "amount"),
        ("amount", json!(100_001), "amount"),
        ("amount", json!(0), "amount"),
        ("amount", json!(-2500), "amount"),
        ("id", json!("not-an-id"), "id"),
        ("id", json!("000000000000000000000000000000D1"), "id"),
        ("firstName", json!("  "), "firstName"),
        ("lastName", json!(""), "lastName"),
        ("email", json!("jane"), "email"),
        ("email", json!(""), "email"),
        ("giftAid.addressLine1", json!(" "), "giftAid.addressLine1"),
        ("giftAid.postcode", json!(""), "giftAid.postcode"),
    ] {
        let (s, out) = give(&t, "alpha", &change(field, value.clone())).await;
        assert_eq!(
            s,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{field}={value}: {out}"
        );
        assert_eq!(out["kind"], "invalid", "{field}={value}: {out}");
        assert_eq!(
            out["problems"][0]["field"], anchor,
            "{field}={value}: {out}"
        );
    }
    // Pence are whole numbers: no pounds, no fractions, no strings.
    for amount in [json!(25.5), json!("2500"), Value::Null] {
        let (s, out) = give(&t, "alpha", &change("amount", amount.clone())).await;
        assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{amount}: {out}");
    }
    // A body past the page's limit isn't read.
    let big = change("firstName", json!("x".repeat(20_000)));
    assert_eq!(
        give(&t, "alpha", &big).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    // The group's own range, at its edges.
    for (id, amount) in [(ID1, 200), (ID2, 100_000)] {
        let mut d = donation(id);
        d["amount"] = json!(amount);
        assert_eq!(give(&t, "alpha", &d).await.0, StatusCode::OK, "{amount}");
    }
    assert_eq!(count(&alpha, "donation_submissions"), 2);
    assert_eq!(sessions_made(&t), 2);
}

#[tokio::test]
async fn pressing_twice_is_one_submission_and_one_session() {
    let t = setup().await;
    alpha_ready(&t).await;
    let alpha = org(&t, &t.w.alpha.id);

    // Two at once: the second waits for the first, then finds the attempt
    // already has its session.
    let body = donation(ID1);
    let (a, b) = tokio::join!(give(&t, "alpha", &body), give(&t, "alpha", &body));
    let mut statuses = [a.0, b.0];
    statuses.sort();
    assert_eq!(
        statuses,
        [StatusCode::OK, StatusCode::CONFLICT],
        "{a:?} {b:?}"
    );
    let refused = if a.0 == StatusCode::CONFLICT {
        &a.1
    } else {
        &b.1
    };
    assert_eq!(refused, &json!({ "kind": "duplicate", "id": ID1 }));
    assert_eq!(count(&alpha, "donation_submissions"), 1);
    assert_eq!(sessions_made(&t), 1);

    // And again later, with other details under the same id: still the
    // first one's, nothing changed, no new session.
    let mut other = donation(ID1);
    other["amount"] = json!(5000);
    other["email"] = json!("someone@else.org");
    assert_eq!(give(&t, "alpha", &other).await.0, StatusCode::CONFLICT);
    let row = submission(&alpha, ID1);
    assert_eq!((row.0, row.3.as_str()), (2500, "jane@example.org"));
    assert_eq!(sessions_made(&t), 1);
    assert_eq!(t.fake.checkout_sessions().len(), 1);

    // A new id is a new attempt.
    assert_eq!(give(&t, "alpha", &donation(ID2)).await.0, StatusCode::OK);
    assert_eq!(count(&alpha, "donation_submissions"), 2);
}

#[tokio::test]
async fn stripe_failing_loses_nothing_and_the_same_attempt_carries_on() {
    let t = setup().await;
    alpha_ready(&t).await;
    let alpha = org(&t, &t.w.alpha.id);

    t.outage(1, 503, "checkout").await;
    let (s, out) = give(&t, "alpha", &with_gift_aid(ID1)).await;
    assert_eq!(
        (s, &out),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            &json!({ "kind": "stripe_unavailable" })
        )
    );
    // What the donor typed is kept, with no session yet.
    let row = submission(&alpha, ID1);
    assert_eq!((row.10.as_deref(), row.11.as_str()), (None, "started"));

    // Stripe made the session but its answer never came: the next try
    // makes another, and that one is the submission's.
    t.outage_with(json!({ "calls": 1, "status": 500, "path": "checkout", "after": true }))
        .await;
    assert_eq!(
        give(&t, "alpha", &with_gift_aid(ID1)).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(submission(&alpha, ID1).10, None);

    let (s, out) = give(&t, "alpha", &with_gift_aid(ID1)).await;
    assert_eq!(s, StatusCode::OK, "{out}");
    let session = session_of(out["url"].as_str().unwrap()).to_owned();
    assert_eq!(
        submission(&alpha, ID1).10.as_deref(),
        Some(session.as_str())
    );
    assert_eq!(count(&alpha, "donation_submissions"), 1);
    nothing_but_submissions(&alpha);
}

#[tokio::test]
async fn the_answer_never_says_whether_the_donor_is_known() {
    let t = setup().await;
    alpha_ready(&t).await;
    let alpha = org(&t, &t.w.alpha.id);
    // Jane Smith is a contact of Alpha's with that email; Zed isn't.
    let (_, c) =
        t.w.call(
            "POST",
            "/api/t/alpha/contacts",
            &t.ann,
            Some(common::person("Jane", "Smith")),
        )
        .await;
    let id = c["id"].as_str().unwrap();
    let (s, out) =
        t.w.call(
            "POST",
            &format!("/api/t/alpha/contacts/{id}/save"),
            &t.ann,
            Some(
                json!({ "methods": { "expected": 0, "phones": [], "emails": [
                { "label": "home", "address": "jane@example.org", "isPrimary": true }] } }),
            ),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{out}");
    let contacts = count(&alpha, "contacts");
    let revisions = count(&alpha, "revisions");

    let mut answers = vec![];
    for (id, first, last, email) in [
        (ID1, "Jane", "Smith", "jane@example.org"),
        // Same email, another name: the staff queue later, the same now.
        (ID2, "John", "Jones", "jane@example.org"),
        (
            "000000000000000000000000000000d3",
            "Zed",
            "Unknown",
            "zed@nowhere.example",
        ),
    ] {
        let mut d = with_gift_aid(id);
        d["firstName"] = json!(first);
        d["lastName"] = json!(last);
        d["email"] = json!(email);
        let (status, headers, body) = send(&t, post("/api/give/alpha/donations", &d)).await;
        let text = String::from_utf8(body).unwrap();
        let out: Value = serde_json::from_str(&text).unwrap();
        let session = session_of(out["url"].as_str().unwrap()).to_owned();
        let mut names: Vec<String> = headers
            .keys()
            .map(|k| k.as_str().to_owned())
            .filter(|k| k != "server-timing")
            .collect();
        names.sort();
        // Byte for byte, but for the session's own id.
        answers.push((status, names, text.replace(&session, "cs")));
    }
    assert_eq!(answers[0], answers[1]);
    assert_eq!(answers[0], answers[2]);
    assert_eq!(answers[0].0, StatusCode::OK);
    // And nothing about any contact was written or made.
    assert_eq!(count(&alpha, "contacts"), contacts);
    assert_eq!(count(&alpha, "gifts"), 0);
    assert_eq!(count(&alpha, "gift_aid_declarations"), 0);
    // Two revisions a donation: the submission, and its session.
    assert_eq!(count(&alpha, "revisions"), revisions + 6);
}

// ── rate limits ────────────────────────────────────────────────────────────

/// The world with the page's limits set, and `Fly-Client-IP` naming the
/// client.
async fn limited(limits: Limits) -> T {
    let mut t = setup().await;
    let mut runtime = api::auth::Runtime::default();
    runtime.config.client_ip_header = Some("fly-client-ip".parse().unwrap());
    t.w.app = app(
        AppState::new(t.w.store.clone(), true)
            .with_stripe(Some(t.stripe.clone()))
            .with_auth(runtime)
            .with_give_limits(limits),
        routes::router(),
    );
    t
}

async fn give_from(t: &T, ip: &str, slug: &str, n: u32) -> StatusCode {
    let body = donation(&format!("{n:032x}"));
    let req = Request::post(format!("/api/give/{slug}/donations"))
        .header(header::CONTENT_TYPE, "application/json")
        .header("fly-client-ip", ip)
        .body(HttpBody::from(body.to_string()))
        .unwrap();
    send(t, req).await.0
}

async fn page_from(t: &T, ip: &str, slug: &str) -> StatusCode {
    let req = Request::get(format!("/api/give/{slug}"))
        .header("fly-client-ip", ip)
        .body(HttpBody::empty())
        .unwrap();
    send(t, req).await.0
}

const HOUR: std::time::Duration = std::time::Duration::from_secs(3600);

#[tokio::test]
async fn donations_are_limited_per_address() {
    let t = limited(Limits {
        page_ip: limiter(2, HOUR),
        donate_ip: limiter(3, HOUR),
        donate_group: limiter(100, HOUR),
    })
    .await;
    alpha_ready(&t).await;
    let alpha = org(&t, &t.w.alpha.id);
    for n in 1..=3 {
        assert_eq!(
            give_from(&t, "203.0.113.7", "alpha", n).await,
            StatusCode::OK
        );
    }
    assert_eq!(
        give_from(&t, "203.0.113.7", "alpha", 4).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    // Refused before anything is stored or Stripe is asked.
    assert_eq!(count(&alpha, "donation_submissions"), 3);
    assert_eq!(sessions_made(&t), 3);
    // Whatever the slug: the address is what is counted.
    assert_eq!(
        give_from(&t, "203.0.113.7", "nobody", 5).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    // Another address is another donor.
    assert_eq!(
        give_from(&t, "203.0.113.8", "alpha", 6).await,
        StatusCode::OK
    );

    // The page's own reads, the same way.
    for _ in 0..2 {
        assert_eq!(page_from(&t, "203.0.113.9", "alpha").await, StatusCode::OK);
    }
    assert_eq!(
        page_from(&t, "203.0.113.9", "alpha").await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(page_from(&t, "203.0.113.10", "alpha").await, StatusCode::OK);
}

#[tokio::test]
async fn donations_are_limited_per_group() {
    let t = limited(Limits {
        page_ip: limiter(100, HOUR),
        donate_ip: limiter(100, HOUR),
        donate_group: limiter(3, HOUR),
    })
    .await;
    alpha_ready(&t).await;
    t.connect("beta", &t.bob).await;
    publish(&org(&t, &t.w.beta.id), [1000, 2500, 5000], 200, 100_000);
    let alpha = org(&t, &t.w.alpha.id);
    // From anywhere: every donor has their own address.
    for n in 1..=3 {
        let ip = format!("198.51.100.{n}");
        assert_eq!(give_from(&t, &ip, "alpha", n).await, StatusCode::OK);
    }
    assert_eq!(
        give_from(&t, "198.51.100.4", "alpha", 4).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(count(&alpha, "donation_submissions"), 3);
    assert_eq!(sessions_made(&t), 3);
    // One group's flood is not another's.
    assert_eq!(
        give_from(&t, "198.51.100.4", "beta", 5).await,
        StatusCode::OK
    );
    // A slug with no page stays a 404 however often it is tried: the
    // group's limit says nothing a page doesn't.
    for n in 6..12 {
        assert_eq!(
            give_from(&t, "198.51.100.9", "nobody", n).await,
            StatusCode::NOT_FOUND
        );
    }
}

// ── the fake's payment page ────────────────────────────────────────────────

#[tokio::test]
async fn paying_on_stripes_page_tells_us_by_webhook_and_sends_the_donor_back() {
    let t = setup().await;
    alpha_ready(&t).await;
    let (_, out) = give(&t, "alpha", &with_gift_aid(ID1)).await;
    let url = out["url"].as_str().unwrap().to_owned();
    let session = session_of(&url).to_owned();

    let shown = t.http.get(&url).send().await.unwrap();
    assert_eq!(shown.status(), 200);
    let html = shown.text().await.unwrap();
    assert!(
        html.contains("Donation to Alpha") && html.contains("£25.00"),
        "{html}"
    );

    // "Back" changes nothing and goes to the form.
    let back = t
        .http
        .post(format!("{url}/decide"))
        .form(&[("decision", "back")])
        .send()
        .await
        .unwrap();
    assert_eq!(back.status(), 303);
    assert_eq!(
        back.headers()["location"],
        format!("{}/give/alpha", t.base).as_str()
    );
    assert_eq!(t.fake.checkout_session(&session).unwrap()["status"], "open");

    // "Pay": the session completes, its event arrives for Alpha, and the
    // donor lands on the thank-you page.
    let paid = t
        .http
        .post(format!("{url}/decide"))
        .form(&[("decision", "pay")])
        .send()
        .await
        .unwrap();
    assert_eq!(paid.status(), 303);
    assert_eq!(
        paid.headers()["location"],
        format!("{}/give/alpha/thanks", t.base).as_str()
    );
    let s = t.fake.checkout_session(&session).unwrap();
    assert_eq!(
        (&s["status"], &s["payment_status"]),
        (&json!("complete"), &json!("paid"))
    );
    assert!(
        s["payment_intent"].as_str().unwrap().starts_with("pi_"),
        "{s}"
    );
    assert_eq!(s["url"], Value::Null);
    let events = t.fake.events();
    let event = events
        .iter()
        .find(|e| e["type"] == "checkout.session.completed")
        .unwrap();
    let object = &event["data"]["object"];
    assert_eq!(object["id"], json!(session));
    assert_eq!(object["client_reference_id"], ID1);
    assert_eq!(object["metadata"]["keep_submission"], ID1);
    assert_eq!(object["payment_intent"], s["payment_intent"]);
    let (_, tenant) = t.event(event["id"].as_str().unwrap());
    assert_eq!(tenant.as_deref(), Some(t.w.alpha.id.as_str()));

    // Paid once: the page is closed, and a second press pays nothing.
    let again = t.http.get(&url).send().await.unwrap().text().await.unwrap();
    assert!(again.contains("no longer open"), "{again}");
    t.http
        .post(format!("{url}/decide"))
        .form(&[("decision", "pay")])
        .send()
        .await
        .unwrap();
    let completed = t
        .fake
        .events()
        .iter()
        .filter(|e| e["type"] == "checkout.session.completed")
        .count();
    assert_eq!(completed, 1);
    // The donor asking for the same attempt again gets no second session.
    assert_eq!(
        give(&t, "alpha", &with_gift_aid(ID1)).await.0,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn a_session_left_unpaid_expires_by_webhook() {
    let t = setup().await;
    alpha_ready(&t).await;
    let (_, out) = give(&t, "alpha", &donation(ID1)).await;
    let session = session_of(out["url"].as_str().unwrap()).to_owned();
    let done = t
        .fake_post(&format!("simulate/checkout/{session}/expire"))
        .await;
    assert_eq!(done["delivered"], true, "{done}");
    assert_eq!(
        t.fake.checkout_session(&session).unwrap()["status"],
        "expired"
    );
    let (_, tenant) = t.event(done["event"].as_str().unwrap());
    assert_eq!(tenant.as_deref(), Some(t.w.alpha.id.as_str()));
    // Expired can't be paid.
    assert!(t.fake.pay_checkout(&session).is_none());
}

#[tokio::test]
async fn the_fake_refuses_what_stripe_would() {
    let t = setup().await;
    alpha_ready(&t).await;
    let account = t.fake.account_ids()[0].clone();
    let now = contracts::now_ms() / 1000;
    let base: Vec<(&str, String)> = vec![
        ("mode", "payment".into()),
        ("line_items[0][quantity]", "1".into()),
        ("line_items[0][price_data][currency]", "gbp".into()),
        ("line_items[0][price_data][unit_amount]", "2500".into()),
        ("success_url", "https://x.example/ok".into()),
        ("customer_email", "jane@example.org".into()),
        ("expires_at", (now + 31 * 60).to_string()),
    ];
    let send = |account: Option<String>, form: Vec<(&'static str, String)>| {
        let t = &t;
        async move {
            let mut req = t
                .http
                .post(format!("{}/api/fake-stripe/v1/checkout/sessions", t.base))
                .bearer_auth(api::stripe::fake::API_KEY)
                .header("Stripe-Version", api::stripe::client::VERSION)
                .form(&form);
            if let Some(a) = account {
                req = req.header("Stripe-Account", a);
            }
            let res = req.send().await.unwrap();
            let status = res.status().as_u16();
            let body: Value = res.json().await.unwrap();
            (status, body["error"]["code"].as_str().map(str::to_owned))
        }
    };
    let with = |key: &'static str, value: &str| {
        let mut f: Vec<(&'static str, String)> =
            base.iter().filter(|(k, _)| *k != key).cloned().collect();
        f.push((key, value.to_owned()));
        f
    };
    assert_eq!(send(Some(account.clone()), base.clone()).await.0, 200);
    assert_eq!(
        send(None, base.clone()).await.0,
        400,
        "a direct charge names its account"
    );
    assert_eq!(
        send(Some("acct_nobody".into()), base.clone()).await,
        (403, Some("account_invalid".into()))
    );
    assert_eq!(
        send(Some(account.clone()), with("customer_email", "jane")).await,
        (400, Some("email_invalid".into()))
    );
    assert_eq!(
        send(
            Some(account.clone()),
            with("line_items[0][price_data][unit_amount]", "29")
        )
        .await,
        (400, Some("amount_too_small".into()))
    );
    for at in [now + 29 * 60, now + 25 * 60 * 60] {
        assert_eq!(
            send(Some(account.clone()), with("expires_at", &at.to_string()))
                .await
                .0,
            400,
            "{at}"
        );
    }
    // An account that can't take payments yet.
    t.simulate(&account, json!({ "charges_enabled": false }))
        .await;
    assert_eq!(
        send(Some(account.clone()), base.clone()).await,
        (400, Some("account_capability_not_active".into()))
    );
    // A session is read only by its own account.
    let made = t.fake.checkout_sessions();
    let id = made[0]["id"].as_str().unwrap();
    let read = |account: String| {
        let t = &t;
        async move {
            t.http
                .get(format!(
                    "{}/api/fake-stripe/v1/checkout/sessions/{id}",
                    t.base
                ))
                .bearer_auth(api::stripe::fake::API_KEY)
                .header("Stripe-Version", api::stripe::client::VERSION)
                .header("Stripe-Account", account)
                .send()
                .await
                .unwrap()
                .status()
                .as_u16()
        }
    };
    assert_eq!(read(account.clone()).await, 200);
    assert_eq!(read("acct_other".into()).await, 404);
}

#[tokio::test]
async fn a_page_on_another_site_cannot_post_a_donation() {
    let t = setup().await;
    alpha_ready(&t).await;
    let req = Request::post("/api/give/alpha/donations")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ORIGIN, "https://evil.example")
        .header("sec-fetch-site", "cross-site")
        .body(HttpBody::from(donation(ID1).to_string()))
        .unwrap();
    assert_eq!(send(&t, req).await.0, StatusCode::FORBIDDEN);
    assert_eq!(count(&org(&t, &t.w.alpha.id), "donation_submissions"), 0);
}
