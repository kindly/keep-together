//! Paying-in batches and the bank methods on record-gift, over HTTP (bank
//! transfers 6b): open a batch on an account, record cash and cheques into
//! it, close it with the slip's total, reopen it; a transfer entered by
//! hand is completed and "not on a statement yet"; a cheque is pending,
//! clears by hand only outside a batch, and can bounce. Viewers read,
//! staff and admins write. Two organisations: B never sees A's batches,
//! and A's ids under B's slug answer 404.

mod common;

use axum::http::StatusCode;
use common::{World, world};
use serde_json::{Value, json};

struct G {
    w: World,
    ann: String,
    sam: String,
    val: String,
    bob: String,
    code: String,
    account: String,
}

async fn ok(w: &World, method: &str, path: &str, cookie: &str, body: Option<Value>) -> Value {
    let (s, out) = w.call(method, path, cookie, body).await;
    assert_eq!(s, StatusCode::OK, "{method} {path}: {out}");
    out
}

async fn setup() -> G {
    let w = world();
    for t in [&w.alpha, &w.beta] {
        let db = w.store.org(&t.id).unwrap();
        contracts::transact(&db, None, api::schema::seed_new_org).unwrap();
        contracts::transact(&db, None, sources::seed_new_org).unwrap();
    }
    let ann = w.login("ann@alpha.org").await;
    let sam = w.login("sam@alpha.org").await;
    let val = w.login("val@alpha.org").await;
    let bob = w.login("bob@beta.org").await;
    let category = ok(
        &w,
        "POST",
        "/api/t/alpha/sources",
        &ann,
        Some(json!({ "name": "Collections", "isActive": true })),
    )
    .await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let code = ok(
        &w,
        "POST",
        "/api/t/alpha/sources",
        &ann,
        Some(json!({ "parentId": category, "name": "Tin", "isActive": true })),
    )
    .await["versionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let account = ok(
        &w,
        "POST",
        "/api/t/alpha/bank/accounts",
        &ann,
        Some(json!({ "name": "CAF current", "active": true })),
    )
    .await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    G {
        w,
        ann,
        sam,
        val,
        bob,
        code,
        account,
    }
}

impl G {
    async fn open(&self, cookie: &str) -> Value {
        ok(
            &self.w,
            "POST",
            "/api/t/alpha/bank/batches",
            cookie,
            Some(json!({ "accountId": self.account, "slipNumber": "000123" })),
        )
        .await
    }

    async fn record(&self, method: &str, pence: i64, over: Value) -> (StatusCode, Value) {
        let mut args = json!({
            "clientKey": contracts::new_id(),
            "contact": { "kind": "individual", "firstName": "Jo", "lastName": "Bloggs", "name": "" },
            "receivedOn": "2026-11-02",
            "amount": pence,
            "method": method,
            "allocations": [{ "sourceCodeId": self.code, "amount": pence }],
        });
        for (k, v) in over.as_object().unwrap() {
            args[k] = v.clone();
        }
        self.w
            .call("POST", "/api/t/alpha/gifts/record", &self.sam, Some(args))
            .await
    }

    async fn gift(&self, id: &str) -> Value {
        ok(&self.w, "GET", &format!("/api/t/alpha/gifts/{id}"), &self.sam, None).await
    }

    async fn status(&self, id: &str, expected: i64, to: &str) -> (StatusCode, Value) {
        let path = format!("/api/t/alpha/gifts/{id}/status");
        let body = json!({ "expected": expected, "status": to });
        self.w.call("POST", &path, &self.sam, Some(body)).await
    }

    async fn batch(&self, id: &str) -> Value {
        ok(&self.w, "GET", &format!("/api/t/alpha/bank/batches/{id}"), &self.val, None).await
    }
}

#[tokio::test]
async fn a_batch_opens_takes_cash_and_cheques_closes_and_reopens() {
    let g = setup().await;
    let opened = g.open(&g.sam).await;
    assert_eq!((opened["status"].as_str(), opened["accountName"].as_str()), (Some("open"), Some("CAF current")));
    assert_eq!(opened["version"], 0);
    let id = opened["id"].as_str().unwrap();
    let batch = json!({ "payingInBatchId": id });
    let (s, cash) = g.record("cash", 2000, batch.clone()).await;
    assert_eq!(s, StatusCode::OK, "{cash}");
    let (_, cheque) = g
        .record("cheque", 5000, json!({ "payingInBatchId": id, "reference": "100231" }))
        .await;
    // Cash counts at once; the cheque is pending until its batch matches.
    assert_eq!(g.gift(cash["giftId"].as_str().unwrap()).await["status"], "completed");
    let c = g.gift(cheque["giftId"].as_str().unwrap()).await;
    assert_eq!((c["status"].as_str(), c["reference"].as_str()), (Some("pending"), Some("100231")));
    assert_eq!(c["payingInBatchId"], id);
    // A transfer has no slip.
    let (s, out) = g.record("bank_transfer", 1000, batch.clone()).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{out}");

    let detail = g.batch(id).await;
    assert_eq!((detail["batch"]["giftCount"].as_i64(), detail["batch"]["giftsTotal"].as_i64()), (Some(2), Some(7000)));
    let methods: Vec<&str> = detail["gifts"].as_array().unwrap().iter().map(|g| g["method"].as_str().unwrap()).collect();
    assert_eq!(methods, ["cash", "cheque"]);
    assert_eq!(detail["gifts"][0]["contactName"], "Jo Bloggs");

    // Closing needs the slip's total and date; a difference isn't refused.
    let url = |what: &str| format!("/api/t/alpha/bank/batches/{id}/{what}");
    let (s, out) = g.w.call("POST", &url("close"), &g.sam, Some(json!({ "expected": 0, "bankedOn": "", "total": 6900 }))).await;
    assert_eq!((s, out["kind"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid")));
    let closed = ok(&g.w, "POST", &url("close"), &g.sam, Some(json!({ "expected": 0, "bankedOn": "2026-11-03", "total": 6900 }))).await;
    assert_eq!(closed["counter"], 1);
    let detail = g.batch(id).await;
    assert_eq!((detail["batch"]["status"].as_str(), detail["batch"]["total"].as_i64()), (Some("closed"), Some(6900)));
    // Closed: no more gifts go in.
    let (s, out) = g.record("cash", 500, batch.clone()).await;
    assert_eq!((s, out["reason"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("batch_closed")));
    // A stale save is 409 with the batch as it is.
    let (s, out) = g.w.call("POST", &url("save"), &g.sam, Some(json!({ "expected": 0, "slipNumber": "9", "bankedOn": "2026-11-03", "total": 6900 }))).await;
    assert_eq!((s, out["kind"].as_str()), (StatusCode::CONFLICT, Some("stale")));
    assert_eq!(out["current"]["status"], "closed");
    ok(&g.w, "POST", &url("save"), &g.sam, Some(json!({ "expected": 1, "slipNumber": "000124", "bankedOn": "2026-11-03", "total": 7000 }))).await;
    // Reopened, it takes the gift left out.
    ok(&g.w, "POST", &url("reopen"), &g.sam, Some(json!({ "expected": 2 }))).await;
    let (s, _) = g.record("cash", 500, batch).await;
    assert_eq!(s, StatusCode::OK);
    let detail = g.batch(id).await;
    assert_eq!((detail["batch"]["status"].as_str(), detail["batch"]["slipNumber"].as_str()), (Some("open"), Some("000124")));
    assert_eq!(detail["batch"]["giftsTotal"], 7500);
    // The list: every member reads it.
    let list = ok(&g.w, "GET", "/api/t/alpha/bank/batches?status=open", &g.val, None).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    let none = ok(&g.w, "GET", "/api/t/alpha/bank/batches?status=closed", &g.val, None).await;
    assert_eq!(none, json!([]));
}

#[tokio::test]
async fn viewers_read_batches_and_write_nothing() {
    let g = setup().await;
    let id = g.open(&g.ann).await["id"].as_str().unwrap().to_owned();
    let (s, _) = g.w.call("GET", "/api/t/alpha/bank/batches", &g.val, None).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = g.w.call("GET", &format!("/api/t/alpha/bank/batches/{id}"), &g.val, None).await;
    assert_eq!(s, StatusCode::OK);
    for (path, body) in [
        ("/api/t/alpha/bank/batches".to_owned(), json!({ "accountId": g.account })),
        (format!("/api/t/alpha/bank/batches/{id}/save"), json!({ "expected": 0 })),
        (format!("/api/t/alpha/bank/batches/{id}/close"), json!({ "expected": 0, "bankedOn": "2026-11-03", "total": 100 })),
        (format!("/api/t/alpha/bank/batches/{id}/reopen"), json!({ "expected": 0 })),
    ] {
        let (s, _) = g.w.call("POST", &path, &g.val, Some(body)).await;
        assert_eq!(s, StatusCode::FORBIDDEN, "{path}");
    }
}

#[tokio::test]
async fn an_archived_account_takes_no_new_batch() {
    let g = setup().await;
    ok(
        &g.w,
        "POST",
        &format!("/api/t/alpha/bank/accounts/{}/save", g.account),
        &g.ann,
        Some(json!({ "expected": 0, "name": "CAF current", "active": false })),
    )
    .await;
    let (s, out) = g
        .w
        .call("POST", "/api/t/alpha/bank/batches", &g.sam, Some(json!({ "accountId": g.account })))
        .await;
    assert_eq!((s, out["reason"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("account_inactive")));
    let (s, out) = g
        .w
        .call("POST", "/api/t/alpha/bank/batches", &g.sam, Some(json!({ "accountId": "0".repeat(32) })))
        .await;
    assert_eq!((s, out["reason"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("unknown_account")));
}

#[tokio::test]
async fn a_transfer_by_hand_is_completed_and_not_on_a_statement_yet() {
    let g = setup().await;
    let (s, out) = g.record("bank_transfer", 2500, json!({ "reference": "100016 GIFT" })).await;
    assert_eq!(s, StatusCode::OK, "{out}");
    let gift = g.gift(out["giftId"].as_str().unwrap()).await;
    assert_eq!(
        (gift["status"].as_str(), gift["notOnAStatement"].as_bool(), gift["reference"].as_str()),
        (Some("completed"), Some(true), Some("100016 GIFT"))
    );
    // Cash carries no reference; a cheque its number.
    let (s, _) = g.record("cash", 100, json!({ "reference": "x" })).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn a_cheque_clears_by_hand_outside_a_batch_and_can_bounce() {
    let g = setup().await;
    let (_, loose) = g.record("cheque", 3000, json!({ "reference": "200001" })).await;
    let loose = loose["giftId"].as_str().unwrap().to_owned();
    let (s, out) = g.status(&loose, 1, "completed").await;
    assert_eq!((s, out["view"]["status"].as_str()), (StatusCode::OK, Some("completed")), "{out}");
    let (s, out) = g.status(&loose, 2, "failed").await;
    assert_eq!((s, out["view"]["status"].as_str()), (StatusCode::OK, Some("failed")), "{out}");

    let id = g.open(&g.sam).await["id"].as_str().unwrap().to_owned();
    let (_, batched) = g.record("cheque", 4000, json!({ "payingInBatchId": id })).await;
    let batched = batched["giftId"].as_str().unwrap().to_owned();
    let (s, out) = g.status(&batched, 1, "completed").await;
    assert_eq!((s, out["reason"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("cheque_not_cleared")));
    let (s, out) = g.status(&batched, 1, "failed").await;
    assert_eq!((s, out["view"]["status"].as_str()), (StatusCode::OK, Some("failed")), "{out}");
    // A bounced cheque leaves the batch's total.
    assert_eq!(g.batch(&id).await["batch"]["giftsTotal"], 4000);
}

#[tokio::test]
async fn b_never_sees_as_batches_and_as_ids_under_b_are_404() {
    let g = setup().await;
    let id = g.open(&g.sam).await["id"].as_str().unwrap().to_owned();
    let list = ok(&g.w, "GET", "/api/t/beta/bank/batches", &g.bob, None).await;
    assert_eq!(list, json!([]));
    let (s, out) = g.w.call("GET", &format!("/api/t/beta/bank/batches/{id}"), &g.bob, None).await;
    assert_eq!((s, out["kind"].as_str()), (StatusCode::NOT_FOUND, Some("not_found")));
    for (what, body) in [
        ("save", json!({ "expected": 0 })),
        ("close", json!({ "expected": 0, "bankedOn": "2026-11-03", "total": 100 })),
        ("reopen", json!({ "expected": 0 })),
    ] {
        let (s, _) = g.w.call("POST", &format!("/api/t/beta/bank/batches/{id}/{what}"), &g.bob, Some(body)).await;
        assert_eq!(s, StatusCode::NOT_FOUND, "{what}");
    }
    // A's account and batch don't exist in B's file.
    let (s, out) = g
        .w
        .call("POST", "/api/t/beta/bank/batches", &g.bob, Some(json!({ "accountId": g.account })))
        .await;
    assert_eq!((s, out["reason"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("unknown_account")));
    // A is untouched.
    assert_eq!(g.batch(&id).await["batch"]["version"], 0);
}
