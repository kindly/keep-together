//! `POST /api/stripe/webhook` (`api::stripe::webhook`, plan stripe.sv S1)
//! against the fake on a real port: the signature (bad, missing, stale),
//! the event store (a repeat is a no-op), routing by Stripe account (an
//! unknown account is stored and not run; an event for A's account never
//! runs against B), events out of order, and Stripe failing mid-run.

mod common;
mod stripe_world;

use api::stripe::fake::WEBHOOK_SECRET;
use api::stripe::webhook::{SIGNATURE_HEADER, TOLERANCE_SECS, sign};
use serde_json::{Value, json};
use stripe_world::{T, ok, setup};

fn now() -> i64 {
    contracts::now_ms() / 1000
}

impl T {
    /// Post `body` to the webhook with this `Stripe-Signature` (none:
    /// no header): the status.
    async fn post(&self, body: &str, signature: Option<&str>) -> u16 {
        let mut req = self
            .http
            .post(format!("{}/api/stripe/webhook", self.base))
            .header("Content-Type", "application/json")
            .body(body.to_owned());
        if let Some(s) = signature {
            req = req.header(SIGNATURE_HEADER, s);
        }
        req.send().await.unwrap().status().as_u16()
    }

    async fn post_signed(&self, event: &Value) -> u16 {
        let raw = event.to_string();
        self.post(&raw, Some(&sign(WEBHOOK_SECRET, now(), raw.as_bytes())))
            .await
    }

    async fn status(&self, slug: &str, cookie: &str) -> Value {
        ok(
            &self.w,
            "GET",
            &format!("/api/t/{slug}/stripe"),
            cookie,
            None,
        )
        .await
    }
}

#[tokio::test]
async fn a_bad_missing_or_stale_signature_is_refused_and_nothing_is_stored() {
    let t = setup().await;
    let s = t.connect("alpha", &t.ann).await;
    let account = s["accountId"].as_str().unwrap();
    let stored = t.event_count();
    // An event that would change the account, if anyone believed it.
    t.fake
        .update_account(account, &json!({ "charges_enabled": false }));
    let event = t.fake.events().last().unwrap().clone();
    let raw = event.to_string();
    let good = sign(WEBHOOK_SECRET, now(), raw.as_bytes());

    assert_eq!(t.post(&raw, None).await, 400, "no signature");
    assert_eq!(t.post(&raw, Some("")).await, 400);
    assert_eq!(t.post(&raw, Some("t=1,v1=00")).await, 400);
    let other = sign("whsec_someone_elses", now(), raw.as_bytes());
    assert_eq!(t.post(&raw, Some(&other)).await, 400, "another secret");
    // A good signature for another body.
    assert_eq!(
        t.post(&raw.replace("false", "true "), Some(&good)).await,
        400
    );
    // Signed properly, but too long ago (a replayed capture).
    let stale = sign(WEBHOOK_SECRET, now() - TOLERANCE_SECS - 30, raw.as_bytes());
    assert_eq!(t.post(&raw, Some(&stale)).await, 400, "stale");
    assert_eq!(t.event_count(), stored, "nothing stored");
    t.settle().await;
    assert_eq!(t.status("alpha", &t.ann).await["chargesEnabled"], true);

    // The same event, signed now: taken.
    assert_eq!(t.post(&raw, Some(&good)).await, 200);
    assert_eq!(t.event_count(), stored + 1);
    t.settle().await;
    assert_eq!(t.status("alpha", &t.ann).await["chargesEnabled"], false);

    // A signed body that isn't an event.
    let junk = r#"{"hello":"world"}"#;
    let signed = sign(WEBHOOK_SECRET, now(), junk.as_bytes());
    assert_eq!(t.post(junk, Some(&signed)).await, 400);
}

#[tokio::test]
async fn a_repeated_event_is_a_no_op() {
    let t = setup().await;
    let s = t.connect("alpha", &t.ann).await;
    let account = s["accountId"].as_str().unwrap();
    let event = t
        .fake
        .update_account(account, &json!({ "payouts_enabled": false }))
        .unwrap();
    let id = event["id"].as_str().unwrap();
    assert_eq!(t.post_signed(&event).await, 200);
    t.settle().await;
    assert_eq!(t.event(id).0.as_deref(), Some("done"));
    let (stored, reads) = (t.event_count(), t.fake.calls("GET /v1/accounts"));

    // Stripe sends it again (it retries, and catch-up reads it too).
    for _ in 0..3 {
        assert_eq!(t.post_signed(&event).await, 200);
    }
    t.settle().await;
    assert_eq!(t.event_count(), stored);
    assert_eq!(t.fake.calls("GET /v1/accounts"), reads, "not run again");
    assert_eq!(t.event(id).0.as_deref(), Some("done"));
}

#[tokio::test]
async fn an_event_for_an_unknown_account_is_stored_and_not_run() {
    let t = setup().await;
    t.connect("alpha", &t.ann).await;
    let before = t.status("alpha", &t.ann).await;
    let reads = t.fake.calls("GET /v1/accounts");
    let event = json!({
        "id": "evt_stranger", "object": "event", "type": "account.updated",
        "account": "acct_nobody_here", "created": now(), "livemode": false,
        "data": { "object": { "id": "acct_nobody_here", "charges_enabled": false } }
    });
    assert_eq!(t.post_signed(&event).await, 200);
    t.settle().await;
    assert_eq!(
        t.event("evt_stranger"),
        (Some("unknown_account".into()), None)
    );
    assert_eq!(t.fake.calls("GET /v1/accounts"), reads);
    assert_eq!(t.status("alpha", &t.ann).await, before);

    // The platform's own events name no account: the same.
    let own = json!({ "id": "evt_own", "type": "balance.available", "created": now(),
        "livemode": false, "data": { "object": {} } });
    assert_eq!(t.post_signed(&own).await, 200);
    assert_eq!(t.event("evt_own"), (Some("unknown_account".into()), None));

    // A live-mode event on a server that isn't live is never run, even
    // for an account we hold.
    let account = before["accountId"].as_str().unwrap();
    let live = json!({ "id": "evt_live", "type": "account.updated", "account": account,
        "created": now(), "livemode": true, "data": { "object": { "id": account } } });
    assert_eq!(t.post_signed(&live).await, 200);
    t.settle().await;
    assert_eq!(t.event("evt_live"), (Some("wrong_mode".into()), None));
    assert_eq!(t.fake.calls("GET /v1/accounts"), reads);
}

#[tokio::test]
async fn an_event_for_one_groups_account_never_runs_against_another() {
    let t = setup().await;
    let a = t.connect("alpha", &t.ann).await;
    let b = t.connect("beta", &t.bob).await;
    let (acct_a, acct_b) = (
        a["accountId"].as_str().unwrap(),
        b["accountId"].as_str().unwrap(),
    );

    // Stripe restricts A's account: only A changes.
    let sim = t
        .simulate(
            acct_a,
            json!({ "charges_enabled": false, "currently_due": ["external_account"],
                "disabled_reason": "requirements.past_due" }),
        )
        .await;
    t.settle().await;
    assert_eq!(
        t.event(sim["event"].as_str().unwrap()),
        (Some("done".into()), Some(t.w.alpha.id.to_string()))
    );
    let a2 = t.status("alpha", &t.ann).await;
    assert_eq!(a2["onboarding"], "restricted");
    assert_eq!(a2["requirementsDue"], 1);
    let b2 = t.status("beta", &t.bob).await;
    assert_eq!(b2, b, "beta is untouched");

    // Rows as a webhook would have stored them, still queued when the
    // run comes: one of alpha's own from before it disconnected, and one
    // for alpha's account wrongly filed under beta. Neither is run:
    // an organisation only runs events of the account it holds now.
    ok(&t.w, "POST", "/api/t/alpha/stripe/disconnect", &t.ann, None).await;
    let reads = t.fake.calls("GET /v1/accounts");
    t.w.store
        .platform()
        .with_write(|tx| {
            for (id, tenant) in [("evt_late", &t.w.alpha.id), ("evt_misfiled", &t.w.beta.id)] {
                tx.execute(
                    "INSERT INTO stripe_events (id, account_id, tenant_id, type, created, body,
                         received_at)
                     VALUES (?1, ?2, ?3, 'account.updated', 0, '{}', 0)",
                    rusqlite::params![id, acct_a, tenant.as_str()],
                )?;
            }
            Ok::<_, store::StoreError>(())
        })
        .unwrap();
    t.settle().await;
    assert_eq!(
        t.event("evt_late"),
        (Some("not_connected".into()), Some(t.w.alpha.id.to_string()))
    );
    assert_eq!(t.event("evt_misfiled").0.as_deref(), Some("not_connected"));
    assert_eq!(
        t.fake.calls("GET /v1/accounts"),
        reads,
        "Stripe never asked"
    );
    assert_eq!(t.status("beta", &t.bob).await, b);
    assert_ne!(acct_a, acct_b);

    // And one that arrives after the disconnect is filed as kept at once.
    let sim = t.simulate(acct_a, json!({ "charges_enabled": true })).await;
    assert_eq!(
        t.event(sim["event"].as_str().unwrap()),
        (Some("not_connected".into()), Some(t.w.alpha.id.to_string()))
    );
}

#[tokio::test]
async fn events_out_of_order_end_in_the_same_state() {
    // Stripe promises no order. Three changes to one account, delivered
    // in order in one world and reversed in another: the same state.
    let mut ends = Vec::new();
    for reverse in [false, true] {
        let t = setup().await;
        let s = t.connect("alpha", &t.ann).await;
        let account = s["accountId"].as_str().unwrap();
        t.fake_post("simulate/webhooks/hold").await;
        for patch in [
            json!({ "charges_enabled": false, "currently_due": ["company.tax_id"],
                "disabled_reason": "requirements.past_due" }),
            json!({ "payouts_enabled": false }),
            json!({ "charges_enabled": true, "currently_due": [], "disabled_reason": null }),
        ] {
            t.simulate(account, patch).await;
        }
        let path = if reverse {
            "simulate/webhooks/release?reverse=true"
        } else {
            "simulate/webhooks/release"
        };
        let released = t.fake_post(path).await;
        assert_eq!(released["events"], 3);
        assert_eq!(released["delivered"], true);
        t.settle().await;
        let mut s = t.status("alpha", &t.ann).await;
        for volatile in ["accountId", "connectedAt", "connectedBy", "statusAt"] {
            s[volatile] = Value::Null;
        }
        ends.push(s);
    }
    assert_eq!(ends[0], ends[1]);
    // And it is the account's last state, not the last event to arrive.
    assert_eq!(ends[0]["chargesEnabled"], true);
    assert_eq!(ends[0]["payoutsEnabled"], false);
    assert_eq!(ends[0]["requirementsDue"], 0);
    assert_eq!(ends[0]["disabledReason"], Value::Null);
}

#[tokio::test]
async fn stripe_failing_mid_run_keeps_the_event_and_it_runs_later() {
    let t = setup().await;
    let s = t.connect("alpha", &t.ann).await;
    let account = s["accountId"].as_str().unwrap();
    // Stripe is down when the event's account is read.
    t.outage(100, 503, "/v1/accounts").await;
    let sim = t
        .simulate(account, json!({ "charges_enabled": false }))
        .await;
    let id = sim["event"].as_str().unwrap();
    assert_eq!(sim["delivered"], true, "taken all the same");
    t.settle().await;
    assert_eq!(t.event(id).0, None, "still queued");
    assert_eq!(t.status("alpha", &t.ann).await["chargesEnabled"], true);
    assert_eq!(t.status("alpha", &t.ann).await["failedEvents"], 0);

    // Back up: it waits out its backoff, then runs.
    t.outage(0, 0, "").await;
    t.settle().await;
    assert_eq!(t.event(id).0, None, "backing off");
    t.w.store
        .platform()
        .with_write(|tx| {
            tx.execute("UPDATE stripe_events SET next_attempt_at = 0", [])?;
            Ok::<_, store::StoreError>(())
        })
        .unwrap();
    t.settle().await;
    assert_eq!(t.event(id).0.as_deref(), Some("done"));
    assert_eq!(t.status("alpha", &t.ann).await["chargesEnabled"], false);

    // One Stripe refuses for good is parked and counted, and can be put
    // back.
    t.outage(1, 400, "/v1/accounts").await;
    let sim = t
        .simulate(account, json!({ "charges_enabled": true }))
        .await;
    let id = sim["event"].as_str().unwrap();
    t.settle().await;
    assert_eq!(t.event(id).0.as_deref(), Some("failed"));
    assert_eq!(t.status("alpha", &t.ann).await["failedEvents"], 1);
    assert_eq!(
        api::stripe::process::requeue_failed(&t.w.store, &t.w.alpha.id).unwrap(),
        1
    );
    t.settle().await;
    assert_eq!(t.event(id).0.as_deref(), Some("done"));
    assert_eq!(t.status("alpha", &t.ann).await["chargesEnabled"], true);
    assert_eq!(t.status("alpha", &t.ann).await["failedEvents"], 0);
}

#[tokio::test]
async fn stripe_refusing_our_key_never_parks_an_event() {
    // A rolled key (401) or a restricted key missing a permission (403)
    // is our fault, not the event's, and hits every group at once: the
    // events wait, however long, and run when the key is put right.
    for status in [401, 403] {
        let t = setup().await;
        let s = t.connect("alpha", &t.ann).await;
        let account = s["accountId"].as_str().unwrap();
        t.outage(1000, status, "/v1/accounts/").await;
        let sim = t
            .simulate(account, json!({ "charges_enabled": false }))
            .await;
        let id = sim["event"].as_str().unwrap();
        t.settle().await;
        assert_eq!(t.event(id).0, None, "{status}: still queued");

        // Long past the tries that park any other failure.
        let tries = api::stripe::process::MAX_ATTEMPTS + 10;
        let again = |attempts: i64| {
            t.w.store
                .platform()
                .with_write(|tx| {
                    tx.execute(
                        "UPDATE stripe_events SET next_attempt_at = 0, attempts = ?1
                         WHERE processed_at IS NULL",
                        [attempts],
                    )?;
                    Ok::<_, store::StoreError>(())
                })
                .unwrap()
        };
        again(tries);
        t.settle().await;
        assert_eq!(t.event(id).0, None, "{status}: never parked");
        assert_eq!(t.status("alpha", &t.ann).await["failedEvents"], 0);
        assert_eq!(t.status("alpha", &t.ann).await["chargesEnabled"], true);

        // The key mended: it runs.
        t.outage(0, 0, "").await;
        again(tries);
        t.settle().await;
        assert_eq!(t.event(id).0.as_deref(), Some("done"), "{status}");
        assert_eq!(t.status("alpha", &t.ann).await["chargesEnabled"], false);
    }
}

#[tokio::test]
async fn handled_events_are_purged_and_kept_ones_stay() {
    let t = setup().await;
    let s = t.connect("alpha", &t.ann).await;
    let account = s["accountId"].as_str().unwrap();
    let done = t
        .simulate(account, json!({ "payouts_enabled": false }))
        .await;
    t.settle().await;
    ok(&t.w, "POST", "/api/t/alpha/stripe/disconnect", &t.ann, None).await;
    let kept = t
        .simulate(account, json!({ "payouts_enabled": true }))
        .await;
    let long_after = contracts::now_ms() + api::stripe::process::KEEP_HANDLED_MS + 1000;
    api::stripe::process::purge(&t.w.store, long_after).unwrap();
    let left: Vec<String> =
        t.w.store
            .platform()
            .with_read(|c| {
                Ok::<_, store::StoreError>(
                    c.prepare("SELECT id FROM stripe_events")?
                        .query_map([], |r| r.get(0))?
                        .collect::<rusqlite::Result<_>>()?,
                )
            })
            .unwrap();
    assert_eq!(left, [kept["event"].as_str().unwrap().to_owned()]);
    assert!(!left.contains(&done["event"].as_str().unwrap().to_owned()));
}
