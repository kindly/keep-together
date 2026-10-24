//! codex C1 #8: stored text is bounded in width, not only in row count,
//! so no read (a contact, the list, the identifier types) can be made
//! huge by what staff typed. At the limit saves; one character over is
//! refused (422, or a form problem for a form slice) and stores nothing.

mod common;

use axum::http::StatusCode;
use common::{person, world};
use serde_json::json;

fn chars(n: usize) -> String {
    // Multi-byte: limits count characters, not bytes.
    "é".repeat(n)
}

#[tokio::test]
async fn names_labels_and_child_values_are_bounded() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;

    // A contact's name parts: 200.
    let (s, c) = w
        .call(
            "POST",
            "/api/t/alpha/contacts",
            &ann,
            Some(person(&chars(200), "Smith")),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{c}");
    let id = c["id"].as_str().unwrap().to_owned();
    let (s, e) = w
        .call(
            "POST",
            "/api/t/alpha/contacts",
            &ann,
            Some(person("Ann", &chars(201))),
        )
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{e}");

    // An identifier type's name: 200.
    let (s, e) = w
        .call(
            "POST",
            "/api/t/alpha/identifier-types",
            &ann,
            Some(json!({ "name": chars(201), "isActive": true })),
        )
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{e}");
    let (s, t) = w
        .call(
            "POST",
            "/api/t/alpha/identifier-types",
            &ann,
            Some(json!({ "name": chars(200), "isActive": true })),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{t}");

    // Relationship labels: 200.
    let (s, e) = w
        .call(
            "POST",
            "/api/t/alpha/relationship-types",
            &ann,
            Some(json!({ "labelAB": chars(201), "labelBA": "Employer of", "kindA": "individual", "kindB": "organization", "isActive": true })),
        )
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{e}");

    // The form's slices: refused as problems, the rest saved.
    let save = |emails: serde_json::Value, line1: String| {
        json!({
            "methods": { "expected": 0, "emails": emails, "phones": [] },
            "addresses": { "expected": 0, "addresses": [{
                "label": "home", "line1": line1, "line2": "", "line3": "",
                "town": "Leeds", "postcode": "LS1 1AA", "country": "GB", "isPrimary": true
            }] },
        })
    };
    let long_email = format!("{}@x.org", "a".repeat(249)); // 255
    let (s, r) = w
        .call(
            "POST",
            &format!("/api/t/alpha/contacts/{id}/save"),
            &ann,
            Some(save(
                json!([{ "label": "home", "address": long_email, "isPrimary": true }]),
                chars(201),
            )),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{r}");
    assert!(r["problems"]["methods"].is_array(), "{r}");
    assert!(r["problems"]["addresses"].is_array(), "{r}");
    assert_eq!(r["saved"], json!([]));
    let ok_email = format!("{}@x.org", "a".repeat(248)); // 254
    let (s, r) = w
        .call(
            "POST",
            &format!("/api/t/alpha/contacts/{id}/save"),
            &ann,
            Some(save(
                json!([{ "label": "home", "address": ok_email, "isPrimary": true }]),
                chars(200),
            )),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{r}");
    assert_eq!(r["saved"], json!(["methods", "addresses"]), "{r}");

    // B's org never sees A's contact: A's id under B's slug is 404.
    let bob = w.login("bob@beta.org").await;
    let (s, _) = w
        .call("GET", &format!("/api/t/beta/contacts/{id}"), &bob, None)
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}
