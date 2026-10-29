//! Declaration scans over HTTP (plan `declaration-scans.sv`, step 3): the
//! phone pairing (token, device cookie, its life), uploads (limits, the
//! re-encode, the files db), the laptop's routes, isolation between two
//! organisations, the two files' ordering and the jobs. The rules of the
//! three contracts are `giftaid/tests/scans.rs`.

mod common;

use std::sync::Arc;

use api::scans::{self, MAX_UPLOADS};
use axum::body::Body as HttpBody;
use axum::http::{Request, StatusCode, header};
use common::{World, world};
use http_body_util::BodyExt;
use image::codecs::jpeg::JpegEncoder;
use image::{Rgb, RgbImage};
use serde_json::{Value, json};
use tower::ServiceExt;

/// A photographed page: a JPEG, different per `seed`.
fn photo(seed: u8) -> Vec<u8> {
    let img = RgbImage::from_fn(900, 1200, |x, y| {
        Rgb([
            ((x / 7) as u8).wrapping_add(seed),
            ((y / 5) as u8).wrapping_mul(3),
            seed,
        ])
    });
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 85)
        .encode_image(&img)
        .unwrap();
    out
}

struct Res {
    status: StatusCode,
    json: Value,
    headers: axum::http::HeaderMap,
    bytes: Vec<u8>,
}

async fn send(w: &World, method: &str, path: &str, cookie: Option<&str>, body: HttpBody) -> Res {
    let mut req = Request::builder().method(method).uri(path);
    if let Some(c) = cookie {
        req = req.header(header::COOKIE, c);
    }
    let res = w
        .app
        .clone()
        .oneshot(req.body(body).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    Res {
        status,
        json: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        headers,
        bytes,
    }
}

/// The phone: no session, at most its device cookie.
struct Phone {
    token: String,
    cookie: Option<String>,
}

impl Phone {
    fn new(token: &str) -> Self {
        Self {
            token: token.to_owned(),
            cookie: None,
        }
    }

    async fn open(&mut self, w: &World) -> Res {
        let res = send(
            w,
            "GET",
            &format!("/api/scan/{}", self.token),
            self.cookie.as_deref(),
            HttpBody::empty(),
        )
        .await;
        if let Some(set) = res.headers.get(header::SET_COOKIE) {
            let set = set.to_str().unwrap();
            assert!(
                set.contains("HttpOnly") && set.contains("SameSite=Strict"),
                "{set}"
            );
            assert!(set.contains("Secure"), "{set}");
            self.cookie = Some(set.split(';').next().unwrap().to_owned());
        }
        res
    }

    async fn upload(&self, w: &World, path: &str, image: Vec<u8>) -> Res {
        send(
            w,
            "POST",
            &format!("/api/scan/{}{path}", self.token),
            self.cookie.as_deref(),
            HttpBody::from(image),
        )
        .await
    }

    async fn new_scan(&self, w: &World, image: Vec<u8>) -> Res {
        self.upload(w, "/scans", image).await
    }

    async fn add_page(&self, w: &World, scan: &str, image: Vec<u8>) -> Res {
        self.upload(w, &format!("/scans/{scan}/pages"), image).await
    }
}

/// Sam (staff at alpha) starts a pairing: (pairing id, token).
async fn pair(w: &World, cookie: &str, slug: &str) -> (String, String) {
    let (s, out) = w
        .call(
            "POST",
            &format!("/api/t/{slug}/scan-pairings"),
            cookie,
            Some(json!({ "purpose": "stack" })),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{out}");
    let path = out["path"].as_str().unwrap();
    let token = path.strip_prefix("/scan.html#").unwrap().to_owned();
    (out["pairing"]["id"].as_str().unwrap().to_owned(), token)
}

async fn staff_sitting(w: &World) -> (String, String, String) {
    let sam = w.login("sam@alpha.org").await;
    let (id, token) = pair(w, &sam, "alpha").await;
    (sam, id, token)
}

fn platform_exec(w: &World, sql: &str, params: impl rusqlite::Params) {
    w.store
        .platform()
        .with_write(|tx| tx.execute(sql, params).map(|_| ()))
        .unwrap();
}

#[tokio::test]
async fn a_phone_claims_the_link_uploads_and_the_laptop_sees_the_stack() {
    let w = world();
    let (sam, pairing, token) = staff_sitting(&w).await;
    let mut phone = Phone::new(&token);
    let opened = phone.open(&w).await;
    assert_eq!(opened.status, StatusCode::OK, "{}", opened.json);
    assert_eq!(opened.json["orgName"], "Alpha");
    assert_eq!(opened.json["uploadsLeft"], MAX_UPLOADS);
    assert_eq!(opened.headers[header::CACHE_CONTROL], "no-store");

    let up = phone.new_scan(&w, photo(1)).await;
    assert_eq!(up.status, StatusCode::OK, "{}", up.json);
    let scan = up.json["scanId"].as_str().unwrap().to_owned();
    assert_eq!(
        (up.json["pages"].clone(), up.json["uploadsLeft"].clone()),
        (json!(1), json!(MAX_UPLOADS - 1))
    );
    let up = phone.add_page(&w, &scan, photo(2)).await;
    assert_eq!(
        (up.status, up.json["pages"].clone()),
        (StatusCode::OK, json!(2))
    );

    // The phone reads back its own sitting, nothing more.
    let again = phone.open(&w).await;
    assert_eq!(
        again.json["scans"],
        json!([{ "id": scan, "pages": 2, "open": true }])
    );

    // The laptop: the pairing's stack, and "Scans to match".
    let (s, view) = w
        .call(
            "GET",
            &format!("/api/t/alpha/scan-pairings/{pairing}"),
            &sam,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(view["claimed"], true);
    assert_eq!(view["scans"][0]["id"], scan);
    assert_eq!(view["scans"][0]["via"], "phone");
    let (_, inbox) = w.call("GET", "/api/t/alpha/scans", &sam, None).await;
    assert_eq!(inbox.as_array().unwrap().len(), 1);
    // Scanned by sam, via the pairing.
    let sam_id = w.store.platform().upsert_user("sam@alpha.org").unwrap().0;
    assert_eq!(inbox[0]["scannedBy"], sam_id);
    assert_eq!(inbox[0]["pairingId"], pairing);

    // The page as stored: a greyscale JPEG the server wrote, private.
    let page = send(
        &w,
        "GET",
        &format!("/api/t/alpha/scans/{scan}/pages/1"),
        Some(&sam),
        HttpBody::empty(),
    )
    .await;
    assert_eq!(page.status, StatusCode::OK);
    assert_eq!(page.headers[header::CONTENT_TYPE], "image/jpeg");
    assert!(
        page.headers[header::CACHE_CONTROL]
            .to_str()
            .unwrap()
            .starts_with("private")
    );
    let img = image::load_from_memory(&page.bytes).unwrap();
    assert_eq!(img.color(), image::ColorType::L8);
    assert!(page.bytes.len() as i64 <= giftaid::scans::MAX_PAGE_BYTES);
    let missing = send(
        &w,
        "GET",
        &format!("/api/t/alpha/scans/{scan}/pages/3"),
        Some(&sam),
        HttpBody::empty(),
    )
    .await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);

    // Usage for Settings.
    let (_, usage) = w.call("GET", "/api/t/alpha/files-usage", &sam, None).await;
    assert!(usage["bytes"].as_i64().unwrap() > 0);
    assert_eq!(usage["capBytes"], store::files::CAP_BYTES);
}

#[tokio::test]
async fn a_second_device_and_a_phone_without_the_cookie_are_refused() {
    let w = world();
    let (_, _, token) = staff_sitting(&w).await;
    let mut first = Phone::new(&token);
    assert_eq!(first.open(&w).await.status, StatusCode::OK);
    // Another phone (no cookie, then its own).
    let mut second = Phone::new(&token);
    let refused = second.open(&w).await;
    assert_eq!(
        (refused.status, &refused.json["kind"]),
        (StatusCode::FORBIDDEN, &json!("forbidden"))
    );
    assert_eq!(
        second.new_scan(&w, photo(1)).await.status,
        StatusCode::FORBIDDEN
    );
    // Uploading without opening first: no claim, refused.
    let (_, _, other) = staff_sitting(&w).await;
    let fresh = Phone {
        token: other,
        cookie: first.cookie.clone(),
    };
    assert_eq!(
        fresh.new_scan(&w, photo(1)).await.status,
        StatusCode::FORBIDDEN
    );
    // The first phone can open a second link with the same cookie.
    let mut reused = Phone {
        token: fresh.token.clone(),
        cookie: first.cookie.clone(),
    };
    assert_eq!(reused.open(&w).await.status, StatusCode::OK);
    assert_eq!(reused.new_scan(&w, photo(3)).await.status, StatusCode::OK);
    assert_eq!(first.new_scan(&w, photo(2)).await.status, StatusCode::OK);
}

#[tokio::test]
async fn expired_idle_ended_revoked_and_forged_tokens_are_gone() {
    let w = world();
    let gone = |r: &Res| r.status == StatusCode::GONE && r.json["kind"] == "gone";

    // Forged.
    let mut forged = Phone::new(&"ab".repeat(32));
    assert!(gone(&forged.open(&w).await));
    assert!(gone(&Phone::new("nope").open(&w).await));

    // Hard cap.
    let (_, id, token) = staff_sitting(&w).await;
    let mut phone = Phone::new(&token);
    phone.open(&w).await;
    platform_exec(
        &w,
        "UPDATE scan_pairings SET expires_at = 1 WHERE id = ?1",
        [&id],
    );
    assert!(gone(&phone.open(&w).await));

    // Idle 15 minutes.
    let (_, id, token) = staff_sitting(&w).await;
    let mut phone = Phone::new(&token);
    phone.open(&w).await;
    let stale = contracts::now_ms() - scans::IDLE_MS - 1;
    platform_exec(
        &w,
        "UPDATE scan_pairings SET last_used_at = ?2 WHERE id = ?1",
        rusqlite::params![id, stale],
    );
    assert!(gone(&phone.new_scan(&w, photo(1)).await));

    // Ended on the laptop.
    let (sam, id, token) = staff_sitting(&w).await;
    let mut phone = Phone::new(&token);
    phone.open(&w).await;
    let (s, ended) = w
        .call(
            "DELETE",
            &format!("/api/t/alpha/scan-pairings/{id}"),
            &sam,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert!(ended["endedAt"].is_number());
    assert!(gone(&phone.new_scan(&w, photo(1)).await));

    // The laptop signs out: its pairings end.
    let (sam, id, token) = staff_sitting(&w).await;
    let mut phone = Phone::new(&token);
    phone.open(&w).await;
    let out = send(
        &w,
        "POST",
        "/api/auth/sign-out",
        Some(&sam),
        HttpBody::empty(),
    )
    .await;
    assert!(out.status.is_success(), "{}", out.status);
    assert!(gone(&phone.open(&w).await));
    let ended_why: String = w
        .store
        .platform()
        .with_read(|c| {
            c.query_row(
                "SELECT ended_why FROM scan_pairings WHERE id = ?1",
                [&id],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(ended_why, "session");

    // Revoke-all (a password reset, a removal): every pairing of the user.
    let (_, _, token) = staff_sitting(&w).await;
    let mut phone = Phone::new(&token);
    phone.open(&w).await;
    let sam_id = w.store.platform().upsert_user("sam@alpha.org").unwrap().0;
    w.store
        .platform()
        .with_write(|tx| ::auth::sessions::revoke_user(tx, sam_id))
        .unwrap();
    assert!(gone(&phone.open(&w).await));

    // Demoted to viewer meanwhile.
    let (_, _, token) = staff_sitting(&w).await;
    let mut phone = Phone::new(&token);
    phone.open(&w).await;
    let p = w.store.platform();
    p.set_membership(store::UserId(sam_id), &w.alpha.id, store::Role::Viewer)
        .unwrap();
    assert!(gone(&phone.open(&w).await));
}

#[tokio::test]
async fn a_session_token_rotation_keeps_its_pairing() {
    let w = world();
    let (sam, id, token) = staff_sitting(&w).await;
    let mut phone = Phone::new(&token);
    phone.open(&w).await;
    // Step-up and one's own role change rotate the token in place.
    let hash = ::auth::secret::hash(sam.split('=').nth(1).unwrap());
    let now = contracts::now_ms();
    w.store
        .platform()
        .with_write(|tx| {
            let s = ::auth::sessions::by_id(tx, &hash, now)?.unwrap();
            ::auth::sessions::step_up(tx, &s, now)
        })
        .unwrap();
    assert_eq!(phone.open(&w).await.status, StatusCode::OK);
    let session: String = w
        .store
        .platform()
        .with_read(|c| {
            c.query_row(
                "SELECT session_id FROM scan_pairings WHERE id = ?1",
                [&id],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_ne!(session, hash);
}

#[tokio::test]
async fn starting_a_pairing_needs_staff_and_a_recent_sign_in() {
    let w = world();
    let val = w.login("val@alpha.org").await;
    let (s, out) = w
        .call(
            "POST",
            "/api/t/alpha/scan-pairings",
            &val,
            Some(json!({ "purpose": "stack" })),
        )
        .await;
    assert_eq!(
        (s, &out["kind"]),
        (StatusCode::FORBIDDEN, &json!("forbidden"))
    );
    let sam = w.login("sam@alpha.org").await;
    let hash = ::auth::secret::hash(sam.split('=').nth(1).unwrap());
    let long_ago = contracts::now_ms() - ::auth::STEP_UP_MS - 1;
    platform_exec(
        &w,
        "UPDATE auth_sessions SET authenticated_at = ?2 WHERE token_hash = ?1",
        rusqlite::params![hash, long_ago],
    );
    let (s, out) = w
        .call(
            "POST",
            "/api/t/alpha/scan-pairings",
            &sam,
            Some(json!({ "purpose": "contact" })),
        )
        .await;
    assert_eq!(
        (s, &out["kind"]),
        (StatusCode::FORBIDDEN, &json!("step_up_required"))
    );
}

#[tokio::test]
async fn the_token_is_stored_hashed() {
    let w = world();
    let (_, id, token) = staff_sitting(&w).await;
    let stored: String = w
        .store
        .platform()
        .with_read(|c| {
            c.query_row(
                "SELECT token_hash FROM scan_pairings WHERE id = ?1",
                [&id],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(stored, ::auth::secret::hash(&token));
    let file = std::fs::read(w.store.dir().join("platform.db")).unwrap();
    let wal = std::fs::read(w.store.dir().join("platform.db-wal")).unwrap_or_default();
    for bytes in [file, wal] {
        assert!(
            !bytes
                .windows(token.len())
                .any(|win| win == token.as_bytes())
        );
    }
}

#[tokio::test]
async fn uploads_are_limited_before_and_after_the_body() {
    let w = world();
    let (sam, id, token) = staff_sitting(&w).await;
    let mut phone = Phone::new(&token);
    phone.open(&w).await;
    let invalid =
        |r: &Res| r.status == StatusCode::UNPROCESSABLE_ENTITY && r.json["kind"] == "invalid";
    // Too big a body.
    assert!(invalid(
        &phone
            .new_scan(&w, vec![0xFF; scans::UPLOAD_BODY_LIMIT + 1])
            .await
    ));
    // Not an image; a decompression bomb (a PNG header claiming 2.5 GP).
    assert!(invalid(&phone.new_scan(&w, b"%PDF-1.7".to_vec()).await));
    let mut bomb = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
    bomb.extend(50_000u32.to_be_bytes());
    bomb.extend(50_000u32.to_be_bytes());
    bomb.extend([8, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert!(invalid(&phone.new_scan(&w, bomb).await));
    // A 7th page.
    let first = phone.new_scan(&w, photo(1)).await;
    let scan = first.json["scanId"].as_str().unwrap().to_owned();
    for n in 2..=6 {
        assert_eq!(
            phone.add_page(&w, &scan, photo(n)).await.status,
            StatusCode::OK
        );
    }
    let seventh = phone.add_page(&w, &scan, photo(7)).await;
    assert_eq!(
        (seventh.status, &seventh.json["reason"]),
        (StatusCode::UNPROCESSABLE_ENTITY, &json!("page_limit"))
    );
    // The 301st upload.
    platform_exec(
        &w,
        "UPDATE scan_pairings SET uploads = ?2 WHERE id = ?1",
        rusqlite::params![id, MAX_UPLOADS],
    );
    let over = phone.new_scan(&w, photo(8)).await;
    assert_eq!(
        (over.status, &over.json["reason"]),
        (StatusCode::UNPROCESSABLE_ENTITY, &json!("upload_limit"))
    );
    // The org past its 2 GB: a new blob is refused, "contact us".
    platform_exec(
        &w,
        "UPDATE scan_pairings SET uploads = 0 WHERE id = ?1",
        [&id],
    );
    let files = w.store.dir().join(format!("files/{}.db", w.alpha.id));
    let conn = rusqlite::Connection::open(&files).unwrap();
    conn.execute(
        "INSERT INTO blobs (sha256, bytes, content_type, size, created_at, last_put_at)
         VALUES ('ff', x'00', 'image/jpeg', ?1, 0, 0)",
        [store::files::CAP_BYTES],
    )
    .unwrap();
    drop(conn);
    let full = phone.new_scan(&w, photo(9)).await;
    assert_eq!(
        (full.status, &full.json["reason"]),
        (StatusCode::UNPROCESSABLE_ENTITY, &json!("files_full"))
    );
    let (_, inbox) = w.call("GET", "/api/t/alpha/scans", &sam, None).await;
    assert_eq!(inbox.as_array().unwrap().len(), 1);
}

/// A dead token's upload is answered without its body being read: a body
/// that never ends doesn't hold the request.
#[tokio::test]
async fn a_dead_tokens_upload_is_refused_before_its_body_is_read() {
    let w = world();
    let endless = futures_util::stream::repeat_with(|| {
        Ok::<_, std::io::Error>(axum::body::Bytes::from_static(&[0u8; 4096]))
    });
    let res = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        send(
            &w,
            "POST",
            &format!("/api/scan/{}/scans", "cd".repeat(32)),
            None,
            HttpBody::from_stream(endless),
        ),
    )
    .await
    .expect("answered before reading the body");
    assert_eq!(res.status, StatusCode::GONE);
}

#[tokio::test]
async fn a_signed_in_phone_uploads_directly_and_a_viewer_cannot() {
    let w = world();
    let sam = w.login("sam@alpha.org").await;
    let up = send(
        &w,
        "POST",
        "/api/t/alpha/scans?id=0190f0c0a0b0c0d0e0f0a0b0c0d0e0a1",
        Some(&sam),
        HttpBody::from(photo(1)),
    )
    .await;
    assert_eq!(up.status, StatusCode::OK, "{}", up.json);
    assert_eq!(up.json["uploadsLeft"], Value::Null);
    // A retry with the same id: the same scan, no second draft.
    let again = send(
        &w,
        "POST",
        "/api/t/alpha/scans?id=0190f0c0a0b0c0d0e0f0a0b0c0d0e0a1",
        Some(&sam),
        HttpBody::from(photo(1)),
    )
    .await;
    assert_eq!(again.json["scanId"], "0190f0c0a0b0c0d0e0f0a0b0c0d0e0a1");
    let page = send(&w, "POST", "/api/t/alpha/scans/0190f0c0a0b0c0d0e0f0a0b0c0d0e0a1/pages?pageId=0190f0c0a0b0c0d0e0f0a0b0c0d0e0a2", Some(&sam), HttpBody::from(photo(2))).await;
    assert_eq!(page.json["pages"], 2);
    let retried = send(&w, "POST", "/api/t/alpha/scans/0190f0c0a0b0c0d0e0f0a0b0c0d0e0a1/pages?pageId=0190f0c0a0b0c0d0e0f0a0b0c0d0e0a2", Some(&sam), HttpBody::from(photo(2))).await;
    assert_eq!(retried.json["pages"], 2);
    let (_, one) = w
        .call(
            "GET",
            "/api/t/alpha/scans/0190f0c0a0b0c0d0e0f0a0b0c0d0e0a1",
            &sam,
            None,
        )
        .await;
    assert_eq!(one["via"], "direct");

    let val = w.login("val@alpha.org").await;
    let refused = send(
        &w,
        "POST",
        "/api/t/alpha/scans",
        Some(&val),
        HttpBody::from(photo(3)),
    )
    .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN);
    for path in [
        "/api/t/alpha/scans",
        "/api/t/alpha/scans/0190f0c0a0b0c0d0e0f0a0b0c0d0e0a1",
        "/api/t/alpha/scans/0190f0c0a0b0c0d0e0f0a0b0c0d0e0a1/pages/1",
    ] {
        let r = send(&w, "GET", path, Some(&val), HttpBody::empty()).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{path}");
    }
}

/// Two organisations. B never sees A's scans, images or pairings; A's
/// ids under B's slug are 404; a token minted for A reaches only A's
/// file (the route has no slug to swap); B holding the same bytes changes
/// nothing.
#[tokio::test]
async fn isolation_between_two_organisations() {
    let w = world();
    let (sam, pairing, token) = staff_sitting(&w).await;
    let mut phone = Phone::new(&token);
    phone.open(&w).await;
    let scan = phone.new_scan(&w, photo(1)).await.json["scanId"]
        .as_str()
        .unwrap()
        .to_owned();

    let bob = w.login("bob@beta.org").await;
    // B uploads the very same bytes: per-org content addressing.
    let b_scan = send(
        &w,
        "POST",
        "/api/t/beta/scans",
        Some(&bob),
        HttpBody::from(photo(1)),
    )
    .await;
    assert_eq!(b_scan.status, StatusCode::OK);
    let b_scan = b_scan.json["scanId"].as_str().unwrap().to_owned();
    let (_, b_inbox) = w.call("GET", "/api/t/beta/scans", &bob, None).await;
    assert_eq!(
        b_inbox
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].clone())
            .collect::<Vec<_>>(),
        [json!(b_scan)]
    );

    let (_, usage_b) = w.call("GET", "/api/t/beta/files-usage", &bob, None).await;
    let (_, usage_a) = w.call("GET", "/api/t/alpha/files-usage", &sam, None).await;
    assert_eq!(
        usage_a["bytes"], usage_b["bytes"],
        "the same page, stored once in each file"
    );

    // Every scan route under B's slug with A's ids: 404, strictly (a
    // well-formed body, so nothing can answer `invalid` before it looks).
    for (method, path, body) in [
        ("GET", format!("/api/t/beta/scans/{scan}"), None),
        ("GET", format!("/api/t/beta/scans/{scan}/pages/1"), None),
        ("GET", format!("/api/t/beta/scan-pairings/{pairing}"), None),
        (
            "DELETE",
            format!("/api/t/beta/scan-pairings/{pairing}"),
            None,
        ),
        (
            "POST",
            format!("/api/t/beta/scans/{scan}/discard"),
            Some(json!({ "expected": 0 })),
        ),
        (
            "POST",
            format!("/api/t/beta/scans/{scan}/reorder"),
            Some(json!({ "expected": 0, "order": ["0190f0c0a0b0c0d0e0f0a0b0c0d0e0a1"] })),
        ),
        (
            "POST",
            format!("/api/t/beta/scans/{scan}/delete-images"),
            Some(json!({ "expected": 0 })),
        ),
        (
            "POST",
            format!("/api/t/beta/scans/{scan}/accept"),
            Some(
                json!({ "expected": 0, "contactId": "0190f0c0a0b0c0d0e0f0a0b0c0d0e0a1",
                "match": { "kind": "existing", "declarationId": "0190f0c0a0b0c0d0e0f0a0b0c0d0e0a2" } }),
            ),
        ),
        // Merge both ways: A's scan as the target, and as the source.
        (
            "POST",
            format!("/api/t/beta/scans/{scan}/merge"),
            Some(json!({ "expected": 0, "from": b_scan, "fromExpected": 0 })),
        ),
        (
            "POST",
            format!("/api/t/beta/scans/{b_scan}/merge"),
            Some(json!({ "expected": 0, "from": scan, "fromExpected": 0 })),
        ),
    ] {
        let (s, out) = w.call(method, &path, &bob, body).await;
        assert_eq!(
            (s, &out["kind"]),
            (StatusCode::NOT_FOUND, &json!("not_found")),
            "{method} {path}: {out}"
        );
    }
    // B's own draft is untouched by the merge attempts.
    let (_, b_one) = w
        .call("GET", &format!("/api/t/beta/scans/{b_scan}"), &bob, None)
        .await;
    assert_eq!(
        (
            b_one["status"].clone(),
            b_one["pages"].as_array().unwrap().len()
        ),
        (json!("draft"), 1)
    );
    // A page onto A's scan from B's signed-in phone: 404, nothing added.
    let r = send(
        &w,
        "POST",
        &format!("/api/t/beta/scans/{scan}/pages"),
        Some(&bob),
        HttpBody::from(photo(2)),
    )
    .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    // A's phone onto B's scan id: 404 (not this sitting's).
    let r = phone.add_page(&w, &b_scan, photo(2)).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    // A's token wrote A's file only.
    let (_, a_inbox) = w.call("GET", "/api/t/alpha/scans", &sam, None).await;
    assert_eq!(a_inbox.as_array().unwrap().len(), 1);
    assert_eq!(a_inbox[0]["pages"].as_array().unwrap().len(), 1);
    // A pairing minted at B can't touch A.
    let (_, b_token) = pair(&w, &bob, "beta").await;
    let mut b_phone = Phone::new(&b_token);
    b_phone.open(&w).await;
    assert_eq!(
        b_phone.add_page(&w, &scan, photo(3)).await.status,
        StatusCode::NOT_FOUND
    );
    let (_, a_inbox) = w.call("GET", "/api/t/alpha/scans", &sam, None).await;
    assert_eq!(a_inbox[0]["pages"].as_array().unwrap().len(), 1);
    // Its sitting is B's own.
    let opened = b_phone.open(&w).await;
    assert_eq!(opened.json["orgName"], "Beta");
    assert_eq!(opened.json["scans"], json!([]));

    // A's scan accepted onto an old declaration: in A's "can be deleted"
    // report, never in B's; its declaration's scans are 404 under B.
    let jo = contact(&w, &sam).await;
    let (s, out) = w
        .call(
            "POST",
            &format!("/api/t/alpha/scans/{scan}/accept"),
            &sam,
            Some(json!({ "expected": 0, "contactId": jo,
                "match": { "kind": "new", "declaration": declaration(&jo, "2015-01-01", "paperForm") } })),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{out}");
    let decl = out["declarationId"].as_str().unwrap().to_owned();
    let ann = w.login("ann@alpha.org").await;
    let report = "/api/t/{slug}/giftaid/scans/deletable?today=2026-10-29";
    let (_, a_report) = w
        .call("GET", &report.replace("{slug}", "alpha"), &ann, None)
        .await;
    assert_eq!(a_report[0]["scan"]["id"], scan);
    let (s, b_report) = w
        .call("GET", &report.replace("{slug}", "beta"), &bob, None)
        .await;
    assert_eq!((s, b_report), (StatusCode::OK, json!([])));
    let (s, out) = w
        .call(
            "GET",
            &format!("/api/t/beta/giftaid/{decl}/scans"),
            &bob,
            None,
        )
        .await;
    assert_eq!(
        (s, &out["kind"]),
        (StatusCode::NOT_FOUND, &json!("not_found"))
    );
}

async fn contact(w: &World, cookie: &str) -> String {
    let (s, out) = w
        .call(
            "POST",
            "/api/t/alpha/contacts",
            cookie,
            Some(common::person("Jo", "Bloggs")),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{out}");
    out["id"].as_str().unwrap().to_owned()
}

fn declaration(contact: &str, made_on: &str, method: &str) -> Value {
    json!({
        "contactId": contact, "scope": "future", "madeOn": made_on, "method": method,
        "wordingVersion": giftaid::HMRC_MODEL_WORDING_VERSION,
        "firstName": "Jo", "lastName": "Bloggs", "addressLine1": "12", "postcode": "SW1A 1AA"
    })
}

#[tokio::test]
async fn accept_discard_merge_and_reorder_on_the_laptop() {
    let w = world();
    let (sam, _, token) = staff_sitting(&w).await;
    let mut phone = Phone::new(&token);
    phone.open(&w).await;
    let a = phone.new_scan(&w, photo(1)).await.json["scanId"]
        .as_str()
        .unwrap()
        .to_owned();
    let b = phone.new_scan(&w, photo(2)).await.json["scanId"]
        .as_str()
        .unwrap()
        .to_owned();
    let c = phone.new_scan(&w, photo(3)).await.json["scanId"]
        .as_str()
        .unwrap()
        .to_owned();
    let jo = contact(&w, &sam).await;

    // Merge b into a, then put b's page first.
    let (s, merged) = w
        .call(
            "POST",
            &format!("/api/t/alpha/scans/{a}/merge"),
            &sam,
            Some(json!({ "expected": 0, "from": b, "fromExpected": 0 })),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{merged}");
    let pages: Vec<String> = merged["pages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(pages.len(), 2);
    let (s, reordered) = w
        .call(
            "POST",
            &format!("/api/t/alpha/scans/{a}/reorder"),
            &sam,
            Some(json!({ "expected": merged["scanVersion"], "order": [pages[1], pages[0]] })),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{reordered}");
    assert_eq!(reordered["pages"][0]["id"], pages[1]);
    let (s, stale) = w
        .call(
            "POST",
            &format!("/api/t/alpha/scans/{a}/reorder"),
            &sam,
            Some(json!({ "expected": 0, "order": [pages[0]] })),
        )
        .await;
    assert_eq!((s, &stale["kind"]), (StatusCode::CONFLICT, &json!("stale")));

    // Accept a with a new paper-form declaration: one group.
    let (s, accepted) = w.call("POST", &format!("/api/t/alpha/scans/{a}/accept"), &sam, Some(json!({
        "expected": 0, "contactId": jo,
        "match": { "kind": "new", "declaration": declaration(&jo, "2026-05-05", "paperForm") }
    }))).await;
    assert_eq!(s, StatusCode::OK, "{accepted}");
    let decl = accepted["declarationId"].as_str().unwrap().to_owned();
    assert_eq!(accepted["scan"]["status"], "accepted");

    // A viewer learns the declaration holds a scan, and when; not the scan.
    let val = w.login("val@alpha.org").await;
    let (s, held) = w
        .call(
            "GET",
            &format!("/api/t/alpha/giftaid/{decl}/scans"),
            &val,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(held["held"][0]["id"], a);
    assert_eq!(held["held"][0]["imagesHeld"], true);
    assert_eq!(held["scans"], Value::Null);
    let (_, held) = w
        .call(
            "GET",
            &format!("/api/t/alpha/giftaid/{decl}/scans"),
            &sam,
            None,
        )
        .await;
    assert_eq!(held["scans"][0]["id"], a);

    // Discard c; the inbox is empty.
    let (s, discarded) = w
        .call(
            "POST",
            &format!("/api/t/alpha/scans/{c}/discard"),
            &sam,
            Some(json!({ "expected": 0, "reason": "blurred" })),
        )
        .await;
    assert_eq!(
        (s, &discarded["status"]),
        (StatusCode::OK, &json!("discarded"))
    );
    let (_, inbox) = w.call("GET", "/api/t/alpha/scans", &sam, None).await;
    assert_eq!(inbox, json!([]));

    // A refused accept leaves no declaration: both or neither.
    let d = phone.new_scan(&w, photo(4)).await.json["scanId"]
        .as_str()
        .unwrap()
        .to_owned();
    let (s, out) = w
        .call(
            "POST",
            &format!("/api/t/alpha/scans/{d}/accept"),
            &sam,
            Some(json!({
                "expected": 0, "contactId": jo,
                "match": { "kind": "new", "declaration": declaration(&jo, "2026-06-06", "oral") }
            })),
        )
        .await;
    assert_eq!(
        (s, &out["reason"]),
        (StatusCode::UNPROCESSABLE_ENTITY, &json!("not_paper_form"))
    );
    let (_, panel) = w
        .call(
            "GET",
            &format!("/api/t/alpha/contacts/{jo}/giftaid?today=2026-10-29"),
            &sam,
            None,
        )
        .await;
    assert_eq!(panel["declarations"].as_array().unwrap().len(), 1);
}

/// Whether `seed`'s photo, as the server stores it, is a blob in alpha's
/// files db.
fn alpha_holds(w: &World, seed: u8) -> bool {
    let db = w.store.org(&w.alpha.id).unwrap();
    let processed = api::scans::image::reencode(&photo(seed)).unwrap();
    db.files_if_any()
        .unwrap()
        .unwrap()
        .get(&store::files::sha256_hex(&processed.bytes))
        .unwrap()
        .is_some()
}

/// L2: the phone sends a page again because the answer was lost, and the
/// laptop has accepted (or discarded) its scan meanwhile. The known
/// `pageId` is answered as landed, the same scan and pages, with nothing
/// stored or counted; a new page there is still refused.
#[tokio::test]
async fn a_page_resent_after_accept_or_discard_is_answered_as_landed() {
    let w = world();
    let (sam, _, token) = staff_sitting(&w).await;
    let mut phone = Phone::new(&token);
    phone.open(&w).await;
    let page = "0190f0c0a0b0c0d0e0f0a0b0c0d0e0b1";
    let scan = phone.new_scan(&w, photo(1)).await.json["scanId"]
        .as_str()
        .unwrap()
        .to_owned();
    let sent = phone
        .upload(&w, &format!("/scans/{scan}/pages?pageId={page}"), photo(2))
        .await;
    assert_eq!(sent.status, StatusCode::OK, "{}", sent.json);
    let left = sent.json["uploadsLeft"].clone();
    let jo = contact(&w, &sam).await;
    let (s, out) = w.call("POST", &format!("/api/t/alpha/scans/{scan}/accept"), &sam, Some(json!({
        "expected": 0, "contactId": jo,
        "match": { "kind": "new", "declaration": declaration(&jo, "2026-05-05", "paperForm") }
    }))).await;
    assert_eq!(s, StatusCode::OK, "{out}");

    // Resent (different bytes, to show none are kept): the same answer.
    let again = phone
        .upload(&w, &format!("/scans/{scan}/pages?pageId={page}"), photo(9))
        .await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.json);
    assert_eq!(
        again.json,
        json!({ "scanId": scan, "pages": 2, "uploadsLeft": left })
    );
    assert!(!alpha_holds(&w, 9), "a resend stores no blob");
    let (_, view) = w
        .call("GET", &format!("/api/t/alpha/scans/{scan}"), &sam, None)
        .await;
    assert_eq!(view["pages"].as_array().unwrap().len(), 2);
    assert_eq!(view["pages"][1]["id"], page);

    // A new page onto the accepted scan: still refused.
    let fresh = phone
        .upload(
            &w,
            &format!("/scans/{scan}/pages?pageId=0190f0c0a0b0c0d0e0f0a0b0c0d0e0b2"),
            photo(3),
        )
        .await;
    assert!(!fresh.status.is_success(), "{}", fresh.json);

    // The same after a discard.
    let other = phone.new_scan(&w, photo(4)).await.json["scanId"]
        .as_str()
        .unwrap()
        .to_owned();
    let second = "0190f0c0a0b0c0d0e0f0a0b0c0d0e0b3";
    phone
        .upload(
            &w,
            &format!("/scans/{other}/pages?pageId={second}"),
            photo(5),
        )
        .await;
    let (s, _) = w
        .call(
            "POST",
            &format!("/api/t/alpha/scans/{other}/discard"),
            &sam,
            Some(json!({ "expected": 0 })),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let again = phone
        .upload(
            &w,
            &format!("/scans/{other}/pages?pageId={second}"),
            photo(5),
        )
        .await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.json);
    assert_eq!(
        (&again.json["scanId"], &again.json["pages"]),
        (&json!(other), &json!(2))
    );

    // A signed-in phone's direct resend, likewise.
    let direct = send(
        &w,
        "POST",
        "/api/t/alpha/scans",
        Some(&sam),
        HttpBody::from(photo(6)),
    )
    .await;
    let direct = direct.json["scanId"].as_str().unwrap().to_owned();
    let third = "0190f0c0a0b0c0d0e0f0a0b0c0d0e0b4";
    let path = format!("/api/t/alpha/scans/{direct}/pages?pageId={third}");
    let first = send(&w, "POST", &path, Some(&sam), HttpBody::from(photo(7))).await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.json);
    let (s, _) = w
        .call(
            "POST",
            &format!("/api/t/alpha/scans/{direct}/discard"),
            &sam,
            Some(json!({ "expected": 0 })),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let again = send(&w, "POST", &path, Some(&sam), HttpBody::from(photo(8))).await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.json);
    assert_eq!(
        again.json,
        json!({ "scanId": direct, "pages": 2, "uploadsLeft": null })
    );
    assert!(!alpha_holds(&w, 8));
}

/// A resend is only ever answered for the scan's own sitting: the same
/// scan and `pageId` from another pairing (same org or another), or
/// direct, or under another org's slug, is `404`.
#[tokio::test]
async fn a_resent_page_id_is_only_known_to_its_own_sitting() {
    let w = world();
    let (sam, _, token) = staff_sitting(&w).await;
    let mut phone = Phone::new(&token);
    phone.open(&w).await;
    let page = "0190f0c0a0b0c0d0e0f0a0b0c0d0e0c1";
    let scan = phone.new_scan(&w, photo(1)).await.json["scanId"]
        .as_str()
        .unwrap()
        .to_owned();
    let path = format!("/scans/{scan}/pages?pageId={page}");
    assert_eq!(
        phone.upload(&w, &path, photo(2)).await.status,
        StatusCode::OK
    );
    let (s, _) = w
        .call(
            "POST",
            &format!("/api/t/alpha/scans/{scan}/discard"),
            &sam,
            Some(json!({ "expected": 0 })),
        )
        .await;
    assert_eq!(s, StatusCode::OK);

    // Another sitting of the same org.
    let (_, other_token) = pair(&w, &sam, "alpha").await;
    let mut other = Phone::new(&other_token);
    other.open(&w).await;
    assert_eq!(
        other.upload(&w, &path, photo(2)).await.status,
        StatusCode::NOT_FOUND
    );
    // A sitting of another org.
    let bob = w.login("bob@beta.org").await;
    let (_, beta_token) = pair(&w, &bob, "beta").await;
    let mut beta = Phone::new(&beta_token);
    beta.open(&w).await;
    assert_eq!(
        beta.upload(&w, &path, photo(2)).await.status,
        StatusCode::NOT_FOUND
    );
    // Direct, in its own org (a phone's scan isn't a direct one) and under B.
    for (slug, cookie) in [("alpha", &sam), ("beta", &bob)] {
        let res = send(
            &w,
            "POST",
            &format!("/api/t/{slug}/scans/{scan}/pages?pageId={page}"),
            Some(cookie),
            HttpBody::from(photo(2)),
        )
        .await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{slug}: {}", res.json);
    }
}

/// Blob first on the way in: a refused contract leaves an orphan, which
/// the sweep removes after a day, never a blob a page names. Contract
/// first on the way out: the image is unreachable at once, the blob goes
/// after.
#[tokio::test]
async fn the_two_files_orphans_are_swept_and_deletion_commits_first() {
    let w = world();
    let (sam, _, token) = staff_sitting(&w).await;
    let mut phone = Phone::new(&token);
    phone.open(&w).await;
    let kept = phone.new_scan(&w, photo(1)).await.json["scanId"]
        .as_str()
        .unwrap()
        .to_owned();
    // A page onto a scan that isn't this sitting's: the blob is put, the
    // contract refused, no page row.
    let refused = phone
        .add_page(&w, "0190f0c0a0b0c0d0e0f0a0b0c0d0e0a9", photo(2))
        .await;
    assert_eq!(refused.status, StatusCode::NOT_FOUND);
    let db = w.store.org(&w.alpha.id).unwrap();
    let files = db.files_if_any().unwrap().unwrap();
    let blobs = |files: &store::files::FilesDb| {
        let mut n = 0;
        for seed in 1..=2u8 {
            let processed = api::scans::image::reencode(&photo(seed)).unwrap();
            if files
                .get(&store::files::sha256_hex(&processed.bytes))
                .unwrap()
                .is_some()
            {
                n += 1;
            }
        }
        n
    };
    assert_eq!(blobs(&files), 2, "the refused upload's blob is an orphan");
    let now = contracts::now_ms();
    // Within the day: kept.
    assert_eq!(
        scans::sweep_blobs(&db, now - scans::ORPHAN_AFTER_MS).unwrap(),
        0
    );
    // A day on: the orphan goes, the referenced page stays.
    assert_eq!(scans::sweep_blobs(&db, now + 1).unwrap(), 1);
    assert_eq!(blobs(&files), 1);
    let page = send(
        &w,
        "GET",
        &format!("/api/t/alpha/scans/{kept}/pages/1"),
        Some(&sam),
        HttpBody::empty(),
    )
    .await;
    assert_eq!(page.status, StatusCode::OK);

    // Deletion: an accepted scan in the report (a declaration made long
    // ago, covering no gift), deleted by an admin.
    let ann = w.login("ann@alpha.org").await;
    let jo = contact(&w, &sam).await;
    let (s, out) = w.call("POST", &format!("/api/t/alpha/scans/{kept}/accept"), &sam, Some(json!({
        "expected": 0, "contactId": jo,
        "match": { "kind": "new", "declaration": declaration(&jo, "2015-01-01", "paperForm") }
    }))).await;
    assert_eq!(s, StatusCode::OK, "{out}");
    let (s, report) = w
        .call(
            "GET",
            "/api/t/alpha/giftaid/scans/deletable?today=2026-10-29",
            &ann,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(report[0]["scan"]["id"], kept);
    let (s, _) = w
        .call(
            "GET",
            "/api/t/alpha/giftaid/scans/deletable?today=2026-10-29",
            &sam,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, gone) = w
        .call(
            "POST",
            &format!("/api/t/alpha/scans/{kept}/delete-images"),
            &ann,
            Some(json!({ "expected": 0 })),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{gone}");
    assert_eq!(gone["deletionReason"], "retention");
    let page = send(
        &w,
        "GET",
        &format!("/api/t/alpha/scans/{kept}/pages/1"),
        Some(&sam),
        HttpBody::empty(),
    )
    .await;
    assert_eq!(
        page.status,
        StatusCode::NOT_FOUND,
        "unreachable once the deletion committed"
    );
    // Put this hour: the grace keeps it from the route's sweep; the next
    // sweep takes it.
    assert_eq!(scans::sweep_blobs(&db, contracts::now_ms() + 1).unwrap(), 1);
    assert_eq!(blobs(&files), 0);
}

#[tokio::test]
async fn the_purge_takes_a_discarded_scans_images_at_30_days_and_the_sweep_old_pairings() {
    let w = world();
    let (sam, pairing, token) = staff_sitting(&w).await;
    let mut phone = Phone::new(&token);
    phone.open(&w).await;
    let scan = phone.new_scan(&w, photo(1)).await.json["scanId"]
        .as_str()
        .unwrap()
        .to_owned();
    let (s, _) = w
        .call(
            "POST",
            &format!("/api/t/alpha/scans/{scan}/discard"),
            &sam,
            Some(json!({ "expected": 0 })),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let db = w.store.org(&w.alpha.id).unwrap();
    let day = 24 * 60 * 60 * 1000;
    let now = contracts::now_ms();
    assert_eq!(scans::purge_discarded(&db, now + 29 * day).unwrap(), 0);
    assert_eq!(scans::purge_discarded(&db, now + 31 * day).unwrap(), 1);
    let (_, view) = w
        .call("GET", &format!("/api/t/alpha/scans/{scan}"), &sam, None)
        .await;
    assert_eq!(view["deletionReason"], "discarded");
    assert_eq!(view["pages"].as_array().unwrap().len(), 1, "the row stays");
    assert_eq!(db.files_if_any().unwrap().unwrap().usage().unwrap(), 0);

    // Pairings that ended over a day ago are forgotten.
    assert_eq!(scans::sweep(&w.store, now).unwrap(), 0);
    assert_eq!(
        scans::sweep(&w.store, now + scans::HARD_CAP_MS + day + 1).unwrap(),
        1
    );
    assert!(scans::by_id(&w.store, &pairing).unwrap().is_none());
}

#[tokio::test]
async fn the_jobs_are_registered() {
    let w = world();
    let names = api::jobs::standard(&Arc::clone(&w.store)).names();
    for job in [
        "scan-pairing-sweep",
        "scan-orphan-sweep",
        "scan-discard-purge",
    ] {
        assert!(names.contains(&job), "{job}");
    }
}

/// One HTTP/1.1 request to a running api: (status line, head, body).
fn raw_http(
    port: u16,
    method: &str,
    path: &str,
    cookie: Option<&str>,
    body: &[u8],
) -> (String, String, Vec<u8>) {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    if let Some(c) = cookie {
        head.push_str(&format!("Cookie: {c}\r\n"));
    }
    if !body.is_empty() && body[0] == b'{' {
        head.push_str("Content-Type: application/json\r\n");
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).unwrap();
    stream.write_all(body).unwrap();
    let mut out = Vec::new();
    stream.read_to_end(&mut out).unwrap();
    let split = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&out[..split]).into_owned();
    let status = head.lines().next().unwrap().to_owned();
    (status, head, out[split + 4..].to_vec())
}

fn set_cookie(head: &str) -> String {
    head.lines()
        .find_map(|l| {
            l.strip_prefix("set-cookie: ")
                .or_else(|| l.strip_prefix("Set-Cookie: "))
        })
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

/// The api binary, driven over HTTP through a pairing's whole life (open,
/// uploads good and bad, a second device, the end, the dead token): the
/// token appears nowhere in what it logs.
#[test]
fn the_binary_never_logs_a_pairing_token() {
    let tmp = tempfile::tempdir().unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_api"))
        .env_clear()
        .env("KEEP_DATA_DIR", tmp.path())
        .env("KEEP_ENV", "dev")
        .env("KEEP_DEV_AUTH", "1")
        .env("KEEP_PORT", port.to_string())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut ready = false;
    for _ in 0..200 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            ready = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(ready, "api didn't start");
    let (status, head, _) = raw_http(
        port,
        "POST",
        "/api/dev/login",
        None,
        br#"{"email":"ann@alpha.org"}"#,
    );
    assert!(status.contains("200"), "{status}");
    let ann = set_cookie(&head);
    let (status, _, _) = raw_http(
        port,
        "POST",
        "/api/dev/tenants",
        Some(&ann),
        br#"{"slug":"alpha","name":"Alpha"}"#,
    );
    assert!(status.contains("200"), "{status}");
    let (status, _, body) = raw_http(
        port,
        "POST",
        "/api/t/alpha/scan-pairings",
        Some(&ann),
        br#"{"purpose":"stack"}"#,
    );
    assert!(
        status.contains("200"),
        "{status} {}",
        String::from_utf8_lossy(&body)
    );
    let started: Value = serde_json::from_slice(&body).unwrap();
    let token = started["path"]
        .as_str()
        .unwrap()
        .strip_prefix("/scan.html#")
        .unwrap()
        .to_owned();
    let id = started["pairing"]["id"].as_str().unwrap().to_owned();

    let (status, head, _) = raw_http(port, "GET", &format!("/api/scan/{token}"), None, b"");
    assert!(status.contains("200"), "{status}");
    let device = set_cookie(&head);
    let (status, _, _) = raw_http(
        port,
        "POST",
        &format!("/api/scan/{token}/scans"),
        Some(&device),
        &photo(1),
    );
    assert!(status.contains("200"), "{status}");
    let (status, _, _) = raw_http(
        port,
        "POST",
        &format!("/api/scan/{token}/scans"),
        Some(&device),
        b"not an image",
    );
    assert!(status.contains("422"), "{status}");
    let (status, _, _) = raw_http(
        port,
        "POST",
        &format!("/api/scan/{token}/scans/0190f0c0a0b0c0d0e0f0a0b0c0d0e0a9/pages"),
        Some(&device),
        &photo(2),
    );
    assert!(status.contains("404"), "{status}");
    let (status, _, _) = raw_http(port, "GET", &format!("/api/scan/{token}"), None, b"");
    assert!(status.contains("403"), "{status}");
    let (status, _, _) = raw_http(
        port,
        "DELETE",
        &format!("/api/t/alpha/scan-pairings/{id}"),
        Some(&ann),
        b"",
    );
    assert!(status.contains("200"), "{status}");
    let (status, _, _) = raw_http(
        port,
        "POST",
        &format!("/api/scan/{token}/scans"),
        Some(&device),
        &photo(3),
    );
    assert!(status.contains("410"), "{status}");

    child.kill().unwrap();
    let out = child.wait_with_output().unwrap();
    let logged = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!logged.is_empty(), "the api logs something at boot");
    assert!(!logged.contains(&token), "the token was logged:\n{logged}");
    assert!(
        !logged.contains(&token[..16]),
        "part of the token was logged:\n{logged}"
    );
}

/// "Sign out other sessions" keeps this session, which a pairing hangs
/// from: it ends the user's pairings anyway (an unknown phone is what the
/// button is for).
#[tokio::test]
async fn signing_out_other_sessions_ends_the_users_pairings() {
    let w = world();
    let (sam, id, token) = staff_sitting(&w).await;
    let mut phone = Phone::new(&token);
    assert_eq!(phone.open(&w).await.status, StatusCode::OK);
    let out = send(
        &w,
        "POST",
        "/api/auth/account/sessions/sign-out-others",
        Some(&sam),
        HttpBody::empty(),
    )
    .await;
    assert!(out.status.is_success(), "{} {}", out.status, out.json);
    assert_eq!(phone.open(&w).await.status, StatusCode::GONE);
    let why: String = w
        .store
        .platform()
        .with_read(|c| {
            c.query_row(
                "SELECT ended_why FROM scan_pairings WHERE id = ?1",
                [&id],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(why, "signed_out_others");
    // The laptop stays signed in, and can pair again.
    let (s, _) = w.call("GET", "/api/t/alpha/scans", &sam, None).await;
    assert_eq!(s, StatusCode::OK);
    pair(&w, &sam, "alpha").await;
}

fn with_limits(w: &mut World, limits: Arc<scans::limits::ScanLimits>) {
    w.app = api::app(
        api::AppState::new(w.store.clone(), true).with_scan_limits(limits),
        api::routes::router(),
    );
}

/// Uploads past the slots in flight are refused before their bodies are
/// read (`503 busy`), and stored nothing.
#[tokio::test]
async fn uploads_past_the_slots_in_flight_are_busy() {
    let mut w = world();
    let limits = Arc::new(scans::limits::ScanLimits::default());
    with_limits(&mut w, limits.clone());
    let (sam, _, token) = staff_sitting(&w).await;
    let mut phone = Phone::new(&token);
    phone.open(&w).await;
    let held: Vec<_> = (0..scans::limits::MAX_IN_FLIGHT)
        .map(|_| limits.take_slot().unwrap())
        .collect();
    let busy = phone.new_scan(&w, photo(1)).await;
    assert_eq!(
        (busy.status, &busy.json["kind"]),
        (StatusCode::SERVICE_UNAVAILABLE, &json!("busy"))
    );
    let busy = send(
        &w,
        "POST",
        "/api/t/alpha/scans",
        Some(&sam),
        HttpBody::from(photo(1)),
    )
    .await;
    assert_eq!(busy.status, StatusCode::SERVICE_UNAVAILABLE);
    // Reads aren't uploads.
    assert_eq!(phone.open(&w).await.status, StatusCode::OK);
    drop(held);
    assert_eq!(phone.new_scan(&w, photo(1)).await.status, StatusCode::OK);
    // Every upload, answered or refused, gave its slot back.
    let refused = phone.new_scan(&w, b"not an image".to_vec()).await;
    assert_eq!(refused.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(limits.in_flight(), 0);
}

/// The data volume's reserve: an upload that would eat into it is
/// refused (`507 storage_full`) and stores nothing.
#[tokio::test]
async fn an_upload_into_the_disk_reserve_is_refused() {
    let mut w = world();
    let limits = scans::limits::ScanLimits::default().with_disk_reserve(u64::MAX / 4);
    with_limits(&mut w, Arc::new(limits));
    let (sam, _, token) = staff_sitting(&w).await;
    let mut phone = Phone::new(&token);
    phone.open(&w).await;
    let full = phone.new_scan(&w, photo(1)).await;
    assert_eq!(
        (full.status, &full.json["kind"]),
        (StatusCode::INSUFFICIENT_STORAGE, &json!("storage_full"))
    );
    let full = send(
        &w,
        "POST",
        "/api/t/alpha/scans",
        Some(&sam),
        HttpBody::from(photo(1)),
    )
    .await;
    assert_eq!(full.status, StatusCode::INSUFFICIENT_STORAGE);
    let (_, usage) = w.call("GET", "/api/t/alpha/files-usage", &sam, None).await;
    assert_eq!(usage["bytes"], 0);
}

/// `KEEP_FILES_CAP_BYTES`: the per-org cap is the configured one, and
/// Settings shows it.
#[tokio::test]
async fn the_configured_cap_is_the_one_enforced_and_shown() {
    let mut w = world();
    let limits = scans::limits::ScanLimits::default()
        .with_cap(1)
        .with_disk_reserve(0);
    with_limits(&mut w, Arc::new(limits));
    let sam = w.login("sam@alpha.org").await;
    let full = send(
        &w,
        "POST",
        "/api/t/alpha/scans",
        Some(&sam),
        HttpBody::from(photo(1)),
    )
    .await;
    assert_eq!(
        (full.status, &full.json["reason"]),
        (StatusCode::UNPROCESSABLE_ENTITY, &json!("files_full"))
    );
    let (_, usage) = w.call("GET", "/api/t/alpha/files-usage", &sam, None).await;
    assert_eq!(usage["capBytes"], 1);
    let val = w.login("val@alpha.org").await;
    let (s, _) = w.call("GET", "/api/t/alpha/files-usage", &val, None).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
}

/// A password change keeps the session it was made from, which a pairing
/// hangs from: it ends the user's pairings anyway (R2-L1).
#[tokio::test]
async fn a_password_change_ends_the_users_pairings() {
    let w = world();
    let (sam, id, token) = staff_sitting(&w).await;
    let mut phone = Phone::new(&token);
    assert_eq!(phone.open(&w).await.status, StatusCode::OK);
    let sam_id = w.store.platform().upsert_user("sam@alpha.org").unwrap().0;
    let old = "correct horse battery staple 1";
    w.store
        .platform()
        .with_write(|tx| ::auth::accounts::set_password(tx, sam_id, old, contracts::now_ms()))
        .unwrap();
    let (s, out) = w
        .call(
            "POST",
            "/api/auth/account/password",
            &sam,
            Some(json!({ "current": old, "new": "another long passphrase 2" })),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{out}");
    assert_eq!(phone.open(&w).await.status, StatusCode::GONE);
    let why: String = w
        .store
        .platform()
        .with_read(|c| {
            c.query_row(
                "SELECT ended_why FROM scan_pairings WHERE id = ?1",
                [&id],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(why, "password_changed");
}
