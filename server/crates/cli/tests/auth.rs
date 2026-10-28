//! `keep auth reset-2fa`.

use store::{Role, Store, StoreConfig};

#[test]
fn reset_2fa_clears_the_factor_ends_sessions_and_logs_the_operator() {
    let tmp = tempfile::tempdir().unwrap();
    let open = || {
        Store::open_with(
            StoreConfig {
                dir: tmp.path().to_path_buf(),
                org_migrations: api::schema::org_migrations(),
                readers: 1,
                max_open: 1,
            },
            api::schema::PLATFORM_SCHEMAS,
        )
        .unwrap()
    };
    let store = open();
    let t = store.create_tenant("alpha", "Alpha").unwrap();
    let user = store.platform().upsert_user("ann@alpha.org").unwrap();
    store
        .platform()
        .set_membership(user, &t.id, Role::Admin)
        .unwrap();
    let now = contracts::now_ms();
    store
        .platform()
        .with_write(|tx| {
            auth::accounts::set_password(tx, user.0, "password-ann", now).unwrap();
            let keys = auth::Keys::dev();
            auth::accounts::set_second_factor(
                tx,
                &keys,
                user.0,
                auth::SecondFactor::Email,
                None,
                now,
            )?;
            auth::accounts::new_recovery_codes(tx, &keys, user.0)?;
            auth::sessions::create(tx, user.0, auth::Stage::Full, now)
        })
        .unwrap();
    drop(store);

    // The user is told (S1 M3).
    let notice = cli::auth::reset_2fa(tmp.path(), "ANN@alpha.org", "lost phone, called 24 Oct")
        .unwrap()
        .expect("a user");
    assert_eq!(notice.to, "ann@alpha.org");
    assert!(notice.subject.contains("second factor was reset"));
    assert!(
        cli::auth::reset_2fa(tmp.path(), "nobody@alpha.org", "")
            .unwrap()
            .is_none()
    );

    let store = open();
    let (factor, codes, sessions, log, prove): (Option<String>, i64, i64, String, i64) = store
        .platform()
        .with_read(|c| {
            Ok::<_, rusqlite::Error>((
                c.query_row("SELECT second_factor FROM auth_credentials", [], |r| r.get(0))?,
                c.query_row("SELECT count(*) FROM auth_recovery_codes", [], |r| r.get(0))?,
                c.query_row("SELECT count(*) FROM auth_sessions", [], |r| r.get(0))?,
                c.query_row(
                    "SELECT actor || ':' || detail FROM auth_log WHERE event = 'second_factor_reset'",
                    [],
                    |r| r.get(0),
                )?,
                c.query_row("SELECT must_prove_email FROM auth_credentials", [], |r| {
                    r.get(0)
                })?,
            ))
        })
        .unwrap();
    assert_eq!((factor, codes, sessions), (None, 0, 0));
    assert_eq!(prove, 1, "the next enrolment needs an emailed code (S1 M7)");
    assert_eq!(log, "operator:lost phone, called 24 Oct");
}

#[test]
fn operator_invite_writes_a_live_invite_and_the_mail_carries_its_link() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open_with(
        StoreConfig {
            dir: tmp.path().to_path_buf(),
            org_migrations: api::schema::org_migrations(),
            readers: 1,
            max_open: 1,
        },
        api::schema::PLATFORM_SCHEMAS,
    )
    .unwrap();
    let t = store.create_tenant("alpha", "Alpha").unwrap();
    let now = contracts::now_ms();
    let mail = store
        .platform()
        .with_write(|tx| {
            auth::operator_invite(
                tx,
                t.id.as_str(),
                &t.name,
                " Ann@Alpha.org",
                "admin",
                "https://app.test",
                now,
            )
        })
        .unwrap();
    assert_eq!(mail.to, "ann@alpha.org");
    let at = mail.text.find("https://app.test/invite#").unwrap() + "https://app.test/invite#".len();
    let token = &mail.text[at..at + 64];
    let invite = store
        .platform()
        .with_read(|c| auth::accounts::invite_by_token(c, token, now))
        .unwrap()
        .unwrap();
    assert_eq!(
        (invite.email.as_str(), invite.role.as_str()),
        ("ann@alpha.org", "admin")
    );
    let bad = store.platform().with_write(|tx| {
        auth::operator_invite(
            tx,
            t.id.as_str(),
            &t.name,
            "not an address",
            "admin",
            "",
            now,
        )
    });
    assert!(matches!(bad, Err(auth::AuthError::InvalidEmail(_))));
}

/// N1: the admin `keep tenant create` made is a member without credentials;
/// `keep auth invite` gives them a new link they can accept.
#[test]
fn keep_auth_invite_works_for_a_member_without_credentials() {
    let tmp = tempfile::tempdir().unwrap();
    let made = cli::tenant::create(tmp.path(), "alpha", "Alpha", "ann@alpha.org").unwrap();
    let mail = cli::auth::invite(tmp.path(), "alpha", "Ann@Alpha.org", "admin").unwrap();
    assert_eq!(mail.to, "ann@alpha.org");
    let at = mail.text.find("/invite#").unwrap() + "/invite#".len();
    let token = mail.text[at..at + 64].to_owned();
    let store = cli::tenant::open(tmp.path()).unwrap();
    let now = contracts::now_ms();
    let (invite, live, by): (_, i64, String) = store
        .platform()
        .with_read(|c| {
            Ok::<_, rusqlite::Error>((
                auth::accounts::invite_by_token(c, &token, now)?.unwrap(),
                c.query_row(
                    "SELECT count(*) FROM auth_invites WHERE accepted_at IS NULL AND revoked_at IS NULL",
                    [],
                    |r| r.get(0),
                )?,
                c.query_row(
                    "SELECT actor FROM auth_log WHERE event = 'invited' ORDER BY id DESC LIMIT 1",
                    [],
                    |r| r.get(0),
                )?,
            ))
        })
        .unwrap();
    assert_eq!(invite.tenant_id, made.tenant.id.as_str());
    assert_eq!(invite.role, "admin");
    assert_eq!(live, 1, "the create's link is replaced");
    assert_eq!(by, "operator");
    assert!(cli::auth::invite(tmp.path(), "nowhere", "a@b.org", "staff").is_err());
    assert!(cli::auth::invite(tmp.path(), "alpha", "a@b.org", "owner").is_err());
}
