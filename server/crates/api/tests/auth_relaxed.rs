//! `KEEP_AUTH_POLICY=relaxed` (the preview and local runs): a password
//! alone signs in unless the user enrolled a second factor, there is no
//! step-up, and any non-empty password is accepted. Everything else
//! (invite-only, roles, tenancy) is as strict. The strict side of each
//! rule is pinned in `auth.rs`; the boot refusal in `api::auth::boot`.

mod authworld;

use authworld::{World, password_of, world, world_relaxed};
use axum::http::StatusCode;
use serde_json::json;
use store::Role;

/// Sign in with the password alone: `(response, cookie)`.
async fn password_only(w: &World, email: &str) -> (authworld::Res, Option<String>) {
    let r = w
        .post(
            "/api/auth/sign-in",
            None,
            json!({ "email": email, "password": password_of(email) }),
        )
        .await;
    let cookie = r.cookie();
    (r, cookie)
}

#[tokio::test]
async fn relaxed_signs_in_without_a_second_factor() {
    let w = world_relaxed();
    w.add_password_only("pat@alpha.org", &w.alpha, Role::Admin);
    let (r, cookie) = password_only(&w, "pat@alpha.org").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["stage"], "signed_in");
    assert_eq!(r.body["policy"], "relaxed");
    let cookie = cookie.unwrap();
    let me = w.call("GET", "/api/me", Some(&cookie), None).await;
    assert_eq!(me.status, StatusCode::OK, "{}", me.body);
    assert_eq!(me.body["authPolicy"], "relaxed");
    let boot = w
        .call("GET", "/api/t/alpha/boot", Some(&cookie), None)
        .await;
    assert_eq!(boot.body["me"]["authPolicy"], "relaxed");
    let out = w.call("GET", "/api/auth/state", None, None).await;
    assert_eq!(
        (&out.body["stage"], &out.body["policy"]),
        (&json!("signed_out"), &json!("relaxed"))
    );
}

/// The same user under strict is asked to enrol, and the policy says so.
#[tokio::test]
async fn strict_still_requires_enrolment() {
    let w = world();
    w.add_password_only("pat@alpha.org", &w.alpha, Role::Admin);
    let (r, cookie) = password_only(&w, "pat@alpha.org").await;
    assert_eq!(r.body["stage"], "enrol");
    // Strict answers are as before relaxed existed: no policy field.
    assert!(r.body.get("policy").is_none(), "{}", r.body);
    let me = w.call("GET", "/api/me", Some(&cookie.unwrap()), None).await;
    assert_eq!(me.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn an_enrolled_user_is_still_asked_for_their_factor() {
    let w = world_relaxed();
    for (email, method) in [("ann@alpha.org", "totp"), ("val@alpha.org", "email")] {
        let (r, cookie) = password_only(&w, email).await;
        assert_eq!(r.body["stage"], "second_factor", "{email}");
        assert_eq!(r.body["method"], method);
        let me = w.call("GET", "/api/me", Some(&cookie.unwrap()), None).await;
        assert_eq!(me.status, StatusCode::UNAUTHORIZED, "{email}");
    }
    // ...and gets in with it, as under strict.
    let ann = w.sign_in("ann@alpha.org").await;
    let me = w.call("GET", "/api/me", Some(&ann), None).await;
    assert_eq!(me.status, StatusCode::OK);
}

/// A user signed in by password alone may set up a factor from their
/// account (password, no current code); from then on it is asked for.
#[tokio::test]
async fn a_factor_can_still_be_enrolled_and_is_then_required() {
    let w = world_relaxed();
    w.add_password_only("pat@alpha.org", &w.alpha, Role::Staff);
    let (_, cookie) = password_only(&w, "pat@alpha.org").await;
    let cookie = cookie.unwrap();
    let e = w
        .post("/api/auth/enrol/totp", Some(&cookie), json!({}))
        .await;
    assert_eq!(e.status, StatusCode::OK, "{}", e.body);
    let secret = e.body["secret"].as_str().unwrap().to_owned();
    let code = auth::totp::code_at(&secret, authworld::now_secs()).unwrap();
    let wrong_password = w
        .post(
            "/api/auth/enrol/confirm",
            Some(&cookie),
            json!({ "method": "totp", "code": code, "password": "nope" }),
        )
        .await;
    assert_eq!(wrong_password.reason(), "invalid_credentials");
    let r = w
        .post(
            "/api/auth/enrol/confirm",
            Some(&cookie),
            json!({ "method": "totp", "code": code, "password": password_of("pat@alpha.org") }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["state"]["method"], "totp");
    assert_eq!(r.body["recoveryCodes"].as_array().unwrap().len(), 10);
    let (again, _) = password_only(&w, "pat@alpha.org").await;
    assert_eq!(again.body["stage"], "second_factor");
}

/// No step-up: admin actions work long after the sign-in, where strict
/// answers `step_up_required`.
#[tokio::test]
async fn relaxed_has_no_step_up() {
    for (w, expected) in [
        (world(), StatusCode::FORBIDDEN),
        (world_relaxed(), StatusCode::OK),
    ] {
        let ann = w.sign_in("ann@alpha.org").await;
        w.age_sign_in(&ann, 2 * auth::STEP_UP_MS);
        // Tenant::require_admin
        let prefs = w
            .post(
                "/api/t/alpha/preferences/fields",
                Some(&ann),
                json!({ "staffCanManage": true }),
            )
            .await;
        // members' own admin check
        let invite = w
            .post(
                "/api/t/alpha/members/invite",
                Some(&ann),
                json!({ "email": "new@alpha.org", "role": "staff" }),
            )
            .await;
        // the account's recovery codes
        let codes = w
            .post("/api/auth/account/recovery-codes", Some(&ann), json!({}))
            .await;
        for r in [&prefs, &invite, &codes] {
            assert_eq!(r.status, expected, "{}", r.body);
            if expected == StatusCode::FORBIDDEN {
                assert_eq!(r.kind(), "step_up_required");
            }
        }
    }
}

/// Any non-empty password, on every place one is chosen; hashing as ever.
#[tokio::test]
async fn relaxed_accepts_a_short_password_strict_refuses_it() {
    for (w, ok) in [(world(), false), (world_relaxed(), true)] {
        let ann = w.sign_in("ann@alpha.org").await;
        // An invite for a new address.
        w.post(
            "/api/t/alpha/members/invite",
            Some(&ann),
            json!({ "email": "sam@alpha.org", "role": "staff" }),
        )
        .await;
        let token = w.emailed_token("sam@alpha.org").await;
        let r = w
            .post(
                "/api/auth/invite/accept",
                None,
                json!({ "token": token, "password": "riverside" }),
            )
            .await;
        if ok {
            assert_eq!(r.status, StatusCode::OK, "{}", r.body);
            // No factor needed: the invite signs straight in.
            assert_eq!(r.body["stage"], "signed_in");
            let again = w
                .post(
                    "/api/auth/sign-in",
                    None,
                    json!({ "email": "sam@alpha.org", "password": "riverside" }),
                )
                .await;
            assert_eq!(again.body["stage"], "signed_in", "{}", again.body);
            let hash: String = w
                .store
                .platform()
                .with_read(|c| {
                    c.query_row(
                        "SELECT password_hash FROM auth_credentials a JOIN users u ON u.id = a.user_id WHERE u.email = 'sam@alpha.org'",
                        [],
                        |r| r.get(0),
                    )
                })
                .unwrap();
            assert!(hash.starts_with("$argon2id$"), "{hash}");
        } else {
            assert_eq!(r.kind(), "invalid", "{}", r.body);
        }
        // A password change.
        let r = w
            .post(
                "/api/auth/account/password",
                Some(&ann),
                json!({ "current": password_of("ann@alpha.org"), "new": "abc" }),
            )
            .await;
        assert_eq!(r.status == StatusCode::OK, ok, "{}", r.body);
        // A reset: never an empty password.
        w.post(
            "/api/auth/reset/request",
            None,
            json!({ "email": "cat@alpha.org" }),
        )
        .await;
        let token = w.emailed_token("cat@alpha.org").await;
        let empty = w
            .post(
                "/api/auth/reset/complete",
                None,
                json!({ "token": token, "password": "" }),
            )
            .await;
        assert_eq!(empty.kind(), "invalid", "{}", empty.body);
        let r = w
            .post(
                "/api/auth/reset/complete",
                None,
                json!({ "token": token, "password": "cat" }),
            )
            .await;
        assert_eq!(r.status == StatusCode::OK, ok, "{}", r.body);
    }
}

/// Invite-only and tenancy hold: a password-only member of alpha never
/// reaches beta, and A's ids under B's slug are refused.
#[tokio::test]
async fn relaxed_isolation_is_unaffected() {
    let w = world_relaxed();
    w.add_password_only("pat@alpha.org", &w.alpha, Role::Admin);
    let (_, pat) = password_only(&w, "pat@alpha.org").await;
    let pat = pat.unwrap();
    for path in ["/api/t/beta", "/api/t/beta/boot", "/api/t/beta/members"] {
        let r = w.call("GET", path, Some(&pat), None).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{path}");
    }
    let r = w
        .post(
            "/api/t/beta/members/invite",
            Some(&pat),
            json!({ "email": "x@beta.org", "role": "admin" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    // An alpha contact, then read under beta by beta's admin.
    let made = w
        .post(
            "/api/t/alpha/contacts",
            Some(&pat),
            json!({
                "kind": "individual", "title": "", "firstName": "Ada", "lastName": "Lovelace",
                "nickname": "", "name": "", "isDeceased": false
            }),
        )
        .await;
    assert_eq!(made.status, StatusCode::OK, "{}", made.body);
    let id = made.body["id"].as_str().unwrap();
    let bob = w.sign_in("bob@beta.org").await;
    let r = w
        .call(
            "GET",
            &format!("/api/t/beta/contacts/{id}"),
            Some(&bob),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    // No sign-up: an address nobody invited is a wrong password.
    let r = w
        .post(
            "/api/auth/sign-in",
            None,
            json!({ "email": "stranger@alpha.org", "password": "anything" }),
        )
        .await;
    assert_eq!(r.reason(), "invalid_credentials");
}
