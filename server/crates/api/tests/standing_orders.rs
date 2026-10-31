//! Standing orders over HTTP (plan `bank-transfers.sv` step 5, tests b6
//! "Standing orders" and the standing-order suggester): set-up and end,
//! quarterly only for a standing order, expected payments matched by
//! statement lines, the missed flag and its job, "make this a standing
//! order", roles and isolation. Lines come in through a real OFX import.

mod common;

use axum::body::Body as HttpBody;
use axum::http::{Request, StatusCode, header};
use common::{World, person, world};
use contracts::Source;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

/// Today's UK date less `n` calendar days. Not the UK date of now less
/// `n` × 24 hours: across a clock change that gives one date twice (or
/// skips one), so `days_ago(6)` could equal `days_ago(5)` in the hour
/// before midnight.
fn days_ago(n: i64) -> String {
    giving::terms_rules::add_days(&giftaid::uk_date(contracts::now_ms()), -n).unwrap()
}

fn shift(date: &str, days: i64) -> String {
    giving::terms_rules::add_days(date, days).unwrap()
}

fn day_of(date: &str) -> u8 {
    date[8..10].parse().unwrap()
}

/// The latest date at least `n` days ago on a day 1–28 (a standing
/// order's day must be one every month has).
fn due_at_least(n: i64) -> String {
    (n..n + 4).map(days_ago).find(|d| day_of(d) <= 28).unwrap()
}

async fn ok(w: &World, method: &str, path: &str, cookie: &str, body: Option<Value>) -> Value {
    let (s, out) = w.call(method, path, cookie, body).await;
    assert_eq!(s, StatusCode::OK, "{method} {path}: {out}");
    out
}

struct Credit<'a> {
    on: String,
    pence: i64,
    payer: &'a str,
    reference: &'a str,
}

fn ofx(credits: &[Credit]) -> Vec<u8> {
    let mut body = String::from(
        "OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>\
         <CURDEF>GBP<BANKTRANLIST>\n",
    );
    for c in credits {
        body.push_str(&format!(
            "<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>{}<TRNAMT>{}.{:02}<FITID>{}<NAME>{}\
             <REFNUM>{}<MEMO>STANDING ORDER</STMTTRN>\n",
            c.on.replace('-', ""),
            c.pence / 100,
            c.pence % 100,
            contracts::new_id(),
            c.payer,
            c.reference,
        ));
    }
    body.push_str("</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>\n");
    body.into_bytes()
}

struct S {
    w: World,
    ann: String,
    sam: String,
    val: String,
    bob: String,
    code: String,
    account: String,
}

async fn code(w: &World, slug: &str, cookie: &str) -> String {
    let tree = ok(w, "GET", &format!("/api/t/{slug}/sources"), cookie, None).await;
    let category = tree["parts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["parentId"].is_null())
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    ok(
        w,
        "POST",
        &format!("/api/t/{slug}/sources"),
        cookie,
        Some(json!({ "parentId": category, "name": "Standing orders", "isActive": true })),
    )
    .await["versionId"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn account(w: &World, slug: &str, cookie: &str, code: &str) -> String {
    ok(
        w,
        "POST",
        &format!("/api/t/{slug}/bank/accounts"),
        cookie,
        Some(
            json!({ "name": "CAF current", "sortCode": "", "accountLast4": "", "active": true,
            "defaultSourceCodeId": code }),
        ),
    )
    .await["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn setup() -> S {
    let w = world();
    for t in [&w.alpha, &w.beta] {
        let db = w.store.org(&t.id).unwrap();
        contracts::transact(&db, None, api::schema::seed_new_org).unwrap();
    }
    let ann = w.login("ann@alpha.org").await;
    let sam = w.login("sam@alpha.org").await;
    let val = w.login("val@alpha.org").await;
    let bob = w.login("bob@beta.org").await;
    let code = code(&w, "alpha", &ann).await;
    let account = account(&w, "alpha", &ann, &code).await;
    S {
        w,
        ann,
        sam,
        val,
        bob,
        code,
        account,
    }
}

impl S {
    async fn contact(&self, slug: &str, cookie: &str, first: &str) -> String {
        ok(
            &self.w,
            "POST",
            &format!("/api/t/{slug}/contacts"),
            cookie,
            Some(person(first, "Giver")),
        )
        .await["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    /// A monthly standing order of `pence`, first due `starts_on`.
    async fn standing(&self, contact: &str, pence: i64, starts_on: &str) -> Value {
        ok(
            &self.w,
            "POST",
            &format!("/api/t/alpha/contacts/{contact}/standing-orders"),
            &self.sam,
            Some(json!({
                "amount": pence, "frequency": "monthly", "dayOfMonth": day_of(starts_on),
                "sourceCodeId": self.code, "bankReference": "SMITH123", "startsOn": starts_on,
            })),
        )
        .await
    }

    async fn import(&self, credits: &[Credit<'_>]) -> Vec<Value> {
        let req = Request::builder()
            .method("POST")
            .uri(format!(
                "/api/t/alpha/bank/imports?accountId={}&fileName=s.ofx&layout=%7B%22kind%22%3A%22ofx%22%7D",
                self.account
            ))
            .header(header::COOKIE, &self.sam)
            .body(HttpBody::from(ofx(credits)))
            .unwrap();
        let res = self.w.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let body = res.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        let import: Value = serde_json::from_slice(&body).unwrap();
        ok(
            &self.w,
            "GET",
            &format!(
                "/api/t/alpha/bank/imports/{}",
                import["id"].as_str().unwrap()
            ),
            &self.sam,
            None,
        )
        .await["lines"]
            .as_array()
            .unwrap()
            .clone()
    }

    async fn line(&self, id: &str) -> Value {
        ok(
            &self.w,
            "GET",
            &format!("/api/t/alpha/bank/lines/{id}"),
            &self.sam,
            None,
        )
        .await
    }

    async fn post(&self, path: &str, body: Value) -> (StatusCode, Value) {
        self.w
            .call(
                "POST",
                &format!("/api/t/alpha/{path}"),
                &self.sam,
                Some(body),
            )
            .await
    }

    async fn get_so(&self, id: &str) -> Value {
        ok(
            &self.w,
            "GET",
            &format!("/api/t/alpha/standing-orders/{id}"),
            &self.ann,
            None,
        )
        .await
    }

    async fn job(&self, today: &str) {
        api::routes::standing_orders::run_missed(&self.w.store, today.to_owned())
            .await
            .unwrap();
    }
}

fn id(v: &Value) -> String {
    v["id"].as_str().unwrap().to_owned()
}

// ── set-up, end, frequencies ───────────────────────────────────────────────

/// "Record a standing order": active at once, a bank transfer's regular
/// gift with no provider; monthly, quarterly (with its first month) or
/// yearly. Ended, nothing is expected after.
#[tokio::test]
async fn a_standing_order_is_recorded_active_and_ended_with_nothing_expected_after() {
    let s = setup().await;
    let jo = s.contact("alpha", &s.ann, "Jo").await;
    let start = due_at_least(40);
    let (st, out) = s
        .post(
            &format!("contacts/{jo}/standing-orders"),
            json!({ "amount": 3000, "frequency": "quarterly", "dayOfMonth": 10,
                "sourceCodeId": s.code, "startsOn": start }),
        )
        .await;
    assert_eq!(
        (st, out["problems"][0]["field"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("month"))
    );
    let quarterly = ok(
        &s.w,
        "POST",
        &format!("/api/t/alpha/contacts/{jo}/standing-orders"),
        &s.sam,
        Some(
            json!({ "amount": 3000, "frequency": "quarterly", "dayOfMonth": 10, "month": 2,
            "sourceCodeId": s.code, "startsOn": "2026-02-10" }),
        ),
    )
    .await;
    assert_eq!(quarterly["chain"][0]["frequency"], "quarterly");
    let so = s.standing(&jo, 1000, &start).await;
    assert_eq!(
        (so["status"].as_str(), so["bankReference"].as_str()),
        (Some("active"), Some("SMITH123"))
    );
    let mine = ok(
        &s.w,
        "GET",
        &format!("/api/t/alpha/contacts/{jo}/standing-orders"),
        &s.val,
        None,
    )
    .await;
    assert_eq!(mine.as_array().unwrap().len(), 2);
    assert!(
        so["expected"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["dueOn"] == start.as_str())
    );

    let ended = ok(
        &s.w,
        "POST",
        &format!("/api/t/alpha/standing-orders/{}/end", id(&so)),
        &s.sam,
        Some(json!({ "expected": so["mandateVersion"], "reason": "Donor stopped it" })),
    )
    .await;
    assert_eq!(
        (ended["status"].as_str(), ended["endedReason"].as_str()),
        (Some("cancelled"), Some("Donor stopped it"))
    );
    let today = days_ago(0);
    assert!(
        ended["expected"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["dueOn"].as_str().unwrap() < today.as_str()),
        "nothing expected from its end: {ended}"
    );
}

/// g2q1: Direct Debit stays monthly or yearly. A quarterly set-up is
/// refused, and so is a quarterly row on a Direct Debit's chain, by any
/// path (the terms contract).
#[tokio::test]
async fn quarterly_is_refused_on_a_direct_debit() {
    let s = setup().await;
    let jo = s.contact("alpha", &s.ann, "Jo").await;
    let setup = |frequency| giving::regular::SetUp {
        contact_id: jo.clone(),
        amount: 1000,
        frequency,
        day_of_month: 5,
        month: Some(1),
        source_code_id: s.code.clone(),
        client_key: None,
    };
    match giving::regular::prepare_setup(setup(giving::regular::Frequency::Quarterly)) {
        Err(contracts::ContractError::Invalid(p)) => assert_eq!(p[0].field, "frequency"),
        other => panic!("{other:?}"),
    }
    let db = s.w.store.org(&s.w.alpha.id).unwrap();
    let refused = contracts::transact(&db, Some(1), |ctx| {
        let dd = giving::regular::create_regular_gift(
            ctx,
            &contracts::new_id(),
            giving::regular::SetUp {
                month: None,
                ..setup(giving::regular::Frequency::Monthly)
            },
            giving::regular::MandatePayload::default(),
            Source::Ui,
        )?;
        contracts::execute(
            ctx,
            &giving::terms::REGULAR_GIFT_TERMS,
            giving::terms::TermsPayload {
                regular_gift_id: dd,
                effective_from: "2027-03-05".into(),
                amount: 3000,
                frequency: giving::regular::Frequency::Quarterly,
                day_of_month: 5,
                month: Some(3),
                allocations: vec![giving::terms::TermAllocationRow {
                    key: None,
                    source_code_id: s.code.clone(),
                    amount: 3000,
                }],
                note: None,
                withdrawn: false,
                origin: giving::terms::Origin::Staff,
            },
            contracts::Exec::create(Source::Ui),
        )
    });
    match refused {
        Err(contracts::ContractError::Rejected { reason, .. }) => {
            assert_eq!(reason, "quarterly_direct_debit")
        }
        other => panic!("{other:?}"),
    }
}

// ── expected payments, missed, late ────────────────────────────────────────

/// A payment still unmatched 14 days after it was due is flagged missed
/// (by the job), not at 13; a late payment, matched to the missed period
/// by hand, pays it and clears the flag. The suggester doesn't offer a
/// line that late.
#[tokio::test]
async fn a_payment_is_missed_after_14_days_and_a_late_one_clears_it() {
    let s = setup().await;
    let jo = s.contact("alpha", &s.ann, "Jo").await;
    let due = due_at_least(20);
    let so = id(&s.standing(&jo, 1000, &due).await);

    s.job(&shift(&due, 13)).await;
    assert_eq!(s.get_so(&so).await["missedOn"], Value::Null);
    s.job(&shift(&due, 14)).await;
    assert_eq!(s.get_so(&so).await["missedOn"], due.as_str());
    s.job(&days_ago(0)).await;
    let missed = ok(
        &s.w,
        "GET",
        "/api/t/alpha/standing-orders/missed",
        &s.val,
        None,
    )
    .await;
    assert_eq!(missed[0]["id"], so.as_str());
    assert_eq!(
        (missed[0]["missedOn"].as_str(), missed[0]["amount"].as_i64()),
        (Some(due.as_str()), Some(1000))
    );

    let lines = s
        .import(&[Credit {
            on: days_ago(1),
            pence: 1000,
            payer: "J GIVER",
            reference: "SO REF",
        }])
        .await;
    let line = id(&lines[0]);
    let detail = s.line(&line).await;
    assert!(
        detail["suggestions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|x| x["proposal"]["kind"] != "instalment"),
        "too late for the suggester: {detail}"
    );
    let (st, out) = s
        .post(
            &format!("bank/lines/{line}/instalment"),
            json!({ "expected": detail["line"]["matchVersion"], "regularGiftId": so, "scheduledOn": due }),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{out}");
    let gift = ok(
        &s.w,
        "GET",
        &format!(
            "/api/t/alpha/gifts/{}",
            out["gifts"][0]["id"].as_str().unwrap()
        ),
        &s.ann,
        None,
    )
    .await;
    assert_eq!(
        (gift["regularGiftId"].as_str(), gift["receivedOn"].as_str()),
        (Some(so.as_str()), Some(days_ago(1).as_str()))
    );
    assert_eq!(gift["allocations"][0]["sourceCodeId"], s.code.as_str());
    let after = s.get_so(&so).await;
    assert_eq!(after["missedOn"], Value::Null);
    let period = after["expected"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["dueOn"] == due.as_str())
        .unwrap()
        .clone();
    assert_eq!(period["status"], "collected");
    assert!(
        ok(
            &s.w,
            "GET",
            "/api/t/alpha/standing-orders/missed",
            &s.sam,
            None
        )
        .await
        .as_array()
        .unwrap()
        .is_empty()
    );
}

/// The standing-order suggester: an expected payment matches a line
/// posted from 5 days before its due date to 15 after, with the exact
/// amount; outside the window, or another amount, it isn't suggested.
/// Strong (pre-ticked) only when the line's payer is a known payer of the
/// donor (review b5r round 3): B paid Jo before. F quotes the standing
/// order's reference ("reference SMITH123 matches") but is only
/// suggested; C, inside the window too, is "amount and date only". Two lines for one
/// period: the second is refused on its own (`period_paid`, review b5r
/// M1) and the rest of the accept applies.
#[tokio::test]
async fn an_expected_payment_matches_inside_minus_5_plus_15_only() {
    let s = setup().await;
    let jo = s.contact("alpha", &s.ann, "Jo").await;
    let due = due_at_least(17);
    let so = id(&s.standing(&jo, 1500, &due).await);
    let credit = |days: i64, pence: i64, payer: &'static str, reference: &'static str| Credit {
        on: shift(&due, days),
        pence,
        payer,
        reference,
    };
    // B paid Jo before (a payment staff matched): a known payer.
    let earlier = s
        .import(&[credit(-40, 999, "B", "FPI SMITH123 DONATION")])
        .await;
    let e0 = s.line(&id(&earlier[0])).await;
    let (st, _) = s
        .post(
            &format!("bank/lines/{}/gifts", id(&earlier[0])),
            json!({ "expected": e0["line"]["matchVersion"],
                "parts": [{ "contact": jo, "amount": 999 }] }),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let lines = s
        .import(&[
            credit(-6, 1500, "A", "SMITH123"),
            credit(-5, 1500, "B", "FPI SMITH123 DONATION"),
            credit(15, 1500, "C", ""),
            credit(16, 1500, "D", "SMITH123"),
            credit(2, 1501, "E", "SMITH123"),
            credit(3, 1500, "F", "SMITH123"),
        ])
        .await;
    let instalments = |v: &Value| -> Vec<Value> {
        v["suggestions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|x| x["proposal"]["kind"] == "instalment")
            .cloned()
            .collect()
    };
    let by_payer = |p: &str| lines.iter().find(|l| l["payer"] == p).map(id).unwrap();
    for (payer, fits) in [
        ("A", None),
        ("B", Some(("strong", true))),
        ("C", Some(("suggested", false))),
        ("D", None),
        ("E", None),
        // The standing order's reference alone: ranked, said, not strong.
        ("F", Some(("suggested", false))),
    ] {
        let found = instalments(&s.line(&by_payer(payer)).await);
        assert_eq!(
            found.len(),
            usize::from(fits.is_some()),
            "{payer}: {found:?}"
        );
        if let Some((confidence, ticked)) = fits {
            assert_eq!(
                found[0]["proposal"],
                json!({ "kind": "instalment", "regularGiftId": so, "scheduledOn": due })
            );
            assert_eq!(
                (
                    found[0]["confidence"].as_str(),
                    found[0]["ticked"].as_bool()
                ),
                (Some(confidence), Some(ticked)),
                "{payer}"
            );
        }
    }
    let f = s.line(&by_payer("F")).await;
    assert!(
        instalments(&f)[0]["reason"]
            .as_str()
            .unwrap()
            .contains("reference SMITH123 matches"),
        "{f}"
    );
    let c = s.line(&by_payer("C")).await;
    assert!(
        instalments(&c)[0]["reason"]
            .as_str()
            .unwrap()
            .contains("amount and date only"),
        "{c}"
    );

    // B and C both sent for the one period, and E as a new gift for Jo.
    let b = s.line(&by_payer("B")).await;
    let e = s.line(&by_payer("E")).await;
    let item = |l: &Value, proposal: Value| {
        json!({ "lineId": l["line"]["id"], "expected": l["line"]["matchVersion"],
            "proposal": proposal })
    };
    let out = ok(
        &s.w,
        "POST",
        "/api/t/alpha/bank/accept",
        &s.sam,
        Some(json!({ "items": [
            item(&b, instalments(&b)[0]["proposal"].clone()),
            item(&c, instalments(&c)[0]["proposal"].clone()),
            item(&e, json!({ "kind": "newGift", "contactId": jo })),
        ] })),
    )
    .await;
    assert_eq!(
        (
            out[0]["status"].as_i64(),
            out[1]["status"].as_i64(),
            out[1]["error"]["reason"].as_str(),
            out[2]["status"].as_i64()
        ),
        (Some(200), Some(422), Some("period_paid"), Some(200)),
        "{out}"
    );
    // Paid: C, inside the window too, is no longer offered that period.
    assert!(instalments(&s.line(&by_payer("C")).await).is_empty());
    assert_eq!(s.line(&by_payer("C")).await["line"]["state"], "unmatched");
}

/// H1's other way to name the donor: a payer matched to the standing
/// order's donor before makes its expected payment strong, with no
/// reference.
#[tokio::test]
async fn a_known_payer_makes_a_standing_order_payment_strong() {
    let s = setup().await;
    let jo = s.contact("alpha", &s.ann, "Jo").await;
    let first = due_at_least(40);
    let so = ok(
        &s.w,
        "POST",
        &format!("/api/t/alpha/contacts/{jo}/standing-orders"),
        &s.sam,
        Some(
            json!({ "amount": 2000, "frequency": "monthly", "dayOfMonth": day_of(&first),
            "sourceCodeId": s.code, "startsOn": first }),
        ),
    )
    .await;
    let second = shift(&first, 30);
    let lines = s
        .import(&[
            Credit {
                on: first.clone(),
                pence: 2000,
                payer: "JO GIVER",
                reference: "",
            },
            Credit {
                on: second.clone(),
                pence: 2000,
                payer: "JO GIVER",
                reference: "",
            },
        ])
        .await;
    let (one, two) = (id(&lines[0]), id(&lines[1]));
    let l = s.line(&one).await;
    let first_due = instalments_of(&l)[0].clone();
    assert_eq!(first_due["confidence"], "suggested", "{l}");
    let (st, out) = s
        .post(
            &format!("bank/lines/{one}/instalment"),
            json!({ "expected": l["line"]["matchVersion"], "regularGiftId": id(&so),
                "scheduledOn": first }),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{out}");
    let next = instalments_of(&s.line(&two).await);
    assert_eq!(next.len(), 1);
    assert_eq!(
        (next[0]["confidence"].as_str(), next[0]["ticked"].as_bool()),
        (Some("strong"), Some(true))
    );

    // A payer known for someone else names Al, not Jo: Jo's expected
    // payment from them is only suggested.
    let al = s.contact("alpha", &s.ann, "Al").await;
    let more = s
        .import(&[
            Credit {
                on: shift(&first, -20),
                pence: 777,
                payer: "AL OTHER",
                reference: "",
            },
            Credit {
                on: shift(&second, 1),
                pence: 2000,
                payer: "AL OTHER",
                reference: "",
            },
        ])
        .await;
    let a0 = s.line(&id(&more[0])).await;
    let (st, _) = s
        .post(
            &format!("bank/lines/{}/gifts", id(&more[0])),
            json!({ "expected": a0["line"]["matchVersion"],
                "parts": [{ "contact": al, "amount": 777 }] }),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let theirs = instalments_of(&s.line(&id(&more[1])).await);
    assert_eq!(theirs.len(), 1);
    assert_eq!(
        (
            theirs[0]["confidence"].as_str(),
            theirs[0]["ticked"].as_bool()
        ),
        (Some("suggested"), Some(false))
    );
}

fn instalments_of(v: &Value) -> Vec<Value> {
    v["suggestions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|x| x["proposal"]["kind"] == "instalment")
        .cloned()
        .collect()
}

/// Review b5r L1: unmatching an instalment re-opens its period, and the
/// missed flag says so at once (not at the next job). L3: a line pays no
/// period due more than 5 days after it. L5: "make this a standing
/// order" starts on or before the line.
#[tokio::test]
async fn unmatching_an_instalment_reopens_its_period_and_lines_pay_only_periods_come() {
    let s = setup().await;
    let jo = s.contact("alpha", &s.ann, "Jo").await;
    let due = due_at_least(20);
    let so = id(&s.standing(&jo, 1000, &due).await);
    s.job(&days_ago(0)).await;
    assert_eq!(s.get_so(&so).await["missedOn"], due.as_str());
    let lines = s
        .import(&[
            Credit {
                on: days_ago(1),
                pence: 1000,
                payer: "J GIVER",
                reference: "SO REF",
            },
            Credit {
                on: days_ago(1),
                pence: 700,
                payer: "NEW SO",
                reference: "",
            },
        ])
        .await;
    let (line, other) = (id(&lines[0]), id(&lines[1]));
    let l = s.line(&line).await;
    // A period months ahead isn't this line's to pay.
    let far = shift(&due, 92);
    let (st, out) = s
        .post(
            &format!("bank/lines/{line}/instalment"),
            json!({ "expected": l["line"]["matchVersion"], "regularGiftId": so, "scheduledOn": far }),
        )
        .await;
    assert_eq!(
        (st, out["reason"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("period_not_due")),
        "{out}"
    );
    let (st, _) = s
        .post(
            &format!("bank/lines/{line}/instalment"),
            json!({ "expected": l["line"]["matchVersion"], "regularGiftId": so, "scheduledOn": due }),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(s.get_so(&so).await["missedOn"], Value::Null);

    let l = s.line(&line).await;
    let (st, _) = s
        .post(
            &format!("bank/lines/{line}/unmatch"),
            json!({ "expected": l["line"]["matchVersion"] }),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let after = s.get_so(&so).await;
    assert_eq!(after["missedOn"], due.as_str(), "{after}");
    let period = after["expected"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["dueOn"] == due.as_str())
        .unwrap()
        .clone();
    assert_eq!(
        (period["status"].as_str(), &period["giftId"]),
        (Some("missing"), &Value::Null)
    );

    // "Make this a standing order" can't start after its own line.
    let o = s.line(&other).await;
    let later = (day_of(&days_ago(1)) + 1).min(28);
    if later > day_of(&days_ago(1)) {
        let (st, out) = s
            .post(
                &format!("bank/lines/{other}/standing-order"),
                json!({ "expected": o["line"]["matchVersion"], "contact": jo,
                    "frequency": "monthly", "dayOfMonth": later }),
            )
            .await;
        assert_eq!(
            (st, out["problems"][0]["field"].as_str()),
            (StatusCode::UNPROCESSABLE_ENTITY, Some("dayOfMonth")),
            "{out}"
        );
    }
}

/// An instalment claimed for Gift Aid, its line then unmatched: the gift
/// is void with the unmatch's reason, and the next claim repays it as an
/// adjustment (as any gift made from a line).
#[tokio::test]
async fn a_claimed_instalment_unmatched_is_repaid_through_the_next_claim() {
    let s = setup().await;
    let rec = ok(&s.w, "POST", "/api/t/alpha/gifts/record", &s.ann, Some(json!({
        "clientKey": contracts::new_id(),
        "contact": { "kind": "individual", "firstName": "Ann", "lastName": "Smith", "name": "" },
        "home": { "line1": "12 High Street", "postcode": "ls1 1aa" },
        "giftAid": {},
        "receivedOn": days_ago(30), "amount": 1000, "method": "cash",
        "allocations": [{ "sourceCodeId": s.code, "amount": 1000 }],
    }))).await;
    let ann_smith = rec["contactId"].as_str().unwrap().to_owned();
    let due = due_at_least(8);
    let so = id(&s.standing(&ann_smith, 4000, &due).await);
    let lines = s
        .import(&[Credit {
            on: shift(&due, 1),
            pence: 4000,
            payer: "A SMITH",
            reference: "SO REF",
        }])
        .await;
    let line = id(&lines[0]);
    let l = s.line(&line).await;
    let paid = ok(
        &s.w,
        "POST",
        &format!("/api/t/alpha/bank/lines/{line}/instalment"),
        &s.sam,
        Some(json!({ "expected": l["line"]["matchVersion"], "regularGiftId": so, "scheduledOn": due })),
    )
    .await;
    let gift = paid["gifts"][0]["id"].as_str().unwrap().to_owned();
    ok(
        &s.w,
        "POST",
        "/api/t/alpha/giftaid/hmrc-details",
        &s.ann,
        Some(json!({
            "hmrcReference": "ab12345", "regulator": "ccew", "regulatorNumber": "1234567",
            "officialTitle": "Mrs", "officialFirstName": "Jane", "officialLastName": "Doe",
            "officialPostcode": "ls1 1aa", "officialPhone": "0113 496 0000",
        })),
    )
    .await;
    let today = days_ago(0);
    let claim = ok(
        &s.w,
        "POST",
        "/api/t/alpha/giftaid/claims",
        &s.ann,
        Some(json!({ "periodEnd": today })),
    )
    .await["claims"][0]
        .clone();
    let claim_id = claim["id"].as_str().unwrap().to_owned();
    for step in [
        json!({ "status": "ready" }),
        json!({ "status": "submitted", "submittedOn": today, "hmrcReference": "CHAR-123" }),
    ] {
        let v = ok(
            &s.w,
            "GET",
            &format!("/api/t/alpha/giftaid/claims/{claim_id}"),
            &s.ann,
            None,
        )
        .await;
        let mut body = step;
        body["expected"] = v["statusVersion"].clone();
        ok(
            &s.w,
            "POST",
            &format!("/api/t/alpha/giftaid/claims/{claim_id}/status"),
            &s.ann,
            Some(body),
        )
        .await;
    }
    let l = s.line(&line).await;
    let (st, _) = s
        .post(
            &format!("bank/lines/{line}/unmatch"),
            json!({ "expected": l["line"]["matchVersion"] }),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let preview = ok(
        &s.w,
        "GET",
        &format!("/api/t/alpha/giftaid/claims/preview?periodEnd={today}"),
        &s.ann,
        None,
    )
    .await;
    let adjustments = preview["adjustments"].as_array().unwrap();
    assert_eq!(adjustments.len(), 1, "{preview}");
    assert_eq!(adjustments[0]["giftId"], gift.as_str());
    assert_eq!(adjustments[0]["originalClaimId"], claim_id.as_str());
    assert_eq!(adjustments[0]["amount"], 1000);
}

/// "Make this a standing order" (g2q3): offered when a payer matched
/// before pays the same amount about a month later, on that second
/// payment and never the first; only suggested. Taking it records the
/// standing order with the line as its first payment.
#[tokio::test]
async fn make_this_a_standing_order_is_offered_on_the_second_payment_not_the_first() {
    let s = setup().await;
    let jo = s.contact("alpha", &s.ann, "Jo").await;
    let first_on = due_at_least(35);
    let second_on = shift(&first_on, 31);
    let lines = s
        .import(&[
            Credit {
                on: first_on.clone(),
                pence: 2000,
                payer: "JO GIVER",
                reference: "MONTHLY",
            },
            Credit {
                on: second_on.clone(),
                pence: 2000,
                payer: "JO GIVER",
                reference: "MONTHLY",
            },
        ])
        .await;
    let (first, second) = (id(&lines[0]), id(&lines[1]));
    let offers = |v: &Value| -> Vec<Value> {
        v["suggestions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|x| x["proposal"]["kind"] == "newStandingOrder")
            .cloned()
            .collect()
    };
    assert!(offers(&s.line(&first).await).is_empty());
    assert!(
        offers(&s.line(&second).await).is_empty(),
        "no payment before it is matched yet"
    );
    let f = s.line(&first).await;
    let (st, _) = s
        .post(
            &format!("bank/lines/{first}/gifts"),
            json!({ "expected": f["line"]["matchVersion"],
            "parts": [{ "contact": jo, "amount": 2000 }] }),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let offered = offers(&s.line(&second).await);
    assert_eq!(offered.len(), 1);
    assert_eq!(
        offered[0]["proposal"],
        json!({ "kind": "newStandingOrder", "contactId": jo, "frequency": "monthly",
            "dayOfMonth": day_of(&second_on).min(28), "month": null })
    );
    assert_eq!(
        (
            offered[0]["confidence"].as_str(),
            offered[0]["ticked"].as_bool()
        ),
        (Some("suggested"), Some(false))
    );

    let l = s.line(&second).await;
    let (st, out) = s
        .post(
            &format!("bank/lines/{second}/standing-order"),
            json!({ "expected": l["line"]["matchVersion"],
            "contact": jo, "frequency": "monthly", "dayOfMonth": day_of(&second_on).min(28) }),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{out}");
    let mine = ok(
        &s.w,
        "GET",
        &format!("/api/t/alpha/contacts/{jo}/standing-orders"),
        &s.ann,
        None,
    )
    .await;
    assert_eq!(mine.as_array().unwrap().len(), 1);
    // The line's reference is never taken for it: staff type one.
    assert_eq!(mine[0]["bankReference"], Value::Null);
    let gift = ok(
        &s.w,
        "GET",
        &format!(
            "/api/t/alpha/gifts/{}",
            out["gifts"][0]["id"].as_str().unwrap()
        ),
        &s.ann,
        None,
    )
    .await;
    assert_eq!(gift["regularGiftId"], mine[0]["id"]);
}

/// soui L1: the offer never goes through "Accept ticked", whatever the
/// client sends: refused, the line left unmatched, no standing order.
#[tokio::test]
async fn accept_refuses_the_offer_to_make_a_standing_order() {
    let s = setup().await;
    let jo = s.contact("alpha", &s.ann, "Jo").await;
    let on = due_at_least(10);
    let lines = s
        .import(&[Credit {
            on: on.clone(),
            pence: 2000,
            payer: "JO GIVER",
            reference: "MONTHLY",
        }])
        .await;
    let line = id(&lines[0]);
    let l = s.line(&line).await;
    let out = ok(
        &s.w,
        "POST",
        "/api/t/alpha/bank/accept",
        &s.sam,
        Some(
            json!({ "items": [{ "lineId": line, "expected": l["line"]["matchVersion"],
            "proposal": { "kind": "newStandingOrder", "contactId": jo, "frequency": "monthly",
                "dayOfMonth": day_of(&on).min(28), "month": null } }] }),
        ),
    )
    .await;
    assert_eq!(
        (
            out[0]["status"].as_u64(),
            out[0]["error"]["reason"].as_str()
        ),
        (Some(422), Some("one_at_a_time")),
        "{out}"
    );
    assert_eq!(s.line(&line).await["line"]["state"], "unmatched");
    let mine = ok(
        &s.w,
        "GET",
        &format!("/api/t/alpha/contacts/{jo}/standing-orders"),
        &s.ann,
        None,
    )
    .await;
    assert_eq!(mine, json!([]));
}

// ── the job, roles, isolation ──────────────────────────────────────────────

/// The job visits every organisation (`each_org`): a missed payment in
/// each is flagged in each, and neither sees the other's.
#[tokio::test]
async fn the_missed_job_runs_over_every_organisation() {
    let s = setup().await;
    let due = due_at_least(20);
    let jo = s.contact("alpha", &s.ann, "Jo").await;
    s.standing(&jo, 1000, &due).await;
    let bea = s.contact("beta", &s.bob, "Bea").await;
    let beta_code = code(&s.w, "beta", &s.bob).await;
    ok(
        &s.w,
        "POST",
        &format!("/api/t/beta/contacts/{bea}/standing-orders"),
        &s.bob,
        Some(json!({
        "amount": 500, "frequency": "monthly", "dayOfMonth": day_of(&due),
        "sourceCodeId": beta_code, "startsOn": due })),
    )
    .await;
    s.job(&days_ago(0)).await;
    for (slug, cookie, who) in [("alpha", &s.ann, &jo), ("beta", &s.bob, &bea)] {
        let missed = ok(
            &s.w,
            "GET",
            &format!("/api/t/{slug}/standing-orders/missed"),
            cookie,
            None,
        )
        .await;
        let ids: Vec<&str> = missed
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["contactId"].as_str().unwrap())
            .collect();
        assert_eq!(ids, [who.as_str()], "{slug}");
    }
}

/// Viewers read standing orders but write none; B never sees A's, and
/// A's ids under B's slug are 404.
#[tokio::test]
async fn viewers_read_only_and_b_never_sees_a_s_standing_orders() {
    let s = setup().await;
    let jo = s.contact("alpha", &s.ann, "Jo").await;
    let so = s.standing(&jo, 1000, &due_at_least(20)).await;
    let lines = s
        .import(&[Credit {
            on: days_ago(1),
            pence: 1000,
            payer: "X",
            reference: "",
        }])
        .await;
    let line = id(&lines[0]);
    for (path, body) in [
        (
            format!("/api/t/alpha/contacts/{jo}/standing-orders"),
            json!({}),
        ),
        (
            format!("/api/t/alpha/standing-orders/{}/end", id(&so)),
            json!({ "expected": 0 }),
        ),
        (
            format!("/api/t/alpha/bank/lines/{line}/instalment"),
            json!({}),
        ),
        (
            format!("/api/t/alpha/bank/lines/{line}/standing-order"),
            json!({}),
        ),
    ] {
        let (st, _) = s.w.call("POST", &path, &s.val, Some(body)).await;
        assert_eq!(st, StatusCode::FORBIDDEN, "{path}");
    }
    ok(
        &s.w,
        "GET",
        &format!("/api/t/alpha/standing-orders/{}", id(&so)),
        &s.val,
        None,
    )
    .await;

    for (method, path, body) in [
        (
            "GET",
            format!("/api/t/beta/standing-orders/{}", id(&so)),
            None,
        ),
        (
            "GET",
            format!("/api/t/beta/contacts/{jo}/standing-orders"),
            None,
        ),
        (
            "POST",
            format!("/api/t/beta/contacts/{jo}/standing-orders"),
            Some(json!({
            "amount": 1000, "frequency": "monthly", "dayOfMonth": 5, "sourceCodeId": s.code,
            "startsOn": "2026-01-05" })),
        ),
        (
            "POST",
            format!("/api/t/beta/standing-orders/{}/end", id(&so)),
            Some(json!({ "expected": 0 })),
        ),
        (
            "POST",
            format!("/api/t/beta/bank/lines/{line}/instalment"),
            Some(json!({
            "expected": 0, "regularGiftId": id(&so), "scheduledOn": "2026-01-05" })),
        ),
        (
            "POST",
            format!("/api/t/beta/bank/lines/{line}/standing-order"),
            Some(json!({
            "expected": 0, "contact": jo, "frequency": "monthly", "dayOfMonth": 5 })),
        ),
    ] {
        let (st, out) = s.w.call(method, &path, &s.bob, body).await;
        assert_eq!(st, StatusCode::NOT_FOUND, "{method} {path}: {out}");
    }
    assert!(
        ok(
            &s.w,
            "GET",
            "/api/t/beta/standing-orders/missed",
            &s.bob,
            None
        )
        .await
        .as_array()
        .unwrap()
        .is_empty()
    );
}

// ── step 5 follow-ups (controller, after round 4) ──────────────────────────

/// (a) The donor's own Luhn-valid contact number in the line makes their
/// standing order's instalment strong, as step 4's contact-number rule;
/// another contact's number doesn't (that one is its own new gift).
#[tokio::test]
async fn the_donors_own_contact_number_makes_an_instalment_strong() {
    let s = setup().await;
    let numbered = |c: &Value| {
        (
            id(c),
            contacts::number::format_number(c["number"].as_i64().unwrap()),
        )
    };
    let (jo, jo_no) = numbered(
        &ok(
            &s.w,
            "POST",
            "/api/t/alpha/contacts",
            &s.ann,
            Some(person("Jo", "Giver")),
        )
        .await,
    );
    let (_, al_no) = numbered(
        &ok(
            &s.w,
            "POST",
            "/api/t/alpha/contacts",
            &s.ann,
            Some(person("Al", "Other")),
        )
        .await,
    );
    let due = due_at_least(17);
    let so = id(&s.standing(&jo, 1500, &due).await);
    let lines = s
        .import(&[
            Credit {
                on: shift(&due, 1),
                pence: 1500,
                payer: "X",
                reference: &jo_no,
            },
            Credit {
                on: shift(&due, 2),
                pence: 1500,
                payer: "Y",
                reference: &al_no,
            },
        ])
        .await;
    let mine = instalments_of(&s.line(&id(&lines[0])).await);
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0]["proposal"]["regularGiftId"], so.as_str());
    assert_eq!(
        (mine[0]["confidence"].as_str(), mine[0]["ticked"].as_bool()),
        (Some("strong"), Some(true))
    );
    assert!(mine[0]["reason"].as_str().unwrap().contains("contact no."));
    let theirs = instalments_of(&s.line(&id(&lines[1])).await);
    assert_eq!(theirs.len(), 1);
    assert_eq!(theirs[0]["confidence"], "suggested");
}

/// (b) A line with a blank payer never makes or matches a known payer:
/// a generic reference ("DONATION") names no one. Neither the known-payer
/// suggester nor a standing order's expected payment is strong from it.
#[tokio::test]
async fn a_blank_payer_is_never_a_known_payer() {
    let s = setup().await;
    let jo = s.contact("alpha", &s.ann, "Jo").await;
    let first = due_at_least(40);
    let so = id(&s.standing(&jo, 2000, &first).await);
    let second = shift(&first, 30);
    let lines = s
        .import(&[
            Credit {
                on: first.clone(),
                pence: 2000,
                payer: "",
                reference: "DONATION",
            },
            Credit {
                on: shift(&first, 2),
                pence: 700,
                payer: "",
                reference: "DONATION",
            },
            Credit {
                on: second.clone(),
                pence: 2000,
                payer: "",
                reference: "DONATION",
            },
            Credit {
                on: shift(&second, 2),
                pence: 700,
                payer: "",
                reference: "DONATION",
            },
        ])
        .await;
    // Staff match the first two by hand: an instalment and a plain gift.
    let l0 = s.line(&id(&lines[0])).await;
    let (st, _) = s
        .post(
            &format!("bank/lines/{}/instalment", id(&lines[0])),
            json!({ "expected": l0["line"]["matchVersion"], "regularGiftId": so,
                "scheduledOn": first }),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let l1 = s.line(&id(&lines[1])).await;
    let (st, _) = s
        .post(
            &format!("bank/lines/{}/gifts", id(&lines[1])),
            json!({ "expected": l1["line"]["matchVersion"],
                "parts": [{ "contact": jo, "amount": 700 }] }),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let payers = ok(
        &s.w,
        "GET",
        &format!("/api/t/alpha/bank/lines/{}", id(&lines[2])),
        &s.sam,
        None,
    )
    .await;
    let next = instalments_of(&payers);
    assert_eq!(next.len(), 1);
    assert_eq!(
        (next[0]["confidence"].as_str(), next[0]["ticked"].as_bool()),
        (Some("suggested"), Some(false)),
        "{payers}"
    );
    let gift_line = s.line(&id(&lines[3])).await;
    assert!(
        gift_line["suggestions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|x| x["suggesters"] != json!(["knownPayer"])),
        "{gift_line}"
    );
}

// ── review soui ────────────────────────────────────────────────────────────

/// M3: the next payment due comes from the terms chain however far
/// ahead: a yearly one due in about ten months still has it.
#[tokio::test]
async fn a_yearly_standing_order_knows_its_next_payment_far_ahead() {
    let s = setup().await;
    let jo = s.contact("alpha", &s.ann, "Jo").await;
    // First paid about two months ago: the next is about ten months off.
    let first = due_at_least(60);
    let so = ok(
        &s.w,
        "POST",
        &format!("/api/t/alpha/contacts/{jo}/standing-orders"),
        &s.sam,
        Some(
            json!({ "amount": 12000, "frequency": "yearly", "dayOfMonth": day_of(&first),
            "month": first[5..7].parse::<u8>().unwrap(), "sourceCodeId": s.code,
            "startsOn": first }),
        ),
    )
    .await;
    // The same day next year.
    let next = format!("{}{}", first[0..4].parse::<i32>().unwrap() + 1, &first[4..]);
    assert_eq!(so["nextDueOn"], next.as_str(), "{so}");
    // Ended: nothing is next.
    let ended = ok(
        &s.w,
        "POST",
        &format!("/api/t/alpha/standing-orders/{}/end", id(&so)),
        &s.sam,
        Some(json!({ "expected": so["mandateVersion"] })),
    )
    .await;
    assert_eq!(ended["nextDueOn"], Value::Null);
}

/// Round 2 N2: a payment that came early (its line before the due date)
/// pays its period, so the next due is the period after, not the one
/// already in.
#[tokio::test]
async fn an_early_payment_moves_the_next_due_on_a_period() {
    let s = setup().await;
    let jo = s.contact("alpha", &s.ann, "Jo").await;
    // Due a few days from now (within EARLY_DAYS of a line posted today).
    let due = (2..=giving::standing::EARLY_DAYS)
        .map(|n| shift(&days_ago(0), n))
        .find(|d| day_of(d) <= 28)
        .unwrap();
    let so = id(&s.standing(&jo, 1000, &due).await);
    assert_eq!(s.get_so(&so).await["nextDueOn"], due.as_str());
    let lines = s
        .import(&[Credit {
            on: days_ago(0),
            pence: 1000,
            payer: "J GIVER",
            reference: "SO REF",
        }])
        .await;
    let line = id(&lines[0]);
    let l = s.line(&line).await;
    let (st, out) = s
        .post(
            &format!("bank/lines/{line}/instalment"),
            json!({ "expected": l["line"]["matchVersion"], "regularGiftId": so, "scheduledOn": due }),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{out}");
    // The same day next month.
    let (y, m): (i32, u32) = (due[0..4].parse().unwrap(), due[5..7].parse().unwrap());
    let (y, m) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    let next = format!("{y}-{m:02}-{}", &due[8..10]);
    let after = s.get_so(&so).await;
    assert_eq!(after["nextDueOn"], next.as_str(), "{after}");
}

/// M1: "make this a standing order" starts on the line's own day (capped
/// at the 28th) in the line's month, whatever the frequency: what the
/// form shows read-only (`lineSchedule` in src/lib/domain/
/// standing-orders.ts) is what the server records.
#[tokio::test]
async fn a_standing_order_from_a_line_starts_on_the_lines_day_capped_at_28() {
    let s = setup().await;
    let jo = s.contact("alpha", &s.ann, "Jo").await;
    // A line on the 29th–31st if the calendar allows, else the latest.
    let on = (20..60).map(days_ago).find(|d| day_of(d) >= 29).unwrap();
    let lines = s
        .import(&[Credit {
            on: on.clone(),
            pence: 3000,
            payer: "JO GIVER",
            reference: "",
        }])
        .await;
    let l = s.line(&id(&lines[0])).await;
    let month: u8 = on[5..7].parse().unwrap();
    let (st, out) = s
        .post(
            &format!("bank/lines/{}/standing-order", id(&lines[0])),
            json!({ "expected": l["line"]["matchVersion"], "contact": jo,
                "frequency": "yearly", "dayOfMonth": 28, "month": month }),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{out}");
    let mine = ok(
        &s.w,
        "GET",
        &format!("/api/t/alpha/contacts/{jo}/standing-orders"),
        &s.ann,
        None,
    )
    .await;
    let first = &mine[0]["chain"][0];
    assert_eq!(first["effectiveFrom"], format!("{}-28", &on[0..7]));
    assert_eq!(
        (first["dayOfMonth"].as_u64(), first["month"].as_u64()),
        (Some(28), Some(u64::from(month)))
    );

    // Round 2 N3: quarterly the same, its month the line's own.
    let bo = s.contact("alpha", &s.ann, "Bo").await;
    let on = (60..120).map(days_ago).find(|d| day_of(d) >= 29).unwrap();
    let lines = s
        .import(&[Credit {
            on: on.clone(),
            pence: 4500,
            payer: "BO GIVER",
            reference: "",
        }])
        .await;
    let l = s.line(&id(&lines[0])).await;
    let month: u8 = on[5..7].parse().unwrap();
    let (st, out) = s
        .post(
            &format!("bank/lines/{}/standing-order", id(&lines[0])),
            json!({ "expected": l["line"]["matchVersion"], "contact": bo,
                "frequency": "quarterly", "dayOfMonth": 28, "month": month }),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{out}");
    let theirs = ok(
        &s.w,
        "GET",
        &format!("/api/t/alpha/contacts/{bo}/standing-orders"),
        &s.ann,
        None,
    )
    .await;
    let first = &theirs[0]["chain"][0];
    assert_eq!(first["effectiveFrom"], format!("{}-28", &on[0..7]));
    assert_eq!(
        (
            first["frequency"].as_str(),
            first["dayOfMonth"].as_u64(),
            first["month"].as_u64()
        ),
        (Some("quarterly"), Some(28), Some(u64::from(month)))
    );
}
