//! The session invariants (`auth::sessions` docs; the controller's
//! conditions for hand-written sessions): token storage, cookie flags,
//! rotation, revoke-all, live streams ending, the origin check, the sweep,
//! the dev host guard.

mod authworld;

use std::time::Duration;

use authworld::{ORIGIN, World, password_of, world, world_dev};
use axum::body::Body as HttpBody;
use axum::http::{StatusCode, header};
use http_body_util::BodyExt;
use serde_json::json;

fn token(cookie: &str) -> &str {
    cookie.split_once('=').unwrap().1
}

#[tokio::test]
async fn the_cookie_is_256_random_bits_and_only_its_hash_is_stored() {
    let w = world();
    let a = w.sign_in("ann@alpha.org").await;
    let b = w.sign_in("bob@beta.org").await;
    for c in [&a, &b] {
        let t = token(c);
        assert!(auth::secret::well_formed(t), "{t}");
        let (by_token, by_hash): (i64, i64) = w
            .store
            .platform()
            .with_read(|c| {
                Ok::<_, rusqlite::Error>((
                    c.query_row(
                        "SELECT count(*) FROM auth_sessions WHERE token_hash = ?1",
                        [t],
                        |r| r.get(0),
                    )?,
                    c.query_row(
                        "SELECT count(*) FROM auth_sessions WHERE token_hash = ?1",
                        [auth::secret::hash(t)],
                        |r| r.get(0),
                    )?,
                ))
            })
            .unwrap();
        assert_eq!((by_token, by_hash), (0, 1));
    }
    assert_ne!(a, b);
}

#[tokio::test]
async fn cookie_flags_secure_except_on_localhost() {
    let w = world();
    let sign_in = |host: &'static str| {
        World::request("POST", "/api/auth/sign-in", None, None)
            .header(header::HOST, host)
            .header(header::CONTENT_TYPE, "application/json")
            .body(HttpBody::from(
                json!({ "email": "ann@alpha.org", "password": password_of("ann@alpha.org") })
                    .to_string(),
            ))
            .unwrap()
    };
    let res = w.send(sign_in("app.keep-together.org.uk")).await;
    let c = &res.set_cookies[0];
    for flag in [
        "HttpOnly",
        "SameSite=Lax",
        "Path=/",
        "Secure",
        "Max-Age=900",
    ] {
        assert!(c.contains(flag), "{c} lacks {flag}");
    }
    for host in ["localhost:3000", "127.0.0.1:8794"] {
        let res = w.send(sign_in(host)).await;
        let c = &res.set_cookies[0];
        assert!(
            c.contains("HttpOnly") && !c.contains("Secure"),
            "{host}: {c}"
        );
    }
}

#[tokio::test]
async fn a_partial_session_reaches_nothing_but_the_second_factor() {
    let w = world();
    let res = w
        .post(
            "/api/auth/sign-in",
            None,
            json!({ "email": "ann@alpha.org", "password": password_of("ann@alpha.org") }),
        )
        .await;
    assert_eq!(res.body["stage"], "second_factor");
    let partial = res.cookie().unwrap();
    for path in [
        "/api/me",
        "/api/t/alpha",
        "/api/t/alpha/contacts",
        "/api/t/alpha/members",
        "/api/auth/account",
    ] {
        let r = w.call("GET", path, Some(&partial), None).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{path}");
    }
    let r = w
        .post(
            "/api/auth/step-up",
            Some(&partial),
            json!({ "password": "x", "code": "1" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_token_rotates_when_sign_in_completes() {
    let w = world();
    let res = w
        .post(
            "/api/auth/sign-in",
            None,
            json!({ "email": "ann@alpha.org", "password": password_of("ann@alpha.org") }),
        )
        .await;
    let partial = res.cookie().unwrap();
    let res = w
        .post(
            "/api/auth/second-factor",
            Some(&partial),
            json!({ "code": w.totp("ann@alpha.org") }),
        )
        .await;
    let full = res.cookie().unwrap();
    assert_ne!(partial, full);
    assert_eq!(
        w.call("GET", "/api/me", Some(&full), None).await.status,
        StatusCode::OK
    );
    // The partial token is gone, not upgraded.
    let r = w.call("GET", "/api/auth/state", Some(&partial), None).await;
    assert_eq!(r.body["stage"], "signed_out");
}

#[tokio::test]
async fn the_token_rotates_on_step_up() {
    let w = world();
    let old = w.sign_in("ann@alpha.org").await;
    let res = w
        .post(
            "/api/auth/step-up",
            Some(&old),
            json!({ "password": password_of("ann@alpha.org"), "code": w.totp("ann@alpha.org") }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let new = res.cookie().unwrap();
    assert_ne!(old, new);
    assert_eq!(
        w.call("GET", "/api/me", Some(&old), None).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        w.call("GET", "/api/me", Some(&new), None).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn the_token_rotates_on_your_own_role_change_and_others_are_signed_out() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    let cat = w.sign_in("cat@alpha.org").await;
    // Make cat admin (others: revoked), then ann steps down (own: rotated).
    let cat_id = w.user_id("cat@alpha.org");
    let r = w
        .post(
            &format!("/api/t/alpha/members/{cat_id}/role"),
            Some(&ann),
            json!({ "role": "admin" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert!(r.cookie().is_none());
    assert_eq!(
        w.call("GET", "/api/me", Some(&cat), None).await.status,
        StatusCode::UNAUTHORIZED
    );
    let ann_id = w.user_id("ann@alpha.org");
    let r = w
        .post(
            &format!("/api/t/alpha/members/{ann_id}/role"),
            Some(&ann),
            json!({ "role": "staff" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let rotated = r.cookie().unwrap();
    assert_ne!(rotated, ann);
    assert_eq!(
        w.call("GET", "/api/me", Some(&ann), None).await.status,
        StatusCode::UNAUTHORIZED
    );
    let r = w.call("GET", "/api/t/alpha", Some(&rotated), None).await;
    assert_eq!(r.body["role"], "staff");
}

#[tokio::test]
async fn revoke_all_on_password_reset() {
    let w = world();
    let one = w.sign_in("cat@alpha.org").await;
    let two = w.sign_in("cat@alpha.org").await;
    w.post(
        "/api/auth/reset/request",
        None,
        json!({ "email": "cat@alpha.org" }),
    )
    .await;
    let t = w.emailed_token("cat@alpha.org").await;
    let r = w
        .post(
            "/api/auth/reset/complete",
            None,
            json!({ "token": t, "password": "a whole new one" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    for c in [&one, &two] {
        assert_eq!(
            w.call("GET", "/api/me", Some(c), None).await.status,
            StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
async fn revoke_all_on_2fa_reset_and_member_removal() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    let val = w.sign_in("val@alpha.org").await;
    let val_id = w.user_id("val@alpha.org");
    let r = w
        .post(
            &format!("/api/t/alpha/members/{val_id}/reset-2fa"),
            Some(&ann),
            json!({}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(
        w.call("GET", "/api/me", Some(&val), None).await.status,
        StatusCode::UNAUTHORIZED
    );

    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    let cat = w.sign_in("cat@alpha.org").await;
    let cat_id = w.user_id("cat@alpha.org");
    let r = w
        .post(
            &format!("/api/t/alpha/members/{cat_id}/remove"),
            Some(&ann),
            json!({}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    // Every session, in every organisation.
    assert_eq!(
        w.call("GET", "/api/t/beta", Some(&cat), None).await.status,
        StatusCode::UNAUTHORIZED
    );
}

/// Read one SSE stream until it ends; `None` if it is still open after
/// `wait`.
async fn ends_within(
    w: &World,
    cookie: &str,
    wait: Duration,
    then: impl std::future::Future<Output = ()>,
) -> bool {
    let req = World::request("GET", "/api/t/alpha/events", Some(cookie), None)
        .body(HttpBody::empty())
        .unwrap();
    let res = tower::ServiceExt::oneshot(w.app.clone(), req)
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let mut body = res.into_body();
    then.await;
    tokio::time::timeout(wait, async {
        while let Some(frame) = body.frame().await {
            if frame.is_err() {
                break;
            }
        }
    })
    .await
    .is_ok()
}

#[tokio::test]
async fn live_streams_close_on_sign_out() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    let ended = ends_within(&w, &ann, Duration::from_secs(2), async {
        w.post("/api/auth/sign-out", Some(&ann), json!({})).await;
    })
    .await;
    assert!(ended);
}

#[tokio::test]
async fn live_streams_close_on_membership_removal() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    let val = w.sign_in("val@alpha.org").await;
    let val_id = w.user_id("val@alpha.org");
    let ended = ends_within(&w, &val, Duration::from_secs(2), async {
        let r = w
            .post(
                &format!("/api/t/alpha/members/{val_id}/remove"),
                Some(&ann),
                json!({}),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK);
    })
    .await;
    assert!(ended);
}

#[tokio::test]
async fn a_stream_stays_open_while_nothing_is_revoked() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    let bob = w.sign_in("bob@beta.org").await;
    let ended = ends_within(&w, &ann, Duration::from_millis(300), async {
        // Someone else signing out doesn't end ann's stream.
        w.post("/api/auth/sign-out", Some(&bob), json!({})).await;
    })
    .await;
    assert!(!ended);
}

#[tokio::test]
async fn cross_site_writes_are_refused() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    let post = |origin: &str, site: Option<&str>| {
        let mut req = World::request("POST", "/api/t/alpha/contacts", Some(&ann), None)
            .header(header::CONTENT_TYPE, "application/json")
            .header("origin", origin);
        if let Some(s) = site {
            req = req.header("sec-fetch-site", s);
        }
        req.body(HttpBody::from(authworld_person().to_string()))
            .unwrap()
    };
    let r = w
        .send(post("https://evil.example", Some("cross-site")))
        .await;
    assert_eq!((r.status, r.kind()), (StatusCode::FORBIDDEN, "forbidden"));
    // A sibling subdomain: SameSite=Lax would send the cookie.
    let r = w.send(post("https://x.app.test", Some("same-site"))).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = w.send(post(ORIGIN, Some("same-origin"))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    // Reads aren't checked.
    let req = World::request("GET", "/api/me", Some(&ann), None)
        .header("origin", "https://evil.example")
        .header("sec-fetch-site", "cross-site")
        .body(HttpBody::empty())
        .unwrap();
    assert_eq!(w.send(req).await.status, StatusCode::OK);
    // Sign-in is a write too (login CSRF).
    let req = World::request("POST", "/api/auth/sign-in", None, None)
        .header(header::CONTENT_TYPE, "application/json")
        .header("origin", "https://evil.example")
        .header("sec-fetch-site", "cross-site")
        .body(HttpBody::from(
            json!({ "email": "a@b.c", "password": "x" }).to_string(),
        ))
        .unwrap();
    assert_eq!(w.send(req).await.status, StatusCode::FORBIDDEN);
}

fn authworld_person() -> serde_json::Value {
    json!({
        "kind": "individual", "title": "", "firstName": "Pat", "lastName": "Doe",
        "nickname": "", "name": "", "isDeceased": false
    })
}

#[tokio::test]
async fn expired_sessions_read_as_none_and_the_sweep_deletes_them() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    let hash = auth::secret::hash(token(&ann));
    let now = contracts::now_ms();
    w.store
        .platform()
        .with_write(|tx| {
            tx.execute(
                "UPDATE auth_sessions SET expires_at = ?2 WHERE token_hash = ?1",
                rusqlite::params![hash, now - 1],
            )
        })
        .unwrap();
    assert_eq!(
        w.call("GET", "/api/me", Some(&ann), None).await.status,
        StatusCode::UNAUTHORIZED
    );
    let swept = w
        .store
        .platform()
        .with_write(|tx| auth::sessions::sweep(tx, contracts::now_ms()))
        .unwrap();
    assert_eq!(swept, 1);
}

#[tokio::test]
async fn a_full_session_lasts_seven_days() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    let (created, expires): (i64, i64) = w
        .store
        .platform()
        .with_read(|c| {
            c.query_row(
                "SELECT created_at, expires_at FROM auth_sessions WHERE token_hash = ?1",
                [auth::secret::hash(token(&ann))],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    assert_eq!(expires - created, 7 * 24 * 60 * 60 * 1000);
}

#[tokio::test]
async fn dev_routes_need_a_loopback_host() {
    let w = world_dev();
    let req = |host: &'static str| {
        World::request("POST", "/api/dev/login", None, None)
            .header(header::HOST, host)
            .header(header::CONTENT_TYPE, "application/json")
            .body(HttpBody::from(json!({ "email": "x@y.z" }).to_string()))
            .unwrap()
    };
    for host in ["localhost:3000", "127.0.0.1:8794", "[::1]:8794"] {
        assert_eq!(w.send(req(host)).await.status, StatusCode::OK, "{host}");
    }
    for host in [
        "evil.example",
        "keep.tail1234.ts.net",
        "localhost.evil.example",
    ] {
        assert_eq!(
            w.send(req(host)).await.status,
            StatusCode::FORBIDDEN,
            "{host}"
        );
    }
}

fn pending_secrets(w: &World) -> i64 {
    w.store
        .platform()
        .with_read(|c| {
            c.query_row(
                "SELECT count(*) FROM auth_sessions WHERE pending_secret IS NOT NULL",
                [],
                |r| r.get(0),
            )
        })
        .unwrap()
}

/// Enrol a new invitee up to the TOTP secret: (enrol cookie, secret).
async fn enrolling(w: &World) -> (String, String) {
    let ann = w.sign_in("ann@alpha.org").await;
    w.post(
        "/api/t/alpha/members/invite",
        Some(&ann),
        json!({ "email": "new@alpha.org", "role": "staff" }),
    )
    .await;
    let token = w.emailed_token("new@alpha.org").await;
    let r = w
        .post(
            "/api/auth/invite/accept",
            None,
            json!({ "token": token, "password": "new person's pw" }),
        )
        .await;
    let enrol = r.cookie().unwrap();
    let r = w
        .post("/api/auth/enrol/totp", Some(&enrol), json!({}))
        .await;
    (enrol, r.body["secret"].as_str().unwrap().to_owned())
}

#[tokio::test]
async fn the_enrolment_secret_is_cleared_when_enrolment_completes() {
    let w = world();
    let (enrol, secret) = enrolling(&w).await;
    assert_eq!(pending_secrets(&w), 1);
    let code = auth::totp::code_at(&secret, authworld::now_secs()).unwrap();
    let r = w
        .post(
            "/api/auth/enrol/confirm",
            Some(&enrol),
            json!({ "method": "totp", "code": code }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(pending_secrets(&w), 0);
}

#[tokio::test]
async fn an_expired_enrolment_secret_is_unusable_and_swept() {
    let w = world();
    let (enrol, secret) = enrolling(&w).await;
    let now = contracts::now_ms();
    w.store
        .platform()
        .with_write(|tx| {
            tx.execute(
                "UPDATE auth_sessions SET pending_secret_expires = ?1 WHERE pending_secret IS NOT NULL",
                [now - 1],
            )
        })
        .unwrap();
    let code = auth::totp::code_at(&secret, authworld::now_secs()).unwrap();
    let r = w
        .post(
            "/api/auth/enrol/confirm",
            Some(&enrol),
            json!({ "method": "totp", "code": code }),
        )
        .await;
    assert_eq!(r.reason(), "wrong_code");
    w.store
        .platform()
        .with_write(|tx| auth::sessions::sweep(tx, contracts::now_ms()))
        .unwrap();
    assert_eq!(pending_secrets(&w), 0);
}
