//! One round trip per action: `/boot` on a cold load; create, archive and
//! restore answer with the contact's view; history of an unknown id is 404.

mod common;

use axum::http::StatusCode;
use common::{person, world};
use serde_json::json;

#[tokio::test]
async fn boot_is_everything_a_cold_load_needs_for_one_organisation() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let bob = w.login("bob@beta.org").await;
    let val = w.login("val@alpha.org").await;
    w.call(
        "POST",
        "/api/t/alpha/contacts",
        &ann,
        Some(person("Ann", "Alpha")),
    )
    .await;
    w.call(
        "POST",
        "/api/t/alpha/fields",
        &ann,
        Some(json!({ "label": "Volunteer status", "appliesTo": ["individual"], "isActive": true })),
    )
    .await;
    w.call(
        "POST",
        "/api/t/beta/contacts",
        &bob,
        Some(person("Bob", "Beta")),
    )
    .await;

    let (s, boot) = w.call("GET", "/api/t/alpha/boot", &ann, None).await;
    assert_eq!(s, StatusCode::OK, "{boot}");
    assert_eq!(boot["me"]["email"], "ann@alpha.org");
    assert_eq!(boot["me"]["memberships"][0]["slug"], "alpha");
    assert_eq!(
        boot["org"],
        json!({ "slug": "alpha", "name": "Alpha", "role": "admin" })
    );
    assert_eq!(boot["fields"][0]["label"], "Volunteer status");
    let rows = boot["firstPage"]["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["displayName"], "Ann Alpha");
    // The same as the separate reads.
    let (_, page) = w.call("GET", "/api/t/alpha/contacts", &ann, None).await;
    assert_eq!(boot["firstPage"], page);

    let (s, boot) = w.call("GET", "/api/t/alpha/boot", &val, None).await;
    assert_eq!(
        (s, boot["org"]["role"].as_str()),
        (StatusCode::OK, Some("viewer"))
    );
    // Beta's admin sees beta only, and alpha's boot is the usual 403.
    let (_, boot) = w.call("GET", "/api/t/beta/boot", &bob, None).await;
    assert_eq!(boot["firstPage"]["rows"][0]["displayName"], "Bob Beta");
    assert_eq!(boot["fields"], json!([]));
    let (s, _) = w.call("GET", "/api/t/alpha/boot", &bob, None).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn create_archive_and_restore_answer_with_the_view() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let (s, created) = w
        .call(
            "POST",
            "/api/t/alpha/contacts",
            &ann,
            Some(person("Ann", "Smith")),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap();
    assert_eq!(created["view"]["id"], id);
    assert_eq!(created["view"]["number"], created["number"]);
    assert_eq!(created["view"]["displayName"], "Ann Smith");
    let (_, fetched) = w
        .call("GET", &format!("/api/t/alpha/contacts/{id}"), &ann, None)
        .await;
    assert_eq!(created["view"], fetched);

    let (s, archived) = w
        .call(
            "POST",
            &format!("/api/t/alpha/contacts/{id}/archive"),
            &ann,
            Some(json!({ "expected": 0, "archived": true })),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{archived}");
    assert_eq!(
        (archived["id"].as_str(), archived["counter"].as_i64()),
        (Some(id), Some(1))
    );
    assert_eq!(archived["view"]["archived"], true);

    let mut annie = person("Annie", "Smith");
    annie["expected"] = json!(0);
    let (s, saved) = w
        .call(
            "POST",
            &format!("/api/t/alpha/contacts/{id}/save"),
            &ann,
            Some(json!({ "details": annie })),
        )
        .await;
    assert_eq!(
        (s, &saved["saved"]),
        (StatusCode::OK, &json!(["details"])),
        "{saved}"
    );
    let (_, history) = w
        .call(
            "GET",
            &format!("/api/t/alpha/contacts/{id}/history"),
            &ann,
            None,
        )
        .await;
    let created_rev = history["revisions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["contract"] == "contacts.details" && r["counter"] == 0)
        .unwrap()["id"]
        .clone();
    let (s, restored) = w
        .call(
            "POST",
            &format!("/api/t/alpha/contacts/{id}/restore"),
            &ann,
            Some(json!({ "revisionId": created_rev })),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{restored}");
    assert_eq!(restored["restored"], json!(["contacts.details"]));
    assert_eq!(restored["view"]["displayName"], "Ann Smith");
}

#[tokio::test]
async fn history_of_an_unknown_id_is_not_found() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let bob = w.login("bob@beta.org").await;
    let (_, theirs) = w
        .call(
            "POST",
            "/api/t/beta/contacts",
            &bob,
            Some(person("Bob", "Beta")),
        )
        .await;
    let theirs = theirs["id"].as_str().unwrap();
    for id in [contracts::new_id().as_str(), theirs] {
        let (s, body) = w
            .call(
                "GET",
                &format!("/api/t/alpha/contacts/{id}/history"),
                &ann,
                None,
            )
            .await;
        assert_eq!(
            (s, body["kind"].as_str()),
            (StatusCode::NOT_FOUND, Some("not_found"))
        );
    }
}
