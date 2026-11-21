//! Stripe Connect (`api::stripe`, plan stripe.sv S1) end to end against
//! the fake, served on a real port so the HTTP client, the hosted
//! onboarding page's redirects and the signed webhooks all cross the
//! wire: who may connect, the account we ask Stripe for, onboarding and
//! its status, disconnecting and connecting again, Stripe failing.
//! Tenancy on every route: B never sees A's account.

mod common;
mod stripe_world;

use axum::http::StatusCode;
use serde_json::{Value, json};
use stripe_world::{ok, setup};

fn status_path(slug: &str) -> String {
    format!("/api/t/{slug}/stripe")
}

#[tokio::test]
async fn off_only_the_status_answers_and_says_so() {
    let w = common::world();
    let ann = w.login("ann@alpha.org").await;
    let s = ok(&w, "GET", &status_path("alpha"), &ann, None).await;
    assert_eq!(s["enabled"], false);
    assert_eq!(s["mode"], "off");
    assert_eq!(s["connected"], false);
    assert_eq!(s["onboarding"], "none");
    for route in ["connect", "disconnect"] {
        let (code, _) = w
            .call("POST", &format!("/api/t/alpha/stripe/{route}"), &ann, None)
            .await;
        assert_eq!(code, StatusCode::NOT_FOUND, "{route}");
    }
    let (code, _) = w.call("POST", "/api/stripe/webhook", "", None).await;
    assert_eq!(code, StatusCode::NOT_FOUND);
    // No fake mounted either.
    let (code, _) = w
        .call("GET", "/api/fake-stripe/simulate/webhooks", "", None)
        .await;
    assert_eq!(code, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn only_an_admin_connects_or_disconnects_and_every_member_reads() {
    let t = setup().await;
    for (cookie, who) in [(&t.sam, "staff"), (&t.val, "viewer")] {
        for route in ["connect", "disconnect"] {
            let (code, body) =
                t.w.call(
                    "POST",
                    &format!("/api/t/alpha/stripe/{route}"),
                    cookie,
                    None,
                )
                .await;
            assert_eq!(code, StatusCode::FORBIDDEN, "{who} {route}: {body}");
        }
        let s = ok(&t.w, "GET", &status_path("alpha"), cookie, None).await;
        assert_eq!(s["enabled"], true, "{who}");
        assert_eq!(s["mode"], "fake");
    }
    // Nobody was refused part-way: Stripe was never asked for anything.
    assert!(t.fake.account_ids().is_empty());
    // Another group's admin is not a member here.
    for (method, path) in [
        ("GET", "/api/t/alpha/stripe"),
        ("POST", "/api/t/alpha/stripe/connect"),
        ("POST", "/api/t/alpha/stripe/disconnect"),
    ] {
        let (code, _) = t.w.call(method, path, &t.bob, None).await;
        assert_eq!(code, StatusCode::FORBIDDEN, "{method} {path}");
    }
}

#[tokio::test]
async fn connecting_makes_the_account_we_mean_and_a_link_to_stripes_form() {
    let t = setup().await;
    let start = t.start("alpha", &t.ann).await;
    let account = start["status"]["accountId"].as_str().unwrap().to_owned();
    assert!(account.starts_with("acct_"), "{account}");
    assert_eq!(t.fake.account_ids(), std::slice::from_ref(&account));

    // The three properties the plan settles, however they were asked for:
    // the full Dashboard, the account pays Stripe's fees, Stripe carries
    // the losses (and collects the requirements); in the UK.
    let a = t.fake.account(&account).unwrap();
    assert_eq!(a["controller"]["stripe_dashboard"]["type"], "full");
    assert_eq!(a["controller"]["fees"]["payer"], "account");
    assert_eq!(a["controller"]["losses"]["payments"], "stripe");
    assert_eq!(a["controller"]["requirement_collection"], "stripe");
    assert_eq!(a["country"], "GB");
    assert_eq!(a["metadata"]["keep_tenant"], t.w.alpha.id.as_str());

    // Connected, with Stripe's form still to do.
    let s = &start["status"];
    assert_eq!(s["connected"], true);
    assert_eq!(s["onboarding"], "pending");
    assert_eq!(s["detailsSubmitted"], false);
    assert_eq!(s["chargesEnabled"], false);
    assert_eq!(s["requirementsDue"], 3);
    assert_eq!(s["disabledReason"], "requirements.past_due");
    assert!(s["connectedAt"].as_i64().unwrap() > 0);
    assert!(s["connectedBy"].as_i64().unwrap() > 0);
    assert_eq!(
        &ok(&t.w, "GET", &status_path("alpha"), &t.val, None).await,
        s,
        "what the admin was answered is what every member reads"
    );

    // The link is Stripe's hosted page; finishing it comes back to the
    // group's settings.
    let url = start["url"].as_str().unwrap();
    assert!(
        url.starts_with(&format!("{}/api/fake-stripe/onboarding/", t.base)),
        "{url}"
    );
    let back = t.onboard(url, "complete").await;
    assert_eq!(back, format!("{}/t/alpha/settings?stripe=return", t.base));

    // The fake delivered `account.updated` before it sent the browser
    // back; the status follows once the event has run.
    t.settle().await;
    let s = ok(&t.w, "GET", &status_path("alpha"), &t.ann, None).await;
    assert_eq!(s["onboarding"], "complete");
    assert_eq!(s["detailsSubmitted"], true);
    assert_eq!(s["chargesEnabled"], true);
    assert_eq!(s["payoutsEnabled"], true);
    assert_eq!(s["requirementsDue"], 0);
    assert_eq!(s["disabledReason"], Value::Null);
    assert_eq!(s["failedEvents"], 0);

    // Nothing left for Stripe's form: connecting again answers no link,
    // and makes no second account.
    let again = t.start("alpha", &t.ann).await;
    assert_eq!(again["url"], Value::Null);
    assert_eq!(again["status"]["accountId"], account.as_str());
    assert_eq!(again["status"]["connectedAt"], s["connectedAt"]);
    assert_eq!(t.fake.account_ids().len(), 1);
}

#[tokio::test]
async fn a_form_sent_in_with_more_needed_is_restricted_and_can_be_gone_back_to() {
    let t = setup().await;
    let start = t.start("alpha", &t.ann).await;
    let url = start["url"].as_str().unwrap().to_owned();
    // Leaving the form changes nothing, and comes back all the same:
    // the return proves nothing.
    assert!(t.onboard(&url, "leave").await.ends_with("?stripe=return"));
    t.settle().await;
    let s = ok(&t.w, "GET", &status_path("alpha"), &t.ann, None).await;
    assert_eq!(s["onboarding"], "pending");

    // A link works once: the spent one sends the browser to ask for
    // another.
    let res = t.http.get(&url).send().await.unwrap();
    assert_eq!(res.status(), 303);
    assert_eq!(
        res.headers()["location"].to_str().unwrap(),
        format!("{}/t/alpha/settings?stripe=refresh", t.base)
    );

    // Another press of "Connect Stripe": a new link to the same account.
    let second = t.start("alpha", &t.ann).await;
    let url2 = second["url"].as_str().unwrap();
    assert_ne!(url2, url);
    assert_eq!(second["status"]["accountId"], start["status"]["accountId"]);
    assert_eq!(t.fake.account_ids().len(), 1);
    t.onboard(url2, "partial").await;
    t.settle().await;
    let s = ok(&t.w, "GET", &status_path("alpha"), &t.ann, None).await;
    assert_eq!(s["onboarding"], "restricted");
    assert_eq!(s["detailsSubmitted"], true);
    assert_eq!(s["chargesEnabled"], false);
    assert_eq!(s["requirementsDue"], 1);
    assert_eq!(s["disabledReason"], "requirements.pending_verification");
    // Still something for the form: a link is answered.
    assert!(t.start("alpha", &t.ann).await["url"].is_string());
}

#[tokio::test]
async fn each_group_has_its_own_account_and_never_sees_anothers() {
    let t = setup().await;
    let a = t.connect("alpha", &t.ann).await;
    // Beta, not connected, sees nothing of alpha's.
    let b = ok(&t.w, "GET", &status_path("beta"), &t.bob, None).await;
    assert_eq!(b["connected"], false);
    assert_eq!(b["accountId"], Value::Null);
    assert_eq!(b["onboarding"], "none");
    assert_eq!(b["chargesEnabled"], false);

    let b = t.connect("beta", &t.bob).await;
    assert_ne!(a["accountId"], b["accountId"]);
    assert_eq!(t.fake.account_ids().len(), 2);
    assert_eq!(
        t.fake.account(b["accountId"].as_str().unwrap()).unwrap()["metadata"]["keep_tenant"],
        t.w.beta.id.as_str()
    );

    // Beta disconnecting leaves alpha as it was.
    let gone = ok(&t.w, "POST", "/api/t/beta/stripe/disconnect", &t.bob, None).await;
    assert_eq!(gone["connected"], false);
    let still = ok(&t.w, "GET", &status_path("alpha"), &t.ann, None).await;
    assert_eq!(still, a);
    // A's connected account is A's alone in platform.db.
    assert_eq!(
        api::stripe::accounts::tenant_for(&t.w.store, a["accountId"].as_str().unwrap())
            .unwrap()
            .unwrap(),
        t.w.alpha.id
    );
    assert_eq!(
        api::stripe::accounts::tenant_for(&t.w.store, b["accountId"].as_str().unwrap()).unwrap(),
        None,
        "a disconnected account routes nowhere"
    );
}

#[tokio::test]
async fn disconnecting_forgets_the_routing_and_connecting_again_is_the_same_account() {
    let t = setup().await;
    let first = t.connect("alpha", &t.ann).await;
    let account = first["accountId"].as_str().unwrap().to_owned();
    let calls = t.fake.calls("GET /v1/accounts") + t.fake.calls("POST /v2/core/accounts");

    let gone = ok(&t.w, "POST", "/api/t/alpha/stripe/disconnect", &t.ann, None).await;
    assert_eq!(gone["connected"], false);
    assert_eq!(gone["accountId"], Value::Null);
    assert_eq!(gone["onboarding"], "none");
    assert_eq!(gone["chargesEnabled"], false);
    // Nothing was asked of Stripe: the account is the group's and stays.
    assert_eq!(
        t.fake.calls("GET /v1/accounts") + t.fake.calls("POST /v2/core/accounts"),
        calls
    );
    assert!(t.fake.account(&account).is_some());
    // Disconnecting twice is the same answer.
    let twice = ok(&t.w, "POST", "/api/t/alpha/stripe/disconnect", &t.ann, None).await;
    assert_eq!(twice, gone);

    // What Stripe says of the account meanwhile is kept, not run.
    let sim = t
        .simulate(
            &account,
            json!({ "charges_enabled": false, "disabled_reason": "under_review" }),
        )
        .await;
    assert_eq!(sim["delivered"], true);
    t.settle().await;
    assert_eq!(
        t.event(sim["event"].as_str().unwrap()),
        (Some("not_connected".into()), Some(t.w.alpha.id.to_string()))
    );

    // Connecting again: the same account, a new connection, and its
    // state as Stripe has it now.
    let again = t.start("alpha", &t.ann).await;
    assert_eq!(again["status"]["accountId"], account.as_str());
    assert_eq!(again["status"]["connected"], true);
    assert_eq!(again["status"]["onboarding"], "restricted");
    assert_eq!(again["status"]["disabledReason"], "under_review");
    assert!(again["status"]["connectedAt"].as_i64() >= first["connectedAt"].as_i64());
    assert_eq!(t.fake.account_ids().len(), 1);
    // The event kept while disconnected has now run.
    t.settle().await;
    assert_eq!(
        t.event(sim["event"].as_str().unwrap()).0.as_deref(),
        Some("done")
    );
}

#[tokio::test]
async fn stripe_failing_changes_nothing_and_the_next_try_carries_on() {
    let t = setup().await;
    // Stripe down for the create: 503, nothing made, not connected.
    // Stripe stores that failure against the create's idempotency key
    // and would answer it again (the fake does): the next try below
    // only works because it goes under a new key.
    t.outage(1, 503, "accounts").await;
    let (code, body) =
        t.w.call("POST", "/api/t/alpha/stripe/connect", &t.ann, None)
            .await;
    assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["kind"], "stripe_unavailable");
    assert!(t.fake.account_ids().is_empty());
    let s = ok(&t.w, "GET", &status_path("alpha"), &t.ann, None).await;
    assert_eq!(s["connected"], false);

    // The account made but its link refused: connected (the account is
    // ours), and the next press makes the link for that same account.
    t.outage(1, 500, "account_links").await;
    let (code, _) =
        t.w.call("POST", "/api/t/alpha/stripe/connect", &t.ann, None)
            .await;
    assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(t.fake.account_ids().len(), 1);
    let s = ok(&t.w, "GET", &status_path("alpha"), &t.ann, None).await;
    assert_eq!(s["connected"], true);
    let start = t.start("alpha", &t.ann).await;
    assert_eq!(start["status"]["accountId"], s["accountId"]);
    assert_eq!(t.fake.account_ids().len(), 1);
}

#[tokio::test]
async fn a_create_whose_answer_never_came_is_the_same_account_when_tried_again() {
    let t = setup().await;
    // Stripe makes the account, and we never hear (here: its answer is a
    // 409, "that request is still in flight"). Nothing is stored against
    // the key, so the next try sends the same key and gets that account.
    t.outage_with(json!({ "calls": 1, "status": 409, "path": "accounts", "after": true }))
        .await;
    let (code, body) =
        t.w.call("POST", "/api/t/alpha/stripe/connect", &t.ann, None)
            .await;
    assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(t.fake.account_ids().len(), 1, "made at Stripe");
    let s = ok(&t.w, "GET", &status_path("alpha"), &t.ann, None).await;
    assert_eq!(s["connected"], false, "but not known here");

    let start = t.start("alpha", &t.ann).await;
    assert_eq!(t.fake.account_ids().len(), 1, "no second account");
    assert_eq!(
        start["status"]["accountId"],
        t.fake.account_ids()[0].as_str()
    );
}

#[tokio::test]
async fn a_new_accounts_id_is_kept_even_if_it_cant_be_read_back() {
    let t = setup().await;
    // The create answers; reading the new account fails. The id is ours
    // already: the group is connected to it, nothing known of it yet.
    t.outage(1, 503, "/v1/accounts/").await;
    let (code, _) =
        t.w.call("POST", "/api/t/alpha/stripe/connect", &t.ann, None)
            .await;
    assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE);
    let made = t.fake.account_ids();
    assert_eq!(made.len(), 1);
    let s = ok(&t.w, "GET", &status_path("alpha"), &t.ann, None).await;
    assert_eq!(s["connected"], true);
    assert_eq!(s["accountId"], made[0].as_str());
    assert_eq!(s["onboarding"], "pending");

    // The next try reads that account by its id: no create at all, so
    // it doesn't lean on an idempotency key Stripe forgets in time.
    let creates = t.fake.calls("POST /v2/core/accounts") + t.fake.calls("POST /v1/accounts");
    let start = t.start("alpha", &t.ann).await;
    assert_eq!(start["status"]["accountId"], made[0].as_str());
    assert_eq!(
        start["status"]["requirementsDue"], 3,
        "now read from Stripe"
    );
    assert_eq!(
        t.fake.calls("POST /v2/core/accounts") + t.fake.calls("POST /v1/accounts"),
        creates
    );
    assert_eq!(t.fake.account_ids().len(), 1);
}

#[tokio::test]
async fn a_create_stripe_failed_or_refused_is_tried_again_under_a_new_key() {
    let t = setup().await;
    let key = |t: &stripe_world::T| {
        api::stripe::accounts::account(&t.w.store, &t.w.alpha.id)
            .unwrap()
            .unwrap()
            .create_key
    };
    // A 500, then a refusal: each is what Stripe would answer for that
    // key from then on, so each try after one goes under another key.
    let mut keys = Vec::new();
    for status in [500, 400] {
        t.outage(1, status, "accounts").await;
        let (code, _) =
            t.w.call("POST", "/api/t/alpha/stripe/connect", &t.ann, None)
                .await;
        assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE, "{status}");
        keys.push(key(&t));
    }
    assert_ne!(keys[0], keys[1]);
    assert!(t.fake.account_ids().is_empty());
    // A rate limit stores nothing: the same key again.
    t.outage(1, 429, "accounts").await;
    let (code, _) =
        t.w.call("POST", "/api/t/alpha/stripe/connect", &t.ann, None)
            .await;
    assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(key(&t), keys[1]);

    let start = t.start("alpha", &t.ann).await;
    assert_eq!(start["status"]["connected"], true);
    assert_eq!(t.fake.account_ids().len(), 1);
}

#[tokio::test]
async fn an_account_stripe_no_longer_knows_as_ours_is_replaced() {
    let t = setup().await;
    let first = t.connect("alpha", &t.ann).await;
    // A wiped sandbox: the id means nothing to Stripe now.
    t.fake.wipe();
    let start = t.start("alpha", &t.ann).await;
    let account = start["status"]["accountId"].as_str().unwrap();
    assert_ne!(account, first["accountId"].as_str().unwrap());
    assert_eq!(t.fake.account_ids(), [account.to_owned()]);
    assert_eq!(start["status"]["onboarding"], "pending");
    assert!(start["url"].is_string());
}

#[tokio::test]
async fn the_owner_removing_us_at_stripe_disconnects_the_group_here() {
    let t = setup().await;
    let s = t.connect("alpha", &t.ann).await;
    let account = s["accountId"].as_str().unwrap();
    let res = t
        .http
        .post(format!(
            "{}/api/fake-stripe/simulate/accounts/{account}/deauthorize",
            t.base
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    t.settle().await;
    let s = ok(&t.w, "GET", &status_path("alpha"), &t.ann, None).await;
    assert_eq!(s["connected"], false);
    assert_eq!(s["onboarding"], "none");
}
