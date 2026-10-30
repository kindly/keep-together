//! `/api/t/{slug}/bank/…` over HTTP: roles (viewers see nothing, staff
//! import, admins set accounts up), the import flow and its error shapes
//! (`422 file_rows`, `413 too_large`, `422 rejected account_inactive`),
//! a layout kept with the import, and two organisations: B never sees A's
//! accounts, imports or lines, and A's ids under B's slug answer 404.

mod common;

use axum::body::Body as HttpBody;
use axum::http::{Request, StatusCode, header};
use common::{World, world};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

const NONE: &str = "0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0";

fn fixture(name: &str) -> Vec<u8> {
    let path = format!("{}/../banking/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// A Lloyds-layout CSV with one £10 credit on each of these November days.
fn lloyds_days(days: impl IntoIterator<Item = u32>) -> Vec<u8> {
    let mut text = String::from(
        "Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance,\n",
    );
    for d in days {
        text.push_str(&format!("{d:02}/11/2026,SO,'30-00-00,12345678,J SMITH SO,,10.00,0,\n"));
    }
    text.into_bytes()
}

fn enc(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

async fn upload(w: &World, path: &str, cookie: &str, bytes: Vec<u8>) -> (StatusCode, Value) {
    let req = Request::builder()
        .method("POST")
        .uri(path)
        .header(header::COOKIE, cookie)
        .header(header::CONTENT_TYPE, "text/csv")
        .body(HttpBody::from(bytes))
        .unwrap();
    let res = w.app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

fn query(account: &str, layout: Option<Value>, save: bool) -> String {
    let mut q = format!("accountId={account}&fileName=statement.csv");
    if let Some(l) = layout {
        q.push_str(&format!("&layout={}", enc(&l.to_string())));
    }
    if save {
        q.push_str("&saveLayout=true");
    }
    q
}

fn lloyds() -> Option<Value> {
    Some(json!({ "kind": "preset", "id": "lloyds" }))
}

fn account(name: &str, layout: Option<Value>) -> Value {
    let mut a = json!({
        "name": name, "sortCode": "30-00-00", "accountLast4": "5678", "active": true
    });
    if let Some(l) = layout {
        a["csvLayout"] = l;
    }
    a
}

async fn new_account(w: &World, slug: &str, cookie: &str, layout: Option<Value>) -> String {
    let (s, out) = w
        .call(
            "POST",
            &format!("/api/t/{slug}/bank/accounts"),
            cookie,
            Some(account("Current", layout)),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{out}");
    out["id"].as_str().unwrap().to_owned()
}

async fn import(
    w: &World,
    slug: &str,
    cookie: &str,
    q: &str,
    bytes: Vec<u8>,
) -> (StatusCode, Value) {
    upload(w, &format!("/api/t/{slug}/bank/imports?{q}"), cookie, bytes).await
}

#[tokio::test]
async fn viewers_see_nothing_and_only_admins_set_accounts_up() {
    let w = world();
    let (ann, sam, val) = (
        w.login("ann@alpha.org").await,
        w.login("sam@alpha.org").await,
        w.login("val@alpha.org").await,
    );
    let acc = new_account(&w, "alpha", &ann, lloyds()).await;
    let (_, done) = import(&w, "alpha", &sam, &query(&acc, None, false), lloyds_days([1])).await;
    let imp = done["id"].as_str().unwrap().to_owned();
    for path in [
        "/bank/presets".to_owned(),
        "/bank/accounts".to_owned(),
        format!("/bank/accounts/{acc}"),
        format!("/bank/accounts/{acc}/imports"),
        format!("/bank/imports/{imp}"),
    ] {
        let url = format!("/api/t/alpha{path}");
        let (s, _) = w.call("GET", &url, &val, None).await;
        assert_eq!(s, StatusCode::FORBIDDEN, "viewer GET {path}");
        let (s, _) = w.call("GET", &url, &sam, None).await;
        assert_eq!(s, StatusCode::OK, "staff GET {path}");
    }
    for path in [
        format!("/bank/imports?{}", query(&acc, None, false)),
        format!("/bank/imports/preview?{}", query(&acc, None, false)),
        "/bank/peek".to_owned(),
    ] {
        let (s, _) = upload(&w, &format!("/api/t/alpha{path}"), &val, lloyds_days([2])).await;
        assert_eq!(s, StatusCode::FORBIDDEN, "viewer POST {path}");
    }
    let (s, _) = w
        .call("POST", "/api/t/alpha/bank/accounts", &sam, Some(account("Other", None)))
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let save = json!({ "expected": 0, "name": "Renamed", "active": true });
    let (s, _) = w
        .call("POST", &format!("/api/t/alpha/bank/accounts/{acc}/save"), &sam, Some(save.clone()))
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, _) = w
        .call("POST", &format!("/api/t/alpha/bank/accounts/{acc}/save"), &ann, Some(save))
        .await;
    assert_eq!(s, StatusCode::OK);
}

#[tokio::test]
async fn an_account_saves_with_expected_and_answers_409_when_stale() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let acc = new_account(&w, "alpha", &ann, None).await;
    let (_, read) = w.call("GET", &format!("/api/t/alpha/bank/accounts/{acc}"), &ann, None).await;
    assert_eq!((read["version"].as_i64(), read["sortCode"].as_str()), (Some(0), Some("300000")));
    let url = format!("/api/t/alpha/bank/accounts/{acc}/save");
    let mut save = account("CAF current", lloyds());
    save["expected"] = json!(0);
    let (s, out) = w.call("POST", &url, &ann, Some(save.clone())).await;
    assert_eq!((s, out["counter"].as_i64()), (StatusCode::OK, Some(1)));
    let (s, out) = w.call("POST", &url, &ann, Some(save)).await;
    assert_eq!((s, out["kind"].as_str()), (StatusCode::CONFLICT, Some("stale")));
    assert_eq!(out["current"]["name"], "CAF current");
    let (_, presets) = w.call("GET", "/api/t/alpha/bank/presets", &ann, None).await;
    assert!(presets["presets"].as_array().unwrap().iter().all(|p| p["verified"] == false));
    assert_eq!(presets["awaitingSamples"][0], "CAF Bank");
}

#[tokio::test]
async fn import_preview_then_import_then_nothing_new() {
    let w = world();
    let (ann, sam) = (w.login("ann@alpha.org").await, w.login("sam@alpha.org").await);
    let acc = new_account(
        &w,
        "alpha",
        &ann,
        Some(json!({ "kind": "preset", "id": "natwest-bankline-statement" })),
    )
    .await;
    let file = fixture("natwest-bankline-statement.csv");
    let q = query(&acc, None, false);
    let (s, preview) = upload(
        &w,
        &format!("/api/t/alpha/bank/imports/preview?{q}"),
        &sam,
        file.clone(),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{preview}");
    assert_eq!((preview["newLines"].as_i64(), preview["debitsDropped"].as_i64()), (Some(4), Some(1)));
    assert_eq!(preview["lines"][0]["amount"], 2500);
    // A preview writes nothing.
    let (_, list) = w.call("GET", &format!("/api/t/alpha/bank/accounts/{acc}/imports"), &sam, None).await;
    assert_eq!(list.as_array().unwrap().len(), 0);

    let (s, done) = import(&w, "alpha", &sam, &q, file.clone()).await;
    assert_eq!(s, StatusCode::OK, "{done}");
    assert_eq!(
        (done["newLines"].as_i64(), done["duplicateLines"].as_i64(), done["firstDate"].as_str(), done["lastDate"].as_str()),
        (Some(4), Some(0), Some("2026-11-02"), Some("2026-11-04"))
    );
    let (_, again) = import(&w, "alpha", &sam, &q, file).await;
    assert_eq!((again["newLines"].as_i64(), again["duplicateLines"].as_i64()), (Some(0), Some(4)));

    let (_, list) = w.call("GET", &format!("/api/t/alpha/bank/accounts/{acc}/imports"), &sam, None).await;
    assert_eq!(list.as_array().unwrap().len(), 2);
    let id = done["id"].as_str().unwrap();
    let (s, detail) = w.call("GET", &format!("/api/t/alpha/bank/imports/{id}"), &sam, None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(detail["accountId"], acc.as_str());
    assert_eq!(detail["import"]["preset"], "natwest-bankline-statement");
    assert_eq!(detail["lines"].as_array().unwrap().len(), 4);
}

#[tokio::test]
async fn an_unreadable_file_is_422_by_line_and_stores_nothing() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let acc = new_account(&w, "alpha", &ann, lloyds()).await;
    let mut file = lloyds_days(1..=3);
    file.extend_from_slice(b"31/02/2026,SO,'30-00-00,12345678,BAD,,ten,0,\n");
    let (s, out) = import(&w, "alpha", &ann, &query(&acc, None, false), file).await;
    assert_eq!((s, out["kind"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("file_rows")));
    assert_eq!(out["rows"][0]["line"], 5);
    assert!(out["rows"][0]["message"].as_str().unwrap().contains("date"), "{out}");
    let (_, list) = w.call("GET", &format!("/api/t/alpha/bank/accounts/{acc}/imports"), &ann, None).await;
    assert_eq!(list.as_array().unwrap().len(), 0);
    // A layout that isn't one.
    let (s, out) = import(&w, "alpha", &ann, &format!("accountId={acc}&fileName=x&layout=%7B"), lloyds_days([1])).await;
    assert_eq!((s, out["kind"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid")));
}

#[tokio::test]
async fn a_file_over_5_mb_is_413() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let acc = new_account(&w, "alpha", &ann, lloyds()).await;
    let big = vec![b'a'; banking::import::FILE_BYTES_MAX + 1];
    let (s, out) = import(&w, "alpha", &ann, &query(&acc, None, false), big).await;
    assert_eq!((s, out["kind"].as_str()), (StatusCode::PAYLOAD_TOO_LARGE, Some("too_large")));
    assert_eq!(out["limit"].as_u64(), Some(banking::import::FILE_BYTES_MAX as u64));
    // Over the ordinary 2 MB but under 5: read, and refused for its rows.
    let (s, out) = import(&w, "alpha", &ann, &query(&acc, None, false), vec![b'a'; 3 << 20]).await;
    assert_eq!((s, out["kind"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("file_rows")));
}

#[tokio::test]
async fn an_archived_account_is_422_account_inactive() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let acc = new_account(&w, "alpha", &ann, lloyds()).await;
    let mut save = account("Current", lloyds());
    save["active"] = json!(false);
    save["expected"] = json!(0);
    w.call("POST", &format!("/api/t/alpha/bank/accounts/{acc}/save"), &ann, Some(save)).await;
    let (s, out) = import(&w, "alpha", &ann, &query(&acc, None, false), lloyds_days([1])).await;
    assert_eq!(
        (s, out["kind"].as_str(), out["reason"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("rejected"), Some("account_inactive"))
    );
}

#[tokio::test]
async fn a_mapping_is_kept_with_the_import_once_and_staff_cant_replace_it() {
    let w = world();
    let (ann, sam) = (w.login("ann@alpha.org").await, w.login("sam@alpha.org").await);
    let acc = new_account(&w, "alpha", &ann, None).await;
    let mapping = json!({ "kind": "mapping", "mapping": {
        "header": { "kind": "find" },
        "date": { "name": "Transaction Date" },
        "amount": { "kind": "paidInOut",
                    "paidIn": { "name": "Credit Amount" }, "paidOut": { "name": "Debit Amount" } },
        "narrative": [{ "name": "Transaction Description" }]
    }});
    // No layout saved, none sent: one file error, nothing stored.
    let (s, out) = import(&w, "alpha", &sam, &query(&acc, None, false), lloyds_days([1])).await;
    assert_eq!((s, out["rows"][0]["line"].as_i64()), (StatusCode::UNPROCESSABLE_ENTITY, Some(0)));
    let (s, out) = import(&w, "alpha", &sam, &query(&acc, Some(mapping.clone()), true), lloyds_days([1])).await;
    assert_eq!((s, out["newLines"].as_i64()), (StatusCode::OK, Some(1)), "{out}");
    let (_, read) = w.call("GET", &format!("/api/t/alpha/bank/accounts/{acc}"), &sam, None).await;
    assert_eq!(read["csvLayout"]["kind"], "mapping");
    assert_eq!(read["version"], 1);
    // Next time the saved mapping is used.
    let (_, out) = import(&w, "alpha", &sam, &query(&acc, None, false), lloyds_days([1, 2])).await;
    assert_eq!(out["newLines"], 1);
    // Staff can't replace a saved layout; nothing is imported either.
    let (s, _) = import(&w, "alpha", &sam, &query(&acc, lloyds(), true), lloyds_days([3])).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (_, list) = w.call("GET", &format!("/api/t/alpha/bank/accounts/{acc}/imports"), &sam, None).await;
    assert_eq!(list.as_array().unwrap().len(), 2);
    // An admin can.
    let (s, _) = import(&w, "alpha", &ann, &query(&acc, lloyds(), true), lloyds_days([3])).await;
    assert_eq!(s, StatusCode::OK);
    let (_, read) = w.call("GET", &format!("/api/t/alpha/bank/accounts/{acc}"), &sam, None).await;
    assert_eq!(read["csvLayout"], json!({ "kind": "preset", "id": "lloyds" }));
}

#[tokio::test]
async fn peek_shows_the_first_rows() {
    let w = world();
    let sam = w.login("sam@alpha.org").await;
    let (s, rows) = upload(&w, "/api/t/alpha/bank/peek", &sam, lloyds_days(1..=50)).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(rows.as_array().unwrap().len(), 30);
    assert_eq!(rows[0]["cells"][0], "Transaction Date");
    assert_eq!(rows[1]["line"], 2);
}

#[tokio::test]
async fn b_never_sees_a_and_as_ids_under_b_are_404() {
    let w = world();
    let (ann, bob) = (w.login("ann@alpha.org").await, w.login("bob@beta.org").await);
    let acc = new_account(&w, "alpha", &ann, lloyds()).await;
    let (_, done) = import(&w, "alpha", &ann, &query(&acc, None, false), lloyds_days([1])).await;
    let imp = done["id"].as_str().unwrap().to_owned();

    let (s, list) = w.call("GET", "/api/t/beta/bank/accounts", &bob, None).await;
    assert_eq!((s, list), (StatusCode::OK, json!([])));
    for path in [
        format!("/bank/accounts/{acc}"),
        format!("/bank/accounts/{acc}/imports"),
        format!("/bank/imports/{imp}"),
        format!("/bank/accounts/{NONE}"),
    ] {
        let (s, out) = w.call("GET", &format!("/api/t/beta{path}"), &bob, None).await;
        assert_eq!((s, out["kind"].as_str()), (StatusCode::NOT_FOUND, Some("not_found")), "{path}");
    }
    let mut save = account("Mine now", None);
    save["expected"] = json!(0);
    let (s, _) = w.call("POST", &format!("/api/t/beta/bank/accounts/{acc}/save"), &bob, Some(save)).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    for path in ["imports", "imports/preview"] {
        let url = format!("/api/t/beta/bank/{path}?{}", query(&acc, lloyds(), false));
        let (s, _) = upload(&w, &url, &bob, lloyds_days([2])).await;
        assert_eq!(s, StatusCode::NOT_FOUND, "{path}");
    }
    // A's own file is untouched by B's attempts, and B's import of the
    // same file is all new there.
    let b_acc = new_account(&w, "beta", &bob, lloyds()).await;
    let (_, out) = import(&w, "beta", &bob, &query(&b_acc, None, false), lloyds_days([1])).await;
    assert_eq!(out["newLines"], 1);
    let (_, list) = w.call("GET", &format!("/api/t/alpha/bank/accounts/{acc}/imports"), &ann, None).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
}
