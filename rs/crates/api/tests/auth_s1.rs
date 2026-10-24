//! The S1 auth security review's fixes (`factory/out/reviewer-auth-sec-report.md`
//! on main 9f1d710): a test or more per finding, named by it.

mod authworld;

use std::time::Duration;

use api::auth::{Config, ip_key};
use authworld::{ORIGIN, World, config, password_of, world, world_with};
use axum::body::Body as HttpBody;
use axum::http::{StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};

fn post_json(path: &str, body: Value) -> axum::http::request::Builder {
    let _ = body;
    World::request("POST", path, None, None).header(header::CONTENT_TYPE, "application/json")
}

async fn sign_in_from(w: &World, ip: &str, email: &str) -> authworld::Res {
    let body = json!({ "email": email, "password": "wrong-password" });
    w.send(
        post_json("/api/auth/sign-in", body.clone())
            .header("fly-client-ip", ip)
            .body(HttpBody::from(body.to_string()))
            .unwrap(),
    )
    .await
}

fn count(w: &World, sql: &str, user: i64) -> i64 {
    w.store
        .platform()
        .with_read(|c| c.query_row(sql, [user], |r| r.get(0)))
        .unwrap()
}

// ── H1 / L4 / M5: per-client rate limits behind the proxy ─────────────────

/// H1: with `KEEP_CLIENT_IP_HEADER` (Fly-Client-IP), each client has its
/// own password bucket: one client spending it doesn't touch another.
/// M5: an IPv6 client is its /64. L4: a header that isn't exactly one IP
/// (an `X-Forwarded-For`-style list a client can prepend to) doesn't pick
/// the key; the peer does.
#[tokio::test]
async fn behind_the_proxy_each_client_has_its_own_password_limit() {
    let w = world_with(Config {
        client_ip_header: Some("fly-client-ip".parse().unwrap()),
        ..config()
    });
    let mut n = 0;
    let mut next = || {
        n += 1;
        format!("n{n}@alpha.org")
    };
    for _ in 0..20 {
        let r = sign_in_from(&w, "203.0.113.7", &next()).await;
        assert_eq!(r.reason(), "invalid_credentials", "{}", r.body);
    }
    let r = sign_in_from(&w, "203.0.113.7", &next()).await;
    assert_eq!(
        r.status,
        StatusCode::TOO_MANY_REQUESTS,
        "that client is limited"
    );
    let r = sign_in_from(&w, "203.0.113.8", &next()).await;
    assert_eq!(r.reason(), "invalid_credentials", "another client isn't");

    for i in 0..20 {
        sign_in_from(&w, &format!("2001:db8:1:2::{i:x}"), &next()).await;
    }
    let r = sign_in_from(&w, "2001:db8:1:2:ffff:ffff:ffff:ffff", &next()).await;
    assert_eq!(
        r.status,
        StatusCode::TOO_MANY_REQUESTS,
        "one /64 is one client"
    );
    let r = sign_in_from(&w, "2001:db8:1:3::1", &next()).await;
    assert_eq!(r.reason(), "invalid_credentials", "the next /64 isn't");

    for i in 0..20 {
        sign_in_from(&w, &format!("198.51.100.{i}, 203.0.113.9"), &next()).await;
    }
    let r = sign_in_from(&w, "198.51.100.99, 203.0.113.9", &next()).await;
    assert_eq!(
        r.status,
        StatusCode::TOO_MANY_REQUESTS,
        "a list isn't one IP: those all counted as the peer"
    );
}

#[test]
fn client_keys() {
    assert_eq!(ip_key("203.0.113.7".parse().unwrap()), "203.0.113.7");
    assert_eq!(
        ip_key("2001:db8:1:2:aaaa::1".parse().unwrap()),
        "2001:db8:1:2::/64"
    );
    assert_eq!(ip_key("::ffff:203.0.113.7".parse().unwrap()), "203.0.113.7");
}

// ── M1: second-factor lockout ──────────────────────────────────────────────

/// M1: the tenth wrong code in an hour locks the user's second factor:
/// the sign-in ends, the user is emailed once, and even the right code is
/// refused until the hour is up or the password is reset.
#[tokio::test]
async fn ten_wrong_codes_in_an_hour_lock_the_second_factor() {
    let w = world();
    let ann = w.user_id("ann@alpha.org");
    // Eight misses earlier in the hour (the in-memory limit allows 5 a
    // minute, so the API alone takes minutes to get here).
    let earlier = contracts::now_ms() - 10 * 60 * 1000;
    w.store
        .platform()
        .with_write(|tx| {
            for _ in 0..8 {
                tx.execute(
                    "INSERT INTO auth_factor_failures (user_id, at) VALUES (?1, ?2)",
                    [ann, earlier],
                )?;
            }
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    let sign_in = || async {
        let r = w
            .post(
                "/api/auth/sign-in",
                None,
                json!({ "email": "ann@alpha.org", "password": password_of("ann@alpha.org") }),
            )
            .await;
        r.cookie().unwrap()
    };
    let partial = sign_in().await;
    let r = w
        .post(
            "/api/auth/second-factor",
            Some(&partial),
            json!({ "code": "000000" }),
        )
        .await;
    assert_eq!(r.reason(), "wrong_code", "the ninth");
    let r = w
        .post(
            "/api/auth/second-factor",
            Some(&partial),
            json!({ "code": "000000" }),
        )
        .await;
    assert_eq!(r.reason(), "locked", "the tenth: {}", r.body);
    assert!(r.cookie().unwrap().ends_with('='), "the sign-in ended");
    w.wait_for_subject("ann@alpha.org", "Too many wrong keep-together codes")
        .await;

    // The right code is refused while locked, and nobody is told twice.
    let partial = sign_in().await;
    let r = w
        .post(
            "/api/auth/second-factor",
            Some(&partial),
            json!({ "code": w.totp("ann@alpha.org") }),
        )
        .await;
    assert_eq!(r.reason(), "locked");
    tokio::time::sleep(Duration::from_millis(50)).await;
    let notices = w
        .subjects_to("ann@alpha.org")
        .iter()
        .filter(|s| s.starts_with("Too many"))
        .count();
    assert_eq!(notices, 1);

    // A password reset lifts it.
    w.post(
        "/api/auth/reset/request",
        None,
        json!({ "email": "ann@alpha.org" }),
    )
    .await;
    let token = w.emailed_token("ann@alpha.org").await;
    let r = w
        .post(
            "/api/auth/reset/complete",
            None,
            json!({ "token": token, "password": "a-brand-new-password" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = w
        .post(
            "/api/auth/sign-in",
            None,
            json!({ "email": "ann@alpha.org", "password": "a-brand-new-password" }),
        )
        .await;
    let r = w
        .post(
            "/api/auth/second-factor",
            Some(&r.cookie().unwrap()),
            json!({ "code": w.totp("ann@alpha.org") }),
        )
        .await;
    assert_eq!(r.body["stage"], "signed_in", "{}", r.body);
}

/// M1: wrong codes at step-up count too; a signed-in session isn't ended
/// by them, only refused.
#[tokio::test]
async fn wrong_step_up_codes_count_towards_the_lock() {
    let w = world();
    let cookie = w.sign_in("ann@alpha.org").await;
    let ann = w.user_id("ann@alpha.org");
    let now = contracts::now_ms();
    w.store
        .platform()
        .with_write(|tx| {
            for _ in 0..9 {
                tx.execute(
                    "INSERT INTO auth_factor_failures (user_id, at) VALUES (?1, ?2)",
                    [ann, now],
                )?;
            }
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    let r = w
        .post(
            "/api/auth/step-up",
            Some(&cookie),
            json!({ "password": password_of("ann@alpha.org"), "code": "000000" }),
        )
        .await;
    assert_eq!(r.reason(), "locked", "{}", r.body);
    w.wait_for_subject("ann@alpha.org", "Too many wrong keep-together codes")
        .await;
    assert_eq!(
        w.call("GET", "/api/me", Some(&cookie), None).await.status,
        StatusCode::OK,
        "still signed in"
    );
}

// ── M2: nothing usable in a copy of platform.db ───────────────────────────

/// M2: an enrolled TOTP secret is sealed, recovery codes are ≥ 80 bits and
/// stored as HMAC under the pepper, an emailed code likewise: none is in
/// the database in the clear or as a bare SHA-256.
#[tokio::test]
async fn secrets_and_codes_are_not_stored_in_the_clear() {
    let w = world();
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
            json!({ "token": token, "password": password_of("new@alpha.org") }),
        )
        .await;
    let enrol = r.cookie().unwrap();
    let r = w
        .post("/api/auth/enrol/totp", Some(&enrol), json!({}))
        .await;
    let secret = r.body["secret"].as_str().unwrap().to_owned();
    let user = w.user_id("new@alpha.org");
    let pending: String = w
        .store
        .platform()
        .with_read(|c| {
            c.query_row(
                "SELECT pending_secret FROM auth_sessions WHERE user_id = ?1",
                [user],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(pending.starts_with("v1:") && !pending.contains(&secret));
    let code = auth::totp::code_at(&secret, (contracts::now_ms() / 1000) as u64).unwrap();
    let r = w
        .post(
            "/api/auth/enrol/confirm",
            Some(&enrol),
            json!({ "method": "totp", "code": code }),
        )
        .await;
    assert_eq!(r.body["state"]["stage"], "signed_in", "{}", r.body);
    let codes: Vec<String> = serde_json::from_value(r.body["recoveryCodes"].clone()).unwrap();
    assert_eq!(codes.len(), 10);
    assert!(codes.iter().all(|c| c.len() == 23), "{codes:?}");

    let (stored_secret, stored_codes): (String, Vec<String>) = w
        .store
        .platform()
        .with_read(|c| {
            let s = c.query_row(
                "SELECT totp_secret FROM auth_credentials WHERE user_id = ?1",
                [user],
                |r| r.get(0),
            )?;
            let mut stmt =
                c.prepare("SELECT code_hash FROM auth_recovery_codes WHERE user_id = ?1")?;
            let codes = stmt
                .query_map([user], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            Ok::<_, rusqlite::Error>((s, codes))
        })
        .unwrap();
    assert!(stored_secret.starts_with("v1:") && !stored_secret.contains(&secret));
    for c in &codes {
        let bare = auth::secret::hash(&c.replace('-', ""));
        assert!(!stored_codes.contains(&bare), "{c} stored as bare SHA-256");
    }
    // The codes still work.
    let r = w
        .post(
            "/api/auth/sign-in",
            None,
            json!({ "email": "new@alpha.org", "password": password_of("new@alpha.org") }),
        )
        .await;
    let r = w
        .post(
            "/api/auth/second-factor",
            Some(&r.cookie().unwrap()),
            json!({ "code": codes[3] }),
        )
        .await;
    assert_eq!(r.body["stage"], "signed_in", "{}", r.body);

    // An emailed code: not a bare SHA-256 of six digits; 10 minutes (L5).
    let r = w
        .post(
            "/api/auth/sign-in",
            None,
            json!({ "email": "val@alpha.org", "password": password_of("val@alpha.org") }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let mail = w
        .next_mail_where("val@alpha.org", |m| m.subject.contains("code: "))
        .await;
    let code = mail.subject.rsplit(' ').next().unwrap();
    assert!(mail.text.contains("for 10 minutes"), "{}", mail.text);
    let val = w.user_id("val@alpha.org");
    let stored: String = w
        .store
        .platform()
        .with_read(|c| {
            c.query_row(
                "SELECT email_code_hash FROM auth_sessions WHERE user_id = ?1",
                [val],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_ne!(stored, auth::secret::hash(code));
}

// ── M3: notices ────────────────────────────────────────────────────────────

/// M3: password change and reset, a new second factor, new recovery codes
/// and an admin's 2FA reset each email the account's owner.
#[tokio::test]
async fn credential_changes_are_mailed_to_the_owner() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;

    let r = w
        .post("/api/auth/account/recovery-codes", Some(&ann), json!({}))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    w.wait_for_subject("ann@alpha.org", "New keep-together recovery codes")
        .await;

    w.post("/api/auth/enrol/email", Some(&ann), json!({})).await;
    let code = w.emailed_code("ann@alpha.org").await;
    let r = w
        .post(
            "/api/auth/enrol/confirm",
            Some(&ann),
            json!({ "method": "email", "code": code }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let ann = r.cookie().unwrap();
    w.wait_for_subject(
        "ann@alpha.org",
        "Your keep-together second factor was set up",
    )
    .await;

    let r = w
        .post(
            "/api/auth/account/password",
            Some(&ann),
            json!({ "current": password_of("ann@alpha.org"), "new": "another-good-password" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    w.wait_for_subject("ann@alpha.org", "Your keep-together password was changed")
        .await;

    let val = w.user_id("val@alpha.org");
    let r = w
        .post(
            &format!("/api/t/alpha/members/{val}/reset-2fa"),
            Some(&ann),
            json!({}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    w.wait_for_subject(
        "val@alpha.org",
        "Your keep-together second factor was reset",
    )
    .await;

    w.post(
        "/api/auth/reset/request",
        None,
        json!({ "email": "bob@beta.org" }),
    )
    .await;
    let token = w.emailed_token("bob@beta.org").await;
    w.post(
        "/api/auth/reset/complete",
        None,
        json!({ "token": token, "password": "bobs-new-password" }),
    )
    .await;
    w.wait_for_subject("bob@beta.org", "Your keep-together password was reset")
        .await;
}

// ── M6: idle timeout and the sessions list ────────────────────────────────

fn set_last_seen(w: &World, cookie: &str, ago_ms: i64) {
    let hash = auth::secret::hash(cookie.split_once('=').unwrap().1);
    w.store
        .platform()
        .with_write(|tx| {
            tx.execute(
                "UPDATE auth_sessions SET last_seen = ?2 WHERE token_hash = ?1",
                rusqlite::params![hash, contracts::now_ms() - ago_ms],
            )
        })
        .unwrap();
}

/// M6: 12 idle hours end a session (its 7 days notwithstanding); a request
/// restarts the clock.
#[tokio::test]
async fn twelve_idle_hours_end_a_session() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    set_last_seen(&w, &ann, auth::IDLE_MS - 60_000);
    assert_eq!(
        w.call("GET", "/api/me", Some(&ann), None).await.status,
        StatusCode::OK
    );
    // That request touched it: another 12 hours from now.
    set_last_seen(&w, &ann, 0);
    let bob = w.sign_in("bob@beta.org").await;
    set_last_seen(&w, &bob, auth::IDLE_MS + 1);
    assert_eq!(
        w.call("GET", "/api/me", Some(&bob), None).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn a_request_restarts_the_idle_clock() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    set_last_seen(&w, &ann, 11 * 60 * 60 * 1000);
    w.call("GET", "/api/me", Some(&ann), None).await;
    let hash = auth::secret::hash(ann.split_once('=').unwrap().1);
    let last_seen: i64 = w
        .store
        .platform()
        .with_read(|c| {
            c.query_row(
                "SELECT last_seen FROM auth_sessions WHERE token_hash = ?1",
                [hash],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(contracts::now_ms() - last_seen < 60_000);
}

/// M6 (ASVS 3.3.4): Your account lists your sessions and signs the
/// others out.
#[tokio::test]
async fn your_sessions_are_listed_and_the_others_can_be_signed_out() {
    let w = world();
    let first = w.sign_in("ann@alpha.org").await;
    // A second browser, which says what it is.
    let body = json!({ "email": "ann@alpha.org", "password": password_of("ann@alpha.org") });
    let r = w
        .send(
            post_json("/api/auth/sign-in", body.clone())
                .header(header::USER_AGENT, "Firefox on the office PC")
                .body(HttpBody::from(body.to_string()))
                .unwrap(),
        )
        .await;
    let r = w
        .post(
            "/api/auth/second-factor",
            Some(&r.cookie().unwrap()),
            json!({ "code": w.totp("ann@alpha.org") }),
        )
        .await;
    let second = r.cookie().unwrap();
    let bob = w.sign_in("bob@beta.org").await;

    let r = w
        .call("GET", "/api/auth/account/sessions", Some(&first), None)
        .await;
    let list = r.body.as_array().unwrap();
    assert_eq!(list.len(), 2, "ann's, not bob's: {}", r.body);
    assert_eq!(list.iter().filter(|s| s["current"] == true).count(), 1);
    assert!(
        list.iter()
            .any(|s| s["userAgent"] == "Firefox on the office PC" && s["current"] == false)
    );

    let r = w
        .post(
            "/api/auth/account/sessions/sign-out-others",
            Some(&first),
            json!({}),
        )
        .await;
    assert_eq!(r.body["ended"], 1);
    assert_eq!(
        w.call("GET", "/api/me", Some(&second), None).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        w.call("GET", "/api/me", Some(&first), None).await.status,
        StatusCode::OK
    );
    assert_eq!(
        w.call("GET", "/api/me", Some(&bob), None).await.status,
        StatusCode::OK
    );
    let r = w
        .call("GET", "/api/auth/account/sessions", Some(&first), None)
        .await;
    assert_eq!(r.body.as_array().unwrap().len(), 1);
}

// ── M7: re-enrolment after a 2FA reset ─────────────────────────────────────

/// M7: after an admin resets someone's 2FA, the password alone doesn't
/// enrol a new factor: an emailed code (to the account's address) is
/// needed with the authenticator app's.
#[tokio::test]
async fn after_a_2fa_reset_enrolling_needs_an_emailed_code_too() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    let val = w.user_id("val@alpha.org");
    w.post(
        &format!("/api/t/alpha/members/{val}/reset-2fa"),
        Some(&ann),
        json!({}),
    )
    .await;

    let r = w
        .post(
            "/api/auth/sign-in",
            None,
            json!({ "email": "val@alpha.org", "password": password_of("val@alpha.org") }),
        )
        .await;
    assert_eq!(r.body["stage"], "enrol");
    assert_eq!(r.body["needsEmailCode"], true);
    let enrol = r.cookie().unwrap();
    let emailed = w.emailed_code("val@alpha.org").await;
    let r = w
        .post("/api/auth/enrol/totp", Some(&enrol), json!({}))
        .await;
    let secret = r.body["secret"].as_str().unwrap().to_owned();
    let totp = || auth::totp::code_at(&secret, (contracts::now_ms() / 1000) as u64).unwrap();

    // The app's code alone, or with a wrong emailed one: refused.
    let wrong = if emailed == "000000" {
        "000001"
    } else {
        "000000"
    };
    for extra in [json!(null), json!(wrong)] {
        let r = w
            .post(
                "/api/auth/enrol/confirm",
                Some(&enrol),
                json!({ "method": "totp", "code": totp(), "emailCode": extra }),
            )
            .await;
        assert_eq!(r.reason(), "wrong_code", "{extra}: {}", r.body);
    }
    let r = w
        .post(
            "/api/auth/enrol/confirm",
            Some(&enrol),
            json!({ "method": "totp", "code": totp(), "emailCode": emailed }),
        )
        .await;
    assert_eq!(r.body["state"]["stage"], "signed_in", "{}", r.body);
    assert_eq!(r.body["state"]["needsEmailCode"], false);
    assert_eq!(
        count(
            &w,
            "SELECT must_prove_email FROM auth_credentials WHERE user_id = ?1",
            val
        ),
        0
    );
}

/// M7: an account that never had a factor (a new invitee) enrols with the
/// password alone: the invite link already proved the mailbox.
#[tokio::test]
async fn a_new_member_enrols_without_an_extra_code() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    w.post(
        "/api/t/alpha/members/invite",
        Some(&ann),
        json!({ "email": "fresh@alpha.org", "role": "staff" }),
    )
    .await;
    let token = w.emailed_token("fresh@alpha.org").await;
    let r = w
        .post(
            "/api/auth/invite/accept",
            None,
            json!({ "token": token, "password": password_of("fresh@alpha.org") }),
        )
        .await;
    assert_eq!(r.body["stage"], "enrol");
    assert_eq!(r.body["needsEmailCode"], false);
}

// ── L1: the __Host- cookie ─────────────────────────────────────────────────

/// L1: deployed, the cookie is `__Host-kt_session` (Secure, no Domain), and
/// a plain `kt_session` (which a sibling subdomain could set) is ignored;
/// on localhost it stays `kt_session` without Secure.
#[tokio::test]
async fn the_session_cookie_is_host_prefixed_except_on_localhost() {
    let w = world();
    let sign_in = |host: &'static str| {
        let body = json!({ "email": "ann@alpha.org", "password": password_of("ann@alpha.org") });
        post_json("/api/auth/sign-in", body.clone())
            .header(header::HOST, host)
            .body(HttpBody::from(body.to_string()))
            .unwrap()
    };
    let res = w.send(sign_in("app.keep-together.org.uk")).await;
    let c = &res.set_cookies[0];
    assert!(c.starts_with("__Host-kt_session="), "{c}");
    assert!(
        c.contains("Secure") && c.contains("Path=/") && !c.contains("Domain"),
        "{c}"
    );
    let res = w.send(sign_in("localhost:3000")).await;
    assert!(res.set_cookies[0].starts_with("kt_session="));

    let full = w.sign_in("ann@alpha.org").await;
    let token = full.split_once('=').unwrap().1;
    let me = |cookie: String| {
        World::request("GET", "/api/me", Some(&cookie), None)
            .header(header::HOST, "app.keep-together.org.uk")
            .body(HttpBody::empty())
            .unwrap()
    };
    assert_eq!(
        w.send(me(format!("kt_session={token}"))).await.status,
        StatusCode::UNAUTHORIZED,
        "a plain cookie is ignored when deployed"
    );
    assert_eq!(
        w.send(me(format!("__Host-kt_session={token}")))
            .await
            .status,
        StatusCode::OK
    );
}

// ── L2: invite acceptance decides inside its transaction ──────────────────

/// L2: two invites to one new address, accepted at once with different
/// passwords. Before the fix both could take the "new account" path and
/// the second overwrite the first's password; now the account's password
/// is the one whose acceptance succeeded.
#[tokio::test]
async fn concurrent_invites_for_a_new_address_set_one_password() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    let bob = w.sign_in("bob@beta.org").await;
    for (who, slug) in [(&ann, "alpha"), (&bob, "beta")] {
        let r = w
            .post(
                &format!("/api/t/{slug}/members/invite"),
                Some(who),
                json!({ "email": "twice@x.org", "role": "staff" }),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    }
    let a = w.emailed_token("twice@x.org").await;
    let b = w.emailed_token("twice@x.org").await;
    let (ra, rb) = tokio::join!(
        w.post(
            "/api/auth/invite/accept",
            None,
            json!({ "token": a, "password": "first-password-here" })
        ),
        w.post(
            "/api/auth/invite/accept",
            None,
            json!({ "token": b, "password": "second-password-here" })
        ),
    );
    let ok: Vec<_> = [(&ra, "first-password-here"), (&rb, "second-password-here")]
        .into_iter()
        .filter(|(r, _)| r.status == StatusCode::OK)
        .collect();
    assert_eq!(ok.len(), 1, "{} / {}", ra.body, rb.body);
    let loser = if ra.status == StatusCode::OK {
        &rb
    } else {
        &ra
    };
    assert!(
        matches!(loser.reason(), "try_again" | "invalid_credentials"),
        "{}",
        loser.body
    );
    let user = w.user_id("twice@x.org");
    let hash: String = w
        .store
        .platform()
        .with_read(|c| {
            c.query_row(
                "SELECT password_hash FROM auth_credentials WHERE user_id = ?1",
                [user],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(
        auth::password::verify(ok[0].1, &hash),
        "the winner's password stands"
    );
}

// ── L6: every revocation is broadcast ──────────────────────────────────────

async fn stream_ends_within(
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

/// L6: signing in again from a browser ends its previous session's live
/// streams at once (not at the 30 s recheck).
#[tokio::test]
async fn signing_in_again_ends_the_old_sessions_streams_at_once() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    let ended = stream_ends_within(&w, &ann, Duration::from_secs(2), async {
        let r = w
            .post(
                "/api/auth/sign-in",
                Some(&ann),
                json!({ "email": "ann@alpha.org", "password": password_of("ann@alpha.org") }),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK);
    })
    .await;
    assert!(ended);
}

/// L6: so does accepting an invite in a signed-in browser.
#[tokio::test]
async fn accepting_an_invite_ends_the_old_sessions_streams_at_once() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    w.post(
        "/api/t/alpha/members/invite",
        Some(&ann),
        json!({ "email": "other@alpha.org", "role": "staff" }),
    )
    .await;
    let token = w.emailed_token("other@alpha.org").await;
    let ended = stream_ends_within(&w, &ann, Duration::from_secs(2), async {
        let r = w
            .post(
                "/api/auth/invite/accept",
                Some(&ann),
                json!({ "token": token, "password": password_of("other@alpha.org") }),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    })
    .await;
    assert!(ended);
}

// ── L7: a password change spends reset links ──────────────────────────────

#[tokio::test]
async fn a_password_change_spends_earlier_reset_links() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    w.post(
        "/api/auth/reset/request",
        None,
        json!({ "email": "ann@alpha.org" }),
    )
    .await;
    let token = w.emailed_token("ann@alpha.org").await;
    let r = w
        .post(
            "/api/auth/account/password",
            Some(&ann),
            json!({ "current": password_of("ann@alpha.org"), "new": "a-fresh-password" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = w
        .post("/api/auth/reset/check", None, json!({ "token": token }))
        .await;
    assert_eq!(r.body["valid"], false);
    let r = w
        .post(
            "/api/auth/reset/complete",
            None,
            json!({ "token": token, "password": "the-attackers-pass" }),
        )
        .await;
    assert_eq!(r.reason(), "link_expired");
}

// ── L8: an operator invite can't demote the last admin ────────────────────

#[tokio::test]
async fn an_invite_cant_demote_a_groups_last_admin() {
    let w = world();
    let mail = w
        .store
        .platform()
        .with_write(|tx| {
            auth::operator_invite(
                tx,
                w.alpha.id.as_str(),
                "Alpha",
                "ann@alpha.org",
                "viewer",
                ORIGIN,
                contracts::now_ms(),
            )
        })
        .unwrap();
    let at = mail.text.find('#').unwrap();
    let token = &mail.text[at + 1..at + 65];
    let r = w
        .post(
            "/api/auth/invite/accept",
            None,
            json!({ "token": token, "password": password_of("ann@alpha.org") }),
        )
        .await;
    assert_eq!(r.reason(), "last_admin", "{}", r.body);
    let ann = w.sign_in("ann@alpha.org").await;
    let r = w.call("GET", "/api/t/alpha", Some(&ann), None).await;
    assert_eq!(r.body["role"], "admin");
    // Not spent: it can be accepted once someone else is admin.
    let r = w
        .post("/api/auth/invite/check", None, json!({ "token": token }))
        .await;
    assert_eq!(r.status, StatusCode::OK);
}
