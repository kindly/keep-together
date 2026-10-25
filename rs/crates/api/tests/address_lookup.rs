//! `GET /api/t/{slug}/address-lookup` (`api::address`): roles, tenancy,
//! the monthly cap and daily ceiling, shape checks before any provider
//! call, and the `ideal` provider against a local mock (never the real
//! API).

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use api::address::fake::{self, Fake};
use api::address::ideal::Ideal;
use api::address::{self, AddressLookup, Lookup, LookupError, Mode};
use api::{AppState, app, routes, schema};
use axum::extract::{Path, RawQuery};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use common::{World, world};
use serde_json::{Value, json};
use store::{Store, StoreConfig};

/// `world()` with the fake provider behind `cap` and `ceiling`.
fn with_fake(cap: i64, ceiling: i64) -> (World, Arc<Fake>) {
    let mut w = world();
    let fake = Arc::new(Fake::default());
    let lookup = Lookup::new(Mode::Fake, fake.clone(), cap, ceiling);
    w.app = app(
        AppState::new(w.store.clone(), true).with_address(Some(lookup)),
        routes::router(),
    );
    (w, fake)
}

fn path(slug: &str, postcode: &str) -> String {
    format!(
        "/api/t/{slug}/address-lookup?postcode={}",
        postcode.replace(' ', "%20")
    )
}

#[tokio::test]
async fn staff_and_admins_get_the_addresses_at_a_postcode() {
    let (w, fake) = with_fake(100, 2000);
    let sam = w.login("sam@alpha.org").await;
    let (s, body) = w.call("GET", &path("alpha", "id1 1qd"), &sam, None).await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let addresses = body["addresses"].as_array().unwrap();
    assert_eq!(addresses.len(), 3);
    assert_eq!(
        addresses[2],
        json!({"line1": "Flat 3", "line2": "4 Test Street", "line3": "",
               "town": "Fakebury", "postcode": "ID1 1QD"})
    );
    let ann = w.login("ann@alpha.org").await;
    let (s, body) = w.call("GET", &path("alpha", "KT11AA"), &ann, None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["addresses"][0]["town"], "Kingston upon Thames");
    assert_eq!(fake.calls(), 2);
    let now = contracts::now_ms();
    assert_eq!(
        address::used_this_month(&w.store, &w.alpha.id, now).unwrap(),
        2
    );
}

#[tokio::test]
async fn a_viewer_and_another_group_are_refused_before_any_lookup() {
    let (w, fake) = with_fake(100, 2000);
    let val = w.login("val@alpha.org").await;
    let (s, body) = w
        .call("GET", &path("alpha", fake::SEVERAL), &val, None)
        .await;
    assert_eq!(
        (s, body["kind"].as_str()),
        (StatusCode::FORBIDDEN, Some("forbidden"))
    );
    // B's session on A's slug: refused like any tenant route.
    let bob = w.login("bob@beta.org").await;
    let (s, body) = w
        .call("GET", &path("alpha", fake::SEVERAL), &bob, None)
        .await;
    assert_eq!(
        (s, body["kind"].as_str()),
        (StatusCode::FORBIDDEN, Some("forbidden"))
    );
    // Signed out.
    let (s, _) = w.call("GET", &path("alpha", fake::SEVERAL), "", None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(fake.calls(), 0);
    let now = contracts::now_ms();
    assert_eq!(
        address::used_this_month(&w.store, &w.alpha.id, now).unwrap(),
        0
    );
    assert_eq!(
        address::used_this_month(&w.store, &w.beta.id, now).unwrap(),
        0
    );
}

#[tokio::test]
async fn a_bad_postcode_is_422_and_costs_nothing() {
    let (w, fake) = with_fake(100, 2000);
    let sam = w.login("sam@alpha.org").await;
    for bad in ["", "hello", "SW1A", "12345", "SW1A%2F1AA"] {
        let (s, body) = w
            .call(
                "GET",
                &format!("/api/t/alpha/address-lookup?postcode={bad}"),
                &sam,
                None,
            )
            .await;
        assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{bad}");
        assert_eq!(body["kind"], "invalid");
    }
    // No postcode at all.
    let (s, _) = w
        .call("GET", "/api/t/alpha/address-lookup", &sam, None)
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(fake.calls(), 0);
    let now = contracts::now_ms();
    assert_eq!(
        address::used_this_month(&w.store, &w.alpha.id, now).unwrap(),
        0
    );
}

/// It spends a credit, so a cross-site navigation (which carries the
/// `Lax` cookie) is refused like a cross-site write; the SPA's own fetch
/// (`same-origin`) and a non-browser client pass.
#[tokio::test]
async fn a_cross_site_request_is_refused_before_any_lookup() {
    use axum::http::header;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    let (w, fake) = with_fake(100, 2000);
    let sam = w.login("sam@alpha.org").await;
    let send = |site: Option<&'static str>, origin: Option<&'static str>| {
        let mut req = common::request("GET", &path("alpha", fake::ONE), Some(&sam), None);
        if let Some(site) = site {
            req.headers_mut()
                .insert("sec-fetch-site", site.parse().unwrap());
        }
        if let Some(origin) = origin {
            req.headers_mut()
                .insert(header::ORIGIN, origin.parse().unwrap());
        }
        let app = w.app.clone();
        async move {
            let res = app.oneshot(req).await.unwrap();
            let status = res.status();
            let body = res.into_body().collect().await.unwrap().to_bytes();
            (status, serde_json::from_slice::<Value>(&body).unwrap())
        }
    };
    for (site, origin) in [
        (Some("cross-site"), None),
        (Some("same-site"), Some("https://evil.keep-together.org.uk")),
        (None, Some("https://evil.example")),
    ] {
        let (s, body) = send(site, origin).await;
        assert_eq!(
            (s, body["kind"].as_str()),
            (StatusCode::FORBIDDEN, Some("forbidden"))
        );
    }
    assert_eq!(fake.calls(), 0);
    assert_eq!(send(Some("same-origin"), None).await.0, StatusCode::OK);
    assert_eq!(send(None, None).await.0, StatusCode::OK);
    assert_eq!(fake.calls(), 2);
}

#[tokio::test]
async fn not_found_and_unavailable() {
    let (w, _) = with_fake(100, 2000);
    let sam = w.login("sam@alpha.org").await;
    let (s, body) = w.call("GET", &path("alpha", "SW1A 1AA"), &sam, None).await;
    assert_eq!(
        (s, body["kind"].as_str()),
        (StatusCode::NOT_FOUND, Some("not_found"))
    );
    let (s, body) = w.call("GET", &path("alpha", fake::DOWN), &sam, None).await;
    assert_eq!(
        (s, body["kind"].as_str()),
        (StatusCode::SERVICE_UNAVAILABLE, Some("lookup_unavailable"))
    );
}

#[tokio::test]
async fn the_monthly_cap_is_per_group_and_stops_before_the_provider() {
    let (w, fake) = with_fake(2, 2000);
    let sam = w.login("sam@alpha.org").await;
    for _ in 0..2 {
        let (s, _) = w.call("GET", &path("alpha", fake::ONE), &sam, None).await;
        assert_eq!(s, StatusCode::OK);
    }
    let (s, body) = w.call("GET", &path("alpha", fake::ONE), &sam, None).await;
    assert_eq!(
        (s, body["kind"].as_str()),
        (StatusCode::TOO_MANY_REQUESTS, Some("lookup_cap"))
    );
    assert_eq!(fake.calls(), 2);
    // Another group has its own month.
    let bob = w.login("bob@beta.org").await;
    let (s, _) = w.call("GET", &path("beta", fake::ONE), &bob, None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(fake.calls(), 3);
}

#[tokio::test]
async fn the_daily_ceiling_is_platform_wide() {
    let (w, fake) = with_fake(100, 2);
    let sam = w.login("sam@alpha.org").await;
    let bob = w.login("bob@beta.org").await;
    assert_eq!(
        w.call("GET", &path("alpha", fake::ONE), &sam, None).await.0,
        StatusCode::OK
    );
    assert_eq!(
        w.call("GET", &path("beta", fake::ONE), &bob, None).await.0,
        StatusCode::OK
    );
    let (s, body) = w.call("GET", &path("alpha", fake::ONE), &sam, None).await;
    assert_eq!(
        (s, body["kind"].as_str()),
        (StatusCode::SERVICE_UNAVAILABLE, Some("lookup_unavailable"))
    );
    assert_eq!(fake.calls(), 2);
}

#[tokio::test]
async fn off_is_404_and_me_says_whether_it_is_on() {
    let w = world();
    let sam = w.login("sam@alpha.org").await;
    let (s, body) = w
        .call("GET", &path("alpha", fake::SEVERAL), &sam, None)
        .await;
    assert_eq!(
        (s, body["kind"].as_str()),
        (StatusCode::NOT_FOUND, Some("not_found"))
    );
    let (_, me) = w.call("GET", "/api/me", &sam, None).await;
    assert!(me.get("addressLookup").is_none(), "{me}");

    let (w, _) = with_fake(100, 2000);
    let sam = w.login("sam@alpha.org").await;
    let (_, me) = w.call("GET", "/api/me", &sam, None).await;
    assert_eq!(me["addressLookup"], true);
    let (_, boot) = w.call("GET", "/api/t/alpha/boot", &sam, None).await;
    assert_eq!(boot["me"]["addressLookup"], true);
}

fn open(dir: &std::path::Path) -> Store {
    Store::open_with(
        StoreConfig {
            dir: dir.to_path_buf(),
            org_migrations: schema::org_migrations(),
            readers: 1,
            max_open: 4,
        },
        schema::PLATFORM_SCHEMAS,
    )
    .unwrap()
}

#[test]
fn usage_survives_a_restart_and_resets_with_the_month() {
    let tmp = tempfile::tempdir().unwrap();
    // 2026-10-31T12:00:00Z, and 2026-11-01T12:00:00Z.
    let (oct, nov) = (1_793_448_000_000, 1_793_534_400_000);
    let tenant = {
        let store = open(tmp.path());
        let t = store.create_tenant("alpha", "Alpha").unwrap();
        assert_eq!(
            address::reserve(&store, &t.id, oct, 1, 10).unwrap(),
            address::Reserve::Taken
        );
        t.id
    };
    let store = open(tmp.path());
    assert_eq!(address::used_this_month(&store, &tenant, oct).unwrap(), 1);
    assert_eq!(
        address::reserve(&store, &tenant, oct, 1, 10).unwrap(),
        address::Reserve::Cap
    );
    assert_eq!(
        address::reserve(&store, &tenant, nov, 1, 10).unwrap(),
        address::Reserve::Taken
    );
}

// --- `ideal` against a local mock ---------------------------------------

const KEY: &str = "ak_secret_test_key_0123";

/// A mock of Ideal Postcodes on a loopback port: answers by postcode and
/// records each request's path and query.
async fn mock() -> (String, Arc<Mutex<Vec<String>>>) {
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let log = seen.clone();
    let app = Router::new().route(
        "/v1/postcodes/{postcode}",
        get(move |Path(pc): Path<String>, RawQuery(q): RawQuery| {
            let log = log.clone();
            async move {
                log.lock().unwrap().push(format!("{pc}?{}", q.unwrap_or_default()));
                match pc.as_str() {
                    "SW1A 1AA" => Json(json!({
                        "code": 2000, "message": "Success",
                        "result": [{
                            "line_1": "Buckingham Palace", "line_2": "", "line_3": "",
                            "post_town": "LONDON", "postcode": "SW1A 1AA",
                            "uprn": "10033544614", "county": "London"
                        }]
                    }))
                    .into_response(),
                    "ZZ1 1ZZ" => (
                        StatusCode::NOT_FOUND,
                        Json(json!({"code": 4040, "message": "Postcode not found", "suggestions": []})),
                    )
                        .into_response(),
                    "NC1 1AA" => (
                        StatusCode::PAYMENT_REQUIRED,
                        Json(json!({"code": 4020, "message": "Token balance depleted"})),
                    )
                        .into_response(),
                    "BK1 1AA" => (
                        StatusCode::UNAUTHORIZED,
                        Json(json!({"code": 4010, "message": format!("Invalid key {KEY}")})),
                    )
                        .into_response(),
                    "SL1 1AA" => {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        Json(json!({"code": 2000, "result": []})).into_response()
                    }
                    _ => (StatusCode::INTERNAL_SERVER_ERROR, "<html>oops</html>").into_response(),
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, seen)
}

fn unavailable(out: Result<Vec<address::LookupAddress>, address::Sent>) -> (String, bool) {
    match out {
        Err(address::Sent {
            error: LookupError::Unavailable(detail),
            reached,
        }) => (detail, reached),
        other => panic!("expected unavailable, got {other:?}"),
    }
}

#[tokio::test]
async fn ideal_maps_their_answers_and_never_shows_the_key() {
    let (base, seen) = mock().await;
    let ideal = Ideal::with_timeout(KEY, &base, Duration::from_millis(300)).unwrap();

    let found = ideal.lookup("SW1A 1AA").await.unwrap();
    assert_eq!(
        found,
        vec![address::LookupAddress {
            line1: "Buckingham Palace".into(),
            line2: "".into(),
            line3: "".into(),
            town: "LONDON".into(),
            postcode: "SW1A 1AA".into(),
        }]
    );
    assert_eq!(
        seen.lock().unwrap()[0],
        format!("SW1A 1AA?api_key={KEY}"),
        "the postcode in the path, the key as api_key"
    );

    assert_eq!(
        ideal.lookup("ZZ1 1ZZ").await.unwrap_err(),
        address::Sent::reached(LookupError::NotFound)
    );
    for (postcode, status) in [
        ("NC1 1AA", "status 402, code 4020"),
        ("BK1 1AA", "status 401, code 4010"),
        ("XX1 1XX", "status 500, code none"),
    ] {
        let (detail, reached) = unavailable(ideal.lookup(postcode).await);
        assert!(detail.contains(status), "{detail}");
        assert!(reached);
        assert!(
            !detail.contains(KEY) && !detail.contains(postcode),
            "{detail}"
        );
    }
    // Timeout: unavailable, counted (it may have reached them).
    let (detail, reached) = unavailable(ideal.lookup("SL1 1AA").await);
    assert!(reached);
    assert!(!detail.contains(KEY) && !detail.contains("SL1"), "{detail}");
}

#[tokio::test]
async fn ideal_unreachable_is_unavailable_and_given_back() {
    // A port nobody listens on.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let ideal = Ideal::new(KEY, &base).unwrap();
    let (detail, reached) = unavailable(ideal.lookup("SW1A 1AA").await);
    assert!(!reached, "{detail}");
    assert!(
        !detail.contains(KEY) && !detail.contains("SW1A"),
        "{detail}"
    );

    let tmp = tempfile::tempdir().unwrap();
    let store = Arc::new(open(tmp.path()));
    let t = store.create_tenant("alpha", "Alpha").unwrap();
    let lookup = Lookup::new(Mode::Ideal, Arc::new(ideal), 100, 2000);
    let out = lookup.lookup(store.clone(), t.id.clone(), "SW1A 1AA").await;
    assert!(matches!(out, Err(LookupError::Unavailable(_))));
    let now = contracts::now_ms();
    assert_eq!(address::used_this_month(&store, &t.id, now).unwrap(), 0);
}

#[tokio::test]
async fn ideal_through_the_route() {
    let (base, _) = mock().await;
    let mut w = world();
    let lookup = Lookup::new(
        Mode::Ideal,
        Arc::new(Ideal::new(KEY, &base).unwrap()),
        100,
        2000,
    );
    w.app = app(
        AppState::new(w.store.clone(), true).with_address(Some(lookup)),
        routes::router(),
    );
    let sam = w.login("sam@alpha.org").await;
    let (s, body): (StatusCode, Value) = w.call("GET", &path("alpha", "sw1a1aa"), &sam, None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["addresses"][0]["line1"], "Buckingham Palace");
    let (s, body) = w.call("GET", &path("alpha", "NC1 1AA"), &sam, None).await;
    assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
    assert!(!body.to_string().contains(KEY));
}
