//! B1's routes over HTTP, on the real org schema: the fields admin
//! (save, options, delete, reorder, retire), bulk set, history moments
//! and restore. Tenancy on every route (B never sees A; A's ids under
//! B's slug are 404), who may manage fields, and the response shapes.

mod common;

use axum::http::StatusCode;
use common::{World, person, world};
use serde_json::{Value, json};

struct Field {
    id: String,
    options: Vec<String>,
}

/// "Volunteer status" (individuals) with Active, Lapsed, in alpha.
async fn volunteer(w: &World, cookie: &str) -> Field {
    let (s, f) = w
        .call(
            "POST",
            "/api/t/alpha/fields",
            cookie,
            Some(json!({ "label": "Volunteer status", "appliesTo": ["individual"], "isActive": true })),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{f}");
    let id = f["id"].as_str().unwrap().to_owned();
    let mut options = vec![];
    for label in ["Active", "Lapsed"] {
        // A new option goes at the end, whatever position it names.
        let (s, o) = w
            .call(
                "POST",
                "/api/t/alpha/fields/options",
                cookie,
                Some(json!({ "fieldId": id, "label": label, "position": 0, "isActive": true })),
            )
            .await;
        assert_eq!(s, StatusCode::OK, "{o}");
        options.push(o["id"].as_str().unwrap().to_owned());
    }
    Field { id, options }
}

async fn contact(w: &World, slug: &str, cookie: &str, first: &str) -> String {
    let (s, c) = w
        .call(
            "POST",
            &format!("/api/t/{slug}/contacts"),
            cookie,
            Some(person(first, "Smith")),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{c}");
    c["id"].as_str().unwrap().to_owned()
}

async fn fields(w: &World, slug: &str, cookie: &str) -> Value {
    let (s, f) = w
        .call("GET", &format!("/api/t/{slug}/fields"), cookie, None)
        .await;
    assert_eq!(s, StatusCode::OK);
    f
}

#[tokio::test]
async fn the_fields_admin_answers_its_shapes() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let f = volunteer(&w, &ann).await;
    let list = fields(&w, "alpha", &ann).await;
    assert_eq!(list[0]["retiring"], false);
    assert_eq!(list[0]["deletable"], true);
    let positions: Vec<_> = list[0]["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["position"].as_i64().unwrap())
        .collect();
    assert_eq!(positions, [0, 1]);

    // Reorder: every option named; a partial order is 409 stale.
    let (s, err) = w
        .call(
            "POST",
            &format!("/api/t/alpha/fields/{}/reorder", f.id),
            &ann,
            Some(json!({ "order": [f.options[1]] })),
        )
        .await;
    assert_eq!(
        (s, err["kind"].as_str()),
        (StatusCode::CONFLICT, Some("stale"))
    );
    let (s, out) = w
        .call(
            "POST",
            &format!("/api/t/alpha/fields/{}/reorder", f.id),
            &ann,
            Some(json!({ "order": [f.options[1], f.options[0]] })),
        )
        .await;
    assert_eq!((s, out), (StatusCode::OK, json!({ "moved": 2 })));

    // Delete an option, then the field: stale first, then gone.
    let (s, err) = w
        .call(
            "POST",
            &format!("/api/t/alpha/fields/options/{}/delete", f.options[0]),
            &ann,
            Some(json!({ "expected": 7 })),
        )
        .await;
    assert_eq!(
        (s, err["kind"].as_str()),
        (StatusCode::CONFLICT, Some("stale"))
    );
    let (s, out) = w
        .call(
            "POST",
            &format!("/api/t/alpha/fields/options/{}/delete", f.options[0]),
            &ann,
            Some(json!({ "expected": 1 })),
        )
        .await;
    assert_eq!((s, out), (StatusCode::OK, json!({ "deleted": 1 })));
    let (s, out) = w
        .call(
            "POST",
            &format!("/api/t/alpha/fields/{}/delete", f.id),
            &ann,
            Some(json!({ "expected": 0 })),
        )
        .await;
    assert_eq!((s, out), (StatusCode::OK, json!({ "deleted": 2 })));
    let (s, _) = w
        .call(
            "POST",
            &format!("/api/t/alpha/fields/{}/delete", f.id),
            &ann,
            Some(json!({ "expected": 0 })),
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(fields(&w, "alpha", &ann).await, json!([]));
}

#[tokio::test]
async fn retire_clears_the_values_and_answers_how_many() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let f = volunteer(&w, &ann).await;
    let mut ids = vec![];
    for name in ["Ann", "Bea", "Cat"] {
        ids.push(contact(&w, "alpha", &ann, name).await);
    }
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let (s, out) = w
        .call(
            "POST",
            "/api/t/alpha/contacts/bulk-set-field",
            &ann,
            Some(json!({ "contactIds": refs, "fieldId": f.id, "optionId": f.options[0] })),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{out}");
    assert_eq!(
        (out["changed"].as_i64(), out["skipped"].as_i64()),
        (Some(3), Some(0))
    );
    assert!(out["group"].is_i64());
    // Now used: the field can only be archived or retired.
    let list = fields(&w, "alpha", &ann).await;
    assert_eq!(list[0]["deletable"], false);
    let (s, err) = w
        .call(
            "POST",
            &format!("/api/t/alpha/fields/{}/delete", f.id),
            &ann,
            Some(json!({ "expected": 0 })),
        )
        .await;
    assert_eq!(
        (s, err["reason"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("used"))
    );

    let (s, out) = w
        .call(
            "POST",
            &format!("/api/t/alpha/fields/{}/retire", f.id),
            &ann,
            None,
        )
        .await;
    assert_eq!((s, out), (StatusCode::OK, json!({ "cleared": 3 })));
    assert_eq!(fields(&w, "alpha", &ann).await, json!([]));
    let (_, view) = w
        .call(
            "GET",
            &format!("/api/t/alpha/contacts/{}", ids[0]),
            &ann,
            None,
        )
        .await;
    assert_eq!(view["fields"]["values"], json!([]));
    // History names the retire.
    let (_, h) = w
        .call(
            "GET",
            &format!("/api/t/alpha/contacts/{}/history", ids[0]),
            &ann,
            None,
        )
        .await;
    assert_eq!(
        h["moments"][0]["groupName"],
        "Retire field Volunteer status"
    );
    assert_eq!(
        h["moments"][1]["groupName"],
        "set Volunteer status to Active"
    );
    // Retiring a retired field is refused.
    let (s, err) = w
        .call(
            "POST",
            &format!("/api/t/alpha/fields/{}/retire", f.id),
            &ann,
            None,
        )
        .await;
    assert_eq!(
        (s, err["reason"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("retired_field"))
    );
}

// fields.test.ts › who manages fields: admins; staff only while the switch
// is on; viewers never.
#[tokio::test]
async fn admins_manage_fields_staff_only_with_the_switch_viewers_never() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let sam = w.login("sam@alpha.org").await;
    let val = w.login("val@alpha.org").await;
    let f = volunteer(&w, &ann).await;
    let attempts = |f: &Field| {
        vec![
            // First: the next one adds an option, after which this order
            // no longer names them all.
            (
                format!("/api/t/alpha/fields/{}/reorder", f.id),
                json!({ "order": [f.options[1], f.options[0]] }),
            ),
            (
                "/api/t/alpha/fields".to_owned(),
                json!({ "label": "Newsletter", "appliesTo": ["individual"], "isActive": true }),
            ),
            (
                "/api/t/alpha/fields/options".to_owned(),
                json!({ "fieldId": f.id, "label": "Away", "position": 0, "isActive": true }),
            ),
        ]
    };
    for (path, body) in attempts(&f) {
        for who in [&sam, &val] {
            let (s, _) = w.call("POST", &path, who, Some(body.clone())).await;
            assert_eq!(s, StatusCode::FORBIDDEN, "{path}");
        }
    }
    let (s, _) = w
        .call(
            "POST",
            &format!("/api/t/alpha/fields/{}/retire", f.id),
            &sam,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    // Everyone reads.
    assert_eq!(fields(&w, "alpha", &val).await.as_array().unwrap().len(), 1);

    let (s, _) = w
        .call(
            "POST",
            "/api/t/alpha/preferences/fields",
            &ann,
            Some(json!({ "staffCanManage": true })),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    for (path, body) in attempts(&f) {
        let (s, out) = w.call("POST", &path, &sam, Some(body.clone())).await;
        assert_eq!(s, StatusCode::OK, "{path}: {out}");
        let (s, _) = w.call("POST", &path, &val, Some(body)).await;
        assert_eq!(s, StatusCode::FORBIDDEN, "{path}");
    }
    // Setting values is ordinary editing: staff always, viewers never.
    let c = contact(&w, "alpha", &ann, "Ann").await;
    let body = json!({ "contactIds": [c], "fieldId": f.id, "optionId": f.options[0] });
    let (s, _) = w
        .call(
            "POST",
            "/api/t/alpha/contacts/bulk-set-field",
            &val,
            Some(body.clone()),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, _) = w
        .call(
            "POST",
            "/api/t/alpha/contacts/bulk-set-field",
            &sam,
            Some(body),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
}

#[tokio::test]
async fn every_b1_route_is_scoped_to_the_callers_organisation() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let bob = w.login("bob@beta.org").await;
    let f = volunteer(&w, &ann).await;
    let c = contact(&w, "alpha", &ann, "Ann").await;
    let (_, h) = w
        .call(
            "GET",
            &format!("/api/t/alpha/contacts/{c}/history"),
            &ann,
            None,
        )
        .await;
    let rev = h["moments"][0]["revisionId"].clone();

    // B sees none of A's fields.
    assert_eq!(fields(&w, "beta", &bob).await, json!([]));
    // A's ids under B's slug: 404 (or, where a body names the field,
    // unknown in B's file).
    for (path, body) in [
        (
            format!("/api/t/beta/fields/{}/delete", f.id),
            Some(json!({ "expected": 0 })),
        ),
        (
            format!("/api/t/beta/fields/options/{}/delete", f.options[0]),
            Some(json!({ "expected": 0 })),
        ),
        (
            format!("/api/t/beta/fields/{}/reorder", f.id),
            Some(json!({ "order": f.options })),
        ),
        (format!("/api/t/beta/fields/{}/retire", f.id), None),
        (
            format!("/api/t/beta/contacts/{c}/restore"),
            Some(json!({ "revisionId": rev })),
        ),
        (
            format!("/api/t/beta/contacts/{c}/restore"),
            Some(json!({ "at": 0 })),
        ),
    ] {
        let (s, out) = w.call("POST", &path, &bob, body).await;
        assert_eq!(s, StatusCode::NOT_FOUND, "{path}: {out}");
    }
    let (s, _) = w
        .call(
            "GET",
            &format!("/api/t/beta/contacts/{c}/history"),
            &bob,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    for (path, body) in [
        (
            "/api/t/beta/fields",
            json!({ "id": f.id, "expected": 0, "label": "x", "appliesTo": ["individual"], "isActive": true }),
        ),
        (
            "/api/t/beta/fields/options",
            json!({ "fieldId": f.id, "label": "x", "position": 0, "isActive": true }),
        ),
        (
            "/api/t/beta/fields/options",
            json!({ "id": f.options[0], "expected": 0, "fieldId": f.id, "label": "x", "position": 0, "isActive": true }),
        ),
        (
            "/api/t/beta/contacts/bulk-set-field",
            json!({ "contactIds": [c], "fieldId": f.id, "optionId": null }),
        ),
    ] {
        let (s, out) = w.call("POST", path, &bob, Some(body)).await;
        assert!(
            s == StatusCode::NOT_FOUND || s == StatusCode::UNPROCESSABLE_ENTITY,
            "{path}: {s} {out}"
        );
    }
    // Under another org's slug, or an unknown one: 403, as every route.
    for path in [
        format!("/api/t/beta/fields/{}/retire", f.id),
        "/api/t/nowhere/contacts/bulk-set-field".to_owned(),
    ] {
        let (s, _) = w.call("POST", &path, &ann, Some(json!({}))).await;
        assert_eq!(s, StatusCode::FORBIDDEN, "{path}");
    }
    // And A is untouched.
    let list = fields(&w, "alpha", &ann).await;
    assert_eq!(list[0]["label"], "Volunteer status");
    assert_eq!(list[0]["options"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn restore_to_here_answers_what_ran_and_what_it_left() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let f = volunteer(&w, &ann).await;
    let c = contact(&w, "alpha", &ann, "Ann").await;
    let save = |option: &str| json!({ "fields": { "expected": 0, "values": [{ "fieldId": f.id, "optionId": option }] } });
    let (s, out) = w
        .call(
            "POST",
            &format!("/api/t/alpha/contacts/{c}/save"),
            &ann,
            Some(save(&f.options[0])),
        )
        .await;
    assert_eq!((s, &out["saved"]), (StatusCode::OK, &json!(["fields"])));
    let (_, h) = w
        .call(
            "GET",
            &format!("/api/t/alpha/contacts/{c}/history"),
            &ann,
            None,
        )
        .await;
    let set = h["moments"][0]["revisionId"].clone();
    // Clear it through the bulk route, then restore the set.
    w.call(
        "POST",
        "/api/t/alpha/contacts/bulk-set-field",
        &ann,
        Some(json!({ "contactIds": [c], "fieldId": f.id, "optionId": null })),
    )
    .await;
    let (s, out) = w
        .call(
            "POST",
            &format!("/api/t/alpha/contacts/{c}/restore"),
            &ann,
            Some(json!({ "revisionId": set })),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{out}");
    assert_eq!(out["restored"], json!(["contacts.fields"]));
    assert_eq!(out["skippedFields"], json!([]));
    assert_eq!(out["view"]["fields"]["values"][0]["optionId"], f.options[0]);
}

#[tokio::test]
async fn the_field_retire_job_finishes_a_retire_left_part_way() {
    use api::jobs::Job;
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let f = volunteer(&w, &ann).await;
    let c = contact(&w, "alpha", &ann, "Ann").await;
    w.call(
        "POST",
        "/api/t/alpha/contacts/bulk-set-field",
        &ann,
        Some(json!({ "contactIds": [c], "fieldId": f.id, "optionId": f.options[0] })),
    )
    .await;
    // The server stopped right after the retire started (as user 1).
    let db = w.store.org(&w.alpha.id).unwrap();
    contracts::transact(&db, Some(1), |ctx| {
        contacts::fields::retire_start(ctx, &f.id, contracts::Source::Ui)
    })
    .unwrap();
    assert_eq!(fields(&w, "alpha", &ann).await[0]["retiring"], true);

    let job = api::routes::fields::FieldRetire(w.store.clone());
    assert_eq!(job.name(), "field-retire");
    job.run().await.unwrap();
    assert_eq!(fields(&w, "alpha", &ann).await, json!([]));
    let (_, h) = w
        .call(
            "GET",
            &format!("/api/t/alpha/contacts/{c}/history"),
            &ann,
            None,
        )
        .await;
    assert_eq!(
        h["moments"][0]["groupName"],
        "Retire field Volunteer status"
    );
    assert_eq!(h["moments"][0]["actor"], 1, "as whoever started it");
    // Nothing left: a second run changes nothing.
    job.run().await.unwrap();
}
