//! `GET /api/t/{slug}/events`: one event per committed contract, after
//! commit only; replay with `Last-Event-ID`; reset when too far behind;
//! each organisation's stream carries only its own changes.

mod common;

use std::time::Duration;

use axum::body::Body as HttpBody;
use axum::http::{StatusCode, header};
use common::{World, person, request, world};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use store::OrgEvent;
use tower::ServiceExt;

#[derive(Debug)]
struct Msg {
    id: Option<String>,
    event: Option<String>,
    data: String,
}

struct Stream {
    body: HttpBody,
    buf: String,
}

impl Stream {
    async fn open(
        w: &World,
        slug: &str,
        cookie: &str,
        last: Option<&str>,
    ) -> (StatusCode, Option<Self>) {
        Self::open_at(w, &format!("/api/t/{slug}/events"), cookie, last).await
    }

    async fn open_at(
        w: &World,
        path: &str,
        cookie: &str,
        last: Option<&str>,
    ) -> (StatusCode, Option<Self>) {
        let mut req = request("GET", path, Some(cookie), None);
        if let Some(last) = last {
            req.headers_mut()
                .insert("last-event-id", last.parse().unwrap());
        }
        let res = w.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        if status != StatusCode::OK {
            return (status, None);
        }
        assert_eq!(
            res.headers()[header::CONTENT_TYPE].to_str().unwrap(),
            "text/event-stream"
        );
        (
            status,
            Some(Self {
                body: res.into_body(),
                buf: String::new(),
            }),
        )
    }

    /// The next message (comments skipped), or None after `wait`.
    async fn next(&mut self, wait: Duration) -> Option<Msg> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            while let Some(end) = self.buf.find("\n\n") {
                let block: String = self.buf.drain(..end + 2).collect();
                let mut msg = Msg {
                    id: None,
                    event: None,
                    data: String::new(),
                };
                let mut any = false;
                for line in block.lines() {
                    if let Some(v) = line.strip_prefix("id:") {
                        msg.id = Some(v.trim().into());
                        any = true;
                    } else if let Some(v) = line.strip_prefix("event:") {
                        msg.event = Some(v.trim().into());
                        any = true;
                    } else if let Some(v) = line.strip_prefix("data:") {
                        msg.data.push_str(v.trim_start());
                        any = true;
                    }
                }
                if any {
                    return Some(msg);
                }
            }
            let frame = tokio::time::timeout_at(deadline, self.body.frame())
                .await
                .ok()??;
            if let Ok(data) = frame.unwrap().into_data() {
                self.buf.push_str(std::str::from_utf8(&data).unwrap());
            }
        }
    }

    async fn change(&mut self) -> OrgEvent {
        let msg = self.next(Duration::from_secs(2)).await.expect("an event");
        assert_eq!(msg.event, None, "{msg:?}");
        let event: OrgEvent = serde_json::from_str(&msg.data).unwrap();
        let seq = msg.id.as_deref().and_then(|id| id.split_once('.'));
        assert_eq!(seq.map(|(_, n)| n), Some(event.seq.to_string().as_str()));
        event
    }

    async fn nothing(&mut self) {
        let msg = self.next(Duration::from_millis(300)).await;
        assert!(msg.is_none(), "unexpected {msg:?}");
    }
}

/// Alpha's cursor at `seq`: `<its recovery generation>.<seq>`.
fn cursor(w: &World, seq: i64) -> String {
    let generation = w
        .store
        .org(&w.alpha.id)
        .unwrap()
        .read(|r| api::events::generation(r))
        .unwrap();
    format!("{generation}.{seq}")
}

async fn create(w: &World, slug: &str, cookie: &str, last: &str) -> Value {
    let (s, body) = w
        .call(
            "POST",
            &format!("/api/t/{slug}/contacts"),
            cookie,
            Some(person("Ann", last)),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{body}");
    body
}

#[tokio::test]
async fn an_event_follows_each_commit_and_never_a_refused_write() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let (_, stream) = Stream::open(&w, "alpha", &ann, None).await;
    let mut stream = stream.unwrap();
    stream.nothing().await;

    let created = create(&w, "alpha", &ann, "Smith").await;
    let id = created["id"].as_str().unwrap();
    let e = stream.change().await;
    assert_eq!(
        (
            e.entity.as_str(),
            e.id.as_str(),
            e.contract.as_str(),
            e.counter
        ),
        ("contacts", id, "contacts.details", 0)
    );

    // Stale: refused, rolled back, no event.
    let (s, _) = w
        .call(
            "POST",
            &format!("/api/t/alpha/contacts/{id}/archive"),
            &ann,
            Some(json!({ "expected": 7, "archived": true })),
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT);
    let (s, _) = w
        .call(
            "POST",
            &format!("/api/t/alpha/contacts/{id}/archive"),
            &ann,
            Some(json!({ "expected": 0, "archived": true })),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let next = stream.change().await;
    assert_eq!(
        (next.contract.as_str(), next.counter),
        ("contacts.archive", 1)
    );
    assert!(next.seq > e.seq);
}

#[tokio::test]
async fn a_reconnect_replays_what_it_missed() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let mut ids = vec![];
    for last in ["One", "Two", "Three"] {
        ids.push(
            create(&w, "alpha", &ann, last).await["id"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    let (_, s) = Stream::open(&w, "alpha", &ann, None).await;
    // A fresh stream starts at now: nothing old.
    s.unwrap().nothing().await;

    let first_seq: i64 = w
        .store
        .org(&w.alpha.id)
        .unwrap()
        .read(|r| r.query_row("SELECT min(id) FROM revisions", [], |row| row.get(0)))
        .unwrap();
    let (_, s) = Stream::open(&w, "alpha", &ann, Some(&cursor(&w, first_seq))).await;
    let mut s = s.unwrap();
    assert_eq!(s.change().await.id, ids[1]);
    assert_eq!(s.change().await.id, ids[2]);
    // Then live.
    let four = create(&w, "alpha", &ann, "Four").await;
    assert_eq!(s.change().await.id, four["id"].as_str().unwrap());
}

#[tokio::test]
async fn too_far_behind_or_unreadable_resets() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let db = w.store.org(&w.alpha.id).unwrap();
    contracts::transact(&db, None, |ctx| {
        for i in 0..=api::events::REPLAY_MAX {
            contacts::form::create(
                ctx,
                serde_json::from_value(person("P", &format!("n{i}"))).unwrap(),
                contracts::Source::Seed,
            )?;
        }
        Ok::<_, contracts::ContractError>(())
    })
    .unwrap();
    for last in [cursor(&w, 0), "not-a-number".into()] {
        let (_, s) = Stream::open(&w, "alpha", &ann, Some(&last)).await;
        let mut s = s.unwrap();
        let msg = s.next(Duration::from_secs(2)).await.unwrap();
        assert_eq!(msg.event.as_deref(), Some("reset"), "{last}");
        // The reset names the head, so a reconnect after it resumes there.
        let head: i64 = db
            .read(|r| r.query_row("SELECT max(id) FROM revisions", [], |row| row.get(0)))
            .unwrap();
        assert_eq!(msg.id, Some(cursor(&w, head)), "{last}");
        // After a reset the stream is live from now on.
        s.nothing().await;
        let c = create(&w, "alpha", &ann, "After").await;
        assert_eq!(s.change().await.id, c["id"].as_str().unwrap());
    }
    // Exactly REPLAY_MAX behind still replays.
    let head: i64 = db
        .read(|r| r.query_row("SELECT max(id) FROM revisions", [], |row| row.get(0)))
        .unwrap();
    let from = cursor(&w, head - api::events::REPLAY_MAX);
    let (_, s) = Stream::open(&w, "alpha", &ann, Some(&from)).await;
    let msg = s.unwrap().next(Duration::from_secs(2)).await.unwrap();
    assert_eq!(msg.event, None);
}

#[tokio::test]
async fn each_stream_carries_only_its_own_organisation() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let bob = w.login("bob@beta.org").await;
    let (_, b) = Stream::open(&w, "beta", &bob, None).await;
    let mut b = b.unwrap();
    let (_, a) = Stream::open(&w, "alpha", &ann, None).await;
    let mut a = a.unwrap();

    let in_alpha = create(&w, "alpha", &ann, "Alpha").await;
    assert_eq!(a.change().await.id, in_alpha["id"].as_str().unwrap());
    b.nothing().await;
    let in_beta = create(&w, "beta", &bob, "Beta").await;
    assert_eq!(b.change().await.id, in_beta["id"].as_str().unwrap());
    a.nothing().await;

    // Not a member: the same 403 as any other route; no session: 401.
    let (s, _) = Stream::open(&w, "alpha", &bob, None).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let res = w
        .app
        .clone()
        .oneshot(request("GET", "/api/t/alpha/events", None, None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn viewers_may_listen() {
    let w = world();
    let val = w.login("val@alpha.org").await;
    let ann = w.login("ann@alpha.org").await;
    let (s, stream) = Stream::open(&w, "alpha", &val, None).await;
    assert_eq!(s, StatusCode::OK);
    let c = create(&w, "alpha", &ann, "Seen").await;
    assert_eq!(stream.unwrap().change().await.id, c["id"].as_str().unwrap());
}

#[tokio::test]
async fn an_id_ahead_of_the_file_resets_to_its_head() {
    // The file went back in time (a restore, a rollback): the client's id
    // is beyond anything in it, and ids after the head will be reused.
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    create(&w, "alpha", &ann, "One").await;
    create(&w, "alpha", &ann, "Two").await;
    let (_, s) = Stream::open(&w, "alpha", &ann, Some(&cursor(&w, 5000))).await;
    let mut s = s.unwrap();
    let msg = s.next(Duration::from_secs(2)).await.unwrap();
    assert_eq!(msg.event.as_deref(), Some("reset"));
    assert_eq!(msg.id, Some(cursor(&w, 2)));
    // A new command reuses id 3 and is delivered.
    let three = create(&w, "alpha", &ann, "Three").await;
    let e = s.change().await;
    assert_eq!((e.seq, e.id.as_str()), (3, three["id"].as_str().unwrap()));
}

#[tokio::test]
async fn a_cold_load_resumes_after_its_boot_seq() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    create(&w, "alpha", &ann, "Before").await;
    let (_, boot) = w.call("GET", "/api/t/alpha/boot", &ann, None).await;
    let seq = boot["seq"].as_str().unwrap().to_owned();
    assert_eq!(seq, cursor(&w, 1));
    // Someone saves between /boot and /events …
    let between = create(&w, "alpha", &ann, "Between").await;
    // … and `?after=` the boot's seq still delivers it.
    let (_, s) = Stream::open_at(&w, &format!("/api/t/alpha/events?after={seq}"), &ann, None).await;
    assert_eq!(
        s.unwrap().change().await.id,
        between["id"].as_str().unwrap()
    );
    // A browser reconnect keeps the URL but sends its newer id: the header wins.
    let (_, s) = Stream::open_at(
        &w,
        &format!("/api/t/alpha/events?after={}", cursor(&w, 0)),
        &ann,
        Some(&cursor(&w, 2)),
    )
    .await;
    let mut s = s.unwrap();
    s.nothing().await;
}

/// codex C1 #5: a tab at 3, the file put back to 2 (its generation
/// rotated, as restore.sh and rollback-migration.sh do) and written on to
/// 4. The tab's seq is inside the new history, so the seq alone would
/// replay only 4 and miss that 3 is now a different command. Its
/// generation is not the file's: reset. A bare seq (a tab from before
/// generations) resets too.
#[tokio::test]
async fn a_cursor_from_before_a_restore_resets_though_its_seq_is_in_range() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    for last in ["One", "Two", "Three"] {
        create(&w, "alpha", &ann, last).await;
    }
    let before = cursor(&w, 3);
    let db = w.store.org(&w.alpha.id).unwrap();
    db.write_raw(|raw| {
        raw.conn().execute_batch(
            "DELETE FROM revisions WHERE id = 3;
             UPDATE recovery SET generation = lower(hex(randomblob(16)));",
        )
    })
    .unwrap();
    create(&w, "alpha", &ann, "Replacement").await;
    create(&w, "alpha", &ann, "Four").await;
    let head: i64 = db
        .read(|r| r.query_row("SELECT max(id) FROM revisions", [], |row| row.get(0)))
        .unwrap();
    assert!(head > 3);
    for last in [before, "3".to_owned()] {
        let (_, s) = Stream::open(&w, "alpha", &ann, Some(&last)).await;
        let msg = s.unwrap().next(Duration::from_secs(2)).await.unwrap();
        assert_eq!(msg.event.as_deref(), Some("reset"), "{last}");
        assert_eq!(msg.id, Some(cursor(&w, head)), "{last}");
    }
    // The same generation still replays.
    let (_, s) = Stream::open(&w, "alpha", &ann, Some(&cursor(&w, head - 1))).await;
    assert_eq!(s.unwrap().change().await.seq, head);
}

/// codex C1 #5: `rollback-migration.sh` gives each org file it puts back
/// a new recovery generation (restore.sh runs the same statement).
#[test]
fn a_rollback_rotates_the_recovery_generation() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let store = store::Store::open(store::StoreConfig {
        dir: dir.to_path_buf(),
        org_migrations: api::schema::org_migrations(),
        readers: 1,
        max_open: store::StoreConfig::DEFAULT_MAX_OPEN,
    })
    .unwrap();
    let t = store.create_tenant("alpha", "Alpha").unwrap();
    let generation = || {
        store
            .read_org_file(&t.id, |c| api::events::generation(c))
            .unwrap()
    };
    let before = generation();
    // The boot copy a migrating boot would have left: this very file.
    let boot = dir.join("premigrate/boot-000000000000001");
    std::fs::create_dir_all(&boot).unwrap();
    let name = format!("{}.db", t.id.as_str());
    std::fs::write(boot.join("manifest"), format!("{name}\n")).unwrap();
    rusqlite::Connection::open(dir.join("orgs").join(&name))
        .unwrap()
        .execute(
            "VACUUM INTO ?1",
            [boot
                .join(format!("{}.v13.db", t.id.as_str()))
                .to_str()
                .unwrap()],
        )
        .unwrap();
    std::fs::copy(dir.join("platform.db"), boot.join("platform.v1.db")).unwrap();
    drop(store);
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../scripts/ops/rollback-migration.sh");
    let out = std::process::Command::new("bash")
        .arg(&script)
        .arg(dir)
        .arg("--apply")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let store = store::Store::open(store::StoreConfig {
        dir: dir.to_path_buf(),
        org_migrations: api::schema::org_migrations(),
        readers: 1,
        max_open: store::StoreConfig::DEFAULT_MAX_OPEN,
    })
    .unwrap();
    let after = store
        .read_org_file(&t.id, |c| api::events::generation(c))
        .unwrap();
    assert_ne!(after, before);
    assert_eq!(after.len(), 32);
}
