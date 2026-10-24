//! Roles as a route-table meta-test (`convex/lib/roles.test.ts`, "every
//! public mutation and action rejects a viewer"): every write route under
//! `/api/t/{slug}` refuses a viewer with 403 `forbidden`, whatever its
//! body. The route table is read from `src/routes/` (subdirectories
//! included), so a route added later is covered without editing the
//! viewer test; the table itself is pinned, so a new GET is looked at.

mod common;

use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use common::world;
use serde_json::json;

/// `(method, path)` of every method a `.route("…", …)` registers in a
/// routes file.
fn routes_in(text: &str) -> Vec<(&'static str, String)> {
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
            ("GET", "get("),
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

/// The write routes (non-GET) in a routes file.
fn write_routes(text: &str) -> Vec<(&'static str, String)> {
    routes_in(text)
        .into_iter()
        .filter(|(m, _)| *m != "GET")
        .collect()
}

/// Every `.rs` under `dir`, subdirectories included.
fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|x| x == "rs") {
            out.push(path);
        }
    }
}

fn route_files() -> Vec<(PathBuf, String)> {
    let mut files = vec![];
    sources(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src/routes"),
        &mut files,
    );
    // The members page's routes are tenant routes too (auth owns them).
    files.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/auth/members.rs"));
    files.sort();
    files
        .into_iter()
        .map(|f| {
            let text = std::fs::read_to_string(&f).unwrap();
            (f, text)
        })
        .collect()
}

fn table() -> Vec<(&'static str, String)> {
    route_files()
        .iter()
        .flat_map(|(_, text)| write_routes(text))
        .collect()
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
    assert_eq!(routes_in(src).len(), 4);
}

/// The viewer guard is method-based (a viewer's GET passes), so a GET
/// must never write. The route table is pinned here: a new route, or a
/// method changing, fails this test until it is added below, which is the
/// moment to check that a new GET only reads (rs/README.md, "no writes on
/// GET"). Routes are only ever registered as `.route(…, get/post…)` in
/// `src/routes/` (and the members page's in `src/auth/members.rs`), the
/// form the table is read from.
#[test]
fn the_route_table_is_pinned_and_read_only_on_get() {
    let mut all: Vec<String> = route_files()
        .iter()
        .flat_map(|(_, text)| routes_in(text))
        .map(|(m, p)| format!("{m} {p}"))
        .collect();
    all.sort();
    assert_eq!(
        all,
        [
            "GET /contacts",
            "GET /contacts/by-client-key/{key}",
            "GET /contacts/search",
            "GET /contacts/{id}",
            "GET /contacts/{id}/donor",
            "GET /contacts/{id}/email-context",
            "GET /contacts/{id}/giftaid",
            "GET /contacts/{id}/gifts",
            "GET /contacts/{id}/history",
            "GET /contacts/{id}/notes",
            "GET /contacts/{id}/notes/archived",
            "GET /contacts/{id}/relationships",
            "GET /fields",
            "GET /gifts/recent",
            "GET /gifts/{id}",
            "GET /gifts/{id}/history",
            "GET /identifier-types",
            "GET /members",
            "GET /preferences",
            "GET /relationship-types",
            "GET /sources",
            "GET /sources/filter-options",
            "GET /sources/picker",
            "GET /sources/{id}",
            "POST /comms/release",
            "POST /contacts",
            "POST /contacts/{id}/acquisition",
            "POST /contacts/{id}/archive",
            "POST /contacts/{id}/giftaid/cancel",
            "POST /contacts/{id}/restore",
            "POST /contacts/{id}/save",
            "POST /fields",
            "POST /fields/options",
            "POST /giftaid/{id}/void",
            "POST /gifts/record",
            "POST /gifts/{id}/save",
            "POST /gifts/{id}/status",
            "POST /identifier-types",
            "POST /members/invite",
            "POST /members/invites/{id}/revoke",
            "POST /members/{id}/remove",
            "POST /members/{id}/reset-2fa",
            "POST /members/{id}/role",
            "POST /notes",
            "POST /notes/{id}/archive",
            "POST /notes/{id}/pin",
            "POST /notes/{id}/restore",
            "POST /notes/{id}/save",
            "POST /preferences/{kind}",
            "POST /relationship-types",
            "POST /relationships",
            "POST /sources",
            "POST /sources/{id}/delete",
            "POST /sources/{id}/save",
        ],
        "the route table changed: check any new GET only reads, then update this list"
    );
    for (file, text) in route_files() {
        for word in [
            ".nest(",
            ".route_service(",
            ".fallback(",
            "any(",
            "on(MethodFilter",
        ] {
            assert!(
                !text.contains(word),
                "{}: a route registered with {word} escapes the route table",
                file.display()
            );
        }
    }
}

#[tokio::test]
async fn every_write_route_refuses_a_viewer_and_the_role_is_the_reason() {
    let routes = table();
    assert!(!routes.is_empty());
    let w = world();
    let val = w.login("val@alpha.org").await;
    let ann = w.login("ann@alpha.org").await;
    for (method, path) in &routes {
        let url = format!("/api/t/alpha{}", fill(path));
        // Any body: none, and one that is well-formed for nothing in
        // particular. The viewer is refused before either is read.
        for body in [None, Some(json!({}))] {
            let (s, out) = w.call(method, &url, &val, body).await;
            assert_eq!(
                (s, &out["kind"]),
                (StatusCode::FORBIDDEN, &json!("forbidden")),
                "viewer {method} {url}"
            );
        }
        // The same request from an admin reaches the handler: not refused
        // for the role (403), and the path exists. With no body, a write
        // that takes one answers 422 before it looks anything up; one that
        // takes none (a member's remove) looks up the placeholder id and
        // answers the handler's JSON `not_found`, never axum's bodiless
        // no-such-route 404.
        let (s, out) = w.call(method, &url, &ann, None).await;
        let looks_up_an_id = path.contains('{');
        assert!(
            s != StatusCode::FORBIDDEN
                && (s != StatusCode::NOT_FOUND || (looks_up_an_id && out["kind"] == "not_found")),
            "admin {method} {url}: {s} {out}"
        );
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
