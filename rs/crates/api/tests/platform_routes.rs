//! `/api/groups` (`mine`, `opened`) and `/api/t/{slug}/preferences`: the
//! ports of `convex/platform/tenants.test.ts` (opened) and
//! `preferences.test.ts` (the switches through the API), each under two
//! organisations.

mod common;

use axum::http::StatusCode;
use common::{World, world};
use serde_json::{Value, json};
use store::Role;

/// Ann (alpha admin) also joins beta as a viewer: two groups.
async fn two_groups(w: &World) -> String {
    let p = w.store.platform();
    p.set_membership(
        p.upsert_user("ann@alpha.org").unwrap(),
        &w.beta.id,
        Role::Viewer,
    )
    .unwrap();
    w.login("ann@alpha.org").await
}

fn by_slug<'a>(groups: &'a Value, slug: &str) -> &'a Value {
    groups
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["slug"] == slug)
        .unwrap_or_else(|| panic!("{slug} in {groups}"))
}

async fn last_used(w: &World, cookie: &str) -> (Value, Value) {
    let (s, groups) = w.call("GET", "/api/groups", cookie, None).await;
    assert_eq!(s, StatusCode::OK);
    (
        by_slug(&groups, "alpha")["lastUsedAt"].clone(),
        by_slug(&groups, "beta")["lastUsedAt"].clone(),
    )
}

#[tokio::test]
async fn mine_lists_only_the_callers_groups_with_role_and_switches() {
    let w = world();
    let bob = w.login("bob@beta.org").await;
    let (s, groups) = w.call("GET", "/api/groups", &bob, None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        groups,
        json!([{
            "slug": "beta", "name": "Beta", "role": "admin", "lastUsedAt": null,
            "staffCanManageIdentifierTypes": false, "identifierTypesVersion": null,
            "staffCanManageSourceCodes": false, "sourceCodesVersion": null,
            "staffCanManageFields": false, "fieldsVersion": null,
            "canManageIdentifierTypes": true, "canManageSourceCodes": true,
            "canManageFields": true,
        }])
    );
    let sam = w.login("sam@alpha.org").await;
    let (_, groups) = w.call("GET", "/api/groups", &sam, None).await;
    assert_eq!(groups.as_array().unwrap().len(), 1);
    assert_eq!(groups[0]["slug"], "alpha");
    assert_eq!(groups[0]["role"], "staff");
    assert_eq!(groups[0]["canManageFields"], false);

    // A user in no group: an empty list, not an error.
    let nobody = w.login("nobody@x.org").await;
    assert_eq!(
        w.call("GET", "/api/groups", &nobody, None).await,
        (StatusCode::OK, json!([]))
    );
}

#[tokio::test]
async fn signed_out_is_refused() {
    let w = world();
    let (s, body) = w.call("GET", "/api/groups", "kt_session=nope", None).await;
    assert_eq!(
        (s, &body["kind"]),
        (StatusCode::UNAUTHORIZED, &json!("unauthenticated"))
    );
    let (s, body) = w
        .call("POST", "/api/groups/alpha/opened", "kt_session=nope", None)
        .await;
    assert_eq!(
        (s, &body["kind"]),
        (StatusCode::UNAUTHORIZED, &json!("unauthenticated"))
    );
}

#[tokio::test]
async fn opened_one_group_writes_nothing() {
    let w = world();
    let bob = w.login("bob@beta.org").await;
    let (s, body) = w.call("POST", "/api/groups/beta/opened", &bob, None).await;
    assert_eq!((s, body), (StatusCode::OK, json!({ "lastUsedAt": null })));
    let (_, groups) = w.call("GET", "/api/groups", &bob, None).await;
    assert_eq!(groups[0]["lastUsedAt"], Value::Null);
}

#[tokio::test]
async fn opened_the_latest_wins_and_a_repeat_writes_nothing() {
    let w = world();
    let ann = two_groups(&w).await;
    assert_eq!(last_used(&w, &ann).await, (Value::Null, Value::Null));

    // A viewer may record it too: it changes no group data.
    w.call("POST", "/api/groups/beta/opened", &ann, None).await;
    let (alpha, beta) = last_used(&w, &ann).await;
    assert_eq!(alpha, Value::Null);
    let first = beta.as_i64().unwrap();

    // Already the last used: nothing recorded.
    let (_, body) = w.call("POST", "/api/groups/beta/opened", &ann, None).await;
    assert_eq!(body, json!({ "lastUsedAt": null }));

    // Back to alpha: later than beta, even within the same millisecond.
    w.call("POST", "/api/groups/alpha/opened", &ann, None).await;
    let (alpha, beta) = last_used(&w, &ann).await;
    assert_eq!(beta.as_i64(), Some(first));
    assert!(alpha.as_i64().unwrap() > first);

    // Bob is untouched.
    let bob = w.login("bob@beta.org").await;
    let (_, groups) = w.call("GET", "/api/groups", &bob, None).await;
    assert_eq!(groups[0]["lastUsedAt"], Value::Null);

    // No group's file changed: opened is a platform field.
    for t in [&w.alpha, &w.beta] {
        let revisions: i64 = w
            .store
            .org(&t.id)
            .unwrap()
            .read(|r| r.query_row("SELECT count(*) FROM revisions", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(revisions, 0);
    }
}

#[tokio::test]
async fn opened_trading_the_mark_writes_once_a_minute_at_most() {
    let w = world();
    let ann = two_groups(&w).await;
    w.call("POST", "/api/groups/beta/opened", &ann, None).await;
    w.call("POST", "/api/groups/alpha/opened", &ann, None).await;
    let marks = last_used(&w, &ann).await;
    for _ in 0..5 {
        w.call("POST", "/api/groups/beta/opened", &ann, None).await;
        w.call("POST", "/api/groups/alpha/opened", &ann, None).await;
    }
    assert_eq!(last_used(&w, &ann).await, marks);

    // A minute on, coming back to beta counts again.
    w.store
        .platform()
        .with_write(|tx| {
            tx.execute(
                "UPDATE memberships SET last_used_at = ?1
                 WHERE tenant_id = ?2 AND user_id = (SELECT id FROM users WHERE email = 'ann@alpha.org')",
                rusqlite::params![contracts::now_ms() - 61_000, w.beta.id.as_str()],
            )
        })
        .unwrap();
    w.call("POST", "/api/groups/beta/opened", &ann, None).await;
    let (alpha, beta) = last_used(&w, &ann).await;
    assert!(beta.as_i64().unwrap() > alpha.as_i64().unwrap());
}

/// Isolation for the routes outside `/api/t`: someone else's slug (or an
/// unknown one) is 404, and marks nothing.
#[tokio::test]
async fn opened_on_a_group_one_is_not_in_is_404() {
    let w = world();
    let ann = two_groups(&w).await;
    let bob = w.login("bob@beta.org").await;
    for slug in ["alpha", "nowhere", "ALPHA"] {
        let (s, body) = w
            .call("POST", &format!("/api/groups/{slug}/opened"), &bob, None)
            .await;
        assert_eq!(
            (s, &body["kind"]),
            (StatusCode::NOT_FOUND, &json!("not_found")),
            "{slug}"
        );
    }
    assert_eq!(last_used(&w, &ann).await, (Value::Null, Value::Null));
    // Ann's groups never show bob's view of them, and bob's list holds
    // nothing of alpha's.
    let (_, groups) = w.call("GET", "/api/groups", &bob, None).await;
    assert!(!groups.to_string().contains("alpha"));
}

#[tokio::test]
async fn preferences_only_admins_switch_staff_follow_viewers_never() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let sam = w.login("sam@alpha.org").await;
    let val = w.login("val@alpha.org").await;
    let bob = w.login("bob@beta.org").await;

    let (s, prefs) = w.call("GET", "/api/t/alpha/preferences", &val, None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        prefs["fields"],
        json!({ "staffCanManage": false, "version": null })
    );

    // Staff and viewers can't switch.
    for who in [&sam, &val] {
        let (s, _) = w
            .call(
                "POST",
                "/api/t/alpha/preferences/fields",
                who,
                Some(json!({ "staffCanManage": true })),
            )
            .await;
        assert_eq!(s, StatusCode::FORBIDDEN);
    }
    let (s, out) = w
        .call(
            "POST",
            "/api/t/alpha/preferences/fields",
            &ann,
            Some(json!({ "staffCanManage": true })),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{out}");
    assert_eq!(out["counter"], 0);

    // What it means for each caller, through mine.
    let (_, g) = w.call("GET", "/api/groups", &sam, None).await;
    assert_eq!(
        (
            &g[0]["canManageFields"],
            &g[0]["canManageSourceCodes"],
            &g[0]["fieldsVersion"]
        ),
        (&json!(true), &json!(false), &json!(0))
    );
    let (_, g) = w.call("GET", "/api/groups", &val, None).await;
    assert_eq!(g[0]["canManageFields"], false);
    assert_eq!(g[0]["staffCanManageFields"], true);
    // Beta untouched.
    let (_, prefs) = w.call("GET", "/api/t/beta/preferences", &bob, None).await;
    assert_eq!(prefs["fields"]["staffCanManage"], false);

    // Stale per switch: another switch's save doesn't conflict, a stale
    // one does and carries the current state; none sent once a row exists
    // is stale too.
    let (s, _) = w
        .call(
            "POST",
            "/api/t/alpha/preferences/sourceCodes",
            &ann,
            Some(json!({ "expected": 0, "staffCanManage": true })),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let (s, body) = w
        .call(
            "POST",
            "/api/t/alpha/preferences/fields",
            &ann,
            Some(json!({ "expected": 5, "staffCanManage": false })),
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(body["kind"], "stale");
    assert_eq!(body["contract"], "tenantPreferences.fields");
    assert_eq!(body["counter"], 0);
    assert_eq!(body["current"], json!({ "staffCanManageFields": true }));
    let (s, _) = w
        .call(
            "POST",
            "/api/t/alpha/preferences/identifierTypes",
            &ann,
            Some(json!({ "staffCanManage": true })),
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT);

    // An unknown list.
    let (s, _) = w
        .call(
            "POST",
            "/api/t/alpha/preferences/tags",
            &ann,
            Some(json!({ "staffCanManage": true })),
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn preferences_isolation() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let bob = w.login("bob@beta.org").await;
    // B's slug for A's admin, and A's for B's: refused, nothing written.
    let (s, _) = w.call("GET", "/api/t/beta/preferences", &ann, None).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, _) = w
        .call(
            "POST",
            "/api/t/alpha/preferences/fields",
            &bob,
            Some(json!({ "staffCanManage": true })),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (_, prefs) = w.call("GET", "/api/t/alpha/preferences", &ann, None).await;
    assert_eq!(prefs["fields"]["version"], Value::Null);
}

/// A switch is a contract: its save is an event on the org's stream, so
/// other tabs refetch `mine`.
#[tokio::test]
async fn a_switch_save_is_one_revision_on_its_own_entity() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    w.call(
        "POST",
        "/api/t/alpha/preferences/identifierTypes",
        &ann,
        Some(json!({ "staffCanManage": true })),
    )
    .await;
    let rows: Vec<(String, String)> = w
        .store
        .org(&w.alpha.id)
        .unwrap()
        .read(|r| {
            r.prepare("SELECT entity, contract FROM revisions")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect()
        })
        .unwrap();
    assert_eq!(
        rows,
        vec![(
            "tenant_preferences".to_owned(),
            "tenantPreferences.identifierTypes".to_owned()
        )]
    );
}
