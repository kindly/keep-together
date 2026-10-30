//! Matching statement lines over HTTP (plan `bank-transfers.sv` step 4,
//! tests b6): money, gifts from lines, never optimistic, suggesters,
//! isolation, roles and erasure. Lines come in through a real OFX import;
//! gifts by hand through `gifts/record`; a Gift Aid claim through its
//! routes, to prove an unmatch's void reaches the next claim.

mod common;

use axum::body::Body as HttpBody;
use axum::http::{Request, StatusCode, header};
use common::{World, person, world};
use contracts::Source;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

const DAY: i64 = 86_400_000;

fn days_ago(n: i64) -> String {
    giftaid::uk_date(contracts::now_ms() - n * DAY)
}

async fn ok(w: &World, method: &str, path: &str, cookie: &str, body: Option<Value>) -> Value {
    let (s, out) = w.call(method, path, cookie, body).await;
    assert_eq!(s, StatusCode::OK, "{method} {path}: {out}");
    out
}

/// The refusal's status and reason (or kind).
async fn refused(
    w: &World,
    method: &str,
    path: &str,
    cookie: &str,
    body: Option<Value>,
) -> (StatusCode, String) {
    let (s, out) = w.call(method, path, cookie, body).await;
    assert_ne!(s, StatusCode::OK, "{method} {path}: {out}");
    let reason = out["reason"]
        .as_str()
        .or_else(|| out["kind"].as_str())
        .unwrap_or("")
        .to_owned();
    (s, reason)
}

/// One credit on a statement: posted `days_ago`, pence, payer, reference.
struct Credit<'a> {
    days_ago: i64,
    pence: i64,
    payer: &'a str,
    reference: &'a str,
}

/// An OFX statement of credits (the bank's ids unique per call).
fn ofx(credits: &[Credit]) -> Vec<u8> {
    let mut body = String::from(
        "OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>\
         <CURDEF>GBP<BANKTRANLIST>\n",
    );
    for c in credits {
        let date = days_ago(c.days_ago).replace('-', "");
        body.push_str(&format!(
            "<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>{date}<TRNAMT>{}.{:02}<FITID>{}<NAME>{}\
             <REFNUM>{}<MEMO>FASTER PAYMENT</STMTTRN>\n",
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

struct M {
    w: World,
    ann: String,
    sam: String,
    val: String,
    bob: String,
    /// Alpha's codes: the account's default, and another.
    default_code: String,
    other_code: String,
    account: String,
}

async fn code(w: &World, slug: &str, cookie: &str, name: &str) -> String {
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
        Some(json!({ "parentId": category, "name": name, "isActive": true })),
    )
    .await["versionId"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn new_account(
    w: &World,
    slug: &str,
    cookie: &str,
    name: &str,
    default_code: Option<&str>,
) -> String {
    let mut a = json!({ "name": name, "sortCode": "40-52-40", "accountLast4": "1234",
        "active": true });
    if let Some(c) = default_code {
        a["defaultSourceCodeId"] = json!(c);
    }
    ok(
        w,
        "POST",
        &format!("/api/t/{slug}/bank/accounts"),
        cookie,
        Some(a),
    )
    .await["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn setup() -> M {
    let w = world();
    for t in [&w.alpha, &w.beta] {
        let db = w.store.org(&t.id).unwrap();
        contracts::transact(&db, None, api::schema::seed_new_org).unwrap();
    }
    let ann = w.login("ann@alpha.org").await;
    let sam = w.login("sam@alpha.org").await;
    let val = w.login("val@alpha.org").await;
    let bob = w.login("bob@beta.org").await;
    let default_code = code(&w, "alpha", &ann, "Unsolicited transfer").await;
    let other_code = code(&w, "alpha", &ann, "Spring appeal").await;
    let account = new_account(&w, "alpha", &ann, "CAF current", Some(&default_code)).await;
    M {
        w,
        ann,
        sam,
        val,
        bob,
        default_code,
        other_code,
        account,
    }
}

impl M {
    /// Import credits into `account` as `cookie`; answers the new lines,
    /// in posted order.
    async fn import(
        &self,
        slug: &str,
        cookie: &str,
        account: &str,
        credits: &[Credit<'_>],
    ) -> Vec<Value> {
        let layout = "%7B%22kind%22%3A%22ofx%22%7D";
        let req = Request::builder()
            .method("POST")
            .uri(format!(
                "/api/t/{slug}/bank/imports?accountId={account}&fileName=s.ofx&layout={layout}"
            ))
            .header(header::COOKIE, cookie)
            .header(header::CONTENT_TYPE, "application/x-ofx")
            .body(HttpBody::from(ofx(credits)))
            .unwrap();
        let res = self.w.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let body = res.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        let import: Value = serde_json::from_slice(&body).unwrap();
        let detail = ok(
            &self.w,
            "GET",
            &format!(
                "/api/t/{slug}/bank/imports/{}",
                import["id"].as_str().unwrap()
            ),
            cookie,
            None,
        )
        .await;
        detail["lines"].as_array().unwrap().clone()
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

    async fn version(&self, id: &str) -> i64 {
        self.line(id).await["line"]["matchVersion"]
            .as_i64()
            .unwrap()
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

    async fn contact(&self, first: &str, last: &str) -> (String, i64) {
        let c = ok(
            &self.w,
            "POST",
            "/api/t/alpha/contacts",
            &self.ann,
            Some(person(first, last)),
        )
        .await;
        (
            c["id"].as_str().unwrap().to_owned(),
            c["number"].as_i64().unwrap(),
        )
    }

    /// A transfer entered by hand for an existing contact.
    async fn by_hand(&self, contact: &str, days_ago_n: i64, pence: i64) -> String {
        ok(
            &self.w,
            "POST",
            "/api/t/alpha/gifts/record",
            &self.sam,
            Some(json!({
                "clientKey": contracts::new_id(),
                "contact": contact,
                "receivedOn": days_ago(days_ago_n),
                "amount": pence,
                "method": "bank_transfer",
                "allocations": [{ "sourceCodeId": self.other_code, "amount": pence }],
            })),
        )
        .await["giftId"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    async fn gift(&self, id: &str) -> Value {
        ok(
            &self.w,
            "GET",
            &format!("/api/t/alpha/gifts/{id}"),
            &self.ann,
            None,
        )
        .await
    }

    async fn gifts_from(
        &self,
        line: &str,
        parts: Value,
        remainder: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut body = json!({ "expected": self.version(line).await, "parts": parts });
        if let Some(r) = remainder {
            body["remainder"] = r;
        }
        self.post(&format!("bank/lines/{line}/gifts"), body).await
    }

    async fn unmatch(&self, line: &str) -> Value {
        let (s, out) = self
            .post(
                &format!("bank/lines/{line}/unmatch"),
                json!({ "expected": self.version(line).await }),
            )
            .await;
        assert_eq!(s, StatusCode::OK, "{out}");
        out
    }

    fn db(&self) -> std::sync::Arc<store::OrgDb> {
        self.w.store.org(&self.w.alpha.id).unwrap()
    }
}

fn id(v: &Value) -> String {
    v["id"].as_str().unwrap().to_owned()
}

fn written(number: i64) -> String {
    contacts::number::format_number(number)
}

// ── gifts from lines ───────────────────────────────────────────────────────

/// A gift made from a line is dated the line's posted date for the line's
/// amount, a bank transfer carrying its reference; staff can't change
/// its amount or date. The code: the contact's acquisition code, else
/// the account's default (g2q6), else the one picked.
#[tokio::test]
async fn a_gift_from_a_line_takes_its_date_and_amount_and_staff_cant_edit_them() {
    let m = setup().await;
    let (jo, _) = m.contact("Jo", "Bloggs").await;
    let lines = m
        .import(
            "alpha",
            &m.sam,
            &m.account,
            &[Credit {
                days_ago: 3,
                pence: 5000,
                payer: "J BLOGGS",
                reference: "GIFT",
            }],
        )
        .await;
    let line = id(&lines[0]);
    let (s, out) = m
        .gifts_from(&line, json!([{ "contact": jo, "amount": 5000 }]), None)
        .await;
    assert_eq!(s, StatusCode::OK, "{out}");
    assert_eq!(out["line"]["state"], "matched");
    assert_eq!(out["gifts"][0]["fromLine"], true);
    let gift = out["gifts"][0]["id"].as_str().unwrap().to_owned();
    let g = m.gift(&gift).await;
    assert_eq!(
        (
            g["receivedOn"].as_str(),
            g["amount"].as_i64(),
            g["method"].as_str()
        ),
        (
            Some(days_ago(3).as_str()),
            Some(5000),
            Some("bank_transfer")
        )
    );
    assert_eq!(g["reference"], "GIFT");
    assert_eq!(g["madeFromLine"], true);
    assert_eq!(g["allocations"][0]["sourceCodeId"], m.default_code.as_str());

    let mut save = g.clone();
    save["expected"] = g["giftVersion"].clone();
    save["amount"] = json!(4000);
    save["allocations"][0]["amount"] = json!(4000);
    let (s, reason) = refused(
        &m.w,
        "POST",
        &format!("/api/t/alpha/gifts/{gift}/save"),
        &m.sam,
        Some(save),
    )
    .await;
    assert_eq!(
        (s, reason.as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, "line_fixed")
    );

    // An explicit code wins; with no acquisition code and no default,
    // staff must pick one.
    let bare = new_account(&m.w, "alpha", &m.ann, "Unity deposit", None).await;
    let more = m
        .import(
            "alpha",
            &m.sam,
            &bare,
            &[
                Credit {
                    days_ago: 2,
                    pence: 700,
                    payer: "J BLOGGS",
                    reference: "",
                },
                Credit {
                    days_ago: 2,
                    pence: 800,
                    payer: "J BLOGGS",
                    reference: "",
                },
            ],
        )
        .await;
    let (s, out) = m
        .gifts_from(
            &id(&more[0]),
            json!([{ "contact": jo, "amount": 700 }]),
            None,
        )
        .await;
    assert_eq!(
        (s, out["problems"][0]["field"].as_str()),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Some("parts[0].sourceCodeId")
        )
    );
    let (s, out) = m
        .gifts_from(
            &id(&more[0]),
            json!([{ "contact": jo, "amount": 700, "sourceCodeId": m.other_code }]),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{out}");
    let g = m.gift(out["gifts"][0]["id"].as_str().unwrap()).await;
    assert_eq!(g["allocations"][0]["sourceCodeId"], m.other_code.as_str());
}

/// The match form's inline new contact: created with the gift's code as
/// its acquisition code, in the same command.
#[tokio::test]
async fn an_unknown_payer_becomes_a_new_contact_inline() {
    let m = setup().await;
    let lines = m
        .import(
            "alpha",
            &m.sam,
            &m.account,
            &[Credit {
                days_ago: 1,
                pence: 2500,
                payer: "NEW DONOR",
                reference: "",
            }],
        )
        .await;
    let (s, out) = m
        .gifts_from(
            &id(&lines[0]),
            json!([{ "contact": { "kind": "individual", "firstName": "Nia", "lastName": "Newman",
                "name": "", "email": "nia@example.org" }, "amount": 2500 }]),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{out}");
    let contact = out["gifts"][0]["contactId"].as_str().unwrap();
    assert_eq!(out["gifts"][0]["contactName"], "Nia Newman");
    let c = ok(
        &m.w,
        "GET",
        &format!("/api/t/alpha/contacts/{contact}"),
        &m.ann,
        None,
    )
    .await;
    assert_eq!(
        c["acquisition"]["versionId"],
        m.default_code.as_str(),
        "{c}"
    );
}

// ── money ──────────────────────────────────────────────────────────────────

/// g1q6: a line splits across contacts; the parts and the remainder add
/// up to the line exactly, in pence, or it's 422 and nothing is written.
/// A remainder needs its note, kept on the line.
#[tokio::test]
async fn a_split_must_add_up_to_the_line_exactly() {
    let m = setup().await;
    let (a, _) = m.contact("Ann", "Couple").await;
    let (b, _) = m.contact("Bill", "Couple").await;
    let lines = m
        .import(
            "alpha",
            &m.sam,
            &m.account,
            &[Credit {
                days_ago: 2,
                pence: 10_001,
                payer: "MR AND MRS COUPLE",
                reference: "",
            }],
        )
        .await;
    let line = id(&lines[0]);
    for (parts, remainder) in [
        (
            json!([{ "contact": a, "amount": 5000 }, { "contact": b, "amount": 5000 }]),
            None,
        ),
        (
            json!([{ "contact": a, "amount": 5000 }, { "contact": b, "amount": 5002 }]),
            None,
        ),
        (
            json!([{ "contact": a, "amount": 10_001 }, { "contact": b, "amount": 0 }]),
            None,
        ),
        (
            json!([{ "contact": a, "amount": 5000 }]),
            Some(json!({ "amount": 5001, "note": " " })),
        ),
        (
            json!([{ "contact": a, "amount": 9_223_372_036_854_775_807i64 }, { "contact": b, "amount": 2 }]),
            None,
        ),
    ] {
        let (s, out) = m.gifts_from(&line, parts.clone(), remainder).await;
        assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{parts}: {out}");
        assert_eq!(out["kind"], "invalid");
    }
    assert_eq!(m.line(&line).await["line"]["state"], "unmatched");
    assert!(
        ok(
            &m.w,
            "GET",
            &format!("/api/t/alpha/contacts/{a}/gifts"),
            &m.ann,
            None
        )
        .await["rows"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    let (s, out) = m
        .gifts_from(
            &line,
            json!([{ "contact": a, "amount": 4000 }, { "contact": b, "amount": 4000 }]),
            Some(json!({ "amount": 2001, "note": "Raffle tickets" })),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{out}");
    assert_eq!(out["gifts"].as_array().unwrap().len(), 2);
    assert_eq!(out["line"]["note"], "Raffle tickets");
}

// ── matching to what's there ───────────────────────────────────────────────

/// A transfer entered by hand is matched to its line: linked, no longer
/// "not on a statement yet". Gifts that don't add up to the line are 422.
#[tokio::test]
async fn a_line_is_matched_to_a_transfer_entered_by_hand() {
    let m = setup().await;
    let (jo, _) = m.contact("Jo", "Bloggs").await;
    let gift = m.by_hand(&jo, 4, 2000).await;
    assert_eq!(m.gift(&gift).await["notOnAStatement"], true);
    let lines = m
        .import(
            "alpha",
            &m.sam,
            &m.account,
            &[Credit {
                days_ago: 3,
                pence: 2500,
                payer: "J BLOGGS",
                reference: "",
            }],
        )
        .await;
    let line = id(&lines[0]);
    let (s, _) = m
        .post(
            &format!("bank/lines/{line}/match-gifts"),
            json!({ "expected": m.version(&line).await, "giftIds": [gift] }),
        )
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    let (s, out) = m
        .post(
            &format!("bank/lines/{line}/match-gifts"),
            json!({ "expected": m.version(&line).await, "giftIds": [gift],
                "remainder": { "amount": 500, "note": "Refund of a ticket" } }),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{out}");
    assert_eq!(out["gifts"][0]["fromLine"], false);
    let g = m.gift(&gift).await;
    assert_eq!(
        (g["notOnAStatement"].as_bool(), g["bankLineId"].as_str()),
        (Some(false), Some(line.as_str()))
    );
}

/// Not a donation, with a note; and the line can't then take gifts.
#[tokio::test]
async fn a_line_is_marked_not_a_donation_with_a_note() {
    let m = setup().await;
    let lines = m
        .import(
            "alpha",
            &m.sam,
            &m.account,
            &[Credit {
                days_ago: 1,
                pence: 120_000,
                payer: "GOCARDLESS",
                reference: "PAYOUT",
            }],
        )
        .await;
    let line = id(&lines[0]);
    let (s, out) = m
        .post(
            &format!("bank/lines/{line}/not-donation"),
            json!({ "expected": m.version(&line).await, "note": " " }),
        )
        .await;
    assert_eq!(
        (s, out["problems"][0]["field"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("note"))
    );
    let (s, out) = m
        .post(
            &format!("bank/lines/{line}/not-donation"),
            json!({ "expected": m.version(&line).await, "note": "GoCardless payout" }),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{out}");
    assert_eq!(
        (out["line"]["state"].as_str(), out["line"]["note"].as_str()),
        (Some("not_donation"), Some("GoCardless payout"))
    );
    let (s, reason) = refused(
        &m.w,
        "POST",
        &format!("/api/t/alpha/bank/lines/{line}/gifts"),
        &m.sam,
        Some(json!({ "expected": m.version(&line).await, "parts": [] })),
    )
    .await;
    assert_eq!(
        (s, reason.as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, "line_matched")
    );
}

/// A paying-in batch (opened and closed by its own pages) is matched to
/// its line here: its cheques clear; unmatching the line pends them again.
#[tokio::test]
async fn a_line_is_matched_to_a_paying_in_batch_and_its_cheques_follow() {
    let m = setup().await;
    let (jo, _) = m.contact("Jo", "Bloggs").await;
    let db = m.db();
    let (batch, cheque) = contracts::transact(&db, Some(1), |ctx| {
        let b = contracts::execute(
            ctx,
            &giving::PAYING_IN_BATCH,
            giving::types::PayingInBatchPayload {
                account_id: m.account.clone(),
                slip_number: "000123".into(),
                banked_on: None,
                total: None,
                status: giving::types::BatchStatus::Open,
            },
            contracts::Exec::create(Source::Ui),
        )?
        .id;
        let cheque = giving::create_gift(
            ctx,
            giving::types::GiftPayload {
                contact_id: jo.clone(),
                received_on: days_ago(5),
                amount: 3000,
                method: giving::types::Method::Cheque,
                reference: Some("000456".into()),
                allocations: vec![giving::types::AllocationRow {
                    key: None,
                    source_code_id: m.other_code.clone(),
                    amount: 3000,
                }],
                client_key: None,
                origin: None,
                from_line: None,
                paying_in_batch_id: Some(b.clone()),
                instalment: None,
            },
            Source::Ui,
            None,
        )?;
        contracts::execute(
            ctx,
            &giving::PAYING_IN_BATCH,
            giving::types::PayingInBatchPayload {
                account_id: m.account.clone(),
                slip_number: "000123".into(),
                banked_on: Some(days_ago(4)),
                total: Some(3000),
                status: giving::types::BatchStatus::Closed,
            },
            contracts::Exec::update(&b, Some(0), Source::Ui),
        )?;
        Ok::<_, contracts::ContractError>((b, cheque))
    })
    .unwrap();
    assert_eq!(m.gift(&cheque).await["status"], "pending");
    let lines = m
        .import(
            "alpha",
            &m.sam,
            &m.account,
            &[Credit {
                days_ago: 3,
                pence: 3000,
                payer: "",
                reference: "000123",
            }],
        )
        .await;
    let line = id(&lines[0]);
    let (s, out) = m
        .post(
            &format!("bank/lines/{line}/match-batch"),
            json!({ "expected": m.version(&line).await, "batchId": batch, "batchLineVersion": 0 }),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{out}");
    assert_eq!(out["batchId"], batch.as_str());
    assert_eq!(m.gift(&cheque).await["status"], "completed");
    let out = m.unmatch(&line).await;
    assert_eq!(
        (out["line"]["state"].as_str(), &out["batchId"]),
        (Some("unmatched"), &Value::Null)
    );
    assert_eq!(m.gift(&cheque).await["status"], "pending");
}

// ── unmatch ────────────────────────────────────────────────────────────────

/// Unmatching voids the gifts made from the line and only unlinks the
/// ones entered by hand ("not on a statement yet" again). Voiding a gift
/// made from a line by hand frees the line too.
#[tokio::test]
async fn unmatch_voids_the_gifts_made_from_the_line_and_unlinks_the_rest() {
    let m = setup().await;
    let (jo, _) = m.contact("Jo", "Bloggs").await;
    let (al, _) = m.contact("Al", "Other").await;
    let by_hand = m.by_hand(&al, 2, 1000).await;
    let lines = m
        .import(
            "alpha",
            &m.sam,
            &m.account,
            &[
                Credit {
                    days_ago: 2,
                    pence: 6000,
                    payer: "J BLOGGS",
                    reference: "",
                },
                Credit {
                    days_ago: 2,
                    pence: 900,
                    payer: "J BLOGGS",
                    reference: "",
                },
            ],
        )
        .await;
    let line = id(&lines[0]);
    let out = m
        .gifts_from(
            &line,
            json!([{ "contact": jo, "amount": 5000 }]),
            Some(json!({ "amount": 1000, "note": "x" })),
        )
        .await
        .1;
    let made = out["gifts"][0]["id"].as_str().unwrap().to_owned();
    // The line takes the hand-entered one too? No: it's matched already.
    let (s, reason) = refused(
        &m.w,
        "POST",
        &format!("/api/t/alpha/bank/lines/{line}/match-gifts"),
        &m.sam,
        Some(json!({ "expected": m.version(&line).await, "giftIds": [by_hand] })),
    )
    .await;
    assert_eq!(
        (s, reason.as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, "line_matched")
    );
    m.unmatch(&line).await;
    let (s, _) = m
        .post(
            &format!("bank/lines/{line}/match-gifts"),
            json!({ "expected": m.version(&line).await,
            "giftIds": [by_hand], "remainder": { "amount": 5000, "note": "rest" } }),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(m.gift(&made).await["status"], "void");

    let out = m.unmatch(&line).await;
    assert_eq!(out["line"]["state"], "unmatched");
    assert_eq!(out["gifts"], json!([]));
    let h = m.gift(&by_hand).await;
    assert_eq!(
        (h["status"].as_str(), h["notOnAStatement"].as_bool()),
        (Some("completed"), Some(true))
    );

    // Voiding the only gift made from a line, from the gift's page, frees it.
    let small = id(&lines[1]);
    let out = m
        .gifts_from(&small, json!([{ "contact": jo, "amount": 900 }]), None)
        .await
        .1;
    let g = m.gift(out["gifts"][0]["id"].as_str().unwrap()).await;
    ok(
        &m.w,
        "POST",
        &format!("/api/t/alpha/gifts/{}/status", g["id"].as_str().unwrap()),
        &m.sam,
        Some(json!({ "expected": g["statusVersion"], "status": "void" })),
    )
    .await;
    assert_eq!(m.line(&small).await["line"]["state"], "unmatched");
}

/// The unmatch rule end to end: a gift made from a line, claimed for Gift
/// Aid in a submitted claim, then the line unmatched: the gift is void
/// with the unmatch's reason, and the next claim repays it as an
/// adjustment.
#[tokio::test]
async fn a_claimed_gift_voided_by_an_unmatch_is_an_adjustment_in_the_next_claim() {
    let m = setup().await;
    // A donor with a declaration and a home address, from a cash gift.
    let rec = ok(&m.w, "POST", "/api/t/alpha/gifts/record", &m.ann, Some(json!({
        "clientKey": contracts::new_id(),
        "contact": { "kind": "individual", "firstName": "Ann", "lastName": "Smith", "name": "" },
        "home": { "line1": "12 High Street", "postcode": "ls1 1aa" },
        "giftAid": {},
        "receivedOn": days_ago(10), "amount": 1000, "method": "cash",
        "allocations": [{ "sourceCodeId": m.other_code, "amount": 1000 }],
    }))).await;
    let ann_smith = rec["contactId"].as_str().unwrap().to_owned();
    let lines = m
        .import(
            "alpha",
            &m.sam,
            &m.account,
            &[Credit {
                days_ago: 5,
                pence: 4000,
                payer: "A SMITH",
                reference: "",
            }],
        )
        .await;
    let line = id(&lines[0]);
    let made = m
        .gifts_from(
            &line,
            json!([{ "contact": ann_smith, "amount": 4000 }]),
            None,
        )
        .await
        .1["gifts"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    ok(
        &m.w,
        "POST",
        "/api/t/alpha/giftaid/hmrc-details",
        &m.ann,
        Some(json!({
            "hmrcReference": "ab12345", "regulator": "ccew", "regulatorNumber": "1234567",
            "officialTitle": "Mrs", "officialFirstName": "Jane", "officialLastName": "Doe",
            "officialPostcode": "ls1 1aa", "officialPhone": "0113 496 0000",
        })),
    )
    .await;
    let today = days_ago(0);
    let claim = ok(
        &m.w,
        "POST",
        "/api/t/alpha/giftaid/claims",
        &m.ann,
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
            &m.w,
            "GET",
            &format!("/api/t/alpha/giftaid/claims/{claim_id}"),
            &m.ann,
            None,
        )
        .await;
        let mut body = step;
        body["expected"] = v["statusVersion"].clone();
        ok(
            &m.w,
            "POST",
            &format!("/api/t/alpha/giftaid/claims/{claim_id}/status"),
            &m.ann,
            Some(body),
        )
        .await;
    }

    m.unmatch(&line).await;
    let g = m.gift(&made).await;
    assert_eq!(
        (g["status"].as_str(), g["voidReason"].as_str()),
        (Some("void"), Some(giving::bank::LINE_UNMATCHED_REASON))
    );
    let preview = ok(
        &m.w,
        "GET",
        &format!("/api/t/alpha/giftaid/claims/preview?periodEnd={today}"),
        &m.ann,
        None,
    )
    .await;
    let adjustments = preview["adjustments"].as_array().unwrap();
    assert_eq!(adjustments.len(), 1, "{preview}");
    assert_eq!(adjustments[0]["giftId"], made.as_str());
    assert_eq!(adjustments[0]["originalClaimId"], claim_id.as_str());
    assert_eq!(
        adjustments[0]["reason"],
        giving::bank::LINE_UNMATCHED_REASON
    );
    assert_eq!(
        adjustments[0]["amount"], 1000,
        "the tax its line claimed: 4000 / 4"
    );
}

// ── never optimistic ───────────────────────────────────────────────────────

/// An import adds lines and no gifts: an unmatched line counts for
/// nothing. "Accept ticked" applies only the lines sent, each on its own:
/// one matched meanwhile is 409 stale and the others still apply.
#[tokio::test]
async fn accept_ticked_applies_only_the_ticked_lines_still_unmatched() {
    let m = setup().await;
    let (jo, number) = m.contact("Jo", "Bloggs").await;
    let (al, al_number) = m.contact("Al", "Other").await;
    let imported = m
        .import(
            "alpha",
            &m.sam,
            &m.account,
            &[
                Credit {
                    days_ago: 3,
                    pence: 2000,
                    payer: "J BLOGGS",
                    reference: &written(number),
                },
                Credit {
                    days_ago: 3,
                    pence: 3000,
                    payer: "A OTHER",
                    reference: &written(al_number),
                },
                Credit {
                    days_ago: 3,
                    pence: 4000,
                    payer: "UNTICKED",
                    reference: &written(al_number),
                },
            ],
        )
        .await;
    assert_eq!(imported.len(), 3);
    assert!(
        ok(
            &m.w,
            "GET",
            &format!("/api/t/alpha/contacts/{jo}/gifts"),
            &m.ann,
            None
        )
        .await["rows"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let rows = ok(
        &m.w,
        "GET",
        &format!("/api/t/alpha/bank/accounts/{}/lines", m.account),
        &m.sam,
        None,
    )
    .await;
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 3);
    let ticked: Vec<Value> = rows[..2]
        .iter()
        .map(|r| {
            let s = &r["suggestions"][0];
            assert_eq!(
                (s["confidence"].as_str(), s["ticked"].as_bool()),
                (Some("strong"), Some(true)),
                "{r}"
            );
            json!({ "lineId": r["id"], "expected": r["matchVersion"], "proposal": s["proposal"] })
        })
        .collect();
    // Someone matches the second line meanwhile.
    let second = rows[1]["id"].as_str().unwrap();
    m.gifts_from(second, json!([{ "contact": al, "amount": 3000 }]), None)
        .await;

    let out = ok(
        &m.w,
        "POST",
        "/api/t/alpha/bank/accept",
        &m.sam,
        Some(json!({ "items": ticked })),
    )
    .await;
    assert_eq!(out[0]["status"], 200, "{out}");
    assert_eq!(out[0]["line"]["line"]["state"], "matched");
    assert_eq!(out[0]["line"]["gifts"][0]["contactId"], jo.as_str());
    assert_eq!(
        (out[1]["status"].as_i64(), out[1]["error"]["kind"].as_str()),
        (Some(409), Some("stale"))
    );
    // The unticked line is untouched; the stale one holds only the other match.
    assert_eq!(
        m.line(rows[2]["id"].as_str().unwrap()).await["line"]["state"],
        "unmatched"
    );
    assert_eq!(m.line(second).await["gifts"].as_array().unwrap().len(), 1);
}

// ── suggesters ─────────────────────────────────────────────────────────────

/// A Luhn-valid contact number in the reference is strong on its own
/// (the reference names the donor; a new gift takes the line's amount and
/// date), and proposes the donor's transfer entered by hand when one
/// waits; a wrong check digit isn't strong; a name alone is never strong
/// or pre-ticked, and never offers a new gift for a donor whose waiting
/// gift is proposed (review b4r L1, L2).
#[tokio::test]
async fn a_valid_contact_number_is_strong_on_its_own_and_names_never() {
    let m = setup().await;
    let (jo, number) = m.contact("Jo", "Bloggs").await;
    let (sue, sue_number) = m.contact("Sue", "Waiting").await;
    let waiting = m.by_hand(&sue, 1, 1500).await;
    let good = written(number);
    let bad = format!(
        "{number}{}",
        (contacts::number::check_digit(number) + 1) % 10
    );
    let lines = m
        .import(
            "alpha",
            &m.sam,
            &m.account,
            &[
                Credit {
                    days_ago: 2,
                    pence: 2000,
                    payer: "X",
                    reference: &good,
                },
                Credit {
                    days_ago: 2,
                    pence: 2000,
                    payer: "Y",
                    reference: &bad,
                },
                Credit {
                    days_ago: 2,
                    pence: 2000,
                    payer: "J BLOGGS",
                    reference: "",
                },
                Credit {
                    days_ago: 2,
                    pence: 1500,
                    payer: "S WAITING",
                    reference: &written(sue_number),
                },
            ],
        )
        .await;
    let s = &m.line(&id(&lines[0])).await["suggestions"];
    assert_eq!(
        s[0]["proposal"],
        json!({ "kind": "newGift", "contactId": jo })
    );
    assert_eq!(
        (s[0]["confidence"].as_str(), s[0]["ticked"].as_bool()),
        (Some("strong"), Some(true))
    );
    assert!(s[0]["reason"].as_str().unwrap().contains(&good));

    let s = m.line(&id(&lines[1])).await["suggestions"].clone();
    assert!(
        s.as_array()
            .unwrap()
            .iter()
            .all(|x| x["confidence"] != "strong"),
        "{s}"
    );

    let s = m.line(&id(&lines[2])).await["suggestions"].clone();
    assert_eq!(s[0]["suggesters"], json!(["nameOnly"]), "{s}");
    assert_eq!(s[0]["proposal"]["contactId"], jo.as_str());
    assert_eq!(
        (s[0]["confidence"].as_str(), s[0]["ticked"].as_bool()),
        (Some("suggested"), Some(false))
    );

    let s = &m.line(&id(&lines[3])).await["suggestions"];
    assert_eq!(
        s[0]["proposal"],
        json!({ "kind": "existingGifts", "giftIds": [waiting] })
    );
    assert_eq!(s[0]["confidence"], "strong");
    assert!(
        s.as_array()
            .unwrap()
            .iter()
            .all(|x| x["proposal"] != json!({ "kind": "newGift", "contactId": sue })),
        "no new gift for Sue beside her waiting one: {s}"
    );
}

/// A gift entered by hand for the line's amount, near its date, is
/// suggested on its own (not strong: nothing says it's the same donor).
#[tokio::test]
async fn a_transfer_entered_by_hand_is_suggested_for_its_line() {
    let m = setup().await;
    let (jo, _) = m.contact("Jo", "Bloggs").await;
    let near = m.by_hand(&jo, 5, 2500).await;
    m.by_hand(&jo, 30, 2500).await;
    let lines = m
        .import(
            "alpha",
            &m.sam,
            &m.account,
            &[Credit {
                days_ago: 2,
                pence: 2500,
                payer: "SOMEONE",
                reference: "",
            }],
        )
        .await;
    let s = &m.line(&id(&lines[0])).await["suggestions"];
    let hand: Vec<&Value> = s
        .as_array()
        .unwrap()
        .iter()
        .filter(|x| x["suggesters"] == json!(["handEntered"]))
        .collect();
    assert_eq!(hand.len(), 1, "{s}");
    assert_eq!(hand[0]["proposal"]["giftIds"], json!([near]));
    assert_eq!(hand[0]["confidence"], "suggested");
}

/// A payer matched once is remembered for the next line from the same
/// payer and reference on that account: strong at the same amount.
/// Forgetting the contact's payers (erasure, rule 3) clears them, leaves
/// their gifts and the lines as they were, and no rebuild brings them
/// back; a match after the forget is remembered again.
#[tokio::test]
async fn a_known_payer_is_suggested_until_forgotten_and_erasure_keeps_the_money() {
    let m = setup().await;
    let (jo, _) = m.contact("Jo", "Bloggs").await;
    let (al, _) = m.contact("Al", "Other").await;
    let lines = m
        .import(
            "alpha",
            &m.sam,
            &m.account,
            &[
                Credit {
                    days_ago: 40,
                    pence: 1000,
                    payer: "JB HOUSEHOLD",
                    reference: "SO 77",
                },
                Credit {
                    days_ago: 10,
                    pence: 1000,
                    payer: "JB HOUSEHOLD",
                    reference: "SO 77",
                },
            ],
        )
        .await;
    let (first, second) = (id(&lines[0]), id(&lines[1]));
    assert!(
        m.line(&second).await["suggestions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["suggesters"] != json!(["knownPayer"]))
    );
    m.gifts_from(&first, json!([{ "contact": jo, "amount": 1000 }]), None)
        .await;
    let s = &m.line(&second).await["suggestions"];
    assert_eq!(s[0]["suggesters"], json!(["knownPayer"]), "{s}");
    assert_eq!(
        (
            s[0]["proposal"]["contactId"].as_str(),
            s[0]["confidence"].as_str()
        ),
        (Some(jo.as_str()), Some("strong"))
    );

    let db = m.db();
    let read =
        |db: &store::OrgDb, c: &str| db.read(|r| banking::matching::payers_of(r, c)).unwrap();
    assert_eq!(read(&db, &jo).len(), 1);
    let gift = m.line(&first).await["gifts"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    contracts::transact(&db, Some(1), |ctx| {
        banking::forget_payers(ctx, &jo, Source::Ui, None)
    })
    .unwrap();
    assert!(read(&db, &jo).is_empty());
    assert!(
        m.line(&second).await["suggestions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["suggesters"] != json!(["knownPayer"]))
    );
    let g = m.gift(&gift).await;
    assert_eq!(
        (g["status"].as_str(), g["amount"].as_i64()),
        (Some("completed"), Some(1000))
    );
    let l = m.line(&first).await["line"].clone();
    assert_eq!(
        (l["amount"].as_i64(), l["postedOn"].as_str()),
        (Some(1000), Some(days_ago(40).as_str()))
    );

    // A rebuild of that key (another contact matched to it) keeps Jo out.
    m.gifts_from(&second, json!([{ "contact": al, "amount": 1000 }]), None)
        .await;
    assert!(read(&db, &jo).is_empty());
    assert_eq!(read(&db, &al).len(), 1);
    // A match after the forget teaches Jo again.
    let third = m
        .import(
            "alpha",
            &m.sam,
            &m.account,
            &[Credit {
                days_ago: 1,
                pence: 1000,
                payer: "JB HOUSEHOLD",
                reference: "SO 77",
            }],
        )
        .await;
    m.gifts_from(
        &id(&third[0]),
        json!([{ "contact": jo, "amount": 1000 }]),
        None,
    )
    .await;
    assert_eq!(read(&db, &jo).len(), 1);
}

/// Not-a-donation rules: created, listed, suggested (strong, pre-ticked,
/// never applied by themselves), and deleted.
#[tokio::test]
async fn rules_suggest_not_a_donation_until_deleted() {
    let m = setup().await;
    let rule = ok(
        &m.w,
        "POST",
        "/api/t/alpha/bank/rules",
        &m.sam,
        Some(json!({ "field": "payer", "contains": "gocardless", "note": "GoCardless payout" })),
    )
    .await;
    let (s, out) = m
        .post("bank/rules", json!({ "field": "payer", "contains": "  " }))
        .await;
    assert_eq!(
        (s, out["problems"][0]["field"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("contains"))
    );
    assert_eq!(
        ok(&m.w, "GET", "/api/t/alpha/bank/rules", &m.sam, None)
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let lines = m
        .import(
            "alpha",
            &m.sam,
            &m.account,
            &[Credit {
                days_ago: 1,
                pence: 99_000,
                payer: "GOCARDLESS LTD",
                reference: "",
            }],
        )
        .await;
    let line = id(&lines[0]);
    let s = &m.line(&line).await["suggestions"][0];
    assert_eq!(s["proposal"]["kind"], "notDonation");
    assert_eq!(s["proposal"]["note"], "GoCardless payout");
    assert_eq!(
        (s["confidence"].as_str(), s["ticked"].as_bool()),
        (Some("strong"), Some(true))
    );
    assert_eq!(m.line(&line).await["line"]["state"], "unmatched");

    ok(
        &m.w,
        "POST",
        &format!(
            "/api/t/alpha/bank/rules/{}/delete",
            rule["id"].as_str().unwrap()
        ),
        &m.sam,
        Some(json!({ "expected": rule["version"] })),
    )
    .await;
    assert!(
        ok(&m.w, "GET", "/api/t/alpha/bank/rules", &m.sam, None)
            .await
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        m.line(&line).await["suggestions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

// ── roles and isolation ────────────────────────────────────────────────────

/// Viewers never see statement lines (g1q9): 403 on every route here.
/// Staff match.
#[tokio::test]
async fn viewers_get_403_on_every_matching_route_and_staff_match() {
    let m = setup().await;
    let lines = m
        .import(
            "alpha",
            &m.sam,
            &m.account,
            &[Credit {
                days_ago: 1,
                pence: 500,
                payer: "X",
                reference: "",
            }],
        )
        .await;
    let line = id(&lines[0]);
    let routes = [
        (
            "GET",
            format!("/api/t/alpha/bank/accounts/{}/lines", m.account),
        ),
        ("GET", format!("/api/t/alpha/bank/lines/{line}")),
        ("GET", "/api/t/alpha/bank/rules".to_owned()),
        ("POST", format!("/api/t/alpha/bank/lines/{line}/gifts")),
        (
            "POST",
            format!("/api/t/alpha/bank/lines/{line}/match-gifts"),
        ),
        (
            "POST",
            format!("/api/t/alpha/bank/lines/{line}/match-batch"),
        ),
        (
            "POST",
            format!("/api/t/alpha/bank/lines/{line}/not-donation"),
        ),
        ("POST", format!("/api/t/alpha/bank/lines/{line}/unmatch")),
        ("POST", "/api/t/alpha/bank/accept".to_owned()),
        ("POST", "/api/t/alpha/bank/rules".to_owned()),
        ("POST", format!("/api/t/alpha/bank/rules/{line}/delete")),
    ];
    for (method, path) in &routes {
        let body = (*method == "POST").then(|| json!({}));
        let (s, _) = m.w.call(method, path, &m.val, body).await;
        assert_eq!(s, StatusCode::FORBIDDEN, "{method} {path}");
    }
    let (s, out) = m
        .post(
            &format!("bank/lines/{line}/not-donation"),
            json!({ "expected": m.version(&line).await, "note": "Refund" }),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{out}");
}

/// Two organisations: B never sees A's lines or rules, A's ids under B's
/// slug are 404, and B's suggestions never name A's contacts (they read
/// only B's file).
#[tokio::test]
async fn b_never_sees_a_s_lines_and_suggestions_stay_in_their_file() {
    let m = setup().await;
    let (_, number) = m.contact("Jo", "Bloggs").await;
    let a_lines = m
        .import(
            "alpha",
            &m.sam,
            &m.account,
            &[Credit {
                days_ago: 1,
                pence: 500,
                payer: "J BLOGGS",
                reference: &written(number),
            }],
        )
        .await;
    let a_line = id(&a_lines[0]);
    let a_rule = ok(
        &m.w,
        "POST",
        "/api/t/alpha/bank/rules",
        &m.sam,
        Some(json!({ "field": "payer", "contains": "BLOGGS" })),
    )
    .await;
    let b_account = new_account(&m.w, "beta", &m.bob, "CAF current", None).await;
    let b_lines = m
        .import(
            "beta",
            &m.bob,
            &b_account,
            &[Credit {
                days_ago: 1,
                pence: 500,
                payer: "J BLOGGS",
                reference: &written(number),
            }],
        )
        .await;
    let b = ok(
        &m.w,
        "GET",
        &format!("/api/t/beta/bank/lines/{}", id(&b_lines[0])),
        &m.bob,
        None,
    )
    .await;
    assert_eq!(
        b["suggestions"],
        json!([]),
        "B has no Jo Bloggs and no rule: {b}"
    );
    assert!(
        ok(&m.w, "GET", "/api/t/beta/bank/rules", &m.bob, None)
            .await
            .as_array()
            .unwrap()
            .is_empty()
    );
    for (method, path, body) in [
        (
            "GET",
            format!("/api/t/beta/bank/accounts/{}/lines", m.account),
            None,
        ),
        ("GET", format!("/api/t/beta/bank/lines/{a_line}"), None),
        (
            "POST",
            format!("/api/t/beta/bank/lines/{a_line}/gifts"),
            Some(json!({ "expected": 0, "parts": [] })),
        ),
        (
            "POST",
            format!("/api/t/beta/bank/lines/{a_line}/match-gifts"),
            Some(json!({ "expected": 0, "giftIds": [] })),
        ),
        (
            "POST",
            format!("/api/t/beta/bank/lines/{a_line}/match-batch"),
            Some(json!({ "expected": 0, "batchId": a_line, "batchLineVersion": 0 })),
        ),
        (
            "POST",
            format!("/api/t/beta/bank/lines/{a_line}/not-donation"),
            Some(json!({ "expected": 0, "note": "x" })),
        ),
        (
            "POST",
            format!("/api/t/beta/bank/lines/{a_line}/unmatch"),
            Some(json!({ "expected": 0 })),
        ),
        (
            "POST",
            format!(
                "/api/t/beta/bank/rules/{}/delete",
                a_rule["id"].as_str().unwrap()
            ),
            Some(json!({ "expected": 0 })),
        ),
    ] {
        let (s, out) = m.w.call(method, &path, &m.bob, body).await;
        assert_eq!(s, StatusCode::NOT_FOUND, "{method} {path}: {out}");
    }
    let out = ok(
        &m.w,
        "POST",
        "/api/t/beta/bank/accept",
        &m.bob,
        Some(json!({ "items": [{ "lineId": a_line, "expected": 0,
            "proposal": { "kind": "notDonation", "ruleId": "r", "note": "x" } }] })),
    )
    .await;
    assert_eq!(out[0]["status"], 404);
    assert_eq!(m.line(&a_line).await["line"]["state"], "unmatched");
}

// ── review b4r: splits and stale ───────────────────────────────────────────

/// M1: voiding one part of a line's split from the gift's page is refused
/// (`line_split`: unmatch the line instead); the line keeps both parts.
/// Voiding the only gift still frees it.
#[tokio::test]
async fn voiding_one_part_of_a_split_is_refused_and_the_last_frees_the_line() {
    let m = setup().await;
    let (jo, _) = m.contact("Jo", "Bloggs").await;
    let (al, _) = m.contact("Al", "Other").await;
    let lines = m
        .import(
            "alpha",
            &m.sam,
            &m.account,
            &[
                Credit {
                    days_ago: 2,
                    pence: 5000,
                    payer: "J AND A",
                    reference: "",
                },
                Credit {
                    days_ago: 2,
                    pence: 900,
                    payer: "J BLOGGS",
                    reference: "",
                },
            ],
        )
        .await;
    let line = id(&lines[0]);
    let out = m
        .gifts_from(
            &line,
            json!([{ "contact": jo, "amount": 3000 }, { "contact": al, "amount": 2000 }]),
            None,
        )
        .await
        .1;
    let part = m.gift(out["gifts"][1]["id"].as_str().unwrap()).await;
    let (s, reason) = refused(
        &m.w,
        "POST",
        &format!("/api/t/alpha/gifts/{}/status", part["id"].as_str().unwrap()),
        &m.sam,
        Some(json!({ "expected": part["statusVersion"], "status": "void" })),
    )
    .await;
    assert_eq!(
        (s, reason.as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, "line_split")
    );
    let after = m.line(&line).await;
    assert_eq!(
        (
            after["line"]["state"].as_str(),
            after["gifts"].as_array().unwrap().len()
        ),
        (Some("matched"), 2)
    );
    assert_eq!(
        m.gift(part["id"].as_str().unwrap()).await["status"],
        "completed"
    );

    let single = id(&lines[1]);
    let out = m
        .gifts_from(&single, json!([{ "contact": jo, "amount": 900 }]), None)
        .await
        .1;
    let g = m.gift(out["gifts"][0]["id"].as_str().unwrap()).await;
    ok(
        &m.w,
        "POST",
        &format!("/api/t/alpha/gifts/{}/status", g["id"].as_str().unwrap()),
        &m.sam,
        Some(json!({ "expected": g["statusVersion"], "status": "void" })),
    )
    .await;
    assert_eq!(m.line(&single).await["line"]["state"], "unmatched");
}

/// M2: every direct command checks the line's version first: a line
/// matched meanwhile is `409 stale` with its match as it is now, as
/// "Accept ticked" answers, not `422 line_matched`.
#[tokio::test]
async fn a_line_matched_meanwhile_is_stale_for_every_direct_command() {
    let m = setup().await;
    let (jo, _) = m.contact("Jo", "Bloggs").await;
    let by_hand = m.by_hand(&jo, 2, 1000).await;
    let lines = m
        .import(
            "alpha",
            &m.sam,
            &m.account,
            &[Credit {
                days_ago: 2,
                pence: 1000,
                payer: "J BLOGGS",
                reference: "",
            }],
        )
        .await;
    let line = id(&lines[0]);
    let seen = m.version(&line).await;
    // Someone else marks it first.
    let (s, _) = m
        .post(
            &format!("bank/lines/{line}/not-donation"),
            json!({ "expected": seen, "note": "Refund" }),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    for (path, body) in [
        (
            "gifts",
            json!({ "expected": seen, "parts": [{ "contact": jo, "amount": 1000 }] }),
        ),
        (
            "match-gifts",
            json!({ "expected": seen, "giftIds": [by_hand] }),
        ),
        (
            "match-batch",
            json!({ "expected": seen, "batchId": line, "batchLineVersion": 0 }),
        ),
        ("not-donation", json!({ "expected": seen, "note": "x" })),
        ("unmatch", json!({ "expected": seen })),
    ] {
        let (s, out) = m.post(&format!("bank/lines/{line}/{path}"), body).await;
        assert_eq!(
            (s, out["kind"].as_str(), out["contract"].as_str()),
            (
                StatusCode::CONFLICT,
                Some("stale"),
                Some("banking.lineMatch")
            ),
            "{path}: {out}"
        );
        assert_eq!(out["current"]["state"], "not_donation", "{path}");
    }
    assert_eq!(m.line(&line).await["line"]["note"], "Refund");
}

/// Review b4r round 2: a transfer entered by hand and matched to a line
/// keeps the line's amount, date and method (Gift Aid claims on them):
/// saving it as £15 against a £10 line is `422 line_matched_fixed`; and
/// voiding it while it is one part of a line's split is `line_split`,
/// as for a part made from the line.
#[tokio::test]
async fn a_hand_matched_transfer_keeps_the_lines_terms_and_its_split() {
    let m = setup().await;
    let (jo, _) = m.contact("Jo", "Bloggs").await;
    let (al, _) = m.contact("Al", "Other").await;
    let mine = m.by_hand(&jo, 2, 1000).await;
    let lines = m
        .import(
            "alpha",
            &m.sam,
            &m.account,
            &[Credit {
                days_ago: 2,
                pence: 1500,
                payer: "J AND A",
                reference: "",
            }],
        )
        .await;
    let line = id(&lines[0]);
    let (s, out) = m
        .post(
            &format!("bank/lines/{line}/match-gifts"),
            json!({ "expected": m.version(&line).await, "giftIds": [mine],
                "remainder": { "amount": 500, "note": "Al's, recorded below" } }),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{out}");
    let g = m.gift(&mine).await;
    let mut save = g.clone();
    save["expected"] = g["giftVersion"].clone();
    save["amount"] = json!(1500);
    save["allocations"][0]["amount"] = json!(1500);
    let (s, reason) = refused(
        &m.w,
        "POST",
        &format!("/api/t/alpha/gifts/{mine}/save"),
        &m.sam,
        Some(save),
    )
    .await;
    assert_eq!(
        (s, reason.as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, "line_matched_fixed")
    );
    assert_eq!(m.gift(&mine).await["amount"], 1000);

    // Unmatched, then split between Jo's hand-entered gift and Al's.
    m.unmatch(&line).await;
    let theirs = m.by_hand(&al, 2, 500).await;
    let (s, out) = m
        .post(
            &format!("bank/lines/{line}/match-gifts"),
            json!({ "expected": m.version(&line).await, "giftIds": [mine, theirs] }),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{out}");
    let g = m.gift(&theirs).await;
    let (s, reason) = refused(
        &m.w,
        "POST",
        &format!("/api/t/alpha/gifts/{theirs}/status"),
        &m.sam,
        Some(json!({ "expected": g["statusVersion"], "status": "void" })),
    )
    .await;
    assert_eq!(
        (s, reason.as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, "line_split")
    );
    assert_eq!(m.line(&line).await["gifts"].as_array().unwrap().len(), 2);
}
