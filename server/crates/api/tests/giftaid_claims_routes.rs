//! Gift Aid claims over HTTP, on the real org schema: eligibility and
//! every exclusion's reason, the claim as a frozen record, a claimed
//! gift locked, the claim's life (ready, submitted, paid, rejected, a
//! draft deleted), adjustments for gifts voided after a claim was sent,
//! the schedule and XML downloads, the HMRC details, admin only, and
//! tenancy on every route (B never sees A; A's ids under B's slug are
//! 404).

mod common;

use axum::http::{StatusCode, header};
use common::{World, request, world};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

const DAY: i64 = 86_400_000;

fn days_ago(n: i64) -> String {
    giftaid::uk_date(contracts::now_ms() - n * DAY)
}

fn today() -> String {
    days_ago(0)
}

async fn ok(w: &World, method: &str, path: &str, cookie: &str, body: Option<Value>) -> Value {
    let (s, out) = w.call(method, path, cookie, body).await;
    assert_eq!(s, StatusCode::OK, "{method} {path}: {out}");
    out
}

/// A refusal's status and reason (or `kind` when there is none).
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

/// A download: status, content type, the whole body.
async fn download(
    w: &World,
    path: &str,
    cookie: &str,
) -> (StatusCode, String, Vec<u8>, Option<String>) {
    let res = w
        .app
        .clone()
        .oneshot(request("GET", path, Some(cookie), None))
        .await
        .unwrap();
    let status = res.status();
    let ty = res
        .headers()
        .get(header::CONTENT_TYPE)
        .map(|v| v.to_str().unwrap().to_owned())
        .unwrap_or_default();
    let mark = res
        .headers()
        .get("x-irmark")
        .map(|v| v.to_str().unwrap().to_owned());
    let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, ty, bytes, mark)
}

struct C {
    w: World,
    ann: String,
    sam: String,
    val: String,
    bob: String,
    /// alpha's and beta's source-code versions.
    code: String,
    beta_code: String,
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
        Some(json!({ "parentId": category, "name": "Claims", "isActive": true })),
    )
    .await["versionId"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn setup() -> C {
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
    let beta_code = code_for(&w, "beta", &bob).await;
    C {
        w,
        ann,
        sam,
        val,
        bob,
        code,
        beta_code,
    }
}

async fn code_for(w: &World, slug: &str, cookie: &str) -> String {
    code(w, slug, cookie).await
}

/// How a test's donor looks.
struct Donor<'a> {
    kind: &'a str,
    first: &'a str,
    last: &'a str,
    line1: &'a str,
    postcode: &'a str,
    gift_aid: bool,
}

const ANN_SMITH: Donor = Donor {
    kind: "individual",
    first: "Ann",
    last: "Smith",
    line1: "12 High Street",
    postcode: "ls1 1aa",
    gift_aid: true,
};

impl C {
    fn cookie(&self, slug: &str) -> &str {
        if slug == "alpha" {
            &self.ann
        } else {
            &self.bob
        }
    }

    /// A new donor's gift of `amount` pence on `date`, with the gift's
    /// declaration (made today, covering the 4 years before) when
    /// `gift_aid`. The gift's id and its donor's.
    async fn gift(&self, slug: &str, d: &Donor<'_>, date: &str, amount: i64) -> (String, String) {
        let code = if slug == "alpha" {
            &self.code
        } else {
            &self.beta_code
        };
        let mut args = json!({
            "clientKey": contracts::new_id(),
            "contact": {
                "kind": d.kind,
                "firstName": d.first,
                "lastName": if d.kind == "individual" { d.last } else { "" },
                "name": if d.kind == "individual" { "" } else { d.last },
            },
            "receivedOn": date,
            "amount": amount,
            "method": "cash",
            "allocations": [{ "sourceCodeId": code, "amount": amount }],
        });
        if !d.line1.is_empty() || !d.postcode.is_empty() {
            args["home"] = json!({ "line1": d.line1, "postcode": d.postcode });
        }
        if d.gift_aid {
            args["giftAid"] = json!({});
        }
        let out = ok(
            &self.w,
            "POST",
            &format!("/api/t/{slug}/gifts/record"),
            self.cookie(slug),
            Some(args),
        )
        .await;
        (
            out["giftId"].as_str().unwrap().to_owned(),
            out["contactId"].as_str().unwrap().to_owned(),
        )
    }

    /// Another gift from an existing donor.
    async fn again(&self, contact: &str, date: &str, amount: i64) -> String {
        ok(
            &self.w,
            "POST",
            "/api/t/alpha/gifts/record",
            &self.ann,
            Some(json!({
                "clientKey": contracts::new_id(),
                "contact": contact,
                "receivedOn": date,
                "amount": amount,
                "method": "cash",
                "allocations": [{ "sourceCodeId": self.code, "amount": amount }],
            })),
        )
        .await["giftId"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    async fn preview(&self, slug: &str, period_end: &str) -> Value {
        ok(
            &self.w,
            "GET",
            &format!("/api/t/{slug}/giftaid/claims/preview?periodEnd={period_end}"),
            self.cookie(slug),
            None,
        )
        .await
    }

    async fn create(&self, slug: &str) -> Value {
        ok(
            &self.w,
            "POST",
            &format!("/api/t/{slug}/giftaid/claims"),
            self.cookie(slug),
            Some(json!({ "periodEnd": today() })),
        )
        .await["view"]
            .clone()
    }

    async fn claim(&self, id: &str) -> Value {
        ok(
            &self.w,
            "GET",
            &format!("/api/t/alpha/giftaid/claims/{id}"),
            &self.ann,
            None,
        )
        .await
    }

    /// One status step from the claim as it is now.
    async fn step(&self, id: &str, body: Value) -> (StatusCode, Value) {
        let expected = self.claim(id).await["statusVersion"].clone();
        let mut body = body;
        body["expected"] = expected;
        self.w
            .call(
                "POST",
                &format!("/api/t/alpha/giftaid/claims/{id}/status"),
                &self.ann,
                Some(body),
            )
            .await
    }

    async fn step_ok(&self, id: &str, body: Value) -> Value {
        let (s, out) = self.step(id, body).await;
        assert_eq!(s, StatusCode::OK, "{out}");
        out
    }

    async fn submit(&self, id: &str) {
        self.step_ok(id, json!({ "status": "ready" })).await;
        self.step_ok(
            id,
            json!({ "status": "submitted", "submittedOn": today(), "hmrcReference": "CHAR-123" }),
        )
        .await;
    }

    async fn gift_view(&self, id: &str) -> Value {
        ok(
            &self.w,
            "GET",
            &format!("/api/t/alpha/gifts/{id}"),
            &self.ann,
            None,
        )
        .await
    }

    async fn void(&self, id: &str, reason: Option<&str>) -> (StatusCode, Value) {
        let g = self.gift_view(id).await;
        let mut body = json!({ "expected": g["statusVersion"], "status": "void" });
        if let Some(r) = reason {
            body["reason"] = json!(r);
        }
        self.w
            .call(
                "POST",
                &format!("/api/t/alpha/gifts/{id}/status"),
                &self.ann,
                Some(body),
            )
            .await
    }

    async fn hmrc_details(&self) {
        ok(
            &self.w,
            "POST",
            "/api/t/alpha/giftaid/hmrc-details",
            &self.ann,
            Some(json!({
                "hmrcReference": "ab12345", "regulator": "ccew", "regulatorNumber": "1234567",
                "officialTitle": "Mrs", "officialFirstName": "Jane", "officialLastName": "Doe",
                "officialPostcode": "ls1 1aa", "officialPhone": "0113 496 0000",
            })),
        )
        .await;
    }
}

fn ids(list: &Value, field: &str) -> Vec<String> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|l| l[field].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn the_preview_claims_what_is_eligible_and_says_why_the_rest_is_left_out() {
    let c = setup().await;
    let date = days_ago(10);
    let (good, _) = c.gift("alpha", &ANN_SMITH, &date, 2003).await;
    let (undeclared, _) = c
        .gift(
            "alpha",
            &Donor {
                gift_aid: false,
                first: "Bob",
                ..ANN_SMITH
            },
            &date,
            1000,
        )
        .await;
    let (no_postcode, _) = c
        .gift(
            "alpha",
            &Donor {
                postcode: "",
                first: "Cat",
                ..ANN_SMITH
            },
            &date,
            1000,
        )
        .await;
    let (org, _) = c
        .gift(
            "alpha",
            &Donor {
                kind: "organization",
                first: "",
                last: "Acme Ltd",
                gift_aid: false,
                ..ANN_SMITH
            },
            &date,
            5000,
        )
        .await;
    let (void, _) = c.gift("alpha", &ANN_SMITH, &date, 700).await;
    c.void(&void, None).await;
    let (later, _) = c.gift("alpha", &ANN_SMITH, &today(), 900).await;

    let p = c.preview("alpha", &days_ago(1)).await;
    assert_eq!(ids(&p["lines"], "giftId"), std::slice::from_ref(&good));
    let line = &p["lines"][0];
    assert_eq!(line["firstName"], "Ann");
    assert_eq!(line["house"], "12");
    assert_eq!(line["postcode"], "LS1 1AA");
    assert_eq!(line["reclaim"], 500, "a quarter, rounded down");
    assert_eq!(
        p["totals"],
        json!({ "lines": 1, "donations": 2003, "reclaim": 500, "adjustment": 0, "net": 500 })
    );
    assert_eq!(p["scheduleParts"], 1);
    let reasons = |gift: &str| {
        p["excluded"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["giftId"] == gift)
            .map(|e| e["reasons"].clone())
    };
    let label = giftaid::rules::uk_date_label(&date);
    assert_eq!(
        reasons(&undeclared),
        Some(json!([format!("No declaration covers {label}")]))
    );
    assert_eq!(reasons(&no_postcode), Some(json!(["No postcode"])));
    assert_eq!(reasons(&org), Some(json!(["The donor is an organisation"])));
    assert_eq!(reasons(&void), None, "void gifts aren't listed");
    assert_eq!(reasons(&later), None, "after the end date: not listed");
    let names: Vec<&str> = p["excluded"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["contactName"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"Acme Ltd"), "{names:?}");

    // A gift over 4 years old isn't claimable.
    let (old, _) = c
        .gift("alpha", &ANN_SMITH, &days_ago(4 * 366 + 2), 1000)
        .await;
    let p = c.preview("alpha", &today()).await;
    assert!(!ids(&p["lines"], "giftId").contains(&old));
    assert!(reasons(&old).is_none());

    // Bad dates are 422.
    let (s, _) = refused(
        &c.w,
        "GET",
        "/api/t/alpha/giftaid/claims/preview?periodEnd=2026-02-30",
        &c.ann,
        None,
    )
    .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn a_claim_freezes_its_gifts_and_locks_them() {
    let c = setup().await;
    let (gift, contact) = c.gift("alpha", &ANN_SMITH, &days_ago(5), 2000).await;
    let p = c.preview("alpha", &today()).await;

    // The preview the caller saw must still hold.
    let (s, reason) = refused(
        &c.w,
        "POST",
        "/api/t/alpha/giftaid/claims",
        &c.ann,
        Some(json!({ "periodEnd": today(), "expectedLines": 2, "expectedDonations": 2000 })),
    )
    .await;
    assert_eq!(
        (s, reason.as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, "preview_changed")
    );
    let (s, _) = refused(
        &c.w,
        "POST",
        "/api/t/alpha/giftaid/claims",
        &c.ann,
        Some(json!({ "periodEnd": days_ago(-2) })),
    )
    .await;
    assert_eq!(
        s,
        StatusCode::UNPROCESSABLE_ENTITY,
        "no claim ends after today"
    );

    let made = ok(
        &c.w,
        "POST",
        "/api/t/alpha/giftaid/claims",
        &c.ann,
        Some(json!({
            "periodEnd": today(),
            "expectedLines": p["totals"]["lines"],
            "expectedDonations": p["totals"]["donations"],
        })),
    )
    .await;
    let view = &made["view"];
    let id = view["id"].as_str().unwrap().to_owned();
    assert_eq!(view["number"], 1);
    assert_eq!(view["status"], "draft");
    assert_eq!(view["earliestDate"], days_ago(5));
    assert_eq!(view["totals"]["reclaim"], 500);
    assert_eq!(ids(&view["lines"], "giftId"), std::slice::from_ref(&gift));
    assert_eq!(made["counter"], 0);

    // In one claim at most: nothing left to claim.
    assert_eq!(c.preview("alpha", &today()).await["lines"], json!([]));
    let (s, reason) = refused(
        &c.w,
        "POST",
        "/api/t/alpha/giftaid/claims",
        &c.ann,
        Some(json!({ "periodEnd": today() })),
    )
    .await;
    assert_eq!(
        (s, reason.as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, "nothing_to_claim")
    );

    // The gift is locked: amount, date refused; its reference and code free.
    let g = c.gift_view(&gift).await;
    assert_eq!(g["claimId"], id);
    let save = |over: Value| {
        let mut body = json!({
            "expected": g["giftVersion"], "contactId": contact, "receivedOn": g["receivedOn"],
            "amount": g["amount"], "method": "cash",
            "allocations": g["allocations"].as_array().unwrap().iter()
                .map(|a| json!({ "key": a["key"], "sourceCodeId": a["sourceCodeId"], "amount": a["amount"] }))
                .collect::<Vec<_>>(),
        });
        for (k, v) in over.as_object().unwrap() {
            body[k] = v.clone();
        }
        body
    };
    let path = format!("/api/t/alpha/gifts/{gift}/save");
    let mut wrong = save(json!({ "amount": 2500 }));
    wrong["allocations"][0]["amount"] = json!(2500);
    let (s, reason) = refused(&c.w, "POST", &path, &c.ann, Some(wrong)).await;
    assert_eq!(
        (s, reason.as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, "claimed_gift")
    );
    let (_, reason) = refused(
        &c.w,
        "POST",
        &path,
        &c.ann,
        Some(save(json!({ "receivedOn": days_ago(6) }))),
    )
    .await;
    assert_eq!(reason, "claimed_gift");
    ok(
        &c.w,
        "POST",
        &path,
        &c.ann,
        Some(save(json!({ "method": "card", "reference": "R1" }))),
    )
    .await;

    // Voiding it needs a reason.
    let (s, out) = c.void(&gift, None).await;
    assert_eq!(
        (s, out["reason"].as_str()),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Some("void_reason_required")
        )
    );

    // The claim's lines kept the donor as sent, whatever the contact does.
    let lines = c.claim(&id).await["lines"].clone();
    assert_eq!(lines[0]["lastName"], "Smith");
}

#[tokio::test]
async fn the_schema_holds_a_gift_in_one_live_claim() {
    let c = setup().await;
    let (gift, _) = c.gift("alpha", &ANN_SMITH, &days_ago(3), 1000).await;
    let claim = c.create("alpha").await;
    let line = claim["lines"][0].clone();
    // A second claim naming the same gift, straight through the contract:
    // only the partial unique index stands in the way.
    let db = c.w.store.org(&c.w.alpha.id).unwrap();
    let err = contracts::transact(&db, None, |ctx| {
        contracts::execute(
            ctx,
            &giftaid::CLAIM,
            giftaid::claim_types::ClaimPayload {
                period_end: today(),
                lines: vec![giftaid::claim_types::ClaimLine {
                    key: None,
                    ..serde_json::from_value(line.clone()).unwrap()
                }],
                adjustments: vec![],
            },
            contracts::Exec::create(contracts::Source::Test),
        )
    })
    .unwrap_err();
    assert!(
        matches!(&err, contracts::ContractError::Rejected { reason, .. } if reason == "already_claimed"),
        "{err:?}"
    );
    let live: i64 = db
        .read(|r| {
            r.query_row(
                "SELECT count(*) FROM gift_aid_claim_lines WHERE gift_id = ?1 AND live = 1",
                [&gift],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(live, 1);
}

#[tokio::test]
async fn a_claim_moves_forward_only_and_records_each_step() {
    let c = setup().await;
    c.gift("alpha", &ANN_SMITH, &days_ago(3), 4000).await;
    let id = c.create("alpha").await["id"].as_str().unwrap().to_owned();

    // Not a next step; a stale counter.
    let (s, out) = c
        .step(
            &id,
            json!({ "status": "paid", "paidOn": today(), "paidAmount": 1000 }),
        )
        .await;
    assert_eq!(
        (s, out["reason"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("claim_status"))
    );
    let (s, out) =
        c.w.call(
            "POST",
            &format!("/api/t/alpha/giftaid/claims/{id}/status"),
            &c.ann,
            Some(json!({ "expected": 7, "status": "ready" })),
        )
        .await;
    assert_eq!(
        (s, out["kind"].as_str()),
        (StatusCode::CONFLICT, Some("stale"))
    );

    c.step_ok(&id, json!({ "status": "ready" })).await;
    let (s, _) = c.step(&id, json!({ "status": "deleted" })).await;
    assert_eq!(
        s,
        StatusCode::UNPROCESSABLE_ENTITY,
        "only a draft is deleted"
    );
    let (s, out) = c
        .step(
            &id,
            json!({ "status": "submitted", "submittedOn": days_ago(-1) }),
        )
        .await;
    assert_eq!(
        (s, out["kind"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid"))
    );
    let out = c
        .step_ok(&id, json!({ "status": "submitted", "submittedOn": days_ago(1), "hmrcReference": " CHAR-9 " }))
        .await;
    assert_eq!(out["view"]["submittedOn"], days_ago(1));
    assert_eq!(out["view"]["hmrcReference"], "CHAR-9");
    let (s, _) = c
        .step(
            &id,
            json!({ "status": "paid", "paidOn": days_ago(2), "paidAmount": 1000 }),
        )
        .await;
    assert_eq!(
        s,
        StatusCode::UNPROCESSABLE_ENTITY,
        "paid before it was submitted"
    );
    let (s, _) = c
        .step(&id, json!({ "status": "paid", "paidOn": today() }))
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "paid needs the amount");
    let out = c
        .step_ok(
            &id,
            json!({ "status": "paid", "paidOn": today(), "paidAmount": 1000 }),
        )
        .await;
    let v = &out["view"];
    assert_eq!(
        (v["status"].as_str(), v["paidAmount"].as_i64()),
        (Some("paid"), Some(1000))
    );
    assert_eq!(
        v["submittedOn"],
        days_ago(1),
        "earlier steps' facts are kept"
    );
    let (s, _) = c
        .step(&id, json!({ "status": "rejected", "reason": "late" }))
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "paid is final");

    // Each step is a revision of the claim, in its own named group.
    let groups: Vec<String> =
        c.w.store
            .org(&c.w.alpha.id)
            .unwrap()
            .read(|r| {
                r.prepare(
                    "SELECT group_name FROM revisions WHERE entity = 'gift_aid_claims' ORDER BY id",
                )?
                .query_map([], |row| row.get(0))?
                .collect()
            })
            .unwrap();
    assert_eq!(
        groups[1..],
        [
            "Gift Aid claim 1 ready",
            "Gift Aid claim 1 submitted",
            "Gift Aid claim 1 paid"
        ]
    );
    assert!(groups[0].starts_with("Gift Aid claim to "));
}

#[tokio::test]
async fn deleting_a_draft_or_rejecting_a_claim_lets_its_gifts_go() {
    let c = setup().await;
    let (gift, _) = c.gift("alpha", &ANN_SMITH, &days_ago(3), 1000).await;
    let first = c.create("alpha").await["id"].as_str().unwrap().to_owned();
    let out = c.step_ok(&first, json!({ "status": "deleted" })).await;
    assert_eq!(out["view"], Value::Null);
    assert_eq!(c.gift_view(&gift).await["claimId"], Value::Null);
    let list = ok(&c.w, "GET", "/api/t/alpha/giftaid/claims", &c.ann, None).await;
    assert_eq!(list["claims"], json!([]), "a deleted draft isn't listed");
    let (s, _) = refused(
        &c.w,
        "GET",
        &format!("/api/t/alpha/giftaid/claims/{first}"),
        &c.ann,
        None,
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    let second = c.create("alpha").await;
    assert_eq!(second["number"], 2, "numbers aren't reused");
    let second = second["id"].as_str().unwrap().to_owned();
    c.submit(&second).await;
    let (s, _) = c.step(&second, json!({ "status": "rejected" })).await;
    assert_eq!(
        s,
        StatusCode::UNPROCESSABLE_ENTITY,
        "a rejection needs its reason"
    );
    let out = c
        .step_ok(
            &second,
            json!({ "status": "rejected", "reason": "Wrong reference" }),
        )
        .await;
    assert_eq!(out["view"]["rejectedReason"], "Wrong reference");
    assert_eq!(c.gift_view(&gift).await["claimId"], Value::Null);
    assert_eq!(
        ids(&c.preview("alpha", &today()).await["lines"], "giftId"),
        [gift]
    );
}

#[tokio::test]
async fn a_gift_voided_after_its_claim_was_sent_is_paid_back_by_the_next() {
    let c = setup().await;
    let (gift, contact) = c.gift("alpha", &ANN_SMITH, &days_ago(20), 1001).await;
    let first = c.create("alpha").await["id"].as_str().unwrap().to_owned();
    c.submit(&first).await;
    let (s, _) = c.void(&gift, Some("Cheque bounced")).await;
    assert_eq!(s, StatusCode::OK);
    let g = c.gift_view(&gift).await;
    assert_eq!(
        (g["status"].as_str(), g["voidReason"].as_str()),
        (Some("void"), Some("Cheque bounced"))
    );
    // A void after a claim is final.
    let (s, out) =
        c.w.call(
            "POST",
            &format!("/api/t/alpha/gifts/{gift}/status"),
            &c.ann,
            Some(json!({ "expected": g["statusVersion"], "status": "completed" })),
        )
        .await;
    assert_eq!(
        (s, out["reason"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("claimed_gift"))
    );

    c.again(&contact, &days_ago(2), 4000).await;
    let p = c.preview("alpha", &today()).await;
    assert_eq!(
        p["adjustments"],
        json!([{
            "giftId": gift, "originalClaimId": first, "amount": 250, "reason": "Cheque bounced",
        }]),
        "the tax its line claimed: floor(1001 / 4)"
    );
    assert_eq!(p["totals"]["adjustment"], 250);
    assert_eq!(p["totals"]["net"], 1000 - 250);
    let second = c.create("alpha").await;
    let second_id = second["id"].as_str().unwrap().to_owned();
    assert_eq!(second["totals"]["adjustment"], 250);
    assert_eq!(second["adjustments"][0]["giftId"], gift);
    // Paid back once: the next preview carries no adjustment.
    assert_eq!(c.preview("alpha", &today()).await["adjustments"], json!([]));
    // The first claim can't be rejected while the second pays its gift back.
    let (s, out) = c
        .step(&first, json!({ "status": "rejected", "reason": "x" }))
        .await;
    assert_eq!(
        (s, out["reason"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("adjusted_later"))
    );

    // The schedule's Box 2 and the XML carry the adjustment.
    c.hmrc_details().await;
    let (s, _, xml, _) = download(
        &c.w,
        &format!("/api/t/alpha/giftaid/claims/{second_id}/xml"),
        &c.ann,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let xml = String::from_utf8(xml).unwrap();
    assert!(
        xml.contains("<Adjustment>2.50</Adjustment></Repayment>"),
        "{xml}"
    );
    assert!(xml.contains("<OtherInfo>Adjustment of 2.50 is tax on gifts claimed in our claim 1"));
}

#[tokio::test]
async fn a_gift_voided_out_of_an_unsent_claim_holds_that_claim_back() {
    let c = setup().await;
    let (gift, _) = c.gift("alpha", &ANN_SMITH, &days_ago(3), 1000).await;
    let id = c.create("alpha").await["id"].as_str().unwrap().to_owned();
    let (s, _) = c.void(&gift, Some("Entered twice")).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(c.claim(&id).await["voidedGifts"], json!([gift]));
    let (s, out) = c.step(&id, json!({ "status": "ready" })).await;
    assert_eq!(
        (s, out["reason"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("voided_gifts"))
    );
    assert_eq!(
        c.preview("alpha", &today()).await["adjustments"],
        json!([]),
        "never sent: nothing to pay back"
    );
    c.step_ok(&id, json!({ "status": "deleted" })).await;
}

#[tokio::test]
async fn the_schedule_and_the_xml_download() {
    let c = setup().await;
    c.gift("alpha", &ANN_SMITH, &days_ago(4), 2500).await;
    c.gift(
        "alpha",
        &Donor {
            first: "Zoë",
            last: "O'Neil-Brown",
            ..ANN_SMITH
        },
        &days_ago(2),
        1000,
    )
    .await;
    let claim = c.create("alpha").await;
    let id = claim["id"].as_str().unwrap();
    assert_eq!(claim["scheduleParts"], 1);
    for format in ["", "&format=excel", "&format=libreoffice"] {
        let (s, ty, ods, _) = download(
            &c.w,
            &format!("/api/t/alpha/giftaid/claims/{id}/schedule?part=1{format}"),
            &c.ann,
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(ty, "application/vnd.oasis.opendocument.spreadsheet");
        assert_eq!(&ods[..2], b"PK");
        assert_eq!(&ods[30..38], b"mimetype");
    }
    let (s, _, _, _) = download(
        &c.w,
        &format!("/api/t/alpha/giftaid/claims/{id}/schedule?part=2"),
        &c.ann,
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _, _, _) = download(
        &c.w,
        &format!("/api/t/alpha/giftaid/claims/{id}/schedule?format=numbers"),
        &c.ann,
    )
    .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);

    // The XML waits for the HMRC details.
    let (s, reason) = refused(
        &c.w,
        "GET",
        &format!("/api/t/alpha/giftaid/claims/{id}/xml"),
        &c.ann,
        None,
    )
    .await;
    assert_eq!(
        (s, reason.as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, "missing_hmrc_details")
    );
    c.hmrc_details().await;
    let (s, ty, xml, mark) = download(
        &c.w,
        &format!("/api/t/alpha/giftaid/claims/{id}/xml"),
        &c.ann,
    )
    .await;
    assert_eq!((s, ty.as_str()), (StatusCode::OK, "application/xml"));
    let xml = String::from_utf8(xml).unwrap();
    assert!(xml.contains("<OrgName>Alpha</OrgName><HMRCref>AB12345</HMRCref>"));
    assert!(xml.contains("<Regulator><RegName>CCEW</RegName><RegNo>1234567</RegNo></Regulator>"));
    assert!(xml.contains("<OffName><Ttl>Mrs</Ttl><Fore>Jane</Fore><Sur>Doe</Sur></OffName>"));
    assert!(xml.contains(&format!(
        "<GAD><Donor><Fore>Zoë</Fore><Sur>O'Neil Brown</Sur><House>12</House><Postcode>LS1 1AA</Postcode></Donor><Date>{}</Date><Total>10.00</Total></GAD>",
        days_ago(2)
    )));
    assert!(xml.contains(&format!("<EarliestGAdate>{}</EarliestGAdate>", days_ago(4))));
    assert!(!xml.contains("<Adjustment>"));
    let stamped = giftaid::irmark::compute_irmark(&xml).unwrap();
    assert_eq!(mark, Some(stamped.base32));
    assert!(xml.contains(&format!(
        "<IRmark Type=\"generic\">{}</IRmark>",
        stamped.base64
    )));
}

#[tokio::test]
async fn hmrc_details_save_with_warnings_and_are_stale_checked() {
    let c = setup().await;
    let v = ok(
        &c.w,
        "GET",
        "/api/t/alpha/giftaid/hmrc-details",
        &c.ann,
        None,
    )
    .await;
    assert_eq!(v["version"], Value::Null);
    assert_eq!(v["hmrcReference"], "");
    assert!(v["warnings"].as_array().unwrap().len() >= 5);
    let body = json!({
        "hmrcReference": "AB1", "regulator": "none", "regulatorNumber": "",
        "officialTitle": "", "officialFirstName": "Jane", "officialLastName": "Doe",
        "officialPostcode": "nowhere", "officialPhone": "0113 496 0000",
    });
    let out = ok(
        &c.w,
        "POST",
        "/api/t/alpha/giftaid/hmrc-details",
        &c.ann,
        Some(body.clone()),
    )
    .await;
    assert_eq!(out["counter"], 0);
    let v = ok(
        &c.w,
        "GET",
        "/api/t/alpha/giftaid/hmrc-details",
        &c.ann,
        None,
    )
    .await;
    assert_eq!(v["version"], 0);
    assert_eq!(v["officialPostcode"], "NOWHERE", "storable as typed");
    let anchors: Vec<&str> = v["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["anchor"].as_str().unwrap())
        .collect();
    assert_eq!(anchors, ["officialPostcode"]);
    // No `expected` once a row exists: stale.
    let (s, out) =
        c.w.call(
            "POST",
            "/api/t/alpha/giftaid/hmrc-details",
            &c.ann,
            Some(body.clone()),
        )
        .await;
    assert_eq!(
        (s, out["kind"].as_str()),
        (StatusCode::CONFLICT, Some("stale"))
    );
    let mut again = body;
    again["expected"] = json!(0);
    let out = ok(
        &c.w,
        "POST",
        "/api/t/alpha/giftaid/hmrc-details",
        &c.ann,
        Some(again),
    )
    .await;
    assert_eq!(out["counter"], 1);
}

#[tokio::test]
async fn claims_are_for_admins_only() {
    let c = setup().await;
    c.gift("alpha", &ANN_SMITH, &days_ago(3), 1000).await;
    let id = c.create("alpha").await["id"].as_str().unwrap().to_owned();
    let details = json!({
        "hmrcReference": "AB1", "regulator": "none", "regulatorNumber": "",
        "officialTitle": "", "officialFirstName": "Jane", "officialLastName": "Doe",
        "officialPostcode": "", "officialPhone": "",
    });
    for cookie in [&c.sam, &c.val] {
        for (method, path, body) in [
            ("GET", "/api/t/alpha/giftaid/claims".to_owned(), None),
            (
                "GET",
                format!("/api/t/alpha/giftaid/claims/preview?periodEnd={}", today()),
                None,
            ),
            ("GET", format!("/api/t/alpha/giftaid/claims/{id}"), None),
            (
                "GET",
                format!("/api/t/alpha/giftaid/claims/{id}/schedule"),
                None,
            ),
            ("GET", format!("/api/t/alpha/giftaid/claims/{id}/xml"), None),
            ("GET", "/api/t/alpha/giftaid/hmrc-details".to_owned(), None),
            (
                "POST",
                "/api/t/alpha/giftaid/claims".to_owned(),
                Some(json!({ "periodEnd": today() })),
            ),
            (
                "POST",
                format!("/api/t/alpha/giftaid/claims/{id}/status"),
                Some(json!({ "expected": 0, "status": "ready" })),
            ),
            (
                "POST",
                "/api/t/alpha/giftaid/hmrc-details".to_owned(),
                Some(details.clone()),
            ),
        ] {
            let (s, out) = c.w.call(method, &path, cookie, body).await;
            assert_eq!(s, StatusCode::FORBIDDEN, "{method} {path}: {out}");
        }
    }
    assert_eq!(c.claim(&id).await["status"], "draft", "nothing moved");
}

#[tokio::test]
async fn every_claim_route_keeps_two_orgs_apart() {
    let c = setup().await;
    let (a_gift, _) = c.gift("alpha", &ANN_SMITH, &days_ago(3), 1000).await;
    let a_claim = c.create("alpha").await["id"].as_str().unwrap().to_owned();
    c.hmrc_details().await;

    // B sees none of A's gifts, claims or details.
    let p = c.preview("beta", &today()).await;
    assert_eq!(
        (p["lines"].clone(), p["excluded"].clone()),
        (json!([]), json!([]))
    );
    let list = ok(&c.w, "GET", "/api/t/beta/giftaid/claims", &c.bob, None).await;
    assert_eq!(list["claims"], json!([]));
    let d = ok(
        &c.w,
        "GET",
        "/api/t/beta/giftaid/hmrc-details",
        &c.bob,
        None,
    )
    .await;
    assert_eq!(d["version"], Value::Null);

    // A's claim id under B's slug is 404 everywhere.
    for (method, path, body) in [
        ("GET", format!("/api/t/beta/giftaid/claims/{a_claim}"), None),
        (
            "GET",
            format!("/api/t/beta/giftaid/claims/{a_claim}/schedule"),
            None,
        ),
        (
            "GET",
            format!("/api/t/beta/giftaid/claims/{a_claim}/xml"),
            None,
        ),
        (
            "POST",
            format!("/api/t/beta/giftaid/claims/{a_claim}/status"),
            Some(json!({ "expected": 0, "status": "ready" })),
        ),
    ] {
        let (s, out) = c.w.call(method, &path, &c.bob, body).await;
        assert_eq!(s, StatusCode::NOT_FOUND, "{method} {path}: {out}");
    }
    // Not a member of A: forbidden, never A's data.
    let (s, _) =
        c.w.call("GET", "/api/t/alpha/giftaid/claims", &c.bob, None)
            .await;
    assert_eq!(s, StatusCode::FORBIDDEN);

    // B's own claim numbering starts at 1; A's gift stays in A's claim.
    c.gift("beta", &ANN_SMITH, &days_ago(3), 1000).await;
    assert_eq!(c.create("beta").await["number"], 1);
    assert_eq!(c.gift_view(&a_gift).await["claimId"], a_claim);
}
