//! `KEEP_RESET_SEED=riverside`: staging is reset on every deploy. The
//! image's entrypoint (`scripts/ops/entrypoint.sh`) wipes the data dir
//! *before* Litestream starts, so Litestream never watches files vanish
//! under it; then the api seeds the empty store here with `seed::riverside`
//! (100 donors, a password + TOTP user per role), through the same
//! contract functions as the API.
//!
//! Only with `KEEP_ENV=dev` or `staging`. On staging the six
//! `KEEP_RIVERSIDE_<ROLE>_{PASSWORD,TOTP}` must be set (Fly secrets: the
//! boot stops naming any that is missing); on dev a missing one is made
//! and printed, unless the user already has one (kept: a dev
//! authenticator survives restarts). Every boot runs the seed, which
//! writes the donors once and applies a changed password or secret from
//! the env. TOTP secrets are sealed with auth's keys, the api's own.

use auth::Keys;
use seed::riverside::{self, Credential, Origin, SeedError, Seeded};
use store::Store;

pub const SLUG: &str = riverside::SLUG;

/// Seed when `KEEP_RESET_SEED` asks for it. `true` when it made the org.
pub fn seed_from_env(store: &Store, keys: &Keys) -> Result<bool, String> {
    match std::env::var("KEEP_RESET_SEED").ok().as_deref() {
        None | Some("") => Ok(false),
        Some(SLUG) => {
            let keep_env = std::env::var("KEEP_ENV").ok();
            seed(store, keys, keep_env.as_deref(), |name| {
                std::env::var(name).ok()
            })
            .map_err(|e| e.to_string())
        }
        Some(other) => Err(format!("unknown KEEP_RESET_SEED {other:?}")),
    }
}

/// The riverside seed for `KEEP_ENV` (`dev` or `staging`) with the
/// credentials in `env`: generated where missing on dev only (staging
/// never makes one up). Also `keep dev seed-riverside`.
pub fn riverside_with(
    store: &Store,
    keys: &Keys,
    keep_env: Option<&str>,
    env: impl Fn(&str) -> Option<String>,
) -> Result<(Seeded, Vec<Credential>), SeedError> {
    riverside::allowed(keep_env)?;
    let mut credentials = riverside::credentials_from_env(env, keep_env == Some("dev"))?;
    let seeded = riverside::seed(store, keys, &mut credentials, crate::schema::seed_new_org)?;
    Ok((seeded, credentials))
}

/// The auth keys for `keep dev seed-riverside`, as the api reads them:
/// `KEEP_SETTINGS_KEY` and `KEEP_AUTH_PEPPER`, or with neither on dev the
/// published dev keys (the local api's). Staging needs both.
pub fn keys_from_env(
    keep_env: Option<&str>,
    env: impl Fn(&str) -> Option<String>,
) -> Result<Keys, String> {
    match (env("KEEP_SETTINGS_KEY"), env("KEEP_AUTH_PEPPER")) {
        (Some(key), Some(pepper)) => Keys::parse(&key, &pepper).map_err(|e| e.to_string()),
        (None, None) if keep_env == Some("dev") => Ok(Keys::dev()),
        _ => Err("KEEP_SETTINGS_KEY and KEEP_AUTH_PEPPER are both needed (the api's own)".into()),
    }
}

/// One credential part for a log line: the value only when this run
/// generated it.
pub fn shown(value: &str, origin: Origin) -> &str {
    match origin {
        Origin::Generated => value,
        Origin::Kept => "(unchanged)",
        Origin::Env => "(from env)",
    }
}

/// [`seed_from_env`] with `KEEP_ENV` and the env passed in. Prints only
/// generated credentials (dev): a hosted one never reaches the log.
pub fn seed(
    store: &Store,
    keys: &Keys,
    keep_env: Option<&str>,
    env: impl Fn(&str) -> Option<String>,
) -> Result<bool, SeedError> {
    let (seeded, credentials) = riverside_with(store, keys, keep_env, env)?;
    for c in credentials
        .iter()
        .filter(|c| c.password_origin == Origin::Generated || c.totp_origin == Origin::Generated)
    {
        eprintln!(
            "riverside {} {}: password {} totp {} (KEEP_ENV=dev, generated)",
            c.role.as_str(),
            c.email,
            shown(&c.password, c.password_origin),
            shown(&c.totp_secret, c.totp_origin)
        );
    }
    Ok(seeded.created)
}

#[cfg(test)]
mod tests {
    use store::StoreConfig;

    use super::*;

    fn staging_env(name: &str) -> Option<String> {
        if name.ends_with("_PASSWORD") {
            Some(format!("{name}-secret"))
        } else {
            Some("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP".into())
        }
    }

    fn open(dir: &std::path::Path) -> Store {
        Store::open_with(
            StoreConfig {
                dir: dir.into(),
                org_migrations: crate::schema::org_migrations(),
                readers: 1,
                max_open: StoreConfig::DEFAULT_MAX_OPEN,
            },
            crate::schema::PLATFORM_SCHEMAS,
        )
        .unwrap()
    }

    fn contacts(store: &Store, id: &store::TenantId) -> i64 {
        store
            .org(id)
            .unwrap()
            .read(|r| r.query_row("SELECT count(*) FROM contacts", [], |row| row.get(0)))
            .unwrap()
    }

    #[test]
    fn seeds_once_and_only_its_own_org() {
        let tmp = tempfile::tempdir().unwrap();
        let store = open(tmp.path());
        let other = store.create_tenant("other", "Other").unwrap();
        assert!(seed(&store, &Keys::dev(), Some("staging"), staging_env).unwrap());
        assert!(
            !seed(
                &open(tmp.path()),
                &Keys::dev(),
                Some("staging"),
                staging_env
            )
            .unwrap()
        );
        let riverside = store.platform().tenant_by_slug(SLUG).unwrap().unwrap();
        assert_eq!(contacts(&store, &riverside.id), 100);
        assert_eq!(contacts(&store, &other.id), 0);
    }

    #[test]
    fn refused_on_prod_or_unset_keep_env_and_without_staging_secrets() {
        let tmp = tempfile::tempdir().unwrap();
        let store = open(tmp.path());
        for env in [None, Some("prod")] {
            assert!(matches!(
                seed(&store, &Keys::dev(), env, staging_env),
                Err(SeedError::Disabled(_))
            ));
        }
        // Staging never makes credentials up.
        let partial = |n: &str| {
            (!n.starts_with("KEEP_RIVERSIDE_VIEWER"))
                .then(|| staging_env(n))
                .flatten()
        };
        match seed(&store, &Keys::dev(), Some("staging"), partial) {
            Err(SeedError::MissingCredentials(m)) => assert_eq!(
                m,
                [
                    "KEEP_RIVERSIDE_VIEWER_PASSWORD",
                    "KEEP_RIVERSIDE_VIEWER_TOTP"
                ]
            ),
            other => panic!("{other:?}"),
        }
        assert!(store.platform().tenant_by_slug(SLUG).unwrap().is_none());
        // Dev makes the missing ones.
        assert!(seed(&store, &Keys::dev(), Some("dev"), |_| None).unwrap());
    }
}
