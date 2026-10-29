//! GoCardless Direct Debit (`factory/plans/gocardless.sv`, D1 and D2).
//! Each organisation connects its own GoCardless account through
//! GoCardless's partner OAuth, so donors' money goes straight to it; we
//! hold an access token per organisation and never any funds or bank
//! details.
//!
//! GoCardless's documentation, the pages this follows:
//! - OAuth for partners: <https://docs.gocardless.com/docs/api-reference/oauth-reference>
//!   (`connect[-sandbox].gocardless.com`, `/oauth/authorize`,
//!   `/oauth/access_token` → `organisation_id`, `/oauth/revoke`);
//! - the API: <https://docs.gocardless.com/api-reference/> (`api[-sandbox]`,
//!   bearer token, `GoCardless-Version`, `Idempotency-Key`);
//! - billing requests and their flows:
//!   <https://docs.gocardless.com/docs/api-reference/billing-request>,
//!   <https://docs.gocardless.com/docs/api-reference/billing-request-flow>;
//! - subscriptions: <https://docs.gocardless.com/docs/api-reference/subscription>;
//! - payments: <https://docs.gocardless.com/docs/api-reference/payment>;
//! - webhooks: <https://docs.gocardless.com/docs/api-reference/webhooks>
//!   (`Webhook-Signature`: HMAC-SHA256 hex of the raw body; 498 on a bad
//!   one) and events: <https://docs.gocardless.com/docs/api-reference/event>
//!   (`links.organisation` on an OAuth app's webhooks), with the actions in
//!   `…/events/{payment,mandate,billing-request}`.
//!
//! Env ([`from_vars`]):
//!
//! | var | |
//! |---|---|
//! | `KEEP_GOCARDLESS` | `off` (default: every route 404, `GET gocardless` says `enabled: false`), `fake` ([`fake`]: a GoCardless mock mounted on this server, no network; `KEEP_ENV=prod` refuses it), `sandbox` (refused by `prod`), `live` (only with `KEEP_ENV=prod`). Anything else stops the boot |
//! | `KEEP_GOCARDLESS_CLIENT_ID`, `KEEP_GOCARDLESS_CLIENT_SECRET` | the partner app's OAuth client; required for `sandbox`/`live` |
//! | `KEEP_GOCARDLESS_WEBHOOK_SECRET` | the partner app's webhook endpoint secret; required for `sandbox`/`live` |
//!
//! Secrets are never logged, put in an error, a URL or argv. The OAuth
//! redirect is `{KEEP_APP_ORIGIN}/api/gocardless/callback` and the webhook
//! endpoint `{KEEP_APP_ORIGIN}/api/gocardless/webhook`: both registered on
//! the partner app.
//!
//! Where things live:
//! - each organisation's access token: an org secret
//!   ([`platform::settings`], AES-GCM under `KEEP_SETTINGS_KEY`), named
//!   [`TOKEN_SETTING`];
//! - in `platform.db` ([`SCHEMA`]): which GoCardless organisation is which
//!   of ours (webhooks name theirs), the single-use OAuth `state`s, and
//!   every webhook event by id, until a job has handled it in its org file
//!   ([`process`]), and the nightly catch-up's cursor per account
//!   ([`catchup`]).

pub mod catchup;
pub mod client;
pub mod fake;
pub mod oauth;
pub mod process;
pub mod webhook;

use std::sync::Arc;

use platform::settings::SettingsKey;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use store::{PlatformSchema, Store, StoreError, TenantId};
use ts_rs::TS;

pub use client::{Api, CallError, Credentials};

/// The org secret holding the organisation's access token ("" once
/// disconnected).
pub const TOKEN_SETTING: &str = "gocardless.accessToken";
/// The GoCardless account (`OR…`) that token is for, sealed beside it, so
/// a reader can tell a token from an account switch still landing
/// (review L7). Unset for a token sealed before it existed.
pub const ACCOUNT_SETTING: &str = "gocardless.organisationId";
/// How long an OAuth `state` is good for.
pub const STATE_TTL_MS: i64 = 10 * 60 * 1000;

pub const LIVE_API: &str = "https://api.gocardless.com";
pub const LIVE_CONNECT: &str = "https://connect.gocardless.com";
pub const SANDBOX_API: &str = "https://api-sandbox.gocardless.com";
pub const SANDBOX_CONNECT: &str = "https://connect-sandbox.gocardless.com";
/// Where the fake is mounted on this server.
pub const FAKE_PREFIX: &str = "/api/fake-gocardless";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, rename = "GoCardlessMode")]
pub enum Mode {
    Off,
    Fake,
    Sandbox,
    Live,
}

/// The configured GoCardless: the API client, the partner app's
/// credentials and webhook secret, and where the OAuth flow goes.
/// `AppState::gocardless`.
pub struct GoCardless {
    pub mode: Mode,
    pub api: Api,
    creds: Credentials,
    webhook_secret: client::Secret,
    /// Where an admin's browser is sent to connect (`…/oauth/authorize`).
    authorize_base: String,
    /// `{KEEP_APP_ORIGIN}/api/gocardless/callback`.
    pub redirect_uri: String,
    /// Organisations' tokens are sealed under this.
    settings_key: SettingsKey,
    /// One processing run at a time ([`process::process_pending`]).
    pub(crate) processing: tokio::sync::Mutex<()>,
    /// One OAuth connect at a time ([`oauth::callback`]).
    pub(crate) connecting: tokio::sync::Mutex<()>,
    /// Regular gifts whose subscription GoCardless keeps refusing on a
    /// live mandate: refusals and when to try next, by `tenant/id`
    /// ([`process::sweep`]). In memory: a restart tries once more.
    pub(crate) sweep_waits: std::sync::Mutex<std::collections::HashMap<String, (i64, i64)>>,
    /// The mock, in `fake` mode: mounted at [`FAKE_PREFIX`].
    pub fake: Option<Arc<fake::Fake>>,
}

/// What [`from_vars`] needs beyond the environment.
pub struct Origins<'a> {
    /// `KEEP_APP_ORIGIN`: where browsers reach this server.
    pub app_origin: &'a str,
    /// Where this server reaches itself (`http://127.0.0.1:<port>`), for
    /// the fake's API and webhook calls.
    pub self_base: &'a str,
}

/// The configured GoCardless, or `None` when `KEEP_GOCARDLESS` is `off`.
/// Refusals name the variable, never a secret.
pub fn from_vars(
    var: impl Fn(&str) -> Option<String>,
    origins: Origins<'_>,
    settings_key: SettingsKey,
) -> Result<Option<GoCardless>, String> {
    let keep_env = var("KEEP_ENV");
    let prod = keep_env.as_deref() == Some("prod");
    let mode = match var("KEEP_GOCARDLESS").as_deref() {
        None | Some("off") => return Ok(None),
        Some("fake") => Mode::Fake,
        Some("sandbox") => Mode::Sandbox,
        Some("live") => Mode::Live,
        Some(other) => {
            return Err(format!(
                "KEEP_GOCARDLESS={other:?}: expected off, fake, sandbox or live"
            ));
        }
    };
    match mode {
        Mode::Fake | Mode::Sandbox if prod => {
            return Err(format!(
                "KEEP_GOCARDLESS={} is refused with KEEP_ENV=prod",
                if mode == Mode::Fake {
                    "fake"
                } else {
                    "sandbox"
                }
            ));
        }
        // No real money anywhere before prod.
        Mode::Live if !prod => {
            return Err("KEEP_GOCARDLESS=live needs KEEP_ENV=prod".into());
        }
        _ => {}
    }
    let app_origin = origins.app_origin.trim_end_matches('/');
    let redirect_uri = format!("{app_origin}/api/gocardless/callback");
    let (api_base, connect_base, authorize_base, creds, webhook_secret, fake) = match mode {
        Mode::Off => unreachable!(),
        Mode::Fake => {
            let self_base = origins.self_base.trim_end_matches('/');
            let fake = Arc::new(fake::Fake::new(
                format!("{app_origin}{FAKE_PREFIX}"),
                format!("{self_base}/api/gocardless/webhook"),
            ));
            (
                format!("{self_base}{FAKE_PREFIX}/api"),
                format!("{self_base}{FAKE_PREFIX}/connect"),
                format!("{app_origin}{FAKE_PREFIX}/connect"),
                Credentials::new(fake::CLIENT_ID, fake::CLIENT_SECRET),
                client::Secret::new(fake::WEBHOOK_SECRET),
                Some(fake),
            )
        }
        Mode::Sandbox | Mode::Live => {
            let typed = if mode == Mode::Live {
                "live"
            } else {
                "sandbox"
            };
            let need = |name: &str| {
                var(name)
                    .map(|v| v.trim().to_owned())
                    .filter(|v| !v.is_empty())
                    .ok_or_else(|| format!("KEEP_GOCARDLESS={typed} needs {name}"))
            };
            let id = need("KEEP_GOCARDLESS_CLIENT_ID")?;
            let secret = need("KEEP_GOCARDLESS_CLIENT_SECRET")?;
            let webhook = need("KEEP_GOCARDLESS_WEBHOOK_SECRET")?;
            let (api, connect) = if mode == Mode::Live {
                (LIVE_API, LIVE_CONNECT)
            } else {
                (SANDBOX_API, SANDBOX_CONNECT)
            };
            (
                api.to_owned(),
                connect.to_owned(),
                connect.to_owned(),
                Credentials::new(&id, &secret),
                client::Secret::new(&webhook),
                None,
            )
        }
    };
    let api = Api::new(&api_base, &connect_base)?;
    Ok(Some(GoCardless {
        mode,
        api,
        creds,
        webhook_secret,
        authorize_base,
        redirect_uri,
        settings_key,
        processing: tokio::sync::Mutex::new(()),
        connecting: tokio::sync::Mutex::new(()),
        sweep_waits: std::sync::Mutex::new(std::collections::HashMap::new()),
        fake,
    }))
}

impl GoCardless {
    /// The organisation's access token from its file, or `None` when it
    /// isn't connected.
    pub fn token(&self, conn: &Connection) -> Result<Option<String>, crate::ApiError> {
        let token = platform::settings::get(conn, &self.settings_key, TOKEN_SETTING)
            .map_err(crate::ApiError::internal)?;
        Ok(token.filter(|t| !t.is_empty()))
    }

    /// Seal `token` (or "" to forget it) and the account it is for
    /// (`organisation`, "" with it) into the organisation's file.
    pub fn put_token(
        &self,
        ctx: &contracts::Ctx,
        token: &str,
        organisation: &str,
        source: contracts::Source,
    ) -> Result<(), contracts::ContractError> {
        platform::settings::put(ctx, &self.settings_key, TOKEN_SETTING, token, source)?;
        platform::settings::put(
            ctx,
            &self.settings_key,
            ACCOUNT_SETTING,
            organisation,
            source,
        )
        .map(|_| ())
    }

    /// The token, only if it is account `organisation`'s (or was sealed
    /// before the account was recorded beside it).
    pub fn token_for(
        &self,
        conn: &Connection,
        organisation: &str,
    ) -> Result<Option<String>, crate::ApiError> {
        let account = platform::settings::get(conn, &self.settings_key, ACCOUNT_SETTING)
            .map_err(crate::ApiError::internal)?
            .filter(|a| !a.is_empty());
        if account.is_some_and(|a| a != organisation) {
            return Ok(None);
        }
        self.token(conn)
    }

    pub fn credentials(&self) -> &Credentials {
        &self.creds
    }

    pub(crate) fn webhook_secret(&self) -> &client::Secret {
        &self.webhook_secret
    }

    /// Where to send an admin to connect, carrying `state`.
    pub fn authorize_url(&self, state: &str) -> String {
        let mut url = reqwest::Url::parse(&format!("{}/oauth/authorize", self.authorize_base))
            .expect("a valid connect base");
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", self.creds.id())
            .append_pair("scope", "read_write")
            .append_pair("redirect_uri", &self.redirect_uri)
            .append_pair("initial_view", "login")
            .append_pair("state", state);
        url.into()
    }
}

// ── platform.db ────────────────────────────────────────────────────────────

/// `platform.db`: which GoCardless organisation is which of ours, OAuth
/// states in flight, and the webhook events received.
pub const SCHEMA: PlatformSchema = PlatformSchema {
    name: "gocardless",
    steps: &[
        // 1: connections, OAuth states, the event store
        "CREATE TABLE gocardless_connections (
             tenant_id TEXT PRIMARY KEY REFERENCES tenants (id),
             organisation_id TEXT NOT NULL UNIQUE,
             connected_at INTEGER NOT NULL,
             connected_by INTEGER NOT NULL
         ) STRICT;
         CREATE TABLE gocardless_oauth_states (
             state_hash TEXT PRIMARY KEY,
             tenant_id TEXT NOT NULL REFERENCES tenants (id),
             user_id INTEGER NOT NULL,
             session_id TEXT NOT NULL,
             created_at INTEGER NOT NULL
         ) STRICT;
         CREATE TABLE gocardless_events (
             id TEXT PRIMARY KEY,
             organisation_id TEXT,
             tenant_id TEXT REFERENCES tenants (id),
             resource_type TEXT NOT NULL,
             action TEXT NOT NULL,
             body TEXT NOT NULL,
             received_at INTEGER NOT NULL,
             processed_at INTEGER,
             outcome TEXT,
             attempts INTEGER NOT NULL DEFAULT 0,
             next_attempt_at INTEGER,
             last_error TEXT
         ) STRICT;
         CREATE INDEX gocardless_events_pending ON gocardless_events (tenant_id)
             WHERE processed_at IS NULL;
         CREATE INDEX gocardless_events_by_organisation
             ON gocardless_events (organisation_id, outcome);
         CREATE TABLE gocardless_disconnections (
             organisation_id TEXT NOT NULL,
             tenant_id TEXT NOT NULL REFERENCES tenants (id),
             at INTEGER NOT NULL,
             PRIMARY KEY (organisation_id, tenant_id)
         ) STRICT;",
        // 2: the nightly catch-up's cursor per connected organisation
        // (`catchup`): events read up to `since` (RFC 3339) for that
        // account, and what the last run found
        "CREATE TABLE gocardless_catchup (
             tenant_id TEXT PRIMARY KEY REFERENCES tenants (id),
             organisation_id TEXT NOT NULL,
             since TEXT NOT NULL,
             last_run_at INTEGER NOT NULL,
             last_found INTEGER NOT NULL
         ) STRICT;",
    ],
};

/// An organisation's GoCardless connection, from `platform.db`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Connected {
    pub organisation_id: String,
    pub connected_at: i64,
    pub connected_by: i64,
}

pub fn connection(store: &Store, tenant: &TenantId) -> Result<Option<Connected>, StoreError> {
    store.platform().with_read(|c| {
        Ok(c.query_row(
            "SELECT organisation_id, connected_at, connected_by FROM gocardless_connections
             WHERE tenant_id = ?1",
            [tenant.as_str()],
            |r| {
                Ok(Connected {
                    organisation_id: r.get(0)?,
                    connected_at: r.get(1)?,
                    connected_by: r.get(2)?,
                })
            },
        )
        .optional()?)
    })
}

/// The organisation `raw` names, if it is one (a `TenantId` comes only
/// from `platform.db`'s own list).
pub fn known_tenant(store: &Store, raw: &str) -> Result<Option<TenantId>, StoreError> {
    Ok(store.each_org()?.into_iter().find(|t| t.as_str() == raw))
}

/// Our organisation for a GoCardless organisation id, if connected.
pub fn tenant_for(store: &Store, organisation_id: &str) -> Result<Option<TenantId>, StoreError> {
    let id: Option<String> = store.platform().with_read(|c| {
        Ok::<_, StoreError>(
            c.query_row(
                "SELECT tenant_id FROM gocardless_connections WHERE organisation_id = ?1",
                [organisation_id],
                |r| r.get(0),
            )
            .optional()?,
        )
    })?;
    match id {
        Some(id) => known_tenant(store, &id),
        None => Ok(None),
    }
}

/// `GET gocardless`: whether GoCardless is on here, and this
/// organisation's connection.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GoCardlessStatus {
    /// False when `KEEP_GOCARDLESS=off`: hide everything Direct Debit.
    pub enabled: bool,
    pub mode: Mode,
    pub connected: bool,
    /// GoCardless's id for the connected account (`OR…`).
    pub organisation_id: Option<String>,
    #[ts(type = "number | null")]
    pub connected_at: Option<i64>,
    /// The platform user who connected it.
    #[ts(type = "number | null")]
    pub connected_by: Option<i64>,
    /// Webhook events that couldn't be handled and are parked: an admin
    /// puts them back with `POST gocardless/events/retry`.
    #[ts(type = "number")]
    pub failed_events: i64,
}

impl GoCardlessStatus {
    pub fn new(mode: Mode, connected: Option<Connected>) -> Self {
        Self {
            failed_events: 0,
            enabled: mode != Mode::Off,
            mode,
            connected: connected.is_some(),
            organisation_id: connected.as_ref().map(|c| c.organisation_id.clone()),
            connected_at: connected.as_ref().map(|c| c.connected_at),
            connected_by: connected.as_ref().map(|c| c.connected_by),
        }
    }
}

/// `POST gocardless/connect`'s answer: send the admin's browser here.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct ConnectStart {
    pub url: String,
}

/// Record a new OAuth `state` for `tenant`, bound to this user and
/// session; the token itself is returned (only its hash is stored).
pub fn new_state(
    store: &Store,
    tenant: &TenantId,
    user: i64,
    session_id: &str,
    now: i64,
) -> Result<String, StoreError> {
    let state = ::auth::secret::token();
    let hash = ::auth::secret::hash(&state);
    store.platform().with_write(|tx| {
        // Spent or abandoned states go as new ones come.
        tx.execute(
            "DELETE FROM gocardless_oauth_states WHERE created_at < ?1",
            [now - STATE_TTL_MS],
        )?;
        tx.execute(
            "INSERT INTO gocardless_oauth_states (state_hash, tenant_id, user_id, session_id,
                 created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![hash, tenant.as_str(), user, session_id, now],
        )?;
        Ok::<_, StoreError>(())
    })?;
    Ok(state)
}

/// A state taken back from the callback.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateRow {
    pub tenant: TenantId,
    pub user: i64,
    pub session_id: String,
    pub created_at: i64,
}

/// Take `state` back: it is deleted whatever happens next (single use).
/// `None` for an unknown, spent or malformed one.
pub fn take_state(store: &Store, state: &str) -> Result<Option<StateRow>, StoreError> {
    if !::auth::secret::well_formed(state) {
        return Ok(None);
    }
    let hash = ::auth::secret::hash(state);
    let row: Option<(String, i64, String, i64)> = store.platform().with_write(|tx| {
        let row = tx
            .query_row(
                "SELECT tenant_id, user_id, session_id, created_at FROM gocardless_oauth_states
                 WHERE state_hash = ?1",
                [&hash],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        tx.execute(
            "DELETE FROM gocardless_oauth_states WHERE state_hash = ?1",
            [&hash],
        )?;
        Ok::<_, StoreError>(row)
    })?;
    let Some((tenant, user, session_id, created_at)) = row else {
        return Ok(None);
    };
    Ok(known_tenant(store, &tenant)?.map(|tenant| StateRow {
        tenant,
        user,
        session_id,
        created_at,
    }))
}

/// Why a connection can't be recorded.
#[derive(Debug, PartialEq, Eq)]
pub enum ConnectRefused {
    /// That GoCardless account is this other organisation's here.
    Taken(TenantId),
}

/// Record `tenant` as connected to `organisation_id`, replacing any
/// account it had (answered, so a failure after can put it back), in one
/// `platform.db` transaction. Another organisation's account is refused,
/// naming that organisation.
pub fn record_connection(
    store: &Store,
    tenant: &TenantId,
    organisation_id: &str,
    user: i64,
    now: i64,
) -> Result<Result<Option<Connected>, ConnectRefused>, StoreError> {
    let tenants = store.each_org()?;
    store.platform().with_write(|tx| {
        let holder: Option<String> = tx
            .query_row(
                "SELECT tenant_id FROM gocardless_connections WHERE organisation_id = ?1",
                [organisation_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(holder) = holder.filter(|h| h != tenant.as_str())
            && let Some(holder) = tenants.iter().find(|t| t.as_str() == holder)
        {
            return Ok(Err(ConnectRefused::Taken(holder.clone())));
        }
        let previous = tx
            .query_row(
                "SELECT organisation_id, connected_at, connected_by FROM gocardless_connections
                 WHERE tenant_id = ?1",
                [tenant.as_str()],
                |r| {
                    Ok(Connected {
                        organisation_id: r.get(0)?,
                        connected_at: r.get(1)?,
                        connected_by: r.get(2)?,
                    })
                },
            )
            .optional()?;
        // A switch from another account disconnects that one: what comes
        // for it from now on is kept (never purged) and replayed if this
        // organisation connects it again (GoCardless keeps collecting).
        if let Some(p) = previous
            .as_ref()
            .filter(|p| p.organisation_id != organisation_id)
        {
            tx.execute(
                "INSERT INTO gocardless_disconnections (organisation_id, tenant_id, at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT (organisation_id, tenant_id) DO UPDATE SET at = excluded.at",
                params![p.organisation_id, tenant.as_str(), now],
            )?;
        }
        tx.execute(
            "INSERT INTO gocardless_connections (tenant_id, organisation_id, connected_at,
                 connected_by)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (tenant_id) DO UPDATE SET organisation_id = excluded.organisation_id,
                 connected_at = excluded.connected_at, connected_by = excluded.connected_by",
            params![tenant.as_str(), organisation_id, now, user],
        )?;
        Ok(Ok(previous))
    })
}

/// Put `tenant`'s connection back as it was before a
/// [`record_connection`] whose token couldn't be stored.
pub fn restore_connection(
    store: &Store,
    tenant: &TenantId,
    previous: Option<Connected>,
) -> Result<(), StoreError> {
    store.platform().with_write(|tx| {
        tx.execute(
            "DELETE FROM gocardless_connections WHERE tenant_id = ?1",
            [tenant.as_str()],
        )?;
        if let Some(p) = previous {
            tx.execute(
                "INSERT INTO gocardless_connections (tenant_id, organisation_id, connected_at,
                     connected_by)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    tenant.as_str(),
                    p.organisation_id,
                    p.connected_at,
                    p.connected_by
                ],
            )?;
        }
        Ok(())
    })
}

/// Events this organisation missed while it wasn't connected to
/// `organisation_id`, back in the queue (in arrival order: rowid): its
/// own set aside as `not_connected`, and those that came for the account
/// after this organisation disconnected it (`unknown_organisation`). An
/// account's events are never handed to an organisation that didn't hold
/// it when they came. How many.
pub fn requeue_set_aside(
    tx: &rusqlite::Transaction,
    tenant: &TenantId,
    organisation_id: &str,
) -> rusqlite::Result<usize> {
    tx.execute(
        "UPDATE gocardless_events SET tenant_id = ?1, processed_at = NULL, outcome = NULL,
             attempts = 0, next_attempt_at = NULL
         WHERE organisation_id = ?2
           AND ((outcome = 'not_connected' AND tenant_id = ?1)
             OR (outcome = 'unknown_organisation' AND received_at >= (
                 SELECT at FROM gocardless_disconnections
                 WHERE organisation_id = ?2 AND tenant_id = ?1)))",
        params![tenant.as_str(), organisation_id],
    )
}

/// Disconnect `tenant`: its mapping goes, and the account it held is
/// remembered, so what comes for it meanwhile is kept for a reconnect.
pub fn forget_connection(store: &Store, tenant: &TenantId) -> Result<(), StoreError> {
    store.platform().with_write(|tx| {
        tx.execute(
            "INSERT INTO gocardless_disconnections (organisation_id, tenant_id, at)
             SELECT organisation_id, tenant_id, ?2 FROM gocardless_connections
             WHERE tenant_id = ?1
             ON CONFLICT (organisation_id, tenant_id) DO UPDATE SET at = excluded.at",
            params![tenant.as_str(), contracts::now_ms()],
        )?;
        tx.execute(
            "DELETE FROM gocardless_connections WHERE tenant_id = ?1",
            [tenant.as_str()],
        )?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |name| {
            pairs
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone())
        }
    }

    fn boot(pairs: &[(&str, &str)]) -> Result<Option<GoCardless>, String> {
        from_vars(
            vars(pairs),
            Origins {
                app_origin: "https://app.example/",
                self_base: "http://127.0.0.1:8787",
            },
            SettingsKey::parse(&SettingsKey::generate()).unwrap(),
        )
    }

    const SECRETS: [(&str, &str); 3] = [
        ("KEEP_GOCARDLESS_CLIENT_ID", "client-id-1"),
        ("KEEP_GOCARDLESS_CLIENT_SECRET", "s3cret-client"),
        ("KEEP_GOCARDLESS_WEBHOOK_SECRET", "s3cret-webhook"),
    ];

    #[test]
    fn boot_reads_the_mode_and_where_things_go() {
        assert!(boot(&[]).unwrap().is_none());
        assert!(boot(&[("KEEP_GOCARDLESS", "off")]).unwrap().is_none());
        let fake = boot(&[("KEEP_GOCARDLESS", "fake")]).unwrap().unwrap();
        assert_eq!(fake.mode, Mode::Fake);
        assert!(fake.fake.is_some());
        assert_eq!(
            fake.redirect_uri,
            "https://app.example/api/gocardless/callback"
        );
        assert!(
            fake.authorize_url("st")
                .starts_with("https://app.example/api/fake-gocardless/connect/oauth/authorize?")
        );
        let mut sandbox = SECRETS.to_vec();
        sandbox.push(("KEEP_GOCARDLESS", "sandbox"));
        sandbox.push(("KEEP_ENV", "staging"));
        let sandbox = boot(&sandbox).unwrap().unwrap();
        assert_eq!(sandbox.mode, Mode::Sandbox);
        assert!(sandbox.fake.is_none());
        let url = sandbox.authorize_url("st8");
        assert!(url.starts_with("https://connect-sandbox.gocardless.com/oauth/authorize?"));
        for part in [
            "response_type=code",
            "client_id=client-id-1",
            "scope=read_write",
            "state=st8",
            "redirect_uri=https%3A%2F%2Fapp.example%2Fapi%2Fgocardless%2Fcallback",
        ] {
            assert!(url.contains(part), "{url}: {part}");
        }
        assert!(!url.contains("s3cret"));
        let mut live = SECRETS.to_vec();
        live.extend([("KEEP_GOCARDLESS", "live"), ("KEEP_ENV", "prod")]);
        let live = boot(&live).unwrap().unwrap();
        assert!(
            live.authorize_url("x")
                .starts_with("https://connect.gocardless.com/oauth/authorize?")
        );
    }

    #[test]
    fn boot_refusals_name_the_variable_never_a_secret() {
        let with = |extra: &[(&'static str, &'static str)]| {
            let mut all = SECRETS.to_vec();
            all.extend_from_slice(extra);
            boot(&all)
                .err()
                .unwrap_or_else(|| panic!("{extra:?} booted"))
        };
        for (extra, needle) in [
            (vec![("KEEP_GOCARDLESS", "on")], "KEEP_GOCARDLESS="),
            (vec![("KEEP_GOCARDLESS", "Live")], "KEEP_GOCARDLESS="),
            (
                vec![("KEEP_GOCARDLESS", "fake"), ("KEEP_ENV", "prod")],
                "KEEP_ENV=prod",
            ),
            (
                vec![("KEEP_GOCARDLESS", "sandbox"), ("KEEP_ENV", "prod")],
                "KEEP_ENV=prod",
            ),
            (
                vec![("KEEP_GOCARDLESS", "live"), ("KEEP_ENV", "staging")],
                "KEEP_ENV=prod",
            ),
            (vec![("KEEP_GOCARDLESS", "live")], "KEEP_ENV=prod"),
        ] {
            let err = with(&extra);
            assert!(err.contains(needle), "{err}");
            assert!(!err.contains("s3cret"), "{err}");
        }
        for missing in SECRETS.map(|(k, _)| k) {
            let pairs: Vec<(&str, &str)> = SECRETS
                .iter()
                .copied()
                .filter(|(k, _)| *k != missing)
                .chain([("KEEP_GOCARDLESS", "sandbox"), ("KEEP_ENV", "staging")])
                .collect();
            let err = boot(&pairs).err().unwrap();
            assert!(err.contains(missing), "{err}");
            assert!(!err.contains("s3cret"), "{err}");
        }
        let blank: Vec<(&str, &str)> = vec![
            ("KEEP_GOCARDLESS", "sandbox"),
            ("KEEP_GOCARDLESS_CLIENT_ID", "id"),
            ("KEEP_GOCARDLESS_CLIENT_SECRET", "  "),
            ("KEEP_GOCARDLESS_WEBHOOK_SECRET", "w"),
        ];
        assert!(
            boot(&blank)
                .err()
                .unwrap()
                .contains("KEEP_GOCARDLESS_CLIENT_SECRET")
        );
    }

    #[test]
    fn secrets_never_print() {
        let creds = Credentials::new("id", "s3cret");
        assert!(!format!("{creds:?}").contains("s3cret"));
        assert!(!format!("{:?}", client::Secret::new("s3cret")).contains("s3cret"));
    }
}
