//! Staff auth (ADR 0020 §3, without Google), one test per rule, plus the
//! ports of `convex/auth.test.ts`.

mod authworld;

use authworld::{World, password_of, world, world_dev};
use axum::http::StatusCode;
use serde_json::json;

async fn sign_in_password(w: &World, email: &str, password: &str) -> authworld::Res {
    w.post(
        "/api/auth/sign-in",
        None,
        json!({ "email": email, "password": password }),
    )
    .await
}

// ── no enumeration ─────────────────────────────────────────────────────────

/// convex auth.test.ts "wrong password" + "unknown email": one answer.
#[tokio::test]
async fn an_unknown_email_and_a_wrong_password_answer_the_same() {
    let w = world();
    let wrong = sign_in_password(&w, "ann@alpha.org", "not her password").await;
    let unknown = sign_in_password(&w, "nobody@alpha.org", "not her password").await;
    for r in [&wrong, &unknown] {
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            r.body,
            json!({ "kind": "rejected", "reason": "invalid_credentials", "message": "Wrong email or password." })
        );
        assert!(r.cookie().is_none());
    }
}

/// A user without a password (made by the dev login) can't sign in with
/// any password, and looks like an unknown email.
#[tokio::test]
async fn a_user_without_a_password_reads_as_unknown() {
    let w = world_dev();
    w.post("/api/dev/login", None, json!({ "email": "dev@alpha.org" }))
        .await;
    let r = sign_in_password(&w, "dev@alpha.org", "").await;
    assert_eq!(r.reason(), "invalid_credentials");
}

#[tokio::test]
async fn a_reset_request_answers_the_same_for_any_address() {
    let w = world();
    let known = w
        .post(
            "/api/auth/reset/request",
            None,
            json!({ "email": "Ann@Alpha.org " }),
        )
        .await;
    let unknown = w
        .post(
            "/api/auth/reset/request",
            None,
            json!({ "email": "nobody@alpha.org" }),
        )
        .await;
    assert_eq!((known.status, &known.body), (unknown.status, &unknown.body));
    assert_eq!(known.body, json!({ "ok": true }));
    w.mail_to("ann@alpha.org").await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(w.mails_to("nobody@alpha.org"), 0);
}

// ── passwords ──────────────────────────────────────────────────────────────

/// convex auth.test.ts: short / missing / exactly-minimum passwords, on
/// the one place a password is now chosen (an invite or a reset).
#[tokio::test]
async fn new_passwords_need_eight_characters() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    for (email, password, ok) in [
        ("short@x.org", "1234567", false),
        ("missing@x.org", "", false),
        ("exact@x.org", "12345678", true),
    ] {
        w.post(
            "/api/t/alpha/members/invite",
            Some(&ann),
            json!({ "email": email, "role": "staff" }),
        )
        .await;
        let token = w.emailed_token(email).await;
        let r = w
            .post(
                "/api/auth/invite/accept",
                None,
                json!({ "token": token, "password": password }),
            )
            .await;
        if ok {
            assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        } else {
            assert_eq!(
                r.body,
                json!({ "kind": "invalid", "problems": [{ "field": "password", "message": "Password must be at least 8 characters." }] })
            );
        }
    }
    let r = w
        .post(
            "/api/auth/reset/request",
            None,
            json!({ "email": "ann@alpha.org" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let token = w.emailed_token("ann@alpha.org").await;
    let r = w
        .post(
            "/api/auth/reset/complete",
            None,
            json!({ "token": token, "password": "short" }),
        )
        .await;
    assert_eq!(r.kind(), "invalid");
}

#[tokio::test]
async fn passwords_are_stored_as_argon2id() {
    let w = world();
    let hash: String = w
        .store
        .platform()
        .with_read(|c| {
            c.query_row(
                "SELECT password_hash FROM auth_credentials LIMIT 1",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(hash.starts_with("$argon2id$"), "{hash}");
}

// ── the second factor ──────────────────────────────────────────────────────

#[tokio::test]
async fn the_second_factor_is_required() {
    let w = world();
    let r = sign_in_password(&w, "ann@alpha.org", &password_of("ann@alpha.org")).await;
    assert_eq!(r.body["stage"], "second_factor");
    assert_eq!(r.body["method"], "totp");
    let partial = r.cookie().unwrap();
    let r = w
        .post(
            "/api/auth/second-factor",
            Some(&partial),
            json!({ "code": "000000" }),
        )
        .await;
    assert_eq!(r.reason(), "wrong_code");
    assert_eq!(
        w.call("GET", "/api/me", Some(&partial), None).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn a_totp_code_works_once() {
    let w = world();
    let r = sign_in_password(&w, "ann@alpha.org", &password_of("ann@alpha.org")).await;
    let code = w.totp("ann@alpha.org");
    let ok = w
        .post(
            "/api/auth/second-factor",
            Some(&r.cookie().unwrap()),
            json!({ "code": code }),
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK);
    let r = sign_in_password(&w, "ann@alpha.org", &password_of("ann@alpha.org")).await;
    let again = w
        .post(
            "/api/auth/second-factor",
            Some(&r.cookie().unwrap()),
            json!({ "code": code }),
        )
        .await;
    assert_eq!(again.reason(), "wrong_code");
}

#[tokio::test]
async fn the_emailed_code_is_sent_at_sign_in_and_burns_after_five_misses() {
    let w = world();
    let r = sign_in_password(&w, "val@alpha.org", &password_of("val@alpha.org")).await;
    assert_eq!(r.body["method"], "email");
    let partial = r.cookie().unwrap();
    let code = w.emailed_code("val@alpha.org").await;
    assert_eq!(code.len(), 6);
    // The rate limit is 5 per minute too; the code burns at the 5th miss.
    for _ in 0..5 {
        let r = w
            .post(
                "/api/auth/second-factor",
                Some(&partial),
                json!({ "code": if code == "999999" { "999998" } else { "999999" } }),
            )
            .await;
        assert_eq!(r.reason(), "wrong_code");
    }
    let user = w.user_id("val@alpha.org");
    let left: Option<String> = w
        .store
        .platform()
        .with_read(|c| {
            c.query_row(
                "SELECT email_code_hash FROM auth_sessions WHERE user_id = ?1",
                [user],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(left, None, "burned");
}

#[tokio::test]
async fn an_emailed_code_signs_in() {
    let w = world();
    let cookie = w.sign_in("val@alpha.org").await;
    assert_eq!(
        w.call("GET", "/api/me", Some(&cookie), None).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn a_recovery_code_works_once() {
    let w = world();
    let user = w.user_id("bob@beta.org");
    let codes = w
        .store
        .platform()
        .with_write(|tx| auth::accounts::new_recovery_codes(tx, user))
        .unwrap();
    assert_eq!(codes.len(), 10);
    let r = sign_in_password(&w, "bob@beta.org", &password_of("bob@beta.org")).await;
    let ok = w
        .post(
            "/api/auth/second-factor",
            Some(&r.cookie().unwrap()),
            json!({ "code": codes[0].to_uppercase() }),
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.body);
    let r = sign_in_password(&w, "bob@beta.org", &password_of("bob@beta.org")).await;
    let again = w
        .post(
            "/api/auth/second-factor",
            Some(&r.cookie().unwrap()),
            json!({ "code": codes[0] }),
        )
        .await;
    assert_eq!(again.reason(), "wrong_code");
}

// ── rate limits ────────────────────────────────────────────────────────────

#[tokio::test]
async fn password_attempts_are_limited_per_email_known_or_not() {
    let w = world();
    for email in ["ann@alpha.org", "nobody@alpha.org"] {
        for _ in 0..5 {
            let r = sign_in_password(&w, email, "wrong").await;
            assert_eq!(
                r.reason(),
                "invalid_credentials",
                "{email}: {} {}",
                r.status,
                r.body
            );
        }
        let r = sign_in_password(&w, email, &password_of(email)).await;
        assert_eq!(
            (r.status, r.kind()),
            (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
            "{email}"
        );
    }
}

#[tokio::test]
async fn second_factor_attempts_are_limited_per_user() {
    let w = world();
    let r = sign_in_password(&w, "ann@alpha.org", &password_of("ann@alpha.org")).await;
    let partial = r.cookie().unwrap();
    for _ in 0..5 {
        w.post(
            "/api/auth/second-factor",
            Some(&partial),
            json!({ "code": "000000" }),
        )
        .await;
    }
    let r = w
        .post(
            "/api/auth/second-factor",
            Some(&partial),
            json!({ "code": w.totp("ann@alpha.org") }),
        )
        .await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
}

// ── reset by emailed link ──────────────────────────────────────────────────

#[tokio::test]
async fn a_reset_link_sets_a_new_password_once_and_keeps_the_second_factor() {
    let w = world();
    w.post(
        "/api/auth/reset/request",
        None,
        json!({ "email": "ann@alpha.org" }),
    )
    .await;
    let mail = w.mail_to("ann@alpha.org").await;
    assert!(
        mail.text.contains("https://app.test/reset#"),
        "{}",
        mail.text
    );
    let token = w.emailed_token("ann@alpha.org").await;
    assert!(mail.text.contains(&token));
    let r = w
        .post("/api/auth/reset/check", None, json!({ "token": token }))
        .await;
    assert_eq!(r.body, json!({ "valid": true }));
    let r = w
        .post(
            "/api/auth/reset/complete",
            None,
            json!({ "token": token, "password": "brand new password" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let again = w
        .post(
            "/api/auth/reset/complete",
            None,
            json!({ "token": token, "password": "another password" }),
        )
        .await;
    assert_eq!(again.reason(), "link_expired");
    let old = sign_in_password(&w, "ann@alpha.org", &password_of("ann@alpha.org")).await;
    assert_eq!(old.reason(), "invalid_credentials");
    let new = sign_in_password(&w, "ann@alpha.org", "brand new password").await;
    assert_eq!(new.body["stage"], "second_factor");
}

#[tokio::test]
async fn a_reset_link_expires_after_15_minutes() {
    let w = world();
    w.post(
        "/api/auth/reset/request",
        None,
        json!({ "email": "ann@alpha.org" }),
    )
    .await;
    let token = w.emailed_token("ann@alpha.org").await;
    w.store
        .platform()
        .with_write(|tx| {
            tx.execute(
                "UPDATE auth_resets SET expires_at = created_at + 15 * 60 * 1000 - ?1",
                [contracts::now_ms()],
            )
        })
        .unwrap();
    let r = w
        .post("/api/auth/reset/check", None, json!({ "token": token }))
        .await;
    assert_eq!(r.body, json!({ "valid": false }));
    let r = w
        .post(
            "/api/auth/reset/complete",
            None,
            json!({ "token": token, "password": "brand new password" }),
        )
        .await;
    assert_eq!(r.reason(), "link_expired");
}

#[tokio::test]
async fn a_new_reset_link_is_15_minutes_long() {
    let w = world();
    w.post(
        "/api/auth/reset/request",
        None,
        json!({ "email": "ann@alpha.org" }),
    )
    .await;
    let ttl: i64 = w
        .store
        .platform()
        .with_read(|c| {
            c.query_row("SELECT expires_at - created_at FROM auth_resets", [], |r| {
                r.get(0)
            })
        })
        .unwrap();
    assert_eq!(ttl, 15 * 60 * 1000);
}

// ── invite-only staff ──────────────────────────────────────────────────────

#[tokio::test]
async fn an_invite_makes_a_new_member_who_must_enrol_a_second_factor() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    let r = w
        .post(
            "/api/t/alpha/members/invite",
            Some(&ann),
            json!({ "email": "New@Alpha.org", "role": "staff" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["email"], "new@alpha.org");
    let mail = w.mail_to("new@alpha.org").await;
    assert!(mail.subject.contains("Alpha"));
    assert!(mail.text.contains("https://app.test/invite#"));
    let token = w.emailed_token("new@alpha.org").await;
    assert!(mail.text.contains(&token));

    let r = w
        .post("/api/auth/invite/check", None, json!({ "token": token }))
        .await;
    assert_eq!(
        r.body,
        json!({ "email": "new@alpha.org", "group": "Alpha", "role": "staff", "hasAccount": false })
    );

    let r = w
        .post(
            "/api/auth/invite/accept",
            None,
            json!({ "token": token, "password": "new person's pw" }),
        )
        .await;
    assert_eq!(r.body["stage"], "enrol");
    let enrol = r.cookie().unwrap();
    // Not signed in until a second factor is set up.
    assert_eq!(
        w.call("GET", "/api/t/alpha", Some(&enrol), None)
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );

    let r = w
        .post("/api/auth/enrol/totp", Some(&enrol), json!({}))
        .await;
    let secret = r.body["secret"].as_str().unwrap().to_owned();
    assert!(r.body["qrSvg"].as_str().unwrap().starts_with("<svg"));
    assert!(
        r.body["url"]
            .as_str()
            .unwrap()
            .starts_with("otpauth://totp/keep-together:new%40alpha.org")
            || r.body["url"]
                .as_str()
                .unwrap()
                .starts_with("otpauth://totp/keep-together:new@alpha.org")
    );
    let wrong = w
        .post(
            "/api/auth/enrol/confirm",
            Some(&enrol),
            json!({ "method": "totp", "code": "000000" }),
        )
        .await;
    assert_eq!(wrong.reason(), "wrong_code");
    let code = auth::totp::code_at(&secret, authworld::now_secs()).unwrap();
    let r = w
        .post(
            "/api/auth/enrol/confirm",
            Some(&enrol),
            json!({ "method": "totp", "code": code }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["recoveryCodes"].as_array().unwrap().len(), 10);
    assert_eq!(r.body["state"]["stage"], "signed_in");
    let full = r.cookie().unwrap();
    let r = w.call("GET", "/api/t/alpha", Some(&full), None).await;
    assert_eq!(r.body["role"], "staff");

    // Single use.
    let r = w
        .post("/api/auth/invite/check", None, json!({ "token": token }))
        .await;
    assert_eq!(r.reason(), "link_expired");
    let r = w
        .call("GET", "/api/t/alpha/members", Some(&ann), None)
        .await;
    assert!(r.body["invites"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn the_emailed_method_can_be_enrolled() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    w.post(
        "/api/t/alpha/members/invite",
        Some(&ann),
        json!({ "email": "em@alpha.org", "role": "viewer" }),
    )
    .await;
    let token = w.emailed_token("em@alpha.org").await;
    let r = w
        .post(
            "/api/auth/invite/accept",
            None,
            json!({ "token": token, "password": password_of("em@alpha.org") }),
        )
        .await;
    let enrol = r.cookie().unwrap();
    w.post("/api/auth/enrol/email", Some(&enrol), json!({}))
        .await;
    let code = w.emailed_code("em@alpha.org").await;
    let r = w
        .post(
            "/api/auth/enrol/confirm",
            Some(&enrol),
            json!({ "method": "email", "code": code }),
        )
        .await;
    assert_eq!(r.body["state"]["method"], "email");
    // From now on sign-in sends a code.
    let cookie = w.sign_in("em@alpha.org").await;
    assert!(!cookie.is_empty());
}

#[tokio::test]
async fn an_invite_to_an_existing_account_needs_its_password() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    w.post(
        "/api/t/alpha/members/invite",
        Some(&ann),
        json!({ "email": "bob@beta.org", "role": "viewer" }),
    )
    .await;
    let token = w.emailed_token("bob@beta.org").await;
    let r = w
        .post("/api/auth/invite/check", None, json!({ "token": token }))
        .await;
    assert_eq!(r.body["hasAccount"], true);
    let r = w
        .post(
            "/api/auth/invite/accept",
            None,
            json!({ "token": token, "password": "not bob's" }),
        )
        .await;
    assert_eq!(r.reason(), "invalid_credentials");
    let r = w
        .post(
            "/api/auth/invite/accept",
            None,
            json!({ "token": token, "password": password_of("bob@beta.org") }),
        )
        .await;
    assert_eq!(r.body["stage"], "second_factor");
    let r = w
        .post(
            "/api/auth/second-factor",
            Some(&r.cookie().unwrap()),
            json!({ "code": w.totp("bob@beta.org") }),
        )
        .await;
    let bob = r.cookie().unwrap();
    let me = w.call("GET", "/api/me", Some(&bob), None).await;
    assert_eq!(me.body["memberships"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn only_admins_invite_and_only_within_the_step_up_hour() {
    let w = world();
    let cat = w.sign_in("cat@alpha.org").await;
    let r = w
        .post(
            "/api/t/alpha/members/invite",
            Some(&cat),
            json!({ "email": "x@alpha.org", "role": "staff" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let ann = w.sign_in("ann@alpha.org").await;
    w.age_sign_in(&ann, 60 * 60 * 1000);
    let r = w
        .post(
            "/api/t/alpha/members/invite",
            Some(&ann),
            json!({ "email": "x@alpha.org", "role": "staff" }),
        )
        .await;
    assert_eq!(
        (r.status, r.kind()),
        (StatusCode::FORBIDDEN, "step_up_required")
    );
    let r = w
        .post(
            "/api/auth/step-up",
            Some(&ann),
            json!({ "password": password_of("ann@alpha.org"), "code": w.totp("ann@alpha.org") }),
        )
        .await;
    let ann = r.cookie().unwrap();
    let r = w
        .post(
            "/api/t/alpha/members/invite",
            Some(&ann),
            json!({ "email": "x@alpha.org", "role": "staff" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
}

#[tokio::test]
async fn admin_only_domain_routes_need_step_up_too() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    w.age_sign_in(&ann, 61 * 60 * 1000);
    // B1: fields became a list staff may be allowed to manage (like source
    // codes), so the admin-only route here is a Settings switch.
    let switch = json!({ "staffCanManage": true });
    let r = w
        .post("/api/t/alpha/preferences/fields", Some(&ann), switch.clone())
        .await;
    assert_eq!(r.kind(), "step_up_required");
    let ann = w.sign_in("ann@alpha.org").await;
    let r = w.post("/api/t/alpha/preferences/fields", Some(&ann), switch).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
}

#[tokio::test]
async fn step_up_needs_the_password_and_a_code() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    let r = w
        .post(
            "/api/auth/step-up",
            Some(&ann),
            json!({ "password": "wrong", "code": w.totp("ann@alpha.org") }),
        )
        .await;
    assert_eq!(r.reason(), "invalid_credentials");
    let r = w
        .post(
            "/api/auth/step-up",
            Some(&ann),
            json!({ "password": password_of("ann@alpha.org"), "code": "000000" }),
        )
        .await;
    assert_eq!(r.reason(), "wrong_code");
    assert!(r.cookie().is_none());
}

#[tokio::test]
async fn reinviting_replaces_the_link_and_revoking_ends_it() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    let invite = json!({ "email": "z@alpha.org", "role": "viewer" });
    w.post("/api/t/alpha/members/invite", Some(&ann), invite.clone())
        .await;
    let first = w.emailed_token("z@alpha.org").await;
    let r = w
        .post("/api/t/alpha/members/invite", Some(&ann), invite)
        .await;
    let id = r.body["id"].as_str().unwrap().to_owned();
    let r = w
        .post("/api/auth/invite/check", None, json!({ "token": first }))
        .await;
    assert_eq!(r.reason(), "link_expired");
    let second = w.emailed_token("z@alpha.org").await;
    w.post(
        &format!("/api/t/alpha/members/invites/{id}/revoke"),
        Some(&ann),
        json!({}),
    )
    .await;
    let r = w
        .post("/api/auth/invite/check", None, json!({ "token": second }))
        .await;
    assert_eq!(r.reason(), "link_expired");
}

#[tokio::test]
async fn inviting_a_member_is_refused() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    let r = w
        .post(
            "/api/t/alpha/members/invite",
            Some(&ann),
            json!({ "email": "val@alpha.org", "role": "staff" }),
        )
        .await;
    assert_eq!(r.reason(), "already_member");
}

// ── members: roles, removal, the last admin, 2FA reset ─────────────────────

#[tokio::test]
async fn a_group_always_keeps_an_admin() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    let ann_id = w.user_id("ann@alpha.org");
    let r = w
        .post(
            &format!("/api/t/alpha/members/{ann_id}/role"),
            Some(&ann),
            json!({ "role": "staff" }),
        )
        .await;
    assert_eq!(r.reason(), "last_admin");
    let r = w
        .post(
            &format!("/api/t/alpha/members/{ann_id}/remove"),
            Some(&ann),
            json!({}),
        )
        .await;
    assert_eq!(r.reason(), "last_admin");
    let val_id = w.user_id("val@alpha.org");
    let r = w
        .post(
            &format!("/api/t/alpha/members/{val_id}/role"),
            Some(&ann),
            json!({ "role": "admin" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let r = w
        .post(
            &format!("/api/t/alpha/members/{ann_id}/remove"),
            Some(&ann),
            json!({}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
}

#[tokio::test]
async fn the_members_page_lists_members_and_invites() {
    let w = world();
    let val = w.sign_in("val@alpha.org").await;
    let r = w
        .call("GET", "/api/t/alpha/members", Some(&val), None)
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let emails: Vec<_> = r.body["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["email"].as_str().unwrap())
        .collect();
    assert_eq!(emails, ["ann@alpha.org", "cat@alpha.org", "val@alpha.org"]);
    assert_eq!(r.body["members"][2]["you"], true);
    // A viewer can't change anything.
    let ann_id = w.user_id("ann@alpha.org");
    let r = w
        .post(
            &format!("/api/t/alpha/members/{ann_id}/remove"),
            Some(&val),
            json!({}),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn an_admin_resets_2fa_only_for_someone_in_no_other_group() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    let cat_id = w.user_id("cat@alpha.org");
    let r = w
        .post(
            &format!("/api/t/alpha/members/{cat_id}/reset-2fa"),
            Some(&ann),
            json!({}),
        )
        .await;
    assert_eq!(r.reason(), "other_groups");
    let val_id = w.user_id("val@alpha.org");
    let r = w
        .post(
            &format!("/api/t/alpha/members/{val_id}/reset-2fa"),
            Some(&ann),
            json!({}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    // The next sign-in enrols again.
    let r = sign_in_password(&w, "val@alpha.org", &password_of("val@alpha.org")).await;
    assert_eq!(r.body["stage"], "enrol");
    let logged: i64 = w
        .store
        .platform()
        .with_read(|c| {
            c.query_row(
                "SELECT count(*) FROM auth_log WHERE event = 'second_factor_reset'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(logged, 1);
}

// ── isolation ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn member_routes_are_isolated() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    let bob = w.sign_in("bob@beta.org").await;
    // B never sees A: another slug is 403, whatever the route.
    let r = w
        .call("GET", "/api/t/alpha/members", Some(&bob), None)
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = w
        .post(
            "/api/t/alpha/members/invite",
            Some(&bob),
            json!({ "email": "q@x.org", "role": "admin" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    // A's ids under B's slug are 404.
    let ann_id = w.user_id("ann@alpha.org");
    for action in ["remove", "reset-2fa"] {
        let r = w
            .post(
                &format!("/api/t/beta/members/{ann_id}/{action}"),
                Some(&bob),
                json!({}),
            )
            .await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{action}");
    }
    let r = w
        .post(
            &format!("/api/t/beta/members/{ann_id}/role"),
            Some(&bob),
            json!({ "role": "viewer" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = w
        .post(
            "/api/t/alpha/members/invite",
            Some(&ann),
            json!({ "email": "q@x.org", "role": "admin" }),
        )
        .await;
    let invite = r.body["id"].as_str().unwrap().to_owned();
    let r = w
        .post(
            &format!("/api/t/beta/members/invites/{invite}/revoke"),
            Some(&bob),
            json!({}),
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = w.call("GET", "/api/t/beta/members", Some(&bob), None).await;
    assert!(r.body["invites"].as_array().unwrap().is_empty());
    let emails: Vec<_> = r.body["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["email"].as_str().unwrap())
        .collect();
    assert_eq!(emails, ["bob@beta.org", "cat@alpha.org"]);
}

// ── account ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn changing_your_password_signs_out_your_other_sessions() {
    let w = world();
    let one = w.sign_in("cat@alpha.org").await;
    let two = w.sign_in("cat@alpha.org").await;
    let r = w
        .post(
            "/api/auth/account/password",
            Some(&one),
            json!({ "current": "nope", "new": "a new password" }),
        )
        .await;
    assert_eq!(r.reason(), "invalid_credentials");
    let r = w
        .post(
            "/api/auth/account/password",
            Some(&one),
            json!({ "current": password_of("cat@alpha.org"), "new": "a new password" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        w.call("GET", "/api/me", Some(&one), None).await.status,
        StatusCode::OK
    );
    assert_eq!(
        w.call("GET", "/api/me", Some(&two), None).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn new_recovery_codes_need_step_up() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    let r = w.call("GET", "/api/auth/account", Some(&ann), None).await;
    assert_eq!(r.body["recoveryCodesLeft"], 10);
    assert_eq!(r.body["method"], "totp");
    let r = w
        .post("/api/auth/account/recovery-codes", Some(&ann), json!({}))
        .await;
    assert_eq!(r.body["recoveryCodes"].as_array().unwrap().len(), 10);
    w.age_sign_in(&ann, 2 * 60 * 60 * 1000);
    let r = w
        .post("/api/auth/account/recovery-codes", Some(&ann), json!({}))
        .await;
    assert_eq!(r.kind(), "step_up_required");
}

#[tokio::test]
async fn sign_out_clears_the_cookie_and_the_state_says_so() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    let r = w.call("GET", "/api/auth/state", Some(&ann), None).await;
    assert_eq!(r.body["stage"], "signed_in");
    assert!(r.body["stepUpUntil"].as_i64().unwrap() > contracts::now_ms());
    let r = w.post("/api/auth/sign-out", Some(&ann), json!({})).await;
    assert!(r.set_cookies[0].starts_with("kt_session=;") && r.set_cookies[0].contains("Max-Age=0"));
    assert_eq!(r.body["stage"], "signed_out");
    assert_eq!(
        w.call("GET", "/api/me", Some(&ann), None).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[test]
fn dev_auth_is_refused_where_deployed() {
    assert!(api::auth::dev_auth_refused(Some("prod")));
    assert!(api::auth::dev_auth_refused(Some("staging")));
    assert!(!api::auth::dev_auth_refused(Some("dev")));
    assert!(!api::auth::dev_auth_refused(None));
}

// ── a session read before a change commits (review F1) ────────────────────

fn full_sessions(w: &World, email: &str) -> i64 {
    let user = w.user_id(email);
    w.store
        .platform()
        .with_read(|c| {
            c.query_row(
                "SELECT count(*) FROM auth_sessions WHERE user_id = ?1 AND stage = 'full'",
                [user],
                |r| r.get(0),
            )
        })
        .unwrap()
}

/// Two submits of one emailed code at once: one signs in, the other is
/// refused, and only one full session exists.
#[tokio::test]
async fn a_double_submitted_emailed_code_signs_in_once() {
    let w = world();
    let r = sign_in_password(&w, "val@alpha.org", &password_of("val@alpha.org")).await;
    let partial = r.cookie().unwrap();
    let code = w.emailed_code("val@alpha.org").await;
    let body = json!({ "code": code });
    let (a, b) = tokio::join!(
        w.post("/api/auth/second-factor", Some(&partial), body.clone()),
        w.post("/api/auth/second-factor", Some(&partial), body),
    );
    let ok = [&a, &b]
        .iter()
        .filter(|r| r.status == StatusCode::OK)
        .count();
    assert_eq!(ok, 1, "{} {} / {} {}", a.status, a.body, b.status, b.body);
    assert_eq!(full_sessions(&w, "val@alpha.org"), 1);
}

/// Two enrolment confirms at once: one answers the recovery codes, the
/// other is refused, and the codes it answered are the ones that work.
#[tokio::test]
async fn a_double_enrol_confirm_issues_recovery_codes_once() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    w.post(
        "/api/t/alpha/members/invite",
        Some(&ann),
        json!({ "email": "dd@alpha.org", "role": "staff" }),
    )
    .await;
    let token = w.emailed_token("dd@alpha.org").await;
    let r = w
        .post(
            "/api/auth/invite/accept",
            None,
            json!({ "token": token, "password": "dd's password" }),
        )
        .await;
    let enrol = r.cookie().unwrap();
    let r = w
        .post("/api/auth/enrol/totp", Some(&enrol), json!({}))
        .await;
    let secret = r.body["secret"].as_str().unwrap().to_owned();
    let code = auth::totp::code_at(&secret, authworld::now_secs()).unwrap();
    let body = json!({ "method": "totp", "code": code });
    let (a, b) = tokio::join!(
        w.post("/api/auth/enrol/confirm", Some(&enrol), body.clone()),
        w.post("/api/auth/enrol/confirm", Some(&enrol), body),
    );
    let oks: Vec<_> = [&a, &b]
        .into_iter()
        .filter(|r| r.status == StatusCode::OK)
        .collect();
    assert_eq!(
        oks.len(),
        1,
        "{} {} / {} {}",
        a.status,
        a.body,
        b.status,
        b.body
    );
    assert_eq!(full_sessions(&w, "dd@alpha.org"), 1);
    // The answered codes are live.
    let first = oks[0].body["recoveryCodes"][0].as_str().unwrap().to_owned();
    let r = sign_in_password(&w, "dd@alpha.org", "dd's password").await;
    let r = w
        .post(
            "/api/auth/second-factor",
            Some(&r.cookie().unwrap()),
            json!({ "code": first }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
}

#[tokio::test]
async fn an_invite_lasts_seven_days() {
    let w = world();
    let ann = w.sign_in("ann@alpha.org").await;
    w.post(
        "/api/t/alpha/members/invite",
        Some(&ann),
        json!({ "email": "late@alpha.org", "role": "staff" }),
    )
    .await;
    let token = w.emailed_token("late@alpha.org").await;
    let ttl: i64 = w
        .store
        .platform()
        .with_read(|c| {
            c.query_row(
                "SELECT expires_at - created_at FROM auth_invites",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(ttl, 7 * 24 * 60 * 60 * 1000);
    w.store
        .platform()
        .with_write(|tx| {
            tx.execute(
                "UPDATE auth_invites SET expires_at = ?1",
                [contracts::now_ms()],
            )
        })
        .unwrap();
    let r = w
        .post("/api/auth/invite/check", None, json!({ "token": token }))
        .await;
    assert_eq!(r.reason(), "link_expired");
    let r = w
        .post(
            "/api/auth/invite/accept",
            None,
            json!({ "token": token, "password": "too late now" }),
        )
        .await;
    assert_eq!(r.reason(), "link_expired");
    // Still listed (expired), so an admin can send it again.
    let r = w
        .call("GET", "/api/t/alpha/members", Some(&ann), None)
        .await;
    assert_eq!(r.body["invites"][0]["email"], "late@alpha.org");
}
