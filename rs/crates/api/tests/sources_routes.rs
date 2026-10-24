//! The source-code routes and a contact's acquisition over HTTP, on the
//! real org schema: tenancy on every route (B never sees A; A's ids under
//! B's slug are 404), who may manage the list, and the response shapes.

mod common;

use axum::http::StatusCode;
use common::{World, person, world};
use serde_json::{Value, json};
use store::Role;

const TODAY: &str = "2026-10-19";

struct Codes {
    category: String,
    detail: String,
    version: String,
}

/// Street → Wesser (→ 001) in alpha, as its admin.
async fn street(w: &World, ann: &str) -> Codes {
    let (s, cat) = w
        .call(
            "POST",
            "/api/t/alpha/sources",
            ann,
            Some(json!({ "name": "Street", "isActive": true })),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{cat}");
    assert!(cat.get("versionId").is_none(), "a category has no version");
    let category = cat["id"].as_str().unwrap().to_owned();
    let (s, made) = w
        .call(
            "POST",
            "/api/t/alpha/sources",
            ann,
            Some(json!({ "parentId": category, "name": "Wesser", "isActive": true })),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{made}");
    Codes {
        category,
        detail: made["id"].as_str().unwrap().to_owned(),
        version: made["versionId"].as_str().unwrap().to_owned(),
    }
}

async fn contact(w: &World, slug: &str, cookie: &str) -> String {
    let (s, c) = w
        .call(
            "POST",
            &format!("/api/t/{slug}/contacts"),
            cookie,
            Some(person("Ada", "Lovelace")),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{c}");
    c["id"].as_str().unwrap().to_owned()
}

fn part<'a>(tree: &'a Value, id: &str) -> &'a Value {
    tree["parts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == id)
        .unwrap()
}

#[tokio::test]
async fn the_tree_picker_describe_and_filter_options_answer_their_shapes() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let c = street(&w, &ann).await;

    let (s, tree) = w.call("GET", "/api/t/alpha/sources", &ann, None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(tree["canManage"], true);
    let codes: Vec<_> = tree["parts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["level"].as_str().unwrap(), p["code"].as_str().unwrap()))
        .collect();
    assert_eq!(
        codes,
        [
            ("category", "Street"),
            ("detail", "Street-Wesser"),
            ("version", "Street-Wesser-001")
        ]
    );
    let v = part(&tree, &c.version);
    assert_eq!(
        (&v["used"], &v["visible"], &v["saveVersion"], &v["parentId"]),
        (&json!(false), &json!(true), &json!(0), &json!(c.detail))
    );

    let (s, picked) = w
        .call(
            "GET",
            &format!("/api/t/alpha/sources/picker?today={TODAY}&search=wess"),
            &ann,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        picked,
        json!({
            "codes": [{ "versionId": c.version, "code": "Street-Wesser-001", "status": "current" }],
            "truncated": false
        })
    );
    // `today` is required.
    let (s, _) = w
        .call("GET", "/api/t/alpha/sources/picker", &ann, None)
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);

    let (s, d) = w
        .call(
            "GET",
            &format!("/api/t/alpha/sources/{}", c.version),
            &ann,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(d["code"], "Street-Wesser-001");
    assert_eq!(d["categoryId"], json!(c.category));
    // Only a version describes.
    let (s, _) = w
        .call(
            "GET",
            &format!("/api/t/alpha/sources/{}", c.detail),
            &ann,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    let (s, options) = w
        .call("GET", "/api/t/alpha/sources/filter-options", &ann, None)
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        options[1],
        json!({ "id": c.detail, "level": "detail", "parentId": c.category,
                "name": "Wesser", "isActive": true })
    );
}

#[tokio::test]
async fn save_and_delete_answer_counters_stale_and_used() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let c = street(&w, &ann).await;

    let save =
        |expected: i64, name: &str| json!({ "expected": expected, "name": name, "isActive": true });
    let path = format!("/api/t/alpha/sources/{}/save", c.detail);
    let (s, done) = w.call("POST", &path, &ann, Some(save(0, "Wessex"))).await;
    assert_eq!(
        (s, &done),
        (StatusCode::OK, &json!({ "id": c.detail, "counter": 1 }))
    );
    let (s, stale) = w.call("POST", &path, &ann, Some(save(0, "Other"))).await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(
        (
            &stale["kind"],
            &stale["contract"],
            &stale["counter"],
            &stale["current"]["name"]
        ),
        (
            &json!("stale"),
            &json!("sources.code"),
            &json!(1),
            &json!("Wessex")
        )
    );
    let (s, dup) = w
        .call(
            "POST",
            "/api/t/alpha/sources",
            &ann,
            Some(json!({ "name": "street", "isActive": true })),
        )
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(dup["reason"], "duplicate_source_name");

    // Used once (a contact's acquisition): only archive.
    let ada = contact(&w, "alpha", &ann).await;
    let (s, _) = w
        .call(
            "POST",
            &format!("/api/t/alpha/contacts/{ada}/acquisition"),
            &ann,
            Some(json!({ "expected": 0, "codeId": c.version })),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let (s, refused) = w
        .call(
            "POST",
            &format!("/api/t/alpha/sources/{}/delete", c.category),
            &ann,
            Some(json!({ "expected": 0 })),
        )
        .await;
    assert_eq!(
        (s, &refused["reason"]),
        (StatusCode::UNPROCESSABLE_ENTITY, &json!("used"))
    );

    let (_, other) = w
        .call(
            "POST",
            "/api/t/alpha/sources",
            &ann,
            Some(json!({ "name": "Online", "isActive": true })),
        )
        .await;
    let other = other["id"].as_str().unwrap();
    let del = format!("/api/t/alpha/sources/{other}/delete");
    let (s, gone) = w
        .call("POST", &del, &ann, Some(json!({ "expected": 0 })))
        .await;
    assert_eq!((s, gone), (StatusCode::OK, json!({ "deleted": 1 })));
    let (s, _) = w
        .call("POST", &del, &ann, Some(json!({ "expected": 0 })))
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

// sources.test.ts › list management › admins always; staff only with the
// switch; viewers never; per tenant. The switch is A3's
// (`tenantPreferences.sourceCodes`); until it merges staff are refused,
// as with the switch off.
#[tokio::test]
async fn admins_manage_staff_and_viewers_only_read_and_assign() {
    let w = world();
    let p = w.store.platform();
    p.set_membership(
        p.upsert_user("sam@alpha.org").unwrap(),
        &w.alpha.id,
        Role::Staff,
    )
    .unwrap();
    let ann = w.login("ann@alpha.org").await;
    let sam = w.login("sam@alpha.org").await;
    let val = w.login("val@alpha.org").await;
    let c = street(&w, &ann).await;
    let writes = |expected: i64| {
        [
            (
                "/api/t/alpha/sources".to_owned(),
                json!({ "parentId": c.detail, "name": "002", "isActive": true }),
            ),
            (
                format!("/api/t/alpha/sources/{}/save", c.detail),
                json!({ "expected": expected, "name": "X", "isActive": true }),
            ),
            (
                format!("/api/t/alpha/sources/{}/delete", c.detail),
                json!({ "expected": expected }),
            ),
        ]
    };
    for who in [&sam, &val] {
        for (path, body) in writes(0) {
            let (s, e) = w.call("POST", &path, who, Some(body)).await;
            assert_eq!(
                (s, &e["kind"]),
                (StatusCode::FORBIDDEN, &json!("forbidden")),
                "{path}"
            );
        }
        // Both read the tree, which says they can't manage it.
        let (s, tree) = w.call("GET", "/api/t/alpha/sources", who, None).await;
        assert_eq!((s, &tree["canManage"]), (StatusCode::OK, &json!(false)));
    }
    // Staff assign codes (ordinary editing); viewers don't.
    let ada = contact(&w, "alpha", &ann).await;
    let set = format!("/api/t/alpha/contacts/{ada}/acquisition");
    let (s, _) = w
        .call(
            "POST",
            &set,
            &val,
            Some(json!({ "expected": 0, "codeId": c.version })),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, done) = w
        .call(
            "POST",
            &set,
            &sam,
            Some(json!({ "expected": 0, "codeId": c.version })),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(done["counter"], 1);
    assert_eq!(done["view"]["acquisition"]["code"], "Street-Wesser-001");
    assert_eq!(done["view"]["counters"]["acquisition"], 1);
}

#[tokio::test]
async fn a_new_contact_takes_its_code_in_the_create() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let c = street(&w, &ann).await;
    let mut body = person("Bea", "Lovelace");
    body["acquisitionCodeId"] = json!(c.version);
    let (s, made) = w
        .call("POST", "/api/t/alpha/contacts", &ann, Some(body))
        .await;
    assert_eq!(s, StatusCode::OK, "{made}");
    assert_eq!(made["view"]["acquisition"]["code"], "Street-Wesser-001");
    // A refused code refuses the create.
    let mut body = person("Cy", "Lovelace");
    body["acquisitionCodeId"] = json!(c.detail);
    let (s, e) = w
        .call("POST", "/api/t/alpha/contacts", &ann, Some(body))
        .await;
    assert_eq!(
        (s, &e["reason"]),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            &json!("unknown_source_code")
        )
    );
    // The list filters by it.
    let (_, page) = w
        .call(
            "GET",
            &format!("/api/t/alpha/contacts?source=category:{}", c.category),
            &ann,
            None,
        )
        .await;
    assert_eq!(page["rows"].as_array().unwrap().len(), 1);
    let (s, _) = w
        .call("GET", "/api/t/alpha/contacts?source=nope", &ann, None)
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
}

/// Every route: B never sees A's codes, and A's ids under B's slug answer
/// 404 (reads and writes alike); A's slug refuses B.
#[tokio::test]
async fn every_sources_route_keeps_two_orgs_apart() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let bob = w.login("bob@beta.org").await;
    let c = street(&w, &ann).await;
    let ada = contact(&w, "alpha", &ann).await;
    let bea = contact(&w, "beta", &bob).await;

    // B's own reads show none of A's.
    let (_, tree) = w.call("GET", "/api/t/beta/sources", &bob, None).await;
    assert_eq!(tree["parts"], json!([]));
    let (_, options) = w
        .call("GET", "/api/t/beta/sources/filter-options", &bob, None)
        .await;
    assert_eq!(options, json!([]));
    let (_, picked) = w
        .call(
            "GET",
            &format!("/api/t/beta/sources/picker?today={TODAY}"),
            &bob,
            None,
        )
        .await;
    assert_eq!(picked["codes"], json!([]));
    let (_, page) = w
        .call(
            "GET",
            &format!("/api/t/beta/contacts?source=version:{}", c.version),
            &bob,
            None,
        )
        .await;
    assert_eq!(page["rows"], json!([]));

    // A's ids under B's slug: 404.
    let not_found = [
        ("GET", format!("/api/t/beta/sources/{}", c.version), None),
        (
            "POST",
            format!("/api/t/beta/sources/{}/save", c.detail),
            Some(json!({ "expected": 0, "name": "X", "isActive": true })),
        ),
        (
            "POST",
            format!("/api/t/beta/sources/{}/delete", c.detail),
            Some(json!({ "expected": 0 })),
        ),
        (
            "POST",
            format!("/api/t/beta/contacts/{ada}/acquisition"),
            Some(json!({ "expected": 0, "codeId": null })),
        ),
    ];
    for (method, path, body) in not_found {
        let (s, _) = w.call(method, &path, &bob, body).await;
        assert_eq!(s, StatusCode::NOT_FOUND, "{method} {path}");
    }
    // A's code on B's contact, or as B's parent: no such code there.
    let (s, e) = w
        .call(
            "POST",
            &format!("/api/t/beta/contacts/{bea}/acquisition"),
            &bob,
            Some(json!({ "expected": 0, "codeId": c.version })),
        )
        .await;
    assert_eq!(
        (s, &e["reason"]),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            &json!("unknown_source_code")
        )
    );
    let mut body = person("Cy", "Lovelace");
    body["acquisitionCodeId"] = json!(c.version);
    let (s, e) = w
        .call("POST", "/api/t/beta/contacts", &bob, Some(body))
        .await;
    assert_eq!(
        (s, &e["reason"]),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            &json!("unknown_source_code")
        )
    );
    let (s, found) = w
        .call(
            "GET",
            &format!(
                "/api/t/beta/contacts/search?q=lovelace&source=category:{}",
                c.category
            ),
            &bob,
            None,
        )
        .await;
    assert_eq!((s, &found["rows"]), (StatusCode::OK, &json!([])));
    let (s, e) = w
        .call(
            "POST",
            "/api/t/beta/sources",
            &bob,
            Some(json!({ "parentId": c.category, "name": "Sneaky", "isActive": true })),
        )
        .await;
    assert_eq!(
        (s, &e["reason"]),
        (StatusCode::UNPROCESSABLE_ENTITY, &json!("unknown_parent"))
    );

    // B under A's slug: refused, whatever the route.
    for (method, path) in [
        ("GET", "/api/t/alpha/sources".to_owned()),
        ("GET", "/api/t/alpha/sources/filter-options".to_owned()),
        ("GET", format!("/api/t/alpha/sources/picker?today={TODAY}")),
        ("GET", format!("/api/t/alpha/sources/{}", c.version)),
        ("POST", "/api/t/alpha/sources".to_owned()),
        ("POST", format!("/api/t/alpha/sources/{}/save", c.detail)),
        ("POST", format!("/api/t/alpha/sources/{}/delete", c.detail)),
        ("POST", format!("/api/t/alpha/contacts/{ada}/acquisition")),
    ] {
        let (s, _) = w.call(method, &path, &bob, Some(json!({}))).await;
        assert_eq!(s, StatusCode::FORBIDDEN, "{method} {path}");
    }
    // And A's tree is as it was.
    let (_, tree) = w.call("GET", "/api/t/alpha/sources", &ann, None).await;
    assert_eq!(tree["parts"].as_array().unwrap().len(), 3);
}
