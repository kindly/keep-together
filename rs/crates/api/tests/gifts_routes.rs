//! The gift and Gift Aid routes over HTTP, on the real org schema: the
//! record-gift save (Convex `giving/recordGift.test.ts`, each case named),
//! the donor read, the gift page's writes, who may write, and tenancy on
//! every route (B never sees A; A's ids under B's slug are 404).

mod common;

use std::collections::BTreeMap;

use axum::http::StatusCode;
use common::{World, world};
use serde_json::{Value, json};

struct Codes {
    category: String,
    detail: String,
    version: String,
}

struct G {
    w: World,
    ann: String,
    bob: String,
    street: Codes,
    online: Codes,
}

/// UK today, as the server will judge it.
fn today() -> String {
    giftaid::uk_date(contracts::now_ms())
}

fn tomorrow() -> String {
    giftaid::uk_date(contracts::now_ms() + 36 * 3_600_000)
}

async fn ok(w: &World, method: &str, path: &str, cookie: &str, body: Option<Value>) -> Value {
    let (s, out) = w.call(method, path, cookie, body).await;
    assert_eq!(s, StatusCode::OK, "{method} {path}: {out}");
    out
}

/// A seeded category's id (`slug`'s file has the seven starters).
async fn category(w: &World, slug: &str, cookie: &str, name: &str) -> String {
    let tree = ok(w, "GET", &format!("/api/t/{slug}/sources"), cookie, None).await;
    tree["parts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["parentId"].is_null() && p["name"] == name)
        .unwrap_or_else(|| panic!("no {name} in {tree}"))["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn code(w: &World, slug: &str, cookie: &str, cat: &str, detail: &str) -> Codes {
    let category = match category_or_none(w, slug, cookie, cat).await {
        Some(c) => c,
        None => {
            ok(
                w,
                "POST",
                &format!("/api/t/{slug}/sources"),
                cookie,
                Some(json!({ "name": cat, "isActive": true })),
            )
            .await["id"]
                .as_str()
                .unwrap()
                .to_owned()
        }
    };
    let made = ok(
        w,
        "POST",
        &format!("/api/t/{slug}/sources"),
        cookie,
        Some(json!({ "parentId": category, "name": detail, "isActive": true })),
    )
    .await;
    Codes {
        category,
        detail: made["id"].as_str().unwrap().to_owned(),
        version: made["versionId"].as_str().unwrap().to_owned(),
    }
}

async fn category_or_none(w: &World, slug: &str, cookie: &str, name: &str) -> Option<String> {
    let tree = ok(w, "GET", &format!("/api/t/{slug}/sources"), cookie, None).await;
    tree["parts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["parentId"].is_null() && p["name"] == name)
        .map(|p| p["id"].as_str().unwrap().to_owned())
}

/// Archive a source-code part (as alpha's admin).
async fn archive(g: &G, id: &str) {
    let tree = ok(&g.w, "GET", "/api/t/alpha/sources", &g.ann, None).await;
    let p = tree["parts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == id)
        .unwrap()
        .clone();
    ok(
        &g.w,
        "POST",
        &format!("/api/t/alpha/sources/{id}/save"),
        &g.ann,
        Some(json!({
            "expected": p["saveVersion"], "name": p["name"], "isActive": false,
        })),
    )
    .await;
}

async fn setup() -> G {
    let w = world();
    // The seven starter categories, as `keep tenant create` makes them.
    for t in [&w.alpha, &w.beta] {
        let db = w.store.org(&t.id).unwrap();
        contracts::transact(&db, None, api::schema::seed_new_org).unwrap();
        contracts::transact(&db, None, sources::seed_new_org).unwrap();
    }
    let ann = w.login("ann@alpha.org").await;
    let bob = w.login("bob@beta.org").await;
    let _ = category(&w, "alpha", &ann, "Street").await;
    let street = code(&w, "alpha", &ann, "Street", "Wesser").await;
    let online = code(&w, "alpha", &ann, "Online", "Spring").await;
    G {
        w,
        ann,
        bob,
        street,
        online,
    }
}

fn person() -> Value {
    json!({ "kind": "individual", "firstName": "Jo", "lastName": "Bloggs", "name": "" })
}

fn organisation() -> Value {
    json!({ "kind": "organization", "firstName": "", "lastName": "", "name": "Acme Ltd" })
}

impl G {
    /// £20 cash under Street-Wesser-001 from a new Jo Bloggs, with
    /// `over`'s fields; a fresh client key each time, as each render of
    /// the form mints one.
    fn args(&self, over: Value) -> Value {
        let mut args = json!({
            "clientKey": contracts::new_id(),
            "contact": person(),
            "receivedOn": "2026-10-20",
            "amount": 2000,
            "method": "cash",
            "allocations": [{ "sourceCodeId": self.street.version, "amount": 2000 }],
        });
        for (k, v) in over.as_object().unwrap() {
            args[k] = v.clone();
        }
        args
    }

    async fn record_as(&self, slug: &str, cookie: &str, args: Value) -> (StatusCode, Value) {
        self.w
            .call("POST", &format!("/api/t/{slug}/gifts/record"), cookie, Some(args))
            .await
    }

    async fn record(&self, over: Value) -> Value {
        let (s, out) = self.record_as("alpha", &self.ann, self.args(over)).await;
        assert_eq!(s, StatusCode::OK, "{out}");
        out
    }

    async fn refused(&self, over: Value) -> Value {
        let (s, out) = self.record_as("alpha", &self.ann, self.args(over)).await;
        assert_ne!(s, StatusCode::OK, "{out}");
        out
    }

    /// An existing contact, made the usual way.
    async fn existing(&self, slug: &str, cookie: &str, details: Value, code: Option<&str>) -> String {
        let mut body = json!({
            "kind": "individual", "title": "", "firstName": "Jo", "lastName": "Bloggs",
            "nickname": "", "name": "", "isDeceased": false,
        });
        for (k, v) in details.as_object().unwrap() {
            body[k] = v.clone();
        }
        if let Some(code) = code {
            body["acquisitionCodeId"] = json!(code);
        }
        ok(&self.w, "POST", &format!("/api/t/{slug}/contacts"), cookie, Some(body)).await["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    async fn contact(&self, id: &str) -> Value {
        ok(&self.w, "GET", &format!("/api/t/alpha/contacts/{id}"), &self.ann, None).await
    }

    async fn gift(&self, id: &str) -> Value {
        ok(&self.w, "GET", &format!("/api/t/alpha/gifts/{id}"), &self.ann, None).await
    }

    async fn declarations(&self, contact: &str) -> Value {
        ok(
            &self.w,
            "GET",
            &format!("/api/t/alpha/contacts/{contact}/giftaid?today={}", today()),
            &self.ann,
            None,
        )
        .await
    }

    async fn declaration(&self, contact: &str, id: &str) -> Value {
        self.declarations(contact).await["declarations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["id"] == id)
            .unwrap()
            .clone()
    }

    /// Save a contact's addresses through the form.
    async fn addresses(&self, id: &str, rows: Value) {
        let counter = self.contact(id).await["counters"]["addresses"].clone();
        let out = ok(
            &self.w,
            "POST",
            &format!("/api/t/alpha/contacts/{id}/save"),
            &self.ann,
            Some(json!({ "addresses": { "expected": counter, "addresses": rows } })),
        )
        .await;
        assert_eq!(out["saved"], json!(["addresses"]), "{out}");
    }

    async fn donor(&self, contact: &str, date: &str) -> (StatusCode, Value) {
        self.w
            .call(
                "GET",
                &format!("/api/t/alpha/contacts/{contact}/donor?date={date}"),
                &self.ann,
                None,
            )
            .await
    }

    fn sql<T>(&self, slug: &str, f: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>) -> T {
        let t = if slug == "alpha" { &self.w.alpha } else { &self.w.beta };
        self.w.store.org(&t.id).unwrap().read(|r| f(r)).unwrap()
    }

    /// Every table's row count and the contact number sequence: equal
    /// before and after a refused save means it left nothing behind.
    fn fingerprint(&self, slug: &str) -> BTreeMap<String, i64> {
        self.sql(slug, |c| {
            let tables: Vec<String> = c
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table'
                     AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%search_words_%'",
                )?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let mut out = BTreeMap::new();
            for t in tables {
                let n: i64 = c.query_row(&format!("SELECT count(*) FROM \"{t}\""), [], |r| r.get(0))?;
                out.insert(t, n);
            }
            let next: Option<i64> = c
                .query_row("SELECT next FROM contact_number_sequence", [], |r| r.get(0))
                .ok();
            out.insert("contact number".into(), next.unwrap_or(0));
            Ok(out)
        })
    }

    fn used(&self, id: &str) -> bool {
        self.sql("alpha", |c| {
            c.query_row("SELECT used FROM source_codes WHERE id = ?1", [id], |r| r.get(0))
        })
    }

    /// (contract, group name) of every revision in `group`.
    fn group_revisions(&self, name: &str) -> Vec<String> {
        self.sql("alpha", |c| {
            c.prepare(
                "SELECT r.contract FROM revisions r JOIN command_groups g ON g.id = r.group_id
                 WHERE g.name = ?1 ORDER BY r.contract",
            )?
            .query_map([name], |r| r.get(0))?
            .collect()
        })
    }

    fn address_rows(&self, contact: &str) -> Vec<Value> {
        self.sql("alpha", |c| {
            c.prepare(
                "SELECT id, label, line1, postcode, town, country, is_primary
                 FROM contact_addresses WHERE contact_id = ?1 ORDER BY position",
            )?
            .query_map([contact], |r| {
                Ok(json!({
                    "key": r.get::<_, String>(0)?, "label": r.get::<_, String>(1)?,
                    "line1": r.get::<_, String>(2)?, "postcode": r.get::<_, String>(3)?,
                    "town": r.get::<_, String>(4)?, "country": r.get::<_, String>(5)?,
                    "isPrimary": r.get::<_, bool>(6)?,
                }))
            })?
            .collect()
        })
    }
}

fn address(over: Value) -> Value {
    let mut a = json!({
        "label": "home", "line1": "", "line2": "", "line3": "", "town": "",
        "postcode": "", "country": "GB", "isPrimary": false,
    });
    for (k, v) in over.as_object().unwrap() {
        a[k] = v.clone();
    }
    a
}

fn str_of(v: &Value) -> String {
    v.as_str().unwrap().to_owned()
}

// ── a new contact ──────────────────────────────────────────────────────────

/// "is created with a number, the gift's code as acquisition code, email and address"
#[tokio::test]
async fn a_new_contact_has_a_number_the_gifts_code_its_email_and_address() {
    let g = setup().await;
    let out = g
        .record(json!({
            "contact": { "kind": "individual", "firstName": "Jo", "lastName": "Bloggs", "name": "",
                         "email": " jo@example.com " },
            "home": { "line1": "12 High St", "postcode": "ab1 2cd" },
        }))
        .await;
    let contact_id = str_of(&out["contactId"]);
    let c = g.contact(&contact_id).await;
    assert_eq!(
        (&c["kind"], &c["details"]["firstName"], &c["details"]["lastName"]),
        (&json!("individual"), &json!("Jo"), &json!("Bloggs"))
    );
    assert_eq!(c["acquisition"]["versionId"], json!(g.street.version));
    assert!(c["number"].as_i64().unwrap() > 0);
    assert_eq!(c["methods"]["emails"][0]["address"], "jo@example.com");
    let a = &c["addresses"]["addresses"];
    assert_eq!(a.as_array().unwrap().len(), 1);
    assert_eq!(
        (&a[0]["line1"], &a[0]["postcode"], &a[0]["isPrimary"]),
        (&json!("12 High St"), &json!("AB1 2CD"), &json!(true))
    );
    let gift = g.gift(&str_of(&out["giftId"])).await;
    assert_eq!(
        (&gift["contactId"], &gift["amount"], &gift["status"]),
        (&json!(contact_id), &json!(2000), &json!("completed"))
    );
    assert!(gift["enteredBy"].is_i64());
    assert_eq!(out["declarationId"], Value::Null);
}

/// "an organisation needs only its name"
#[tokio::test]
async fn an_organisation_needs_only_its_name() {
    let g = setup().await;
    let out = g.record(json!({ "contact": organisation() })).await;
    let c = g.contact(&str_of(&out["contactId"])).await;
    assert_eq!((&c["kind"], &c["details"]["name"]), (&json!("organization"), &json!("Acme Ltd")));
    assert_eq!(c["acquisition"]["versionId"], json!(g.street.version));
    assert_eq!(g.gift(&str_of(&out["giftId"])).await["contactId"], out["contactId"]);
}

/// "marks the code used"
#[tokio::test]
async fn recording_marks_the_code_used() {
    let g = setup().await;
    g.record(json!({})).await;
    for id in [&g.street.version, &g.street.detail, &g.street.category] {
        assert!(g.used(id));
    }
}

// ── one named command group ────────────────────────────────────────────────

/// "every write of the save runs under the gift's group"
#[tokio::test]
async fn every_write_of_the_save_runs_under_the_gifts_group() {
    let g = setup().await;
    g.record(json!({
        "contact": { "kind": "individual", "firstName": "Jo", "lastName": "Bloggs", "name": "",
                     "email": "jo@example.com" },
        "home": { "line1": "12 High St", "postcode": "AB1 2CD" },
        "giftAid": {},
    }))
    .await;
    let names: Vec<String> = g.sql("alpha", |c| {
        c.prepare("SELECT name FROM command_groups WHERE name LIKE 'gift %'")?
            .query_map([], |r| r.get(0))?
            .collect()
    });
    assert_eq!(names, ["gift £20 cash, Street-Wesser-001"]);
    assert_eq!(
        g.group_revisions("gift £20 cash, Street-Wesser-001"),
        [
            "contacts.acquisition",
            "contacts.addresses",
            "contacts.details",
            "contacts.methods",
            "giftaid.declaration",
            "giving.gift",
            "giving.status",
        ]
    );
}

// ── an existing contact's acquisition code ─────────────────────────────────

/// "empty: filled with the gift's code, in the gift's group"
#[tokio::test]
async fn an_empty_acquisition_code_is_filled_with_the_gifts_in_its_group() {
    let g = setup().await;
    let jo = g.existing("alpha", &g.ann, json!({}), None).await;
    let out = g.record(json!({ "contact": jo })).await;
    assert_eq!(out["contactId"], json!(jo));
    let c = g.contact(&jo).await;
    assert_eq!(c["acquisition"]["versionId"], json!(g.street.version));
    assert_eq!(c["counters"]["acquisition"], 1);
    assert!(
        g.group_revisions("gift £20 cash, Street-Wesser-001")
            .contains(&"contacts.acquisition".to_owned())
    );
}

/// "set: kept, even when the gift is under another code"
#[tokio::test]
async fn a_set_acquisition_code_is_kept() {
    let g = setup().await;
    let jo = g.existing("alpha", &g.ann, json!({}), Some(&g.online.version)).await;
    let before = g.contact(&jo).await["counters"]["acquisition"].clone();
    g.record(json!({ "contact": jo })).await;
    let c = g.contact(&jo).await;
    assert_eq!(c["acquisition"]["versionId"], json!(g.online.version));
    assert_eq!(c["counters"]["acquisition"], before);
}

/// "set but archived since: still kept"
#[tokio::test]
async fn a_set_acquisition_code_archived_since_is_still_kept() {
    let g = setup().await;
    let jo = g.existing("alpha", &g.ann, json!({}), Some(&g.online.version)).await;
    archive(&g, &g.online.version).await;
    g.record(json!({ "contact": jo })).await;
    assert_eq!(g.contact(&jo).await["acquisition"]["versionId"], json!(g.online.version));
}

/// "a second gift doesn't change the code the first one filled"
#[tokio::test]
async fn a_second_gift_doesnt_change_the_filled_code() {
    let g = setup().await;
    let jo = g.existing("alpha", &g.ann, json!({}), None).await;
    g.record(json!({ "contact": jo })).await;
    g.record(json!({
        "contact": jo,
        "allocations": [{ "sourceCodeId": g.online.version, "amount": 2000 }],
    }))
    .await;
    assert_eq!(g.contact(&jo).await["acquisition"]["versionId"], json!(g.street.version));
}

// ── Gift Aid ───────────────────────────────────────────────────────────────

/// "defaults: staff ticked, past 4 years and future, made today naming the gift, current wording"
#[tokio::test]
async fn gift_aid_defaults() {
    let g = setup().await;
    let out = g
        .record(json!({ "home": { "line1": "12 High St", "postcode": "ab1 2cd" }, "giftAid": {} }))
        .await;
    let contact = str_of(&out["contactId"]);
    let d = g.declaration(&contact, &str_of(&out["declarationId"])).await;
    assert_eq!(
        (
            &d["contactId"], &d["scope"], &d["method"], &d["madeOn"], &d["contributionId"],
            &d["wordingVersion"], &d["firstName"], &d["lastName"], &d["addressLine1"],
            &d["postcode"],
        ),
        (
            &json!(contact),
            &json!("futureAndPast4y"),
            &json!("staffTickedNoEvidence"),
            // Today (UK), not the gift's date: a declaration is never back-dated.
            &json!(today()),
            &out["giftId"],
            &json!("hmrc-2016-04"),
            &json!("Jo"),
            &json!("Bloggs"),
            // The snapshot is the address as saved (postcode normalised).
            &json!("12 High St"),
            &json!("AB1 2CD"),
        )
    );
    assert!(d["enteredBy"].is_i64());
}

/// "a "this gift only" declaration names the new gift"
#[tokio::test]
async fn a_this_gift_only_declaration_names_the_new_gift() {
    let g = setup().await;
    let out = g
        .record(json!({
            "giftAid": { "scope": "thisGift", "method": "paperForm", "madeOn": "2026-10-21" },
        }))
        .await;
    let d = g
        .declaration(&str_of(&out["contactId"]), &str_of(&out["declarationId"]))
        .await;
    assert_eq!(
        (&d["scope"], &d["contributionId"], &d["method"], &d["madeOn"]),
        (&json!("thisGift"), &out["giftId"], &json!("paperForm"), &json!("2026-10-21"))
    );
}

/// "an existing person's primary address is the snapshot"
#[tokio::test]
async fn an_existing_persons_primary_address_is_the_snapshot() {
    let g = setup().await;
    let jo = g.existing("alpha", &g.ann, json!({}), None).await;
    g.addresses(
        &jo,
        json!([
            address(json!({ "label": "work", "line1": "1 Office Rd", "postcode": "ZZ1 1ZZ" })),
            address(json!({ "line1": "7 Elm Row", "postcode": "EH1 1AA", "isPrimary": true })),
        ]),
    )
    .await;
    let out = g.record(json!({ "contact": jo, "giftAid": {} })).await;
    let d = g.declaration(&jo, &str_of(&out["declarationId"])).await;
    assert_eq!((&d["addressLine1"], &d["postcode"]), (&json!("7 Elm Row"), &json!("EH1 1AA")));
    assert_eq!(g.address_rows(&jo).len(), 2);
}

/// "an existing person with no address: the one entered is saved and snapshotted (g3q3)"
#[tokio::test]
async fn an_existing_person_with_no_address_gets_the_one_entered() {
    let g = setup().await;
    let jo = g.existing("alpha", &g.ann, json!({}), None).await;
    let out = g
        .record(json!({
            "contact": jo,
            "home": { "line1": "3 Mill Lane", "postcode": "m1 1aa" },
            "giftAid": {},
        }))
        .await;
    let rows = g.address_rows(&jo);
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (&rows[0]["line1"], &rows[0]["postcode"], &rows[0]["isPrimary"], &rows[0]["country"]),
        (&json!("3 Mill Lane"), &json!("M1 1AA"), &json!(true), &json!("GB"))
    );
    let d = g.declaration(&jo, &str_of(&out["declarationId"])).await;
    assert_eq!((&d["addressLine1"], &d["postcode"]), (&json!("3 Mill Lane"), &json!("M1 1AA")));
}

/// "an added address keeps the ones the contact has, and becomes the primary"
#[tokio::test]
async fn an_added_address_keeps_the_others_and_becomes_the_primary() {
    let g = setup().await;
    let jo = g.existing("alpha", &g.ann, json!({}), None).await;
    g.addresses(
        &jo,
        json!([address(json!({
            "label": "work", "line1": "1 Office Rd", "postcode": "ZZ1 1ZZ", "isPrimary": true,
        }))]),
    )
    .await;
    g.record(json!({ "contact": jo, "home": { "line1": "3 Mill Lane", "postcode": "M1 1AA" } }))
        .await;
    let rows: Vec<_> = g
        .address_rows(&jo)
        .into_iter()
        .map(|r| (r["line1"].clone(), r["isPrimary"].clone()))
        .collect();
    assert_eq!(
        rows,
        [(json!("1 Office Rd"), json!(false)), (json!("3 Mill Lane"), json!(true))]
    );
}

/// "left without an address it saves, and the declaration is warned about"
#[tokio::test]
async fn left_without_an_address_it_saves_with_a_warning() {
    let g = setup().await;
    let out = g.record(json!({ "giftAid": {} })).await;
    let d = g
        .declaration(&str_of(&out["contactId"]), &str_of(&out["declarationId"]))
        .await;
    assert_eq!((&d["addressLine1"], &d["postcode"]), (&json!(""), &json!("")));
    let labels: Vec<_> = d["warnings"].as_array().unwrap().iter().map(|w| w["label"].clone()).collect();
    assert!(labels.contains(&json!("Home address")), "{labels:?}");
}

/// "a gift dated after today with Gift Aid saves" (the gift's warning is
/// the SPA's `giftWarnings`; the declaration is still made today)
#[tokio::test]
async fn a_gift_dated_after_today_with_gift_aid_saves() {
    let g = setup().await;
    let out = g.record(json!({ "receivedOn": tomorrow(), "giftAid": {} })).await;
    let d = g
        .declaration(&str_of(&out["contactId"]), &str_of(&out["declarationId"]))
        .await;
    assert_eq!(d["madeOn"], json!(today()));
}

/// "a back-dated gift is covered by the %s declaration made with it today"
#[tokio::test]
async fn a_back_dated_gift_is_covered_by_the_declaration_made_with_it() {
    for scope in ["future", "futureAndPast4y"] {
        let g = setup().await;
        // Before both windows.
        let out = g
            .record(json!({ "receivedOn": "2021-06-01", "giftAid": { "scope": scope } }))
            .await;
        let contact = str_of(&out["contactId"]);
        let earlier = g
            .record(json!({ "contact": contact, "receivedOn": "2021-06-01" }))
            .await;
        let covering = |gift: String| {
            g.sql("alpha", |c| giftaid::coverage(c, &contact, "2021-06-01", Some(&gift)))
        };
        assert_eq!(
            covering(str_of(&out["giftId"])).map(|d| d.id),
            Some(str_of(&out["declarationId"])),
            "{scope}"
        );
        // Another gift of that date is outside the window.
        assert!(covering(str_of(&earlier["giftId"])).is_none(), "{scope}");
    }
}

/// "the address typed is the snapshot, and completes the contact's incomplete primary in place (F3, M3)"
#[tokio::test]
async fn the_typed_address_completes_an_incomplete_primary_in_place() {
    let g = setup().await;
    let jo = g.existing("alpha", &g.ann, json!({}), None).await;
    g.addresses(&jo, json!([address(json!({ "town": "Leeds", "isPrimary": true }))])).await;
    let key = g.address_rows(&jo)[0]["key"].clone();
    let out = g
        .record(json!({
            "contact": jo,
            "home": { "line1": " 3  Mill Lane ", "postcode": " ls1 1aa " },
            "giftAid": {},
        }))
        .await;
    let d = g.declaration(&jo, &str_of(&out["declarationId"])).await;
    assert_eq!((&d["addressLine1"], &d["postcode"]), (&json!("3 Mill Lane"), &json!("LS1 1AA")));
    let rows = g.address_rows(&jo);
    // The address contract trims; only the snapshot collapses spaces.
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (&rows[0]["line1"], &rows[0]["postcode"], &rows[0]["town"], &rows[0]["isPrimary"], &rows[0]["key"]),
        (&json!("3  Mill Lane"), &json!("LS1 1AA"), &json!("Leeds"), &json!(true), &key)
    );
}

/// "a primary with line 1 and no postcode gets its postcode, and a complete one elsewhere is kept"
#[tokio::test]
async fn a_primary_with_no_postcode_gets_one_and_a_complete_one_elsewhere_is_kept() {
    let g = setup().await;
    let jo = g.existing("alpha", &g.ann, json!({}), None).await;
    g.addresses(
        &jo,
        json!([
            address(json!({ "label": "work", "line1": "1 Office Rd", "postcode": "ZZ1 1ZZ" })),
            address(json!({ "line1": "7 Elm Row", "isPrimary": true })),
        ]),
    )
    .await;
    let before = g.address_rows(&jo)[1]["key"].clone();
    g.record(json!({
        "contact": jo,
        "home": { "line1": "7 Elm Row", "postcode": "eh1 1aa" },
        "giftAid": {},
    }))
    .await;
    let rows = g.address_rows(&jo);
    let seen: Vec<_> = rows
        .iter()
        .map(|r| (r["line1"].clone(), r["postcode"].clone(), r["isPrimary"].clone()))
        .collect();
    assert_eq!(
        seen,
        [
            (json!("1 Office Rd"), json!("ZZ1 1ZZ"), json!(false)),
            (json!("7 Elm Row"), json!("EH1 1AA"), json!(true)),
        ]
    );
    // The same row, by id.
    assert_eq!(rows[1]["key"], before);
}

/// "%s with no postcode is left alone; the typed one is added as the primary"
/// (an overseas home address, a work address)
#[tokio::test]
async fn an_overseas_or_work_address_is_left_alone_and_the_typed_one_added() {
    for (label, country) in [("home", "FR"), ("work", "GB")] {
        let g = setup().await;
        let jo = g.existing("alpha", &g.ann, json!({}), None).await;
        g.addresses(
            &jo,
            json!([address(json!({
                "label": label, "line1": "9 Rue Haute", "town": "Lyon", "country": country,
                "isPrimary": true,
            }))]),
        )
        .await;
        let out = g
            .record(json!({
                "contact": jo,
                "home": { "line1": "3 Mill Lane", "postcode": "M1 1AA" },
                "giftAid": {},
            }))
            .await;
        let seen: Vec<_> = g
            .address_rows(&jo)
            .iter()
            .map(|r| (r["line1"].clone(), r["postcode"].clone(), r["country"].clone(), r["isPrimary"].clone()))
            .collect();
        assert_eq!(
            seen,
            [
                (json!("9 Rue Haute"), json!(""), json!(country), json!(false)),
                (json!("3 Mill Lane"), json!("M1 1AA"), json!("GB"), json!(true)),
            ],
            "{label} {country}"
        );
        let d = g.declaration(&jo, &str_of(&out["declarationId"])).await;
        assert_eq!((&d["addressLine1"], &d["postcode"]), (&json!("3 Mill Lane"), &json!("M1 1AA")));
    }
}

/// "blank address fields add no address"
#[tokio::test]
async fn blank_address_fields_add_no_address() {
    let g = setup().await;
    let out = g.record(json!({ "home": { "line1": " ", "postcode": "" } })).await;
    assert!(g.address_rows(&str_of(&out["contactId"])).is_empty());
}

// ── any refusal leaves nothing behind ──────────────────────────────────────

/// Each refusal: its kind or reason, and alpha's file exactly as before.
#[tokio::test]
async fn any_refusal_leaves_nothing_behind() {
    let g = setup().await;
    let jo = g.existing("alpha", &g.ann, json!({}), None).await;
    let acme = g
        .existing(
            "alpha",
            &g.ann,
            json!({ "kind": "organization", "firstName": "", "lastName": "", "name": "Acme" }),
            None,
        )
        .await;
    let cases: Vec<(&str, Value, &str)> = vec![
        ("no source code", json!({ "allocations": [] }), "invalid"),
        (
            // The new contact and its number are rolled back too.
            "amount of £0",
            json!({
                "amount": 0,
                "allocations": [{ "sourceCodeId": g.street.version, "amount": 0 }],
                "contact": { "kind": "individual", "firstName": "Jo", "lastName": "Bloggs",
                             "name": "", "email": "jo@example.com" },
                "home": { "line1": "1 A St", "postcode": "A1 1AA" },
            }),
            "invalid",
        ),
        (
            "shares not adding up to the amount",
            json!({ "allocations": [{ "sourceCodeId": g.street.version, "amount": 1999 }] }),
            "invalid",
        ),
        ("a reference on a cash gift", json!({ "reference": "TX1" }), "invalid"),
        (
            "a new person with no last name",
            json!({ "contact": { "kind": "individual", "firstName": "Jo", "lastName": " ", "name": "" } }),
            "invalid",
        ),
        (
            "Gift Aid for a new organisation",
            json!({ "contact": organisation(), "giftAid": {} }),
            "not_individual",
        ),
        (
            // Its acquisition fill rolled back.
            "Gift Aid for an existing organisation",
            json!({ "contact": acme, "giftAid": {} }),
            "not_individual",
        ),
        (
            "a declaration made after today",
            json!({ "home": { "line1": "1 A St", "postcode": "A1 1AA" }, "giftAid": { "madeOn": tomorrow() } }),
            "invalid",
        ),
        (
            "an on-screen declaration (no donor screen yet)",
            json!({ "giftAid": { "method": "onScreenByDonor" } }),
            "invalid",
        ),
        ("a blank client key", json!({ "clientKey": " " }), "invalid"),
        (
            // F4: an existing contact's added address, when Gift Aid is then refused.
            "an added address, Gift Aid refused",
            json!({
                "contact": jo,
                "home": { "line1": "1 A St", "postcode": "A1 1AA" },
                "giftAid": { "method": "onScreenByDonor" },
            }),
            "invalid",
        ),
        ("an unknown contact", json!({ "contact": "0".repeat(32) }), "unknown_contact"),
    ];
    for (name, over, want) in cases {
        let before = g.fingerprint("alpha");
        let out = g.refused(over).await;
        let got = out["reason"].as_str().or(out["kind"].as_str()).unwrap_or_default();
        assert_eq!(got, want, "{name}: {out}");
        assert_eq!(g.fingerprint("alpha"), before, "{name}");
    }
    assert!(g.address_rows(&jo).is_empty());
}

/// "an archived code, for a new contact" / "for an existing contact with no acquisition code"
#[tokio::test]
async fn an_archived_code_is_refused_for_a_new_or_an_existing_contact() {
    let g = setup().await;
    let jo = g.existing("alpha", &g.ann, json!({}), None).await;
    archive(&g, &g.street.version).await;
    for contact in [person(), json!(jo)] {
        let before = g.fingerprint("alpha");
        let out = g.refused(json!({ "contact": contact })).await;
        assert_eq!(out["reason"], "archived_source_code", "{out}");
        assert_eq!(g.fingerprint("alpha"), before);
    }
}

/// "a double submit for a new contact" / "for an existing contact":
/// refused, naming the gift
#[tokio::test]
async fn a_double_submit_is_refused_naming_the_gift() {
    let g = setup().await;
    let out = g.record(json!({ "clientKey": "form-1" })).await;
    // The new contact carries the form's key too.
    let by_key = ok(&g.w, "GET", "/api/t/alpha/contacts/by-client-key/form-1", &g.ann, None).await;
    assert_eq!(by_key["id"], out["contactId"], "{by_key}");
    let before = g.fingerprint("alpha");
    let (s, e) = g
        .record_as("alpha", &g.ann, g.args(json!({ "clientKey": "form-1", "giftAid": {} })))
        .await;
    assert_eq!((s, &e["kind"], &e["id"]), (StatusCode::CONFLICT, &json!("duplicate"), &out["giftId"]));
    assert_eq!(g.fingerprint("alpha"), before);

    let jo = g.existing("alpha", &g.ann, json!({}), None).await;
    let again = json!({
        "clientKey": "form-2", "contact": jo,
        "home": { "line1": "1 A St", "postcode": "A1 1AA" }, "giftAid": {},
    });
    let first = g.record(again.clone()).await;
    let before = g.fingerprint("alpha");
    let (s, e) = g.record_as("alpha", &g.ann, g.args(again)).await;
    assert_eq!((s, &e["id"]), (StatusCode::CONFLICT, &first["giftId"]));
    assert_eq!(g.fingerprint("alpha"), before);
}

/// "a viewer" / "staff may record"
#[tokio::test]
async fn a_viewer_is_refused_and_staff_may_record() {
    let g = setup().await;
    let val = g.w.login("val@alpha.org").await;
    let before = g.fingerprint("alpha");
    let (s, e) = g.record_as("alpha", &val, g.args(json!({}))).await;
    assert_eq!((s, &e["kind"]), (StatusCode::FORBIDDEN, &json!("forbidden")));
    assert_eq!(g.fingerprint("alpha"), before);
    let sam = g.w.login("sam@alpha.org").await;
    let (s, out) = g.record_as("alpha", &sam, g.args(json!({}))).await;
    assert_eq!(s, StatusCode::OK, "{out}");
    let me = ok(&g.w, "GET", "/api/t/alpha/gifts/recent", &sam, None).await;
    assert_eq!(me[0]["id"], out["giftId"]);
    let annes = ok(&g.w, "GET", "/api/t/alpha/gifts/recent", &g.ann, None).await;
    assert_eq!(annes, json!([]));
}

// ── two tenants ────────────────────────────────────────────────────────────

/// "tenant B's contact is unknown in A"; "tenant B's source code is
/// unknown in A, new contact or existing"
#[tokio::test]
async fn bs_contact_and_code_are_unknown_in_a() {
    let g = setup().await;
    let theirs = g.existing("beta", &g.bob, json!({}), None).await;
    let before = g.fingerprint("alpha");
    let e = g.refused(json!({ "contact": theirs })).await;
    assert_eq!(e["reason"], "unknown_contact");
    let b_code = code(&g.w, "beta", &g.bob, "Street", "Wesser").await;
    let allocations = json!([{ "sourceCodeId": b_code.version, "amount": 2000 }]);
    let e = g.refused(json!({ "allocations": allocations })).await;
    assert_eq!(e["reason"], "unknown_source_code");
    assert_eq!(g.fingerprint("alpha"), before);
    let jo = g.existing("alpha", &g.ann, json!({}), None).await;
    let before = g.fingerprint("alpha");
    let e = g.refused(json!({ "contact": jo, "allocations": allocations })).await;
    assert_eq!(e["reason"], "unknown_source_code");
    assert_eq!(g.fingerprint("alpha"), before);
}

/// "the same save in both tenants stays in each, client key included"
#[tokio::test]
async fn the_same_save_in_both_organisations_stays_in_each() {
    let g = setup().await;
    let b_street = code(&g.w, "beta", &g.bob, "Street", "Wesser").await;
    let in_a = g.record(json!({ "clientKey": "same", "giftAid": {} })).await;
    let (s, in_b) = g
        .record_as(
            "beta",
            &g.bob,
            g.args(json!({
                "clientKey": "same", "giftAid": {},
                "allocations": [{ "sourceCodeId": b_street.version, "amount": 2000 }],
            })),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{in_b}");
    let a = g.contact(&str_of(&in_a["contactId"])).await;
    let b = ok(
        &g.w,
        "GET",
        &format!("/api/t/beta/contacts/{}", str_of(&in_b["contactId"])),
        &g.bob,
        None,
    )
    .await;
    // Each organisation numbers its own contacts.
    assert_eq!(a["number"], b["number"]);
    let recent = ok(&g.w, "GET", "/api/t/alpha/gifts/recent", &g.ann, None).await;
    assert_eq!(
        recent.as_array().unwrap().iter().map(|r| r["id"].clone()).collect::<Vec<_>>(),
        [in_a["giftId"].clone()]
    );
}

// ── the record-gift page's donor ───────────────────────────────────────────

/// "a new person: names, no address, no code, not covered"
#[tokio::test]
async fn the_donor_of_a_new_person() {
    let g = setup().await;
    let id = g.existing("alpha", &g.ann, json!({}), None).await;
    let (s, d) = g.donor(&id, "2026-10-23").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        d,
        json!({
            "id": id, "kind": "individual", "displayName": "Jo Bloggs", "firstName": "Jo",
            "lastName": "Bloggs", "home": { "line1": "", "postcode": "", "completable": false },
            "acquisition": null, "covering": null,
        })
    );
}

/// "after a gift with Gift Aid: the code, the address and the declaration"
#[tokio::test]
async fn the_donor_after_a_gift_with_gift_aid() {
    let g = setup().await;
    let out = g
        .record(json!({ "home": { "line1": "12 High St", "postcode": "ab1 2cd" }, "giftAid": {} }))
        .await;
    let (_, d) = g.donor(&str_of(&out["contactId"]), &today()).await;
    assert_eq!(
        d["home"],
        json!({ "line1": "12 High St", "postcode": "AB1 2CD", "completable": false })
    );
    assert_eq!(
        (&d["acquisition"]["code"], &d["acquisition"]["isActive"]),
        (&json!("Street-Wesser-001"), &json!(true))
    );
    assert_eq!(
        (&d["covering"]["id"], &d["covering"]["scope"], &d["covering"]["method"], &d["covering"]["madeOn"]),
        (&out["declarationId"], &json!("futureAndPast4y"), &json!("staffTickedNoEvidence"), &json!(today()))
    );
}

/// "a "this gift only" declaration covers no other gift"
#[tokio::test]
async fn a_this_gift_only_declaration_covers_no_other_gift() {
    let g = setup().await;
    let out = g.record(json!({ "giftAid": { "scope": "thisGift" } })).await;
    let (_, d) = g.donor(&str_of(&out["contactId"]), "2026-10-23").await;
    assert_eq!(d["covering"], Value::Null);
}

/// "judged on the gift's date: before a "future" declaration, or after a cancellation, not covered"
#[tokio::test]
async fn the_donor_is_judged_on_the_gifts_date() {
    let g = setup().await;
    let out = g
        .record(json!({ "giftAid": { "scope": "future", "madeOn": "2026-10-01" } }))
        .await;
    let contact = str_of(&out["contactId"]);
    assert_eq!(g.donor(&contact, "2026-10-01").await.1["covering"]["id"], out["declarationId"]);
    assert_eq!(g.donor(&contact, "2026-09-15").await.1["covering"], Value::Null);
    let cancelled = ok(
        &g.w,
        "POST",
        &format!("/api/t/alpha/contacts/{contact}/giftaid/cancel"),
        &g.ann,
        Some(json!({ "cancelledFrom": "2026-10-20" })),
    )
    .await;
    assert_eq!(cancelled["cancelled"], json!([out["declarationId"]]));
    assert_eq!(g.donor(&contact, "2026-10-10").await.1["covering"]["id"], out["declarationId"]);
    assert_eq!(g.donor(&contact, "2026-10-21").await.1["covering"], Value::Null);
}

/// "an archived acquisition code reads as archived"
#[tokio::test]
async fn an_archived_acquisition_code_reads_as_archived() {
    let g = setup().await;
    let id = g.existing("alpha", &g.ann, json!({}), Some(&g.online.version)).await;
    archive(&g, &g.online.version).await;
    let (_, d) = g.donor(&id, "2026-10-23").await;
    assert_eq!(
        (&d["acquisition"]["code"], &d["acquisition"]["isActive"]),
        (&json!("Online-Spring-001"), &json!(false))
    );
}

// ── the gift page ──────────────────────────────────────────────────────────

/// Save, void and un-void answer the gift as it now is; a stale save is
/// 409 with the gift's fields now; history pages the moments.
#[tokio::test]
async fn the_gift_pages_writes_answer_the_gift_as_it_now_is() {
    let g = setup().await;
    let out = g.record(json!({ "method": "card", "reference": "R-1" })).await;
    let id = str_of(&out["giftId"]);
    let gift = g.gift(&id).await;
    assert_eq!(
        (&gift["giftVersion"], &gift["statusVersion"], &gift["contact"]["displayName"]),
        (&json!(0), &json!(1), &json!("Jo Bloggs"))
    );
    let key = gift["allocations"][0]["key"].clone();
    let body = |expected: i64, amount: i64| {
        json!({
            "expected": expected, "contactId": gift["contactId"], "receivedOn": "2026-10-19",
            "amount": amount, "method": "card", "reference": "R-1",
            "allocations": [{ "key": key, "sourceCodeId": g.street.version, "amount": amount }],
        })
    };
    let saved = ok(&g.w, "POST", &format!("/api/t/alpha/gifts/{id}/save"), &g.ann, Some(body(0, 2500))).await;
    assert_eq!((&saved["counter"], &saved["view"]["amount"]), (&json!(1), &json!(2500)));
    let (s, e) = g
        .w
        .call("POST", &format!("/api/t/alpha/gifts/{id}/save"), &g.ann, Some(body(0, 3000)))
        .await;
    assert_eq!(
        (s, &e["kind"], &e["counter"], &e["current"]["amount"]),
        (StatusCode::CONFLICT, &json!("stale"), &json!(1), &json!(2500))
    );
    let voided = ok(
        &g.w,
        "POST",
        &format!("/api/t/alpha/gifts/{id}/status"),
        &g.ann,
        Some(json!({ "expected": 1, "status": "void" })),
    )
    .await;
    assert_eq!((&voided["counter"], &voided["view"]["status"]), (&json!(2), &json!("void")));
    let again = ok(
        &g.w,
        "POST",
        &format!("/api/t/alpha/gifts/{id}/status"),
        &g.ann,
        Some(json!({ "expected": 2, "status": "void" })),
    )
    .await;
    assert_eq!(again["counter"], 2, "re-sending the status changes nothing");
    let (s, e) = g
        .w
        .call(
            "POST",
            &format!("/api/t/alpha/gifts/{id}/status"),
            &g.ann,
            Some(json!({ "expected": 1, "status": "completed" })),
        )
        .await;
    assert_eq!((s, &e["kind"]), (StatusCode::CONFLICT, &json!("stale")));
    let unvoided = ok(
        &g.w,
        "POST",
        &format!("/api/t/alpha/gifts/{id}/status"),
        &g.ann,
        Some(json!({ "expected": 2, "status": "completed" })),
    )
    .await;
    assert_eq!(unvoided["view"]["status"], "completed");

    let page = ok(&g.w, "GET", &format!("/api/t/alpha/gifts/{id}/history?limit=10"), &g.ann, None).await;
    let moments: Vec<_> = page["moments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| (m["groupName"].clone(), m["slices"].clone()))
        .collect();
    assert_eq!(
        moments,
        [
            (Value::Null, json!(["status"])),
            (Value::Null, json!(["status"])),
            (Value::Null, json!(["gift"])),
            (json!("gift £20 card, Street-Wesser-001"), json!(["status", "gift"])),
        ]
    );
    assert_eq!(page["nextBefore"], Value::Null);

    let panel = ok(
        &g.w,
        "GET",
        &format!("/api/t/alpha/contacts/{}/gifts?limit=1", str_of(&out["contactId"])),
        &g.ann,
        None,
    )
    .await;
    assert_eq!(
        (&panel["rows"][0]["id"], &panel["isDone"], &panel["rows"][0]["allocations"][0]["code"]),
        (&json!(id), &json!(true), &json!("Street-Wesser-001"))
    );
}

/// The Gift Aid panel's cancel and void, and their refusals.
#[tokio::test]
async fn the_gift_aid_panel_cancels_and_voids() {
    let g = setup().await;
    let out = g.record(json!({ "giftAid": {} })).await;
    let contact = str_of(&out["contactId"]);
    let declaration = str_of(&out["declarationId"]);
    let (s, e) = g
        .w
        .call(
            "POST",
            &format!("/api/t/alpha/contacts/{contact}/giftaid/cancel"),
            &g.ann,
            Some(json!({ "cancelledFrom": "2026-02-30" })),
        )
        .await;
    assert_eq!((s, &e["kind"]), (StatusCode::UNPROCESSABLE_ENTITY, &json!("invalid")));
    let voided = ok(
        &g.w,
        "POST",
        &format!("/api/t/alpha/giftaid/{declaration}/void"),
        &g.ann,
        Some(json!({ "reason": "wrong Jo" })),
    )
    .await;
    assert_eq!(voided, json!({ "id": declaration, "counter": 1 }));
    let (s, e) = g
        .w
        .call(
            "POST",
            &format!("/api/t/alpha/giftaid/{declaration}/void"),
            &g.ann,
            Some(json!({ "reason": "again" })),
        )
        .await;
    assert_eq!((s, &e["reason"]), (StatusCode::UNPROCESSABLE_ENTITY, &json!("immutable")));
    let panel = g.declarations(&contact).await;
    assert_eq!(panel["currentId"], Value::Null);
    assert_eq!(panel["declarations"][0]["voidReason"], "wrong Jo");
    assert_eq!(panel["declarations"][0]["warnings"], json!([]));
}

/// `POST contacts/{id}/giftaid` (Convex's `declare`): a declaration on its
/// own, refused for an organisation, the path's contact only.
#[tokio::test]
async fn a_declaration_on_its_own() {
    let g = setup().await;
    let jo = g.existing("alpha", &g.ann, json!({}), None).await;
    let body = |contact: &str| {
        json!({
            "contactId": contact, "scope": "futureAndPast4y", "madeOn": "2025-01-01",
            "method": "paperForm", "wordingVersion": "hmrc-2016-04", "firstName": "Jo",
            "lastName": "Bloggs", "addressLine1": "1", "postcode": "AB1 2CD",
        })
    };
    let made = ok(&g.w, "POST", &format!("/api/t/alpha/contacts/{jo}/giftaid"), &g.ann, Some(body(&jo))).await;
    assert_eq!(made["counter"], 0);
    assert_eq!(g.declarations(&jo).await["currentId"], made["id"]);
    let other = g.existing("alpha", &g.ann, json!({}), None).await;
    let (s, e) = g
        .w
        .call("POST", &format!("/api/t/alpha/contacts/{jo}/giftaid"), &g.ann, Some(body(&other)))
        .await;
    assert_eq!((s, &e["kind"]), (StatusCode::UNPROCESSABLE_ENTITY, &json!("invalid")));
    let acme = g
        .existing(
            "alpha",
            &g.ann,
            json!({ "kind": "organization", "firstName": "", "lastName": "", "name": "Acme" }),
            None,
        )
        .await;
    let (s, e) = g
        .w
        .call("POST", &format!("/api/t/alpha/contacts/{acme}/giftaid"), &g.ann, Some(body(&acme)))
        .await;
    assert_eq!((s, &e["reason"]), (StatusCode::UNPROCESSABLE_ENTITY, &json!("not_individual")));
    // A's contact under B's slug: 404; a viewer: 403.
    let (s, _) = g
        .w
        .call("POST", &format!("/api/t/beta/contacts/{jo}/giftaid"), &g.bob, Some(body(&jo)))
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let val = g.w.login("val@alpha.org").await;
    let (s, _) = g
        .w
        .call("POST", &format!("/api/t/alpha/contacts/{jo}/giftaid"), &val, Some(body(&jo)))
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
}

/// `?today` and `?date` are compared as ISO dates: anything else is
/// refused, never answered wrongly.
#[tokio::test]
async fn query_dates_must_be_iso_dates() {
    let g = setup().await;
    let out = g.record(json!({ "giftAid": {} })).await;
    let contact = str_of(&out["contactId"]);
    for bad in ["x", "2026-1-5", "2026-02-30", ""] {
        for path in [
            format!("/api/t/alpha/contacts/{contact}/giftaid?today={bad}"),
            format!("/api/t/alpha/contacts/{contact}/donor?date={bad}"),
        ] {
            let (s, e) = g.w.call("GET", &path, &g.ann, None).await;
            assert_eq!((s, &e["kind"]), (StatusCode::UNPROCESSABLE_ENTITY, &json!("invalid")), "{path}");
        }
    }
}

/// Every route: B never sees A's gifts or declarations, and A's ids under
/// B's slug answer 404 (reads and writes alike); a viewer reads but never
/// writes.
#[tokio::test]
async fn every_gift_route_keeps_two_orgs_apart() {
    let g = setup().await;
    let out = g.record(json!({ "giftAid": {} })).await;
    let (contact, gift, declaration) = (
        str_of(&out["contactId"]),
        str_of(&out["giftId"]),
        str_of(&out["declarationId"]),
    );
    // B's own reads show none of A's.
    assert_eq!(ok(&g.w, "GET", "/api/t/beta/gifts/recent", &g.bob, None).await, json!([]));

    let not_found = [
        ("GET", format!("/api/t/beta/gifts/{gift}"), None),
        ("GET", format!("/api/t/beta/gifts/{gift}/history"), None),
        ("GET", format!("/api/t/beta/contacts/{contact}/gifts"), None),
        ("GET", format!("/api/t/beta/contacts/{contact}/donor?date=2026-10-23"), None),
        ("GET", format!("/api/t/beta/contacts/{contact}/giftaid?today=2026-10-23"), None),
        (
            "POST",
            format!("/api/t/beta/gifts/{gift}/save"),
            Some(json!({
                "expected": 0, "contactId": contact, "receivedOn": "2026-10-20", "amount": 100,
                "method": "cash", "allocations": [{ "sourceCodeId": g.street.version, "amount": 100 }],
            })),
        ),
        (
            "POST",
            format!("/api/t/beta/gifts/{gift}/status"),
            Some(json!({ "expected": 1, "status": "void" })),
        ),
        (
            "POST",
            format!("/api/t/beta/contacts/{contact}/giftaid/cancel"),
            Some(json!({ "cancelledFrom": "2026-10-23" })),
        ),
        (
            "POST",
            format!("/api/t/beta/giftaid/{declaration}/void"),
            Some(json!({ "reason": "nope" })),
        ),
    ];
    for (method, path, body) in &not_found {
        let (s, e) = g.w.call(method, path, &g.bob, body.clone()).await;
        assert_eq!((s, &e["kind"]), (StatusCode::NOT_FOUND, &json!("not_found")), "{method} {path}");
    }
    // B under A's slug: refused before any lookup.
    let (s, _) = g.w.call("GET", &format!("/api/t/alpha/gifts/{gift}"), &g.bob, None).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    // A viewer reads every one of them in A, and is refused every write.
    let val = g.w.login("val@alpha.org").await;
    for (method, path, body) in not_found {
        let path = path.replace("/t/beta/", "/t/alpha/");
        let (s, e) = g.w.call(method, &path, &val, body).await;
        let want = if method == "GET" { StatusCode::OK } else { StatusCode::FORBIDDEN };
        assert_eq!(s, want, "viewer {method} {path}: {e}");
    }
    // Nothing of A's reached B's file.
    assert_eq!(
        g.sql("beta", |c| c.query_row(
            "SELECT (SELECT count(*) FROM gifts) + (SELECT count(*) FROM gift_aid_declarations)",
            [],
            |r| r.get::<_, i64>(0)
        )),
        0
    );
    // And A's declaration is untouched.
    assert_eq!(g.declaration(&contact, &declaration).await["voidedAt"], Value::Null);
}
