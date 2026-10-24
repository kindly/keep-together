//! Roles as a route-table meta-test (`convex/lib/roles.test.ts`, "every
//! public mutation and action rejects a viewer"): every write route under
//! `/api/t/{slug}` refuses a viewer with 403 `forbidden`, whatever its
//! body. The route table is read from `src/routes/*.rs`, so a route added
//! later is covered without editing this file.

mod common;

use std::path::Path;

use axum::http::StatusCode;
use common::world;
use serde_json::json;

/// `(method, path)` of every `.route("…", …)` in a routes file whose
/// handler chain has a non-GET method.
fn write_routes(text: &str) -> Vec<(&'static str, String)> {
    let mut out = vec![];
    let mut rest = text;
    while let Some(i) = rest.find(".route(") {
        rest = &rest[i + ".route(".len()..];
        // The call's text up to its matching `)`.
        let mut depth = 1;
        let mut end = 0;
        for (j, c) in rest.char_indices() {
            match c {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = j;
                        break;
                    }
                }
                _ => {}
            }
        }
        let call = &rest[..end];
        let Some(path) = call.split('"').nth(1) else {
            continue;
        };
        for (method, word) in [
            ("POST", "post("),
            ("PUT", "put("),
            ("PATCH", "patch("),
            ("DELETE", "delete("),
        ] {
            if call.contains(word) {
                out.push((method, path.to_owned()));
            }
        }
    }
    out
}

fn table() -> Vec<(&'static str, String)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/routes");
    let mut all = vec![];
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "rs"))
        .collect();
    files.sort();
    for file in files {
        all.extend(write_routes(&std::fs::read_to_string(file).unwrap()));
    }
    all
}

/// A path parameter's stand-in: a well-formed id, or a known list kind.
fn fill(path: &str) -> String {
    path.split('/')
        .map(|seg| match seg {
            "{kind}" => "fields".to_owned(),
            s if s.starts_with('{') => "0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0".to_owned(),
            s => s.to_owned(),
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[test]
fn the_route_table_parser_finds_chained_and_single_writes() {
    let src = r#"
        Router::new()
            .route("/fields", get(list).post(save_field))
            .route("/fields/options", post(save_option))
            .route("/contacts/{id}", get(one))
    "#;
    assert_eq!(
        write_routes(src),
        vec![
            ("POST", "/fields".to_owned()),
            ("POST", "/fields/options".to_owned())
        ]
    );
}

#[tokio::test]
async fn every_write_route_refuses_a_viewer_and_the_role_is_the_reason() {
    let routes = table();
    // The ones that exist today, so the parser can't silently find none.
    for known in [
        "/contacts",
        "/contacts/{id}/save",
        "/fields",
        "/preferences/{kind}",
    ] {
        assert!(
            routes.iter().any(|(_, p)| p == known),
            "{known} not in {routes:?}"
        );
    }
    let w = world();
    let val = w.login("val@alpha.org").await;
    let ann = w.login("ann@alpha.org").await;
    for (method, path) in &routes {
        let url = format!("/api/t/alpha{}", fill(path));
        // Any body: an empty one, and one that would be well-formed for
        // nothing in particular. The viewer is refused before either is read.
        for body in [None, Some(json!({}))] {
            let (s, out) = w.call(method, &url, &val, body.clone()).await;
            assert_eq!(
                (s, &out["kind"]),
                (StatusCode::FORBIDDEN, &json!("forbidden")),
                "viewer {method} {url}"
            );
            // The same request from an admin isn't refused for the role:
            // whatever else it answers, it isn't 403.
            let (s, _) = w.call(method, &url, &ann, body).await;
            assert_ne!(s, StatusCode::FORBIDDEN, "admin {method} {url}");
        }
    }
}

/// `minRole` per tenant (`roles.test.ts`): a role in one organisation
/// carries nowhere else. Val, a viewer of alpha, gets nothing at beta;
/// bob, beta's admin, can't write at alpha.
#[tokio::test]
async fn a_role_is_per_organisation() {
    let w = world();
    let val = w.login("val@alpha.org").await;
    let bob = w.login("bob@beta.org").await;
    let (s, _) = w.call("GET", "/api/t/alpha/contacts", &val, None).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = w.call("GET", "/api/t/beta/contacts", &val, None).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, _) = w
        .call(
            "POST",
            "/api/t/alpha/contacts",
            &bob,
            Some(common::person("Ada", "Lovelace")),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
}
