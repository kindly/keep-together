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
        let mut req = request("GET", &format!("/api/t/{slug}/events"), Some(cookie), None);
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
        assert_eq!(msg.id, Some(event.seq.to_string()));
        event
    }

    async fn nothing(&mut self) {
        let msg = self.next(Duration::from_millis(300)).await;
        assert!(msg.is_none(), "unexpected {msg:?}");
    }
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
    let (_, s) = Stream::open(&w, "alpha", &ann, Some(&first_seq.to_string())).await;
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
    for last in ["0", "not-a-number"] {
        let (_, s) = Stream::open(&w, "alpha", &ann, Some(last)).await;
        let mut s = s.unwrap();
        let msg = s.next(Duration::from_secs(2)).await.unwrap();
        assert_eq!(msg.event.as_deref(), Some("reset"), "{last}");
        // After a reset the stream is live from now on.
        s.nothing().await;
        let c = create(&w, "alpha", &ann, "After").await;
        assert_eq!(s.change().await.id, c["id"].as_str().unwrap());
    }
    // Exactly REPLAY_MAX behind still replays.
    let head: i64 = db
        .read(|r| r.query_row("SELECT max(id) FROM revisions", [], |row| row.get(0)))
        .unwrap();
    let from = (head - api::events::REPLAY_MAX).to_string();
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
