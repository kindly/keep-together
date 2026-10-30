//! The reconcile pages' reads beside step 4's routes (bank transfers 6b):
//! a contact's remembered payers and forgetting them, and the transfers
//! entered by hand near a line. Staff and admins only; two organisations.

mod common;

use axum::body::Body as HttpBody;
use axum::http::{Request, StatusCode, header};
use common::{World, person, world};
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

struct P {
    w: World,
    ann: String,
    sam: String,
    val: String,
    bob: String,
    code: String,
    account: String,
}

async fn setup() -> P {
    let w = world();
    for t in [&w.alpha, &w.beta] {
        let db = w.store.org(&t.id).unwrap();
        contracts::transact(&db, None, api::schema::seed_new_org).unwrap();
    }
    let ann = w.login("ann@alpha.org").await;
    let sam = w.login("sam@alpha.org").await;
    let val = w.login("val@alpha.org").await;
    let bob = w.login("bob@beta.org").await;
    let category = ok(&w, "POST", "/api/t/alpha/sources", &ann, Some(json!({ "name": "Unsolicited", "isActive": true }))).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let code = ok(&w, "POST", "/api/t/alpha/sources", &ann, Some(json!({ "parentId": category, "name": "Transfer", "isActive": true }))).await["versionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let account = ok(
        &w,
        "POST",
        "/api/t/alpha/bank/accounts",
        &ann,
        Some(json!({ "name": "CAF current", "active": true, "defaultSourceCodeId": code })),
    )
    .await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    P { w, ann, sam, val, bob, code, account }
}

impl P {
    /// One credit imported (OFX) into the account; answers its line.
    async fn line(&self, days: i64, pence: i64, payer: &str, reference: &str) -> Value {
        let date = days_ago(days).replace('-', "");
        let ofx = format!(
            "OFXHEADER:100\nDATA:OFXSGML\n\n<OFX><STMTRS><CURDEF>GBP<BANKTRANLIST>\
             <STMTTRN><TRNTYPE>CREDIT<DTPOSTED>{date}<TRNAMT>{}.{:02}<FITID>{}<NAME>{payer}\
             <REFNUM>{reference}</STMTTRN></BANKTRANLIST></STMTRS></OFX>\n",
            pence / 100,
            pence % 100,
            contracts::new_id()
        );
        let req = Request::builder()
            .method("POST")
            .uri(format!(
                "/api/t/alpha/bank/imports?accountId={}&fileName=s.ofx&layout=%7B%22kind%22%3A%22ofx%22%7D",
                self.account
            ))
            .header(header::COOKIE, &self.sam)
            .body(HttpBody::from(ofx))
            .unwrap();
        let res = self.w.app.clone().oneshot(req).await.unwrap();
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let import: Value = serde_json::from_slice(&body).unwrap();
        let detail = ok(
            &self.w,
            "GET",
            &format!("/api/t/alpha/bank/imports/{}", import["id"].as_str().unwrap()),
            &self.sam,
            None,
        )
        .await;
        detail["lines"][0].clone()
    }

    async fn contact(&self, first: &str, last: &str) -> String {
        ok(&self.w, "POST", "/api/t/alpha/contacts", &self.ann, Some(person(first, last))).await["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }
}

#[tokio::test]
async fn a_matched_payer_is_remembered_on_the_contact_until_forgotten() {
    let p = setup().await;
    let jo = p.contact("Jo", "Bloggs").await;
    let line = p.line(2, 2500, "J BLOGGS", "GIFT").await;
    let id = line["id"].as_str().unwrap();
    ok(
        &p.w,
        "POST",
        &format!("/api/t/alpha/bank/lines/{id}/gifts"),
        &p.sam,
        Some(json!({ "expected": 0, "parts": [{ "contact": jo, "amount": 2500 }] })),
    )
    .await;
    let payers = ok(&p.w, "GET", &format!("/api/t/alpha/contacts/{jo}/bank-payers"), &p.sam, None).await;
    assert_eq!(payers.as_array().unwrap().len(), 1, "{payers}");
    assert_eq!(
        (payers[0]["payer"].as_str(), payers[0]["reference"].as_str(), payers[0]["accountName"].as_str()),
        (Some("J BLOGGS"), Some("GIFT"), Some("CAF current"))
    );
    let left = ok(&p.w, "POST", &format!("/api/t/alpha/contacts/{jo}/bank-payers/forget"), &p.sam, None).await;
    assert_eq!(left, json!([]));
    let again = ok(&p.w, "GET", &format!("/api/t/alpha/contacts/{jo}/bank-payers"), &p.sam, None).await;
    assert_eq!(again, json!([]));
    // The money stays: the gift and the line.
    let detail = ok(&p.w, "GET", &format!("/api/t/alpha/bank/lines/{id}"), &p.sam, None).await;
    assert_eq!((detail["line"]["state"].as_str(), detail["gifts"][0]["amount"].as_i64()), (Some("matched"), Some(2500)));
}

#[tokio::test]
async fn hand_transfers_near_a_line_are_listed_within_the_window() {
    let p = setup().await;
    let jo = p.contact("Jo", "Bloggs").await;
    let record = |days: i64, pence: i64| {
        json!({
            "clientKey": contracts::new_id(),
            "contact": jo,
            "receivedOn": days_ago(days),
            "amount": pence,
            "method": "bank_transfer",
            "allocations": [{ "sourceCodeId": p.code, "amount": pence }],
        })
    };
    let near = ok(&p.w, "POST", "/api/t/alpha/gifts/record", &p.sam, Some(record(5, 1000))).await;
    ok(&p.w, "POST", "/api/t/alpha/gifts/record", &p.sam, Some(record(40, 1000))).await;
    let line = p.line(2, 1000, "J BLOGGS", "").await;
    let path = format!("/api/t/alpha/bank/lines/{}/hand-transfers", line["id"].as_str().unwrap());
    let list = ok(&p.w, "GET", &path, &p.sam, None).await;
    let ids: Vec<&str> = list.as_array().unwrap().iter().map(|g| g["id"].as_str().unwrap()).collect();
    assert_eq!(ids, [near["giftId"].as_str().unwrap()]);
    assert_eq!(list[0]["contactName"], "Jo Bloggs");
    let wide = ok(&p.w, "GET", &format!("{path}?days=60"), &p.sam, None).await;
    assert_eq!(wide.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn line_choices_are_the_unmatched_lines_without_suggestions() {
    let p = setup().await;
    let line = p.line(2, 1000, "J BLOGGS", "").await;
    let list = ok(
        &p.w,
        "GET",
        &format!("/api/t/alpha/bank/accounts/{}/line-choices", p.account),
        &p.sam,
        None,
    )
    .await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["id"], line["id"]);
    assert!(list[0].get("suggestions").is_none());
}

#[tokio::test]
async fn viewers_get_403_and_b_sees_none_of_a() {
    let p = setup().await;
    let jo = p.contact("Jo", "Bloggs").await;
    let line = p.line(2, 1000, "J BLOGGS", "").await;
    let line = line["id"].as_str().unwrap().to_owned();
    let acc = p.account.clone();
    for (method, path) in [
        ("GET", format!("/api/t/alpha/bank/accounts/{acc}/line-choices")),
        ("GET", format!("/api/t/alpha/contacts/{jo}/bank-payers")),
        ("POST", format!("/api/t/alpha/contacts/{jo}/bank-payers/forget")),
        ("GET", format!("/api/t/alpha/bank/lines/{line}/hand-transfers")),
    ] {
        let (s, _) = p.w.call(method, &path, &p.val, None).await;
        assert_eq!(s, StatusCode::FORBIDDEN, "viewer {method} {path}");
        let (s, _) = p.w.call(method, &path.replace("/alpha/", "/beta/"), &p.bob, None).await;
        assert_eq!(s, StatusCode::NOT_FOUND, "B {method} {path}");
    }
    // A untouched: B's forget never reached it, nor ann's role a viewer's.
    let (s, _) = p.w.call("GET", &format!("/api/t/alpha/contacts/{jo}/bank-payers"), &p.ann, None).await;
    assert_eq!(s, StatusCode::OK);
}
