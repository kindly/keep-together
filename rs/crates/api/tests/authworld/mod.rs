//! A two-organisation world with real credentials, for the auth tests.
//! alpha: ann (admin, TOTP), val (viewer, emailed code), cat (staff, TOTP,
//! also staff in beta); beta: bob (admin, TOTP). Every password is
//! `keep-<name>-password`. Mail goes to an in-memory outbox.

#![allow(dead_code)]

use std::sync::Arc;
use std::time::Duration;

use api::auth::{Config, Runtime};
use api::{AppState, app, routes, schema};
use auth::accounts::{self, SecondFactor};
use axum::Router;
use axum::body::Body as HttpBody;
use axum::http::{Request, StatusCode, header};
use comms::mail::{Mail, Mailer, Outbox};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use store::{Role, Store, StoreConfig, Tenant};
use tower::ServiceExt;

pub const ORIGIN: &str = "https://app.test";

pub struct World {
    _tmp: tempfile::TempDir,
    pub store: Arc<Store>,
    pub alpha: Tenant,
    pub beta: Tenant,
    pub app: Router,
    pub outbox: Outbox,
    /// Mails per address already handed out by [`World::next_mail`].
    seen: std::sync::Mutex<std::collections::HashMap<String, usize>>,
}

pub struct Res {
    pub status: StatusCode,
    pub body: Value,
    /// Every `Set-Cookie`, whole.
    pub set_cookies: Vec<String>,
}

impl Res {
    /// The session cookie's `name=value` pair the response set, if any
    /// (`__Host-kt_session`: test requests carry no loopback `Host`).
    pub fn cookie(&self) -> Option<String> {
        self.set_cookies
            .iter()
            .find(|c| c.starts_with("__Host-kt_session=") || c.starts_with("kt_session="))
            .map(|c| c.split(';').next().unwrap().to_owned())
    }

    pub fn kind(&self) -> &str {
        self.body["kind"].as_str().unwrap_or("")
    }

    pub fn reason(&self) -> &str {
        self.body["reason"].as_str().unwrap_or("")
    }
}

/// The TOTP secret each TOTP user is enrolled with.
pub fn secret_of(name: &str) -> String {
    base32::encode(
        base32::Alphabet::Rfc4648 { padding: false },
        format!("secret-{name:0>14}").as_bytes(),
    )
}

pub fn password_of(email: &str) -> String {
    format!("keep-{}-password", email.split('@').next().unwrap())
}

pub fn now_secs() -> u64 {
    (contracts::now_ms() / 1000) as u64
}

pub fn world() -> World {
    build(false, config(), MailSetup::On)
}

/// As [`world`], with `KEEP_DEV_AUTH` on.
pub fn world_dev() -> World {
    build(true, config(), MailSetup::On)
}

/// As [`world`], with `config` (e.g. a client-IP header).
pub fn world_with(config: Config) -> World {
    build(false, config, MailSetup::On)
}

/// As [`world`], with `KEEP_MAIL=off` (staging until SES).
pub fn world_mail_off() -> World {
    build(false, config(), MailSetup::Off)
}

/// As [`world`], mailing only `list` (`KEEP_MAIL_ONLY_TO`, staging).
pub fn world_mail_only_to(list: &'static str) -> World {
    build(false, config(), MailSetup::OnlyTo(list))
}

enum MailSetup {
    On,
    Off,
    OnlyTo(&'static str),
}

/// The test worlds' auth config: links start at [`ORIGIN`].
pub fn config() -> Config {
    Config {
        app_origin: ORIGIN.into(),
        ..Config::default()
    }
}

fn build(dev_auth: bool, config: Config, mail: MailSetup) -> World {
    let tmp = tempfile::tempdir().unwrap();
    let store = Arc::new(
        Store::open_with(
            StoreConfig {
                dir: tmp.path().to_path_buf(),
                org_migrations: schema::org_migrations(),
                readers: 2,
                max_open: StoreConfig::DEFAULT_MAX_OPEN,
            },
            schema::PLATFORM_SCHEMAS,
        )
        .unwrap(),
    );
    let alpha = store.create_tenant("alpha", "Alpha").unwrap();
    let beta = store.create_tenant("beta", "Beta").unwrap();
    let p = store.platform();
    let now = contracts::now_ms();
    for (email, factor, memberships) in [
        (
            "ann@alpha.org",
            SecondFactor::Totp,
            vec![(&alpha, Role::Admin)],
        ),
        (
            "val@alpha.org",
            SecondFactor::Email,
            vec![(&alpha, Role::Viewer)],
        ),
        (
            "cat@alpha.org",
            SecondFactor::Totp,
            vec![(&alpha, Role::Staff), (&beta, Role::Staff)],
        ),
        (
            "bob@beta.org",
            SecondFactor::Totp,
            vec![(&beta, Role::Admin)],
        ),
    ] {
        let user = p.upsert_user(email).unwrap();
        for (t, role) in memberships {
            p.set_membership(user, &t.id, role).unwrap();
        }
        let secret = secret_of(email.split('@').next().unwrap());
        p.with_write(|tx| {
            accounts::set_password(tx, user.0, &password_of(email), now).unwrap();
            let totp = (factor == SecondFactor::Totp).then_some((secret.as_str(), 0));
            let keys = auth::Keys::dev();
            accounts::set_second_factor(tx, &keys, user.0, factor, totp, now)?;
            accounts::new_recovery_codes(tx, &keys, user.0)?;
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }
    let (mut mailer, outbox) = Mailer::memory();
    match mail {
        MailSetup::On => {}
        MailSetup::Off => {
            mailer = Mailer::from_vars(|k| (k == "KEEP_MAIL").then(|| "off".to_owned())).unwrap();
        }
        MailSetup::OnlyTo(list) => mailer = mailer.only_to(list).unwrap(),
    }
    let state = AppState::new(store.clone(), dev_auth).with_auth(Runtime::new(config, mailer));
    World {
        _tmp: tmp,
        app: app(state, routes::router()),
        store,
        alpha,
        beta,
        outbox,
        seen: Default::default(),
    }
}

impl World {
    pub async fn send(&self, req: Request<HttpBody>) -> Res {
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let set_cookies = res
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|v| v.to_str().unwrap().to_owned())
            .collect();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        Res {
            status,
            body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            set_cookies,
        }
    }

    pub fn request(
        method: &str,
        path: &str,
        cookie: Option<&str>,
        body: Option<Value>,
    ) -> axum::http::request::Builder {
        let _ = body;
        let mut req = Request::builder().method(method).uri(path);
        if let Some(c) = cookie {
            req = req.header(header::COOKIE, c);
        }
        req
    }

    pub async fn call(
        &self,
        method: &str,
        path: &str,
        cookie: Option<&str>,
        body: Option<Value>,
    ) -> Res {
        let req = Self::request(method, path, cookie, None);
        let req = match body {
            Some(b) => req
                .header(header::CONTENT_TYPE, "application/json")
                .body(HttpBody::from(b.to_string())),
            None => req.body(HttpBody::empty()),
        }
        .unwrap();
        self.send(req).await
    }

    pub async fn post(&self, path: &str, cookie: Option<&str>, body: Value) -> Res {
        self.call("POST", path, cookie, Some(body)).await
    }

    pub fn user_id(&self, email: &str) -> i64 {
        self.store.platform().upsert_user(email).unwrap().0
    }

    /// The next TOTP code `email` hasn't used: the earliest step after
    /// their last, from the current one (not the previous: the clock may
    /// cross a step boundary before the server checks it).
    pub fn totp(&self, email: &str) -> String {
        let user = self.user_id(email);
        let last = self
            .store
            .platform()
            .with_read(|c| accounts::credentials(c, user))
            .unwrap()
            .unwrap()
            .totp_last_step;
        let now = (now_secs() / 30) as i64;
        let step = (last + 1).max(now);
        assert!(step <= now + 1, "used up this minute's TOTP codes");
        auth::totp::code_at(
            &secret_of(email.split('@').next().unwrap()),
            step as u64 * 30,
        )
        .unwrap()
    }

    /// The last mail to `to`, waiting for the background send.
    pub async fn mail_to(&self, to: &str) -> Mail {
        for _ in 0..200 {
            if let Some(m) = self
                .outbox
                .lock()
                .unwrap()
                .iter()
                .rev()
                .find(|m| m.to == to)
            {
                return m.clone();
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("no mail to {to}");
    }

    pub fn mails_to(&self, to: &str) -> usize {
        self.outbox
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m.to == to)
            .count()
    }

    /// The next mail to `to` not handed out before, waiting for the
    /// background send.
    pub async fn next_mail(&self, to: &str) -> Mail {
        let seen = *self.seen.lock().unwrap().get(to).unwrap_or(&0);
        for _ in 0..200 {
            let mails: Vec<Mail> = self
                .outbox
                .lock()
                .unwrap()
                .iter()
                .filter(|m| m.to == to)
                .cloned()
                .collect();
            if mails.len() > seen {
                self.seen.lock().unwrap().insert(to.into(), seen + 1);
                return mails[seen].clone();
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("no new mail to {to}");
    }

    /// The next mail to `to` not handed out before that `wanted` accepts,
    /// skipping (and handing out) others: security notices (S1 M3) arrive
    /// between codes and links.
    pub async fn next_mail_where(&self, to: &str, wanted: impl Fn(&Mail) -> bool) -> Mail {
        loop {
            let m = self.next_mail(to).await;
            if wanted(&m) {
                return m;
            }
        }
    }

    /// The 6-digit code in the next code mail to `to`.
    pub async fn emailed_code(&self, to: &str) -> String {
        let m = self
            .next_mail_where(to, |m| m.subject.starts_with("Your keep-together code: "))
            .await;
        m.subject.rsplit(' ').next().unwrap().to_owned()
    }

    /// The token in the next link mailed to `to` (`…#<token>`).
    pub async fn emailed_token(&self, to: &str) -> String {
        let m = self.next_mail_where(to, |m| m.text.contains('#')).await;
        let at = m.text.find('#').expect("a link");
        m.text[at + 1..at + 65].to_owned()
    }

    /// The subjects of every mail to `to` so far.
    pub fn subjects_to(&self, to: &str) -> Vec<String> {
        self.outbox
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m.to == to)
            .map(|m| m.subject.clone())
            .collect()
    }

    /// Wait until a mail to `to` with `subject` has been sent.
    pub async fn wait_for_subject(&self, to: &str, subject: &str) {
        for _ in 0..200 {
            if self.subjects_to(to).iter().any(|s| s == subject) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("no mail {subject:?} to {to}: {:?}", self.subjects_to(to));
    }

    /// Password then second factor: a signed-in cookie.
    pub async fn sign_in(&self, email: &str) -> String {
        let res = self
            .post(
                "/api/auth/sign-in",
                None,
                json!({ "email": email, "password": password_of(email) }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.body);
        let partial = res.cookie().unwrap();
        let code = if res.body["method"] == "email" {
            self.emailed_code(email).await
        } else {
            self.totp(email)
        };
        let res = self
            .post(
                "/api/auth/second-factor",
                Some(&partial),
                json!({ "code": code }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.body);
        assert_eq!(res.body["stage"], "signed_in");
        res.cookie().unwrap()
    }

    /// Move this session's last sign-in `ms` into the past.
    pub fn age_sign_in(&self, cookie: &str, ms: i64) {
        let hash = auth::secret::hash(cookie.split_once('=').unwrap().1);
        self.store
            .platform()
            .with_write(|tx| {
                tx.execute(
                    "UPDATE auth_sessions SET authenticated_at = authenticated_at - ?2 WHERE token_hash = ?1",
                    rusqlite::params![hash, ms],
                )
            })
            .unwrap();
    }
}
