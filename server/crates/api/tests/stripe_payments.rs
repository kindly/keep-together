//! Stripe processing (`api::stripe::payments`, `catchup`; plan stripe.sv
//! S3) against the fake on a real port: a paid session becomes a payment,
//! a contact, a gift, a declaration and a match; an unpaid, declined or
//! expired one makes no gift; refunds and disputes follow on the same
//! gift; the staff queue and its match route (two orgs: B never sees A);
//! events in any order; the daily catch-up; retention.

mod common;
mod stripe_world;

use std::sync::Arc;

use api::stripe::{catchup, payments, process};
use axum::http::StatusCode;
use contracts::{ContractError, Ctx, Source, command_group};
use giving::stripe::{self as cards, DeclarationScope, DonorForm, SubmissionGiftAid};
use rusqlite::Connection;
use serde_json::{Value, json};
use sources::SourceCodePayload;
use store::OrgDb;
use stripe_world::{T, ok, setup};

const DAY: i64 = 86_400_000;

/// Both groups connected, each with a donation page taking gifts to its
/// own source code.
struct P {
    t: T,
    a: Arc<OrgDb>,
    b: Arc<OrgDb>,
    acct_a: String,
    acct_b: String,
    code_a: String,
    code_b: String,
}

fn tx<T>(db: &OrgDb, f: impl FnOnce(&Ctx) -> Result<T, ContractError>) -> T {
    contracts::transact(db, Some(1), f).unwrap()
}

fn read<T>(db: &OrgDb, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> T {
    db.read(|c| f(c)).unwrap()
}

fn count(db: &OrgDb, table: &str) -> i64 {
    read(db, |c| {
        c.query_row(
            &format!("SELECT count(*) FROM {table} /* any status: a test's count */"),
            [],
            |r| r.get(0),
        )
    })
}

fn code(db: &OrgDb, detail: &str) -> String {
    let category = read(db, sources::tree)
        .into_iter()
        .find(|p| p.parent_id.is_none())
        .unwrap()
        .id;
    tx(db, |ctx| {
        sources::create_part(
            ctx,
            SourceCodePayload {
                parent_id: Some(category),
                name: detail.into(),
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
    .unwrap()
}

/// A contact with one email address.
fn contact(db: &OrgDb, first: &str, last: &str, email: &str) -> String {
    tx(db, |ctx| {
        let group = command_group(ctx, "a test's contact")?;
        let made = contacts::donors::create_contact(
            ctx,
            contacts::types::Details {
                client_key: None,
                kind: contacts::types::Kind::Individual,
                title: String::new(),
                first_name: first.into(),
                last_name: last.into(),
                nickname: String::new(),
                name: String::new(),
                birth_date: None,
                is_deceased: false,
                deceased_date: None,
            },
            None,
            Source::Ui,
            &group,
        )?;
        contacts::donors::add_first_email(ctx, &made.id, email, Source::Ui, &group)?;
        Ok(made.id)
    })
}

fn jane(amount: i64, gift_aid: bool) -> DonorForm {
    DonorForm {
        amount,
        first_name: "Jane".into(),
        last_name: "Smith".into(),
        email: "jane@example.org".into(),
        gift_aid: gift_aid.then(|| SubmissionGiftAid {
            scope: DeclarationScope::FutureAndPast4y,
            wording_version: "hmrc-2016-04".into(),
            address_line1: "12 High Street".into(),
            postcode: "AB1 2CD".into(),
        }),
    }
}

/// What the donor's page does before Stripe: the submission stored (at
/// `at`), and its Checkout Session's id on it. `(submission, session)`.
fn submit_at(db: &OrgDb, form: DonorForm, at: i64) -> (String, String) {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let session = format!("cs_test_{id}");
    contracts::transact(db, None, |ctx| {
        let ctx = Ctx {
            tx: ctx.tx,
            actor: None,
            at,
        };
        cards::submit(&ctx, &id, form, true)?;
        cards::set_checkout_session(&ctx, &id, &session)
    })
    .unwrap();
    (id, session)
}

fn submit(db: &OrgDb, form: DonorForm) -> (String, String) {
    submit_at(db, form, contracts::now_ms())
}

/// One gift row as the tests read it.
#[derive(Debug, PartialEq)]
struct Gift {
    id: String,
    contact: String,
    amount: i64,
    status: String,
    method: String,
    provider: Option<String>,
    payment: Option<String>,
    date: String,
}

fn gifts(db: &OrgDb) -> Vec<Gift> {
    read(db, |c| {
        c.prepare(
            "SELECT id, contact_id, amount, status, method, provider, provider_payment_id,
                    received_on
             FROM gifts ORDER BY seq /* any status: a test reads every gift */",
        )?
        .query_map([], |r| {
            Ok(Gift {
                id: r.get(0)?,
                contact: r.get(1)?,
                amount: r.get(2)?,
                status: r.get(3)?,
                method: r.get(4)?,
                provider: r.get(5)?,
                payment: r.get(6)?,
                date: r.get(7)?,
            })
        })?
        .collect()
    })
}

fn today() -> String {
    giftaid::uk_date(contracts::now_ms())
}

async fn world() -> P {
    let t = setup().await;
    let acct_a = t.connect("alpha", &t.ann).await["accountId"]
        .as_str()
        .unwrap()
        .to_owned();
    let acct_b = t.connect("beta", &t.bob).await["accountId"]
        .as_str()
        .unwrap()
        .to_owned();
    let a = t.w.store.org(&t.w.alpha.id).unwrap();
    let b = t.w.store.org(&t.w.beta.id).unwrap();
    let mut codes = Vec::new();
    for db in [&a, &b] {
        tx(db, api::schema::seed_new_org);
        let code = code(db, "Donation page");
        tx(db, |ctx| {
            cards::save_page(
                ctx,
                cards::DonationPagePayload {
                    source_code_id: Some(code.clone()),
                    ..cards::DonationPagePayload::default()
                },
                None,
                Source::Ui,
            )
        });
        codes.push(code);
    }
    let code_b = codes.pop().unwrap();
    let code_a = codes.pop().unwrap();
    P {
        t,
        a,
        b,
        acct_a,
        acct_b,
        code_a,
        code_b,
    }
}

impl P {
    /// A Checkout Session's event as S4's fake (and Stripe) send it.
    fn session_event(
        &self,
        account: &str,
        kind: &str,
        session: &str,
        submission: &str,
        intent: Option<&str>,
    ) -> Value {
        let expired = kind == "checkout.session.expired";
        self.t.fake.event(
            account,
            kind,
            json!({
                "id": session, "object": "checkout.session",
                "status": if expired { "expired" } else { "complete" },
                "payment_status": if expired { "unpaid" } else { "paid" },
                "payment_intent": intent, "currency": "gbp",
                "client_reference_id": submission,
                "metadata": { "keep_submission": submission }
            }),
        )
    }

    /// The donor pays on Stripe's page: the PaymentIntent's id, once its
    /// `checkout.session.completed` has been delivered and run.
    async fn pay(&self, account: &str, submission: &(String, String), amount: i64) -> String {
        let intent = self.t.fake.pay(account, amount, "gbp", Some(&submission.0));
        let id = intent["id"].as_str().unwrap().to_owned();
        let event = self.session_event(
            account,
            "checkout.session.completed",
            &submission.1,
            &submission.0,
            Some(&id),
        );
        assert!(self.t.fake.deliver(vec![event]).await);
        self.t.settle().await;
        id
    }

    async fn deliver(&self, event: Option<Value>) -> String {
        let event = event.expect("the fake made no event");
        let id = event["id"].as_str().unwrap().to_owned();
        assert!(self.t.fake.deliver(vec![event]).await);
        self.t.settle().await;
        id
    }

    fn record(&self, db: &OrgDb, intent: &str) -> cards::PaymentRecord {
        read(db, |c| cards::payment_by_stripe_id(c, intent)).expect("no payment row")
    }

    async fn queue(&self, slug: &str, cookie: &str) -> Value {
        ok(
            &self.t.w,
            "GET",
            &format!("/api/t/{slug}/stripe/unmatched"),
            cookie,
            None,
        )
        .await
    }

    fn consistent(&self, db: &OrgDb) {
        assert_eq!(read(db, cards::consistency), Vec::<String>::new());
        assert_eq!(read(db, giving::regular::consistency), Vec::<String>::new());
    }
}

// ── never optimistic ───────────────────────────────────────────────────────

#[tokio::test]
async fn a_submission_alone_a_declined_card_and_an_expired_session_make_no_gift() {
    let p = world().await;
    let contacts = count(&p.a, "contacts");
    let s = submit(&p.a, jane(2500, true));
    assert_eq!(count(&p.a, "gifts"), 0, "a submission is not a gift");

    // The card is declined: Stripe's payment is on record, failed, and
    // nothing else is made.
    let declined = p.t.fake.decline(&p.acct_a, 2500, "gbp", Some(&s.0));
    let pi = declined["id"].as_str().unwrap().to_owned();
    let event =
        p.t.fake
            .event(&p.acct_a, "payment_intent.payment_failed", declined);
    let failed = p.deliver(Some(event)).await;
    assert_eq!(p.t.event(&failed).0.as_deref(), Some("recorded"));
    let row = p.record(&p.a, &pi);
    assert_eq!(row.payment.status, cards::StripePaymentStatus::Failed);
    assert_eq!(row.payment.reason.as_deref(), Some("insufficient_funds"));
    assert_eq!(row.payment.submission_id.as_deref(), Some(s.0.as_str()));
    assert_eq!(row.matched, cards::StripePaymentMatchPayload::default());
    assert_eq!(count(&p.a, "gifts"), 0);
    assert_eq!(count(&p.a, "contacts"), contacts);
    assert_eq!(p.queue("alpha", &p.t.ann).await, json!([]));

    // The session runs out: the submission is expired, still no gift.
    let event = p.session_event(&p.acct_a, "checkout.session.expired", &s.1, &s.0, None);
    let expired = p.deliver(Some(event)).await;
    assert_eq!(p.t.event(&expired).0.as_deref(), Some("expired"));
    let held = read(&p.a, |c| cards::submission(c, &s.0)).unwrap();
    assert_eq!(held.outcome.state, cards::SubmissionStatus::Expired);
    assert_eq!(count(&p.a, "gifts"), 0);
    assert_eq!(count(&p.a, "gift_aid_declarations"), 0);
    // An expired session nobody here made is nobody's.
    let event = p.session_event(
        &p.acct_a,
        "checkout.session.expired",
        "cs_test_unknown",
        "0000",
        None,
    );
    let unknown = p.deliver(Some(event)).await;
    assert_eq!(p.t.event(&unknown).0.as_deref(), Some("unknown_resource"));
    p.consistent(&p.a);
}

// ── a paid session ─────────────────────────────────────────────────────────

#[tokio::test]
async fn a_paid_session_makes_the_contact_the_gift_the_declaration_and_the_match_in_one_group() {
    let p = world().await;
    let s = submit(&p.a, jane(2500, true));
    let pi = p.pay(&p.acct_a, &s, 2500).await;

    // The gift: card, Stripe's, completed, dated today, to the page's code.
    let all = gifts(&p.a);
    let [gift] = all.as_slice() else {
        panic!("{all:?}")
    };
    assert_eq!(
        (gift.amount, gift.status.as_str(), gift.method.as_str()),
        (2500, "completed", "card")
    );
    assert_eq!(gift.provider.as_deref(), Some("stripe"));
    assert_eq!(gift.payment.as_deref(), Some(pi.as_str()));
    assert_eq!(gift.date, today());
    let view = read(&p.a, |c| giving::get(c, &gift.id)).unwrap();
    assert_eq!(view.gift.allocations.len(), 1);
    assert_eq!(view.gift.allocations[0].source_code_id, p.code_a);

    // The new contact: the donor's name, email and home address.
    let donor = read(&p.a, |c| contacts::donors::describe_donor(c, &gift.contact)).unwrap();
    assert_eq!(
        (donor.first_name.as_str(), donor.last_name.as_str()),
        ("Jane", "Smith")
    );
    assert_eq!(donor.home.postcode, "AB1 2CD");
    assert_eq!(
        donor.acquisition_code_id.as_deref(),
        Some(p.code_a.as_str())
    );
    let found = read(&p.a, |c| contacts::donors::by_email(c, "JANE@example.org"));
    assert_eq!(found.contacts.len(), 1);

    // The donor's declaration: on screen by the donor, dated the day they
    // ticked it, covering the gift.
    let covering = read(&p.a, |c| {
        giftaid::coverage(c, &gift.contact, &gift.date, Some(&gift.id))
    })
    .expect("the gift is covered");
    assert_eq!(covering.method, giftaid::types::Method::OnScreenByDonor);
    assert_eq!(covering.made_on, today());

    // The match and the submission.
    let row = p.record(&p.a, &pi);
    assert_eq!(
        row.matched.contact_id.as_deref(),
        Some(gift.contact.as_str())
    );
    assert_eq!(row.matched.gift_id.as_deref(), Some(gift.id.as_str()));
    assert_eq!(row.matched.first_name_typed, None);
    let held = read(&p.a, |c| cards::submission(c, &s.0)).unwrap();
    assert_eq!(held.outcome.state, cards::SubmissionStatus::Paid);
    assert_eq!(
        held.outcome.stripe_payment_id.as_deref(),
        Some(row.id.as_str())
    );

    // One command group, the system's, for all of it.
    let groups: Vec<(String, Option<i64>, i64)> = read(&p.a, |c| {
        c.prepare(
            "SELECT group_name, actor, count(*) FROM revisions
             WHERE contract IN ('giving.gift', 'giving.status', 'giving.stripePayment',
                 'giving.stripePaymentMatch', 'giftaid.declaration', 'contacts.details',
                 'contacts.methods', 'contacts.addresses')
               AND at >= (SELECT min(at) FROM revisions WHERE contract = 'giving.stripePayment')
             GROUP BY group_id",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect()
    });
    assert_eq!(groups.len(), 1, "{groups:?}");
    assert_eq!(
        (groups[0].0.as_str(), groups[0].1),
        ("stripe.donation", None)
    );
    assert!(groups[0].2 >= 8, "{groups:?}");

    // Nothing in B's file.
    assert_eq!(count(&p.b, "gifts"), 0);
    assert_eq!(count(&p.b, "stripe_payments"), 0);
    p.consistent(&p.a);

    // Heard again (Stripe repeats itself, and sends the intent's own
    // event too): one gift, one contact, one declaration, and nothing
    // written.
    let revisions = count(&p.a, "revisions");
    let groups_before = count(&p.a, "command_groups");
    let again = p.session_event(
        &p.acct_a,
        "checkout.session.completed",
        &s.1,
        &s.0,
        Some(&pi),
    );
    let done = p.deliver(Some(again)).await;
    assert_eq!(p.t.event(&done).0.as_deref(), Some("done"));
    let intent = p.t.fake.payment(&pi).unwrap();
    let event =
        p.t.fake
            .event(&p.acct_a, "payment_intent.succeeded", intent);
    p.deliver(Some(event)).await;
    assert_eq!(count(&p.a, "gifts"), 1);
    assert_eq!(count(&p.a, "gift_aid_declarations"), 1);
    assert_eq!(count(&p.a, "revisions"), revisions);
    assert_eq!(
        count(&p.a, "command_groups"),
        groups_before,
        "no empty group"
    );
}

#[tokio::test]
async fn gift_aid_not_ticked_makes_no_declaration_and_a_second_tick_adds_one() {
    let p = world().await;
    let first = submit(&p.a, jane(1000, false));
    p.pay(&p.acct_a, &first, 1000).await;
    assert_eq!(count(&p.a, "gifts"), 1);
    assert_eq!(count(&p.a, "gift_aid_declarations"), 0);
    // The donor gives again and ticks Gift Aid: the same contact (their
    // email, their last name), and their declaration.
    let second = submit(&p.a, jane(2000, true));
    p.pay(&p.acct_a, &second, 2000).await;
    let all = gifts(&p.a);
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].contact, all[1].contact);
    assert_eq!(count(&p.a, "gift_aid_declarations"), 1);
    // And once more, already covered by an enduring declaration: the new
    // one is kept all the same (human, 2026-11-21).
    let third = submit(&p.a, jane(3000, true));
    p.pay(&p.acct_a, &third, 3000).await;
    assert_eq!(count(&p.a, "gifts"), 3);
    assert_eq!(count(&p.a, "gift_aid_declarations"), 2);
    assert_eq!(count(&p.a, "contacts"), 1);
    p.consistent(&p.a);
}

// ── matching and the staff queue ───────────────────────────────────────────

#[tokio::test]
async fn one_contact_with_the_email_and_last_name_is_linked_and_a_different_first_name_marked() {
    let p = world().await;
    let john = contact(&p.a, "John", "SMITH", "Jane@Example.org");
    let s = submit(&p.a, jane(2500, true));
    let pi = p.pay(&p.acct_a, &s, 2500).await;
    let all = gifts(&p.a);
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].contact, john);
    assert_eq!(count(&p.a, "contacts"), 1, "no new contact");
    let row = p.record(&p.a, &pi);
    assert_eq!(row.matched.first_name_typed.as_deref(), Some("Jane"));
    // The declaration is in the name the donor typed, on John's record.
    let name: String = read(&p.a, |c| {
        c.query_row(
            "SELECT first_name FROM gift_aid_declarations WHERE contact_id = ?1",
            [&john],
            |r| r.get(0),
        )
    });
    assert_eq!(name, "Jane");
    // John had no address: he has the one the donor typed.
    let donor = read(&p.a, |c| contacts::donors::describe_donor(c, &john)).unwrap();
    assert_eq!(donor.home.postcode, "AB1 2CD");
    assert_eq!(p.queue("alpha", &p.t.ann).await, json!([]));
    p.consistent(&p.a);
}

#[tokio::test]
async fn an_unmatched_payment_waits_in_the_queue_and_staff_match_it() {
    let p = world().await;
    // Two contacts share the email: ambiguous. Another last name: differs.
    let jane_s = contact(&p.a, "Jane", "Smith", "jane@example.org");
    contact(&p.a, "Janet", "Smith", "jane@example.org");
    let jo = contact(&p.a, "Jo", "Jones", "jo@example.org");
    let ambiguous = submit(&p.a, jane(2500, true));
    let pi_1 = p.pay(&p.acct_a, &ambiguous, 2500).await;
    let differs = submit(
        &p.a,
        DonorForm {
            email: "jo@example.org".into(),
            ..jane(1500, false)
        },
    );
    let pi_2 = p.pay(&p.acct_a, &differs, 1500).await;
    // Stripe took the money, so the submissions are paid; but no gift, no
    // declaration, no new contact.
    assert_eq!(count(&p.a, "gifts"), 0);
    assert_eq!(count(&p.a, "gift_aid_declarations"), 0);
    assert_eq!(count(&p.a, "contacts"), 3);
    for s in [&ambiguous, &differs] {
        let held = read(&p.a, |c| cards::submission(c, &s.0)).unwrap();
        assert_eq!(held.outcome.state, cards::SubmissionStatus::Paid);
    }
    p.consistent(&p.a);

    // The queue, newest first, for any member of alpha; never beta's.
    let queue = p.queue("alpha", &p.t.val).await;
    let rows = queue.as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["paymentId"], pi_2.as_str());
    assert_eq!(rows[0]["reason"], "name_differs");
    assert_eq!(rows[0]["candidates"][0]["id"], jo.as_str());
    assert_eq!(rows[1]["reason"], "ambiguous");
    assert_eq!(rows[1]["amount"], 2500);
    assert_eq!(rows[1]["donor"]["firstName"], "Jane");
    assert_eq!(rows[1]["donor"]["giftAid"], true);
    assert_eq!(rows[1]["sourceCodeId"], p.code_a.as_str());
    assert_eq!(rows[1]["candidates"].as_array().unwrap().len(), 2);
    assert_eq!(p.queue("beta", &p.t.bob).await, json!([]));

    let id = rows[1]["id"].as_str().unwrap().to_owned();
    let version = rows[1]["matchVersion"].as_i64().unwrap();
    let path = |slug: &str| format!("/api/t/{slug}/stripe/unmatched/{id}/match");
    let body = |expected: i64, contact: &str| json!({ "expected": expected, "contactId": contact });
    // A's payment under B's slug is not found, whoever asks; a viewer
    // can't match; someone who isn't a member can't reach alpha.
    let (status, _) =
        p.t.w
            .call(
                "POST",
                &path("beta"),
                &p.t.bob,
                Some(body(version, &jane_s)),
            )
            .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) =
        p.t.w
            .call(
                "POST",
                &path("alpha"),
                &p.t.val,
                Some(body(version, &jane_s)),
            )
            .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) =
        p.t.w
            .call(
                "POST",
                &path("alpha"),
                &p.t.bob,
                Some(body(version, &jane_s)),
            )
            .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) =
        p.t.w
            .call("GET", "/api/t/alpha/stripe/unmatched", &p.t.bob, None)
            .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // A stale version, a contact that isn't alpha's.
    let (status, out) =
        p.t.w
            .call(
                "POST",
                &path("alpha"),
                &p.t.sam,
                Some(body(version + 1, &jane_s)),
            )
            .await;
    assert_eq!(
        (status, out["kind"].as_str()),
        (StatusCode::CONFLICT, Some("stale"))
    );
    let theirs = contact(&p.b, "Jane", "Smith", "jane@example.org");
    let (status, out) =
        p.t.w
            .call(
                "POST",
                &path("alpha"),
                &p.t.sam,
                Some(body(version, &theirs)),
            )
            .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(out["reason"], "unknown_contact");
    assert_eq!(count(&p.a, "gifts"), 0, "a refused match leaves nothing");

    // Staff match it: the contact's gift, as Stripe has the payment, and
    // the donor's declaration.
    let (status, out) =
        p.t.w
            .call(
                "POST",
                &path("alpha"),
                &p.t.sam,
                Some(body(version, &jane_s)),
            )
            .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["gift"]["status"], "completed");
    let all = gifts(&p.a);
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].id, out["giftId"].as_str().unwrap());
    assert_eq!(
        (all[0].contact.as_str(), all[0].amount),
        (jane_s.as_str(), 2500)
    );
    assert_eq!(all[0].payment.as_deref(), Some(pi_1.as_str()));
    assert_eq!(count(&p.a, "gift_aid_declarations"), 1);
    let row = p.record(&p.a, &pi_1);
    assert_eq!(row.matched.unmatched, None);
    assert_eq!(row.matched.gift_id.as_deref(), Some(all[0].id.as_str()));
    // Sam matched it: the gift is theirs to answer for.
    let by: Option<i64> = read(&p.a, |c| {
        c.query_row(
            "SELECT entered_by FROM gifts WHERE id = ?1 /* any status: one gift */",
            [&all[0].id],
            |r| r.get(0),
        )
    });
    assert!(by.is_some());
    // Again: already matched.
    let (status, out) =
        p.t.w
            .call(
                "POST",
                &path("alpha"),
                &p.t.sam,
                Some(body(row.match_version, &jane_s)),
            )
            .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(out["reason"], "already_matched");
    assert_eq!(
        p.queue("alpha", &p.t.ann).await.as_array().unwrap().len(),
        1
    );
    assert_eq!(count(&p.b, "gifts"), 0);
    p.consistent(&p.a);

    // The gift follows its payment from here like any other.
    p.deliver(p.t.fake.refund(&pi_1, None)).await;
    assert_eq!(gifts(&p.a)[0].status, "refunded");
    p.consistent(&p.a);
}

#[tokio::test]
async fn a_payment_with_no_submission_is_queued_and_needs_a_source_code_to_match() {
    let p = world().await;
    let jo = contact(&p.a, "Jo", "Jones", "jo@example.org");
    // Taken some other way on the group's Stripe account.
    let out =
        p.t.http
            .post(format!(
                "{}/api/fake-stripe/simulate/accounts/{}/payment",
                p.t.base, p.acct_a
            ))
            .json(&json!({ "amount": 4000 }))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
    p.t.settle().await;
    assert_eq!(
        p.t.event(out["event"].as_str().unwrap()).0.as_deref(),
        Some("unmatched")
    );
    let queue = p.queue("alpha", &p.t.sam).await;
    assert_eq!(queue[0]["reason"], "no_submission");
    assert_eq!(queue[0]["donor"], Value::Null);
    assert_eq!(queue[0]["sourceCodeId"], Value::Null);
    let id = queue[0]["id"].as_str().unwrap();
    let path = format!("/api/t/alpha/stripe/unmatched/{id}/match");
    let version = queue[0]["matchVersion"].as_i64().unwrap();
    let (status, out) =
        p.t.w
            .call(
                "POST",
                &path,
                &p.t.sam,
                Some(json!({ "expected": version, "contactId": jo })),
            )
            .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{out}");
    assert_eq!(out["problems"][0]["field"], "sourceCodeId");
    // B's code is not a code here.
    let (status, out) =
        p.t.w
            .call(
                "POST",
                &path,
                &p.t.sam,
                Some(json!({ "expected": version, "contactId": jo, "sourceCodeId": p.code_b })),
            )
            .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(out["reason"], "unknown_source_code");
    let (status, out) =
        p.t.w
            .call(
                "POST",
                &path,
                &p.t.sam,
                Some(json!({ "expected": version, "contactId": jo, "sourceCodeId": p.code_a })),
            )
            .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    let all = gifts(&p.a);
    assert_eq!(
        (all[0].contact.as_str(), all[0].amount),
        (jo.as_str(), 4000)
    );
    assert_eq!(count(&p.a, "gift_aid_declarations"), 0);
    p.consistent(&p.a);
}

// ── refunds and disputes ───────────────────────────────────────────────────

#[tokio::test]
async fn a_payment_refunded_then_disputed_is_one_gift_changing_status() {
    let p = world().await;
    let s = submit(&p.a, jane(2500, false));
    let pi = p.pay(&p.acct_a, &s, 2500).await;
    let gift = gifts(&p.a).remove(0);

    // Part refunded: completed, at what the group kept.
    p.deliver(p.t.fake.refund(&pi, Some(1000))).await;
    let now = gifts(&p.a);
    assert_eq!(now.len(), 1);
    assert_eq!(
        (now[0].id.as_str(), now[0].amount),
        (gift.id.as_str(), 1500)
    );
    assert_eq!(now[0].status, "completed");
    let view = read(&p.a, |c| giving::get(c, &gift.id)).unwrap();
    assert_eq!(view.gift.allocations[0].amount, 1500);
    assert_eq!(p.record(&p.a, &pi).payment.refunded_amount, 1000);
    p.consistent(&p.a);

    // Disputed: charged back, with Stripe's reason. Lost: it stays.
    p.deliver(p.t.fake.dispute(&pi)).await;
    assert_eq!(gifts(&p.a)[0].status, "charged_back");
    let reason: Option<String> = read(&p.a, |c| {
        c.query_row(
            "SELECT void_reason FROM gifts WHERE id = ?1 /* any status: one gift */",
            [&gift.id],
            |r| r.get(0),
        )
    });
    assert_eq!(reason.as_deref(), Some("Disputed (Stripe): fraudulent"));
    p.consistent(&p.a);
    p.deliver(p.t.fake.close_dispute(&pi, false)).await;
    assert_eq!(gifts(&p.a)[0].status, "charged_back");
    assert_eq!(
        p.record(&p.a, &pi).payment.dispute,
        Some(cards::DisputeState::Lost)
    );

    // The rest refunded: refunded, the gift keeping its last amount.
    p.deliver(p.t.fake.refund(&pi, None)).await;
    let now = gifts(&p.a);
    assert_eq!(now.len(), 1, "one gift for the payment's whole life");
    assert_eq!(now[0].status, "refunded");
    assert_eq!(count(&p.a, "stripe_payments"), 1);
    assert_eq!(
        read(&p.a, |c| giving::received_total(
            c,
            "2000-01-01",
            "2999-01-01"
        )),
        0
    );
    p.consistent(&p.a);
}

#[tokio::test]
async fn a_dispute_the_group_wins_is_completed_again() {
    let p = world().await;
    let s = submit(&p.a, jane(2500, false));
    let pi = p.pay(&p.acct_a, &s, 2500).await;
    p.deliver(p.t.fake.dispute(&pi)).await;
    assert_eq!(gifts(&p.a)[0].status, "charged_back");
    p.deliver(p.t.fake.close_dispute(&pi, true)).await;
    let now = gifts(&p.a);
    assert_eq!((now[0].status.as_str(), now[0].amount), ("completed", 2500));
    p.consistent(&p.a);
}

#[tokio::test]
async fn a_partial_refund_on_a_claimed_gift_keeps_its_amount_and_is_flagged() {
    let p = world().await;
    let s = submit(&p.a, jane(2500, true));
    let pi = p.pay(&p.acct_a, &s, 2500).await;
    let gift = gifts(&p.a).remove(0);
    let claim = "0190f0c0a0b0c0d0e0f0a0b0c0d0e0c1";
    tx(&p.a, |ctx| {
        let group = command_group(ctx, "a test's claim")?;
        giving::lock_for_claim(ctx, &gift.id, claim, Source::Ui, &group)
    });
    p.deliver(p.t.fake.refund(&pi, Some(500))).await;
    let now = gifts(&p.a);
    assert_eq!((now[0].amount, now[0].status.as_str()), (2500, "completed"));
    assert!(p.record(&p.a, &pi).matched.partial_refund_claimed);
    // A draft claim holding it is held back until staff have looked.
    assert!(read(&p.a, |c| giving::regular::payment_moved(c, &gift.id)));
    p.consistent(&p.a);
    // The claim lets it go: the gift takes what the group kept, and the
    // flag goes.
    tx(&p.a, |ctx| {
        let group = command_group(ctx, "a test's claim released")?;
        giving::release_from_claim(ctx, &gift.id, claim, Source::Ui, &group)
    });
    assert_eq!(gifts(&p.a)[0].amount, 2000);
    assert!(!p.record(&p.a, &pi).matched.partial_refund_claimed);
    assert!(!read(&p.a, |c| giving::regular::payment_moved(c, &gift.id)));
    // Refunded in full while claimed: it stops counting (the next claim
    // pays the tax back), whatever the claim holds.
    tx(&p.a, |ctx| {
        let group = command_group(ctx, "a test's claim")?;
        giving::lock_for_claim(ctx, &gift.id, claim, Source::Ui, &group)
    });
    p.deliver(p.t.fake.refund(&pi, None)).await;
    assert_eq!(gifts(&p.a)[0].status, "refunded");
    p.consistent(&p.a);
}

#[tokio::test]
async fn a_gift_staff_voided_stays_void_and_unvoiding_takes_the_payments_status() {
    let p = world().await;
    let s = submit(&p.a, jane(2500, false));
    let pi = p.pay(&p.acct_a, &s, 2500).await;
    let gift = gifts(&p.a).remove(0);
    let path = format!("/api/t/alpha/gifts/{}/status", gift.id);
    // Staff can't change what Stripe says of it…
    let view = ok(
        &p.t.w,
        "GET",
        &format!("/api/t/alpha/gifts/{}", gift.id),
        &p.t.sam,
        None,
    )
    .await;
    let (status, out) =
        p.t.w
            .call(
                "POST",
                &format!("/api/t/alpha/gifts/{}/save", gift.id),
                &p.t.sam,
                Some(json!({
                    "expected": view["giftVersion"],
                    "contactId": gift.contact, "receivedOn": gift.date, "amount": 9999,
                    "method": "card", "reference": pi,
                    "allocations": [{ "sourceCodeId": p.code_a, "amount": 9999 }]
                })),
            )
            .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{out}");
    assert_eq!(out["reason"], "direct_debit_fixed");
    // …but may void it, and the void outlives Stripe's next word.
    let (status, out) =
        p.t.w
            .call(
                "POST",
                &path,
                &p.t.sam,
                Some(json!({ "expected": view["statusVersion"], "status": "void",
                "reason": "a test" })),
            )
            .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    p.deliver(p.t.fake.refund(&pi, None)).await;
    assert_eq!(gifts(&p.a)[0].status, "void");
    p.consistent(&p.a);
    // Un-voided, it is what its payment says: refunded, not completed.
    let (status, out) =
        p.t.w
            .call(
                "POST",
                &path,
                &p.t.sam,
                Some(json!({ "expected": out["counter"], "status": "completed" })),
            )
            .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(gifts(&p.a)[0].status, "refunded");
}

// ── order, routing, money ──────────────────────────────────────────────────

#[tokio::test]
async fn events_in_any_order_end_in_the_same_state() {
    let p = world().await;
    p.t.fake_post("simulate/webhooks/hold").await;
    let s = submit(&p.a, jane(2500, true));
    let intent = p.t.fake.pay(&p.acct_a, 2500, "gbp", Some(&s.0));
    let pi = intent["id"].as_str().unwrap().to_owned();
    let mut events = vec![
        p.session_event(
            &p.acct_a,
            "checkout.session.completed",
            &s.1,
            &s.0,
            Some(&pi),
        ),
        p.t.fake
            .event(&p.acct_a, "payment_intent.succeeded", intent),
        p.t.fake.refund(&pi, Some(500)).unwrap(),
        p.t.fake.dispute(&pi).unwrap(),
        p.t.fake.close_dispute(&pi, true).unwrap(),
        // The session's late expiry notice must not undo anything.
        p.session_event(&p.acct_a, "checkout.session.expired", &s.1, &s.0, None),
    ];
    events.reverse();
    assert!(p.t.fake.deliver(events).await);
    p.t.fake_post("simulate/webhooks/release").await;
    p.t.settle().await;
    let all = gifts(&p.a);
    assert_eq!(all.len(), 1);
    assert_eq!((all[0].amount, all[0].status.as_str()), (2000, "completed"));
    assert_eq!(count(&p.a, "contacts"), 1);
    assert_eq!(count(&p.a, "gift_aid_declarations"), 1);
    let held = read(&p.a, |c| cards::submission(c, &s.0)).unwrap();
    assert_eq!(held.outcome.state, cards::SubmissionStatus::Paid);
    p.consistent(&p.a);
}

#[tokio::test]
async fn a_payment_heard_of_before_its_session_is_picked_up_when_the_session_event_lands() {
    let p = world().await;
    let s = submit(&p.a, jane(2500, false));
    // The intent carries no submission of its own (no metadata).
    let intent = p.t.fake.pay(&p.acct_a, 2500, "gbp", None);
    let pi = intent["id"].as_str().unwrap().to_owned();
    let event =
        p.t.fake
            .event(&p.acct_a, "payment_intent.succeeded", intent);
    let first = p.deliver(Some(event)).await;
    assert_eq!(p.t.event(&first).0.as_deref(), Some("unmatched"));
    assert_eq!(count(&p.a, "gifts"), 0);
    assert_eq!(
        p.queue("alpha", &p.t.ann).await[0]["reason"],
        "no_submission"
    );
    let event = p.session_event(
        &p.acct_a,
        "checkout.session.completed",
        &s.1,
        &s.0,
        Some(&pi),
    );
    let second = p.deliver(Some(event)).await;
    assert_eq!(p.t.event(&second).0.as_deref(), Some("done"));
    let all = gifts(&p.a);
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].payment.as_deref(), Some(pi.as_str()));
    assert_eq!(p.queue("alpha", &p.t.ann).await, json!([]));
    p.consistent(&p.a);
}

#[tokio::test]
async fn a_session_event_cannot_claim_a_submission_of_another_amount_or_another_payment() {
    let p = world().await;
    let s = submit(&p.a, jane(2500, false));
    // A payment of another amount naming the submission: not its payment.
    let wrong = p.t.fake.pay(&p.acct_a, 100, "gbp", Some(&s.0));
    let event = p.t.fake.event(&p.acct_a, "payment_intent.succeeded", wrong);
    p.deliver(Some(event)).await;
    assert_eq!(count(&p.a, "gifts"), 0);
    assert_eq!(
        p.queue("alpha", &p.t.ann).await[0]["reason"],
        "no_submission"
    );
    // The real one.
    let pi = p.pay(&p.acct_a, &s, 2500).await;
    assert_eq!(gifts(&p.a).len(), 1);
    // A second payment naming the same, paid, submission: queued.
    let second = p.t.fake.pay(&p.acct_a, 2500, "gbp", Some(&s.0));
    let second_id = second["id"].as_str().unwrap().to_owned();
    let event =
        p.t.fake
            .event(&p.acct_a, "payment_intent.succeeded", second);
    p.deliver(Some(event)).await;
    assert_eq!(gifts(&p.a).len(), 1);
    assert_eq!(p.record(&p.a, &second_id).payment.submission_id, None);
    assert_eq!(
        p.record(&p.a, &pi).payment.submission_id.as_deref(),
        Some(s.0.as_str())
    );
    p.consistent(&p.a);
}

#[tokio::test]
async fn an_event_for_alphas_account_never_runs_against_beta() {
    let p = world().await;
    // The same donor gives to both groups: each file gets its own.
    let sa = submit(&p.a, jane(2500, true));
    let sb = submit(&p.b, jane(1000, false));
    p.pay(&p.acct_a, &sa, 2500).await;
    assert_eq!((count(&p.a, "gifts"), count(&p.b, "gifts")), (1, 0));
    assert_eq!(count(&p.b, "contacts"), 0);
    // A's event names B's submission: B's file is never opened for it,
    // and A's has no such submission.
    let intent = p.t.fake.pay(&p.acct_a, 1000, "gbp", Some(&sb.0));
    let event =
        p.t.fake
            .event(&p.acct_a, "payment_intent.succeeded", intent);
    p.deliver(Some(event)).await;
    assert_eq!(count(&p.b, "stripe_payments"), 0);
    assert_eq!(count(&p.b, "gifts"), 0);
    let held = read(&p.b, |c| cards::submission(c, &sb.0)).unwrap();
    assert_eq!(held.outcome.state, cards::SubmissionStatus::Started);
    assert_eq!(
        p.queue("alpha", &p.t.ann).await[0]["reason"],
        "no_submission"
    );
    // B's own payment lands in B.
    p.pay(&p.acct_b, &sb, 1000).await;
    assert_eq!((count(&p.a, "gifts"), count(&p.b, "gifts")), (1, 1));
    assert_eq!(count(&p.b, "gift_aid_declarations"), 0);
    assert_eq!(p.queue("beta", &p.t.bob).await, json!([]));
    p.consistent(&p.a);
    p.consistent(&p.b);
}

#[tokio::test]
async fn a_payment_that_is_not_in_pounds_is_never_recorded() {
    let p = world().await;
    let intent = p.t.fake.pay(&p.acct_a, 2500, "eur", None);
    let event =
        p.t.fake
            .event(&p.acct_a, "payment_intent.succeeded", intent);
    let id = p.deliver(Some(event)).await;
    assert_eq!(p.t.event(&id).0.as_deref(), Some("ignored"));
    assert_eq!(count(&p.a, "stripe_payments"), 0);
    assert_eq!(count(&p.a, "gifts"), 0);
}

#[tokio::test]
async fn stripe_failing_mid_event_leaves_nothing_and_the_retry_makes_the_gift_once() {
    let p = world().await;
    let s = submit(&p.a, jane(2500, true));
    let intent = p.t.fake.pay(&p.acct_a, 2500, "gbp", Some(&s.0));
    let pi = intent["id"].as_str().unwrap().to_owned();
    p.t.outage(1, 503, "/v1/disputes").await;
    let event = p.session_event(
        &p.acct_a,
        "checkout.session.completed",
        &s.1,
        &s.0,
        Some(&pi),
    );
    let id = p.deliver(Some(event)).await;
    assert_eq!(p.t.event(&id).0, None, "still queued");
    assert_eq!(count(&p.a, "stripe_payments"), 0);
    assert_eq!(count(&p.a, "gifts"), 0);
    // Its backoff over, it runs again.
    p.t.w
        .store
        .platform()
        .with_write(|tx| {
            tx.execute("UPDATE stripe_events SET next_attempt_at = 0", [])?;
            Ok::<_, store::StoreError>(())
        })
        .unwrap();
    p.t.settle().await;
    assert_eq!(p.t.event(&id).0.as_deref(), Some("done"));
    assert_eq!(count(&p.a, "gifts"), 1);
    p.consistent(&p.a);
}

#[tokio::test]
async fn a_deauthorized_event_is_believed_only_when_stripe_agrees() {
    let p = world().await;
    // Signed, but Stripe still answers for the account: left connected.
    let event = p.t.fake.event(
        &p.acct_a,
        "account.application.deauthorized",
        json!({ "id": "ca_fake", "object": "application" }),
    );
    let id = p.deliver(Some(event)).await;
    assert_eq!(p.t.event(&id).0.as_deref(), Some("ignored"));
    let status = ok(&p.t.w, "GET", "/api/t/alpha/stripe", &p.t.ann, None).await;
    assert_eq!(status["connected"], true);
}

// ── consistency ────────────────────────────────────────────────────────────

#[tokio::test]
async fn giving_consistency_fails_when_a_row_is_tampered_with() {
    let p = world().await;
    let s = submit(&p.a, jane(2500, false));
    let pi = p.pay(&p.acct_a, &s, 2500).await;
    let gift = gifts(&p.a).remove(0);
    p.consistent(&p.a);
    let tamper = |sql: &str| {
        p.a.write_raw(|tx| tx.conn().execute_batch(sql)).unwrap();
        let found = read(&p.a, cards::consistency);
        assert_eq!(found.len(), 1, "{sql}: {found:?}");
        found.into_iter().next().unwrap()
    };
    assert_eq!(
        tamper("UPDATE gifts SET amount = 2499"),
        format!(
            "payment {pi}: gift is 2499p on {0}, payment 2500p on {0}",
            gift.date
        )
    );
    tamper("UPDATE gifts SET amount = 2500; UPDATE gifts SET status = 'failed'");
    assert!(
        tamper("UPDATE gifts SET status = 'completed'; UPDATE stripe_payments SET dispute_state = 'open'")
            .contains("payment says charged_back")
    );
    // A payment that succeeded with no gift and no place in the queue.
    assert!(
        tamper(
            "UPDATE stripe_payments SET dispute_state = NULL, contact_id = NULL, gift_id = NULL;
             DELETE FROM gift_allocation_index; DELETE FROM gift_allocations;
             DELETE FROM gifts"
        )
        .contains("in nobody's queue")
    );
}

// ── the daily catch-up ─────────────────────────────────────────────────────

#[tokio::test]
async fn the_catch_up_reads_events_no_webhook_brought_and_a_second_run_finds_none() {
    let p = world().await;
    let s = submit(&p.a, jane(2500, true));
    // Made at Stripe, never delivered.
    let intent = p.t.fake.pay(&p.acct_a, 2500, "gbp", Some(&s.0));
    let pi = intent["id"].as_str().unwrap().to_owned();
    p.session_event(
        &p.acct_a,
        "checkout.session.completed",
        &s.1,
        &s.0,
        Some(&pi),
    );
    p.t.fake.refund(&pi, Some(500)).unwrap();
    // More than a page of them (each handled type counts; these change
    // nothing), and one for beta's account.
    for _ in 0..120 {
        p.t.fake
            .update_account(&p.acct_a, &json!({ "payouts_enabled": true }));
    }
    let sb = submit(&p.b, jane(1000, false));
    let theirs = p.t.fake.pay(&p.acct_b, 1000, "gbp", Some(&sb.0));
    p.t.fake
        .event(&p.acct_b, "payment_intent.succeeded", theirs);
    assert_eq!(count(&p.a, "gifts"), 0);

    let caught = catchup::catch_up(p.t.w.store.clone(), p.t.stripe.clone())
        .await
        .unwrap();
    let alpha = caught.iter().find(|c| c.tenant == p.t.w.alpha.id).unwrap();
    assert!(alpha.read >= 122, "{alpha:?}");
    assert_eq!(alpha.missed, 122);
    let beta = caught.iter().find(|c| c.tenant == p.t.w.beta.id).unwrap();
    assert_eq!(beta.missed, 1);
    assert!(p.t.fake.calls("GET /v1/events") >= 3, "paged");
    p.t.settle().await;
    let all = gifts(&p.a);
    assert_eq!(all.len(), 1);
    assert_eq!((all[0].amount, all[0].status.as_str()), (2000, "completed"));
    assert_eq!(count(&p.b, "gifts"), 1);
    p.consistent(&p.a);

    // Again: everything read is already here.
    let again = catchup::catch_up(p.t.w.store.clone(), p.t.stripe.clone())
        .await
        .unwrap();
    assert!(again.iter().all(|c| c.missed == 0), "{again:?}");
    assert_eq!(count(&p.a, "gifts"), 1);

    // A disconnected organisation isn't read.
    ok(
        &p.t.w,
        "POST",
        "/api/t/beta/stripe/disconnect",
        &p.t.bob,
        None,
    )
    .await;
    let third = catchup::catch_up(p.t.w.store.clone(), p.t.stripe.clone())
        .await
        .unwrap();
    assert!(third.iter().all(|c| c.tenant != p.t.w.beta.id));
}

#[tokio::test]
async fn events_set_aside_for_a_reconnect_are_kept_thirty_days_then_purged() {
    let p = world().await;
    let now = contracts::now_ms();
    p.t.w
        .store
        .platform()
        .with_write(|tx| {
            for (id, outcome, age_days) in [
                ("evt_aside_old", "not_connected", 31),
                ("evt_aside_new", "not_connected", 29),
                ("evt_done_old", "done", 91),
                ("evt_done_new", "done", 89),
                ("evt_parked", "failed", 400),
            ] {
                tx.execute(
                    "INSERT INTO stripe_events (id, account_id, tenant_id, type, created, body,
                         received_at, processed_at, outcome)
                     VALUES (?1, ?2, ?3, 'account.updated', 0, '{}', 0, ?4, ?5)",
                    rusqlite::params![
                        id,
                        p.acct_a,
                        p.t.w.alpha.id.as_str(),
                        now - age_days * DAY,
                        outcome
                    ],
                )?;
            }
            Ok::<_, store::StoreError>(())
        })
        .unwrap();
    assert_eq!(process::purge(&p.t.w.store, now).unwrap(), 2);
    let left: Vec<String> = p
        .t
        .w
        .store
        .platform()
        .with_read(|c| {
            Ok::<_, store::StoreError>(
                c.prepare("SELECT id FROM stripe_events WHERE id LIKE 'evt\\_%' ESCAPE '\\' AND received_at = 0 ORDER BY id")?
                    .query_map([], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?,
            )
        })
        .unwrap();
    assert_eq!(left, ["evt_aside_new", "evt_done_new", "evt_parked"]);
}

// ── retention ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_retention_job_clears_unpaid_submissions_after_thirty_days_and_never_paid_ones() {
    let p = world().await;
    let now = contracts::now_ms();
    let old_unpaid = submit_at(&p.a, jane(2500, true), now - 31 * DAY);
    let new_unpaid = submit_at(&p.a, jane(2500, true), now - 29 * DAY);
    let old_paid = submit_at(&p.a, jane(1000, true), now - 31 * DAY);
    p.pay(&p.acct_a, &old_paid, 1000).await;
    let theirs = submit_at(&p.b, jane(2500, true), now - 31 * DAY);
    payments::run_retention(&p.t.w.store).await.unwrap();
    let typed = |db: &OrgDb, id: &str| read(db, |c| cards::submission(c, id)).unwrap();
    let cleared = typed(&p.a, &old_unpaid.0);
    assert!(cleared.outcome.personal_cleared_at.is_some());
    assert_eq!(cleared.typed.email, "");
    assert_eq!(cleared.typed.amount, 2500, "the row stays");
    assert_eq!(typed(&p.a, &new_unpaid.0).typed.email, "jane@example.org");
    assert_eq!(typed(&p.a, &old_paid.0).typed.email, "jane@example.org");
    // Every organisation, each in its own file.
    assert!(typed(&p.b, &theirs.0).outcome.personal_cleared_at.is_some());
    // Nothing cascaded from anywhere: the paid one's contact and gift stand.
    assert_eq!(count(&p.a, "gifts"), 1);
    assert_eq!(count(&p.a, "donation_submissions"), 3);
}
