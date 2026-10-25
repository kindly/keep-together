//! `/api/qc/*`, the nightly QC run's token surface on staging
//! (`routes::qc_seed` module docs): one test per rule (a)–(f) of the auth
//! review, plus the api binary's boot and log.

use std::sync::Arc;

use api::auth::{Config, Runtime};
use api::routes::qc_seed::{
    QC_CALLS, QC_DOMAIN, QC_FAILURES, QC_TENANT_CAP, QC_TOKEN_HEADER, QcAccess,
};
use api::{AppState, app, routes, schema};
use axum::Router;
use axum::body::Body as HttpBody;
use axum::http::{Request, StatusCode, header};
use comms::mail::Mailer;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use store::{Role, Store, StoreConfig};
use tower::ServiceExt;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

struct Qc {
    _tmp: tempfile::TempDir,
    store: Arc<Store>,
    app: Router,
}

/// Staging as deployed: no dev auth, the token surface on.
fn staging(qc: Option<QcAccess>) -> Qc {
    staging_with(qc, Mailer::log())
}

/// As [`staging`], with `mailer`.
fn staging_with(qc: Option<QcAccess>, mailer: Mailer) -> Qc {
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
    let app = app(
        AppState::new(store.clone(), false)
            .with_auth(Runtime::new(Config::default(), mailer))
            .with_qc(qc),
        routes::router(),
    );
    Qc {
        _tmp: tmp,
        store,
        app,
    }
}

fn on() -> Qc {
    staging(Some(QcAccess::new(TOKEN).unwrap()))
}

struct Call<'a> {
    path: &'a str,
    body: Value,
    token: Option<&'a str>,
    headers: Vec<(&'a str, &'a str)>,
    cookie: Option<&'a str>,
}

fn call<'a>(path: &'a str, body: Value) -> Call<'a> {
    Call {
        path,
        body,
        token: Some(TOKEN),
        headers: vec![("host", "staging.keep-together.org.uk")],
        cookie: None,
    }
}

impl Qc {
    async fn send(&self, c: Call<'_>) -> (StatusCode, Value, Option<String>) {
        let mut req = Request::builder()
            .method(if c.body.is_null() { "GET" } else { "POST" })
            .uri(c.path);
        if let Some(t) = c.token {
            req = req.header(QC_TOKEN_HEADER, t);
        }
        for (k, v) in c.headers {
            req = req.header(k, v);
        }
        if let Some(cookie) = c.cookie {
            req = req.header(header::COOKIE, cookie);
        }
        let req = if c.body.is_null() {
            req.body(HttpBody::empty())
        } else {
            req.header(header::CONTENT_TYPE, "application/json")
                .body(HttpBody::from(c.body.to_string()))
        }
        .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let cookie = res
            .headers()
            .get(header::SET_COOKIE)
            .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_owned());
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            cookie,
        )
    }

    async fn seed(&self, run: &str) -> Value {
        let (s, world, _) = self
            .send(call("/api/qc/seed", json!({ "runId": run, "worker": 0 })))
            .await;
        assert_eq!(s, StatusCode::OK, "{world}");
        world
    }
}

#[tokio::test]
async fn a_its_own_path_and_the_dev_routes_keep_their_guards() {
    let qc = on();
    let world = qc.seed("a1").await;
    // The dev routes are untouched by the token: no dev auth on staging,
    // and /api/dev/* refuses a non-loopback Host before anything.
    for (path, body) in [
        ("/api/dev/qc-seed", json!({ "runId": "a1", "worker": 0 })),
        (
            "/api/dev/login",
            json!({ "email": world["users"][0]["email"] }),
        ),
        ("/api/dev/tenants", json!({ "slug": "x", "name": "x" })),
    ] {
        let (s, _, _) = qc.send(call(path, body)).await;
        assert_eq!(s, StatusCode::FORBIDDEN, "{path}");
    }
}

/// The world says whether the api's mail is off, so the flows that send
/// email check the `mail_off` refusal instead (qc/flows/auth.spec.ts,
/// members.spec.ts) and the run lists them.
#[tokio::test]
async fn the_world_says_whether_mail_is_off() {
    assert_eq!(on().seed("m1").await["mailOff"], false);
    let off = Mailer::from_vars(|k| (k == "KEEP_MAIL").then(|| "off".to_owned())).unwrap();
    let qc = staging_with(Some(QcAccess::new(TOKEN).unwrap()), off);
    assert_eq!(qc.seed("m2").await["mailOff"], true);
}

#[test]
fn b_fail_closed_only_with_keep_env_staging_and_refused_on_prod() {
    assert!(
        QcAccess::from_env(Some("staging"), Some(TOKEN))
            .unwrap()
            .is_some()
    );
    for env in [None, Some("dev"), Some(""), Some("Staging")] {
        assert!(
            QcAccess::from_env(env, Some(TOKEN)).unwrap().is_none(),
            "{env:?}"
        );
    }
    let err = QcAccess::from_env(Some("prod"), Some(TOKEN)).unwrap_err();
    assert!(err.contains("KEEP_ENV=prod"));
    // No token, or an empty one: off.
    assert!(QcAccess::from_env(Some("staging"), None).unwrap().is_none());
    assert!(
        QcAccess::from_env(Some("staging"), Some(""))
            .unwrap()
            .is_none()
    );
    // Under 256 bits as hex, or not printable: refused (the boot stops).
    let short = &TOKEN[..63];
    let err = QcAccess::from_env(Some("staging"), Some(short)).unwrap_err();
    assert!(!err.contains(short), "the error never quotes the token");
    assert!(QcAccess::new(&format!("{TOKEN} ")).is_err());
}

#[tokio::test]
async fn b_off_every_qc_route_is_404() {
    let qc = staging(None);
    for path in [
        "/api/qc/seed",
        "/api/qc/crowd",
        "/api/qc/hold",
        "/api/qc/session",
    ] {
        let (s, _, _) = qc.send(call(path, json!({}))).await;
        assert_eq!(s, StatusCode::NOT_FOUND, "{path}");
    }
}

#[tokio::test]
async fn c_a_wrong_missing_or_empty_token_is_404_and_never_echoed() {
    let qc = on();
    let body = json!({ "runId": "c1", "worker": 0 });
    let longer = format!("{TOKEN}0");
    let wrong = TOKEN.replace('0', "1");
    for token in [
        None,
        Some(""),
        Some(&TOKEN[..32]),
        Some(longer.as_str()),
        Some(wrong.as_str()),
    ] {
        let (s, out, _) = qc
            .send(Call {
                token,
                ..call("/api/qc/seed", body.clone())
            })
            .await;
        assert_eq!(s, StatusCode::NOT_FOUND, "{token:?}");
        assert_eq!(out, json!({ "kind": "not_found" }));
    }
    assert!(qc.store.platform().tenants().unwrap().is_empty());
    // Not in the URL either: a query-string token is no token.
    let (s, _, _) = qc
        .send(Call {
            token: None,
            ..call(&format!("/api/qc/seed?token={TOKEN}"), body)
        })
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    // Debug never shows it.
    let access = QcAccess::new(TOKEN).unwrap();
    assert!(!format!("{access:?}").contains(&TOKEN[..8]));
}

#[tokio::test]
async fn d_only_qc_groups_and_qc_users() {
    let qc = on();
    let world = qc.seed("d1").await;
    for t in world["tenants"].as_array().unwrap() {
        assert!(t["slug"].as_str().unwrap().starts_with("qc-"));
    }
    for u in world["users"].as_array().unwrap() {
        assert!(
            u["email"]
                .as_str()
                .unwrap()
                .ends_with(&format!("@{QC_DOMAIN}"))
        );
    }

    // A real group, its admin with a password; and a QC-looking address
    // someone invited into it.
    let p = qc.store.platform();
    let real = qc.store.create_tenant("riverside", "Riverside").unwrap();
    let admin = p.upsert_user("admin@keep-together.example").unwrap();
    p.set_membership(admin, &real.id, Role::Admin).unwrap();
    let planted = p.upsert_user(&format!("qc-rd2w0-a@{QC_DOMAIN}")).unwrap();
    p.set_membership(planted, &real.id, Role::Staff).unwrap();
    let hash = |user: store::UserId| {
        p.with_read(|c| {
            c.query_row(
                "SELECT password_hash FROM auth_credentials WHERE user_id = ?1",
                [user.0],
                |r| r.get::<_, String>(0),
            )
            .or(Ok::<_, rusqlite::Error>(String::new()))
        })
        .unwrap()
    };
    p.with_write(|tx| ::auth::accounts::set_password(tx, planted.0, "their-own-password", 0))
        .unwrap();
    let before = hash(planted);

    // The seed won't take over the planted address (run d2's user "a").
    let (s, _, _) = qc
        .send(call("/api/qc/seed", json!({ "runId": "d2", "worker": 0 })))
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_eq!(hash(planted), before);
    assert!(p.tenant_by_slug("qc-rd2w0-a").unwrap().is_none());

    // Sessions: QC users only.
    let qc_email = world["users"][0]["email"].as_str().unwrap();
    for email in [
        "admin@keep-together.example",
        &format!("qc-rd2w0-a@{QC_DOMAIN}"),
        &format!("nobody@{QC_DOMAIN}"),
    ] {
        let (s, _, cookie) = qc
            .send(call("/api/qc/session", json!({ "email": email })))
            .await;
        assert_eq!((s, cookie), (StatusCode::NOT_FOUND, None), "{email}");
    }
    let (s, _, cookie) = qc
        .send(call("/api/qc/session", json!({ "email": qc_email })))
        .await;
    assert_eq!(s, StatusCode::OK);
    // A real session (not a dev one: dev sessions are refused here).
    let (s, me, _) = qc
        .send(Call {
            cookie: cookie.as_deref(),
            ..call("/api/me", Value::Null)
        })
        .await;
    assert_eq!(s, StatusCode::OK, "{me}");
    assert_eq!(me["email"], qc_email);

    // crowd and hold: qc- groups only.
    for (path, body) in [
        (
            "/api/qc/crowd",
            json!({ "slug": "riverside", "lastName": "X", "count": 1 }),
        ),
        (
            "/api/qc/hold",
            json!({ "slug": "riverside", "address": "a@b.org" }),
        ),
    ] {
        let (s, _, _) = qc.send(call(path, body)).await;
        assert_eq!(s, StatusCode::NOT_FOUND, "{path}");
    }
    let slug = world["tenants"][0]["slug"].as_str().unwrap();
    let (s, n, _) = qc
        .send(call(
            "/api/qc/crowd",
            json!({ "slug": slug, "lastName": "Crowd", "count": 3 }),
        ))
        .await;
    assert_eq!((s, n), (StatusCode::OK, json!(3)));
    let count = |id| {
        qc.store
            .org(id)
            .unwrap()
            .read(|r| {
                r.query_row("SELECT count(*) FROM contacts", [], |row| {
                    row.get::<_, i64>(0)
                })
            })
            .unwrap()
    };
    assert_eq!(count(&real.id), 0);

    // A bad run id can't shape a slug.
    let (s, _, _) = qc
        .send(call(
            "/api/qc/seed",
            json!({ "runId": "../x", "worker": 0 }),
        ))
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
}

/// Q1: only the QC seed makes `qc-` groups; the dev tenant route (like
/// `keep tenant create`, cli/tests/tenant.rs) refuses the prefix.
#[tokio::test]
async fn d_the_qc_prefix_is_reserved() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Arc::new(
        Store::open_with(
            StoreConfig {
                dir: tmp.path().to_path_buf(),
                org_migrations: schema::org_migrations(),
                readers: 1,
                max_open: StoreConfig::DEFAULT_MAX_OPEN,
            },
            schema::PLATFORM_SCHEMAS,
        )
        .unwrap(),
    );
    let dev = app(AppState::new(store.clone(), true), routes::router());
    let send = |path: &str, body: Value, cookie: Option<String>| {
        let mut req = Request::builder()
            .method("POST")
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(c) = cookie {
            req = req.header(header::COOKIE, c);
        }
        dev.clone()
            .oneshot(req.body(HttpBody::from(body.to_string())).unwrap())
    };
    let res = send("/api/dev/login", json!({ "email": "ann@alpha.org" }), None)
        .await
        .unwrap();
    let cookie = res.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let res = send(
        "/api/dev/tenants",
        json!({ "slug": "qc-foodbank", "name": "Foodbank" }),
        Some(cookie.clone()),
    )
    .await
    .unwrap();
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert!(store.platform().tenants().unwrap().is_empty());
    let res = send(
        "/api/dev/tenants",
        json!({ "slug": "foodbank", "name": "Foodbank" }),
        Some(cookie),
    )
    .await
    .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn d_the_qc_group_cap() {
    let qc = on();
    let p = qc.store.platform();
    p.with_write(|tx| {
        for i in 0..QC_TENANT_CAP {
            tx.execute(
                "INSERT INTO tenants (id, slug, name) VALUES (?1, ?2, 'x')",
                rusqlite::params![format!("{i:032x}"), format!("qc-filler-{i}")],
            )?;
        }
        Ok::<_, rusqlite::Error>(())
    })
    .unwrap();
    let (s, out, _) = qc
        .send(call("/api/qc/seed", json!({ "runId": "cap", "worker": 0 })))
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{out}");
    assert_eq!(out["reason"], "qc_tenant_cap");
}

#[tokio::test]
async fn e_credentials_only_in_the_response_body() {
    let qc = on();
    let world = qc.seed("e1").await;
    let u = &world["users"][0];
    let (password, secret) = (
        u["password"].as_str().unwrap(),
        u["totpSecret"].as_str().unwrap(),
    );
    assert!(password.len() >= 32 && secret.len() >= 32);
    // Stored hashed; a new seed of the same run makes new ones.
    let stored: String = qc
        .store
        .platform()
        .with_read(|c| {
            c.query_row(
                "SELECT a.password_hash FROM auth_credentials a JOIN users u ON u.id = a.user_id
                 WHERE u.email = ?1",
                [u["email"].as_str().unwrap()],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(!stored.contains(password));
    assert!(::auth::password::verify(password, &stored));
    let again = qc.seed("e1").await;
    assert_ne!(again["users"][0]["password"], u["password"]);
    // (The api's log is checked end to end in `the_binary_…` below.)
}

#[tokio::test]
async fn f_the_csrf_guard_and_rate_limits_still_apply() {
    let qc = on();
    // A browser page elsewhere can't use it, token or not.
    let (s, _, _) = qc
        .send(Call {
            headers: vec![
                ("host", "staging.keep-together.org.uk"),
                ("origin", "https://evil.example"),
                ("sec-fetch-site", "cross-site"),
            ],
            ..call("/api/qc/seed", json!({ "runId": "f1", "worker": 0 }))
        })
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);

    // After QC_FAILURES wrong tokens, even the right one is 429.
    for _ in 0..QC_FAILURES {
        let (s, _, _) = qc
            .send(Call {
                token: Some("nope"),
                ..call("/api/qc/session", json!({ "email": "x" }))
            })
            .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
    }
    let (s, _, _) = qc
        .send(call("/api/qc/seed", json!({ "runId": "f1", "worker": 0 })))
        .await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);

    // Calls a minute, right token.
    let qc = on();
    let mut last = StatusCode::OK;
    for _ in 0..=QC_CALLS {
        (last, _, _) = qc
            .send(call(
                "/api/qc/session",
                json!({ "email": "nobody@example.org" }),
            ))
            .await;
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
}

/// The api binary: a token with KEEP_ENV=prod stops the boot; on staging
/// the token, the seeded passwords and TOTP secrets never reach its log.
#[tokio::test]
async fn the_binary_refuses_prod_and_never_logs_secrets() {
    let tmp = tempfile::tempdir().unwrap();
    let bin = env!("CARGO_BIN_EXE_api");
    let (settings_key, pepper) = (::auth::Keys::generate(), ::auth::Keys::generate());
    let base = |env: &str| {
        let mut cmd = std::process::Command::new(bin);
        // A deployed environment's full config (api::auth::boot).
        cmd.env_clear()
            .env("KEEP_DATA_DIR", tmp.path())
            .env("KEEP_ENV", env)
            .env("KEEP_APP_ORIGIN", "https://staging.example")
            .env("KEEP_CLIENT_IP_HEADER", "Fly-Client-IP")
            .env("KEEP_SETTINGS_KEY", &settings_key)
            .env("KEEP_AUTH_PEPPER", &pepper)
            .env("KEEP_MAIL", "smtp")
            .env("KEEP_SMTP_URL", "smtp://localhost:1025")
            .env("KEEP_QC_TOKEN", TOKEN);
        cmd
    };
    let out = base("prod").output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains("KEEP_QC_TOKEN is refused with KEEP_ENV=prod"),
        "{err}"
    );
    assert!(!err.contains(TOKEN));

    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut child = base("staging")
        .env("KEEP_PORT", port.to_string())
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let url = format!("http://127.0.0.1:{port}");
    let post_as = |path: &str, body: Value, token: &str, cookie: &str| {
        let (path, body, url) = (path.to_owned(), body, url.clone());
        let mut extra = format!("{QC_TOKEN_HEADER}: {token}\r\n");
        if !cookie.is_empty() {
            extra = format!("Cookie: {cookie}\r\n");
        }
        tokio::task::spawn_blocking(move || {
            let mut stream = std::net::TcpStream::connect(url.trim_start_matches("http://"))?;
            let body = body.to_string();
            use std::io::{Read, Write};
            write!(
                stream,
                "POST {path} HTTP/1.1\r\nHost: staging.example\r\n{extra}\
                 Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )?;
            let mut out = String::new();
            stream.read_to_string(&mut out)?;
            Ok::<_, std::io::Error>(out)
        })
    };
    let post = |path: &str, body: Value, token: &str| post_as(path, body, token, "");
    // Wait for it to listen.
    let mut ready = false;
    for _ in 0..100 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            ready = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(ready, "api didn't start");
    let seeded = post(
        "/api/qc/seed",
        json!({ "runId": "log", "worker": 0 }),
        TOKEN,
    )
    .await
    .unwrap()
    .unwrap();
    assert!(seeded.starts_with("HTTP/1.1 200"), "{seeded}");
    let body: Value = serde_json::from_str(seeded.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    let email = body["users"][0]["email"].as_str().unwrap().to_owned();
    let session = post("/api/qc/session", json!({ "email": email }), TOKEN)
        .await
        .unwrap()
        .unwrap();
    assert!(session.starts_with("HTTP/1.1 200"), "{session}");
    // Q3: a real sign-in with the seeded password and a code from the
    // seeded TOTP secret, sealed under this boot's keys.
    let cookie_of = |res: &str| {
        res.lines()
            .find_map(|l| {
                l.strip_prefix("set-cookie: ")
                    .or_else(|| l.strip_prefix("Set-Cookie: "))
            })
            .and_then(|c| c.split(';').next())
            .map(str::to_owned)
            .unwrap_or_else(|| panic!("no cookie in {res}"))
    };
    let password = body["users"][0]["password"].as_str().unwrap();
    let signed = post_as(
        "/api/auth/sign-in",
        json!({ "email": email, "password": password }),
        "",
        "none=1",
    )
    .await
    .unwrap()
    .unwrap();
    assert!(signed.starts_with("HTTP/1.1 200"), "{signed}");
    let partial = cookie_of(&signed);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let code =
        ::auth::totp::code_at(body["users"][0]["totpSecret"].as_str().unwrap(), now).unwrap();
    let full = post_as(
        "/api/auth/second-factor",
        json!({ "code": code }),
        "",
        &partial,
    )
    .await
    .unwrap()
    .unwrap();
    assert!(full.starts_with("HTTP/1.1 200"), "{full}");
    assert!(full.contains("\"stage\":\"signed_in\""), "{full}");
    let wrong = post(
        "/api/qc/seed",
        json!({ "runId": "log", "worker": 0 }),
        &TOKEN[..40],
    )
    .await
    .unwrap()
    .unwrap();
    assert!(wrong.starts_with("HTTP/1.1 404"), "{wrong}");
    let _ = child.kill();
    let out = child.wait_with_output().unwrap();
    let log = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(log.contains("/api/qc/* on"), "{log}");
    assert!(!log.contains(&TOKEN[..16]), "token in the log: {log}");
    for u in body["users"].as_array().unwrap() {
        for k in ["password", "totpSecret"] {
            let v = u[k].as_str().unwrap();
            assert!(!log.contains(v), "{k} in the log: {log}");
        }
    }
}
