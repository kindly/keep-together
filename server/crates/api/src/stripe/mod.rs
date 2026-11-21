//! Stripe (`factory/plans/stripe.sv`, step S1: Connect and plumbing).
//! Each organisation gets its own Stripe account, made by us and filled
//! in on Stripe's own hosted form; donors' money goes straight to it
//! (direct charges) and we never hold funds. The organisation has
//! Stripe's full Dashboard, pays Stripe's fees itself, and Stripe carries
//! the loss risk: what "Standard" used to mean.
//!
//! Stripe's documentation, the pages this follows:
//! - connected accounts by controller properties:
//!   <https://docs.stripe.com/connect/migrate-to-controller-properties>,
//!   <https://docs.stripe.com/api/accounts/create>;
//! - hosted onboarding: <https://docs.stripe.com/connect/hosted-onboarding>,
//!   <https://docs.stripe.com/api/account_links/create>;
//! - webhooks and their signature: <https://docs.stripe.com/webhooks>,
//!   Connect's: <https://docs.stripe.com/connect/webhooks>;
//! - versions and idempotency: <https://docs.stripe.com/api/versioning>,
//!   <https://docs.stripe.com/api/idempotent_requests>.
//!
//! Env ([`from_vars`]):
//!
//! | var | |
//! |---|---|
//! | `KEEP_STRIPE` | `off` (default: every route but `GET stripe` 404), `fake` ([`fake`]: a Stripe mock mounted on this server, no network; `KEEP_ENV=prod` refuses it), `test` (a Stripe sandbox; refused by `prod`), `live` (only with `KEEP_ENV=prod`). Anything else stops the boot |
//! | `KEEP_STRIPE_API_KEY` | the platform's restricted key; required for `test`/`live`, and it must be that mode's (`…_test_…` or `…_live_…`) |
//! | `KEEP_STRIPE_WEBHOOK_SECRET` | the connected-accounts webhook endpoint's signing secret (`whsec_…`); required for `test`/`live` |
//! | `KEEP_QC_STRIPE_ACCOUNT` | the QC run's connected account (`acct_…`), onboarded once by hand in keep-qc's sandbox: `routes::qc_stripe` attaches it to the run's `qc-` organisation. Not a secret. Refused with `KEEP_ENV=prod`; optional on the fake, which otherwise makes one |
//!
//! Secrets are never logged, put in an error, a URL or argv. The webhook
//! endpoint is `{KEEP_APP_ORIGIN}/api/stripe/webhook`, registered on the
//! platform account as a *connected accounts* endpoint.
//!
//! There is no secret per organisation: every call is the platform's key
//! plus the organisation's account id. So everything lives in
//! `platform.db` ([`SCHEMA`]): which Stripe account is which of ours and
//! how far its onboarding has got ([`accounts`]), and every webhook
//! event by id until it has been handled ([`process`]).
//!
//! Where the pieces are: [`client`] (the HTTP calls, and the one place
//! that knows which Accounts API we use), [`connect`] (connect,
//! disconnect, status), [`webhook`] (the endpoint, its signature, the
//! event store), [`process`] (the queue of stored events), [`payments`]
//! (what a payment event does: the gift, the contact, the declaration,
//! refunds and disputes, the staff match), [`catchup`] (the daily read of
//! events webhooks missed), [`fake`].

pub mod accounts;
pub mod catchup;
pub mod checkout;
pub mod client;
pub mod connect;
pub mod fake;
pub mod payments;
pub mod process;
pub mod webhook;

use std::sync::Arc;

use serde::Serialize;
use store::PlatformSchema;
use ts_rs::TS;

pub use client::{Api, CallError, Secret};

pub const LIVE_API: &str = "https://api.stripe.com";
/// Where the fake is mounted on this server.
pub const FAKE_PREFIX: &str = "/api/fake-stripe";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, rename = "StripeMode")]
pub enum Mode {
    Off,
    Fake,
    /// A Stripe sandbox.
    Test,
    Live,
}

/// The configured Stripe: the API client (the platform's key inside it),
/// the webhook endpoint's secret, and where onboarding comes back to.
/// `AppState::stripe`.
pub struct Stripe {
    pub mode: Mode,
    pub api: Api,
    webhook_secret: Secret,
    /// `KEEP_APP_ORIGIN`, no trailing slash: Stripe's form sends the
    /// admin back under it.
    app_origin: String,
    /// One processing run at a time ([`process::process_pending`]).
    pub(crate) processing: tokio::sync::Mutex<()>,
    /// One connect or disconnect at a time ([`connect`]).
    pub(crate) connecting: tokio::sync::Mutex<()>,
    /// The mock, in `fake` mode: mounted at [`FAKE_PREFIX`].
    pub fake: Option<Arc<fake::Fake>>,
    /// `KEEP_QC_STRIPE_ACCOUNT`: the connected account the QC run's
    /// organisation is given (`routes::qc_stripe`). Never with `live`.
    pub qc_account: Option<String>,
}

/// The variable naming the QC run's connected account.
pub const QC_ACCOUNT_VAR: &str = "KEEP_QC_STRIPE_ACCOUNT";

/// `KEEP_QC_STRIPE_ACCOUNT`, if set: a Stripe account id and nothing
/// else. Refused with `KEEP_ENV=prod` whatever `KEEP_STRIPE` says.
fn qc_account(var: &impl Fn(&str) -> Option<String>, prod: bool) -> Result<Option<String>, String> {
    let Some(id) = var(QC_ACCOUNT_VAR)
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
    else {
        return Ok(None);
    };
    if prod {
        return Err(format!("{QC_ACCOUNT_VAR} is refused with KEEP_ENV=prod"));
    }
    let tail = id.strip_prefix("acct_").unwrap_or("");
    if tail.is_empty() || tail.len() > 64 || !tail.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(format!(
            "{QC_ACCOUNT_VAR} must be a Stripe account id (acct_…)"
        ));
    }
    Ok(Some(id))
}

/// What [`from_vars`] needs beyond the environment.
pub struct Origins<'a> {
    /// `KEEP_APP_ORIGIN`: where browsers reach this server.
    pub app_origin: &'a str,
    /// Where this server reaches itself (`http://127.0.0.1:<port>`), for
    /// the fake's API and webhook calls.
    pub self_base: &'a str,
}

/// The configured Stripe, or `None` when `KEEP_STRIPE` is `off`.
/// Refusals name the variable, never a secret.
pub fn from_vars(
    var: impl Fn(&str) -> Option<String>,
    origins: Origins<'_>,
) -> Result<Option<Stripe>, String> {
    let prod = var("KEEP_ENV").as_deref() == Some("prod");
    let qc_account = qc_account(&var, prod)?;
    let mode = match var("KEEP_STRIPE").as_deref() {
        None | Some("off") => return Ok(None),
        Some("fake") => Mode::Fake,
        Some("test") => Mode::Test,
        Some("live") => Mode::Live,
        Some(other) => {
            return Err(format!(
                "KEEP_STRIPE={other:?}: expected off, fake, test or live"
            ));
        }
    };
    match mode {
        Mode::Fake | Mode::Test if prod => {
            return Err(format!(
                "KEEP_STRIPE={} is refused with KEEP_ENV=prod",
                if mode == Mode::Fake { "fake" } else { "test" }
            ));
        }
        // No real money anywhere before prod.
        Mode::Live if !prod => return Err("KEEP_STRIPE=live needs KEEP_ENV=prod".into()),
        _ => {}
    }
    let app_origin = origins.app_origin.trim_end_matches('/').to_owned();
    let (api_base, key, webhook_secret, fake) = match mode {
        Mode::Off => unreachable!(),
        Mode::Fake => {
            let self_base = origins.self_base.trim_end_matches('/');
            let fake = Arc::new(fake::Fake::new(
                format!("{app_origin}{FAKE_PREFIX}"),
                format!("{self_base}/api/stripe/webhook"),
            ));
            (
                format!("{self_base}{FAKE_PREFIX}"),
                Secret::new(fake::API_KEY),
                Secret::new(fake::WEBHOOK_SECRET),
                Some(fake),
            )
        }
        Mode::Test | Mode::Live => {
            let typed = if mode == Mode::Live { "live" } else { "test" };
            let need = |name: &str| {
                var(name)
                    .map(|v| v.trim().to_owned())
                    .filter(|v| !v.is_empty())
                    .ok_or_else(|| format!("KEEP_STRIPE={typed} needs {name}"))
            };
            let key = need("KEEP_STRIPE_API_KEY")?;
            let webhook = need("KEEP_STRIPE_WEBHOOK_SECRET")?;
            // Stripe's keys say which mode they are for (`sk_test_…`,
            // `rk_live_…`): a live key never runs under `test`, nor a
            // sandbox's under `live`.
            if !key.contains(&format!("_{typed}_")) {
                return Err(format!(
                    "KEEP_STRIPE={typed} needs a {typed}-mode KEEP_STRIPE_API_KEY (…_{typed}_…)"
                ));
            }
            (
                LIVE_API.to_owned(),
                Secret::new(&key),
                Secret::new(&webhook),
                None,
            )
        }
    };
    Ok(Some(Stripe {
        mode,
        api: Api::new(&api_base, key)?,
        webhook_secret,
        app_origin,
        processing: tokio::sync::Mutex::new(()),
        connecting: tokio::sync::Mutex::new(()),
        fake,
        qc_account,
    }))
}

impl Stripe {
    pub(crate) fn webhook_secret(&self) -> &Secret {
        &self.webhook_secret
    }

    /// Whether events and accounts here are live-mode ones.
    pub fn livemode(&self) -> bool {
        self.mode == Mode::Live
    }

    /// Where Stripe's form sends the admin when they finish or leave it
    /// (`return`: not proof that anything was completed), and when its
    /// link has expired or been used (`refresh`: ask for a new one).
    pub fn landing(&self, slug: &str, outcome: &str) -> String {
        format!("{}/t/{slug}/settings?stripe={outcome}", self.app_origin)
    }

    /// The donor's page for `slug` (`/give/{slug}`), or a page under it
    /// (`tail`: `"/thanks"`): where Stripe's payment page sends the donor
    /// back to.
    pub fn give_url(&self, slug: &str, tail: &str) -> String {
        format!("{}/give/{slug}{tail}", self.app_origin)
    }

    /// Where the webhook endpoint is, to register at Stripe.
    pub fn webhook_url(&self) -> String {
        format!("{}/api/stripe/webhook", self.app_origin)
    }
}

/// `platform.db`: which Stripe account is which of ours, and the webhook
/// events received.
pub const SCHEMA: PlatformSchema = PlatformSchema {
    name: "stripe",
    steps: &[
        // 1: accounts and the event store.
        //
        // `stripe_accounts`: one row per organisation, kept through a
        // disconnect (`disconnected_at`), so connecting again finds the
        // same account. `account_id` is null until Stripe has made it;
        // `create_key` is that create's idempotency key, so a create
        // whose answer was lost is the same account when tried again.
        // The onboarding columns are Stripe's own answers, as last read.
        //
        // `stripe_events`: every webhook event by Stripe's id. `account_id`
        // is the connected account it names, `tenant_id` the organisation
        // that held that account when it came.
        "CREATE TABLE stripe_accounts (
             tenant_id TEXT PRIMARY KEY REFERENCES tenants (id),
             account_id TEXT UNIQUE,
             create_key TEXT NOT NULL,
             connected_at INTEGER NOT NULL,
             connected_by INTEGER NOT NULL,
             disconnected_at INTEGER,
             details_submitted INTEGER NOT NULL DEFAULT 0,
             charges_enabled INTEGER NOT NULL DEFAULT 0,
             payouts_enabled INTEGER NOT NULL DEFAULT 0,
             requirements_due INTEGER NOT NULL DEFAULT 0,
             disabled_reason TEXT,
             status_at INTEGER
         ) STRICT;
         CREATE TABLE stripe_events (
             id TEXT PRIMARY KEY,
             account_id TEXT,
             tenant_id TEXT REFERENCES tenants (id),
             type TEXT NOT NULL,
             created INTEGER NOT NULL,
             body TEXT NOT NULL,
             received_at INTEGER NOT NULL,
             processed_at INTEGER,
             outcome TEXT,
             attempts INTEGER NOT NULL DEFAULT 0,
             next_attempt_at INTEGER,
             last_error TEXT
         ) STRICT;
         CREATE INDEX stripe_events_pending ON stripe_events (tenant_id)
             WHERE processed_at IS NULL;
         CREATE INDEX stripe_events_by_account ON stripe_events (account_id, outcome);",
        // 2: the catch-up's cursor ([`catchup`]): per organisation, the
        // account it was read for and where the next run reads from (ms).
        "CREATE TABLE stripe_catchup (
             tenant_id TEXT PRIMARY KEY REFERENCES tenants (id),
             account_id TEXT NOT NULL,
             since INTEGER NOT NULL,
             last_run_at INTEGER NOT NULL,
             last_found INTEGER NOT NULL DEFAULT 0
         ) STRICT;",
    ],
};

/// How far the organisation's Stripe account has got.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "StripeOnboarding")]
pub enum Onboarding {
    /// Not connected.
    None,
    /// Stripe's form isn't finished: send the admin back to it.
    Pending,
    /// The form is in, but Stripe isn't taking card payments for the
    /// account (checking it, or asking for more: `requirementsDue`,
    /// `disabledReason`).
    Restricted,
    /// Stripe takes card payments for the account.
    Complete,
}

/// `GET stripe`: whether Stripe is on here, and this organisation's
/// account.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StripeStatus {
    /// False when `KEEP_STRIPE=off`: hide everything Stripe.
    pub enabled: bool,
    pub mode: Mode,
    /// The organisation has a Stripe account here and its events are
    /// routed to it. Not the same as able to take payments:
    /// `chargesEnabled`.
    pub connected: bool,
    /// Stripe's id for the account (`acct_…`).
    pub account_id: Option<String>,
    #[ts(type = "number | null")]
    pub connected_at: Option<i64>,
    /// The platform user who connected it.
    #[ts(type = "number | null")]
    pub connected_by: Option<i64>,
    pub onboarding: Onboarding,
    /// The admin sent Stripe's form in.
    pub details_submitted: bool,
    /// Stripe takes card payments for the account: donations can be taken.
    pub charges_enabled: bool,
    /// Stripe pays out to the organisation's bank account.
    pub payouts_enabled: bool,
    /// How many things Stripe is still asking the organisation for.
    #[ts(type = "number")]
    pub requirements_due: i64,
    /// Stripe's reason the account can't take payments, when it gives one
    /// (`requirements.past_due`, `rejected.fraud`, …).
    pub disabled_reason: Option<String>,
    /// When Stripe last told us any of this (ms).
    #[ts(type = "number | null")]
    pub status_at: Option<i64>,
    /// Webhook events that couldn't be handled and are parked.
    #[ts(type = "number")]
    pub failed_events: i64,
}

impl StripeStatus {
    pub fn new(mode: Mode, row: Option<&accounts::Row>, failed_events: i64) -> Self {
        let row = row.filter(|r| r.connected());
        let onboarding = match row {
            None => Onboarding::None,
            Some(r) if r.charges_enabled => Onboarding::Complete,
            Some(r) if r.details_submitted => Onboarding::Restricted,
            Some(_) => Onboarding::Pending,
        };
        Self {
            enabled: mode != Mode::Off,
            mode,
            connected: row.is_some(),
            account_id: row.and_then(|r| r.account_id.clone()),
            connected_at: row.map(|r| r.connected_at),
            connected_by: row.map(|r| r.connected_by),
            onboarding,
            details_submitted: row.is_some_and(|r| r.details_submitted),
            charges_enabled: row.is_some_and(|r| r.charges_enabled),
            payouts_enabled: row.is_some_and(|r| r.payouts_enabled),
            requirements_due: row.map_or(0, |r| r.requirements_due),
            disabled_reason: row.and_then(|r| r.disabled_reason.clone()),
            status_at: row.and_then(|r| r.status_at),
            failed_events,
        }
    }
}

/// `POST stripe/connect`'s answer: send the admin's browser to `url`,
/// Stripe's form for the account (a link works once and lasts minutes).
/// `url` is null when Stripe is asking for nothing: the account is
/// connected and taking payments.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StripeConnectStart {
    pub url: Option<String>,
    pub status: StripeStatus,
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

    fn boot(pairs: &[(&str, &str)]) -> Result<Option<Stripe>, String> {
        from_vars(
            vars(pairs),
            Origins {
                app_origin: "https://app.example/",
                self_base: "http://127.0.0.1:8787",
            },
        )
    }

    const WEBHOOK: (&str, &str) = ("KEEP_STRIPE_WEBHOOK_SECRET", "whsec_s3cret");

    #[test]
    fn boot_reads_the_mode_and_where_things_go() {
        assert!(boot(&[]).unwrap().is_none());
        assert!(boot(&[("KEEP_STRIPE", "off")]).unwrap().is_none());
        let fake = boot(&[("KEEP_STRIPE", "fake")]).unwrap().unwrap();
        assert_eq!(fake.mode, Mode::Fake);
        assert!(fake.fake.is_some());
        assert!(!fake.livemode());
        assert_eq!(fake.webhook_url(), "https://app.example/api/stripe/webhook");
        assert_eq!(
            fake.landing("alpha", "return"),
            "https://app.example/t/alpha/settings?stripe=return"
        );
        let test = boot(&[
            ("KEEP_STRIPE", "test"),
            ("KEEP_ENV", "staging"),
            ("KEEP_STRIPE_API_KEY", "rk_test_s3cret"),
            WEBHOOK,
        ])
        .unwrap()
        .unwrap();
        assert_eq!(test.mode, Mode::Test);
        assert!(test.fake.is_none());
        let live = boot(&[
            ("KEEP_STRIPE", "live"),
            ("KEEP_ENV", "prod"),
            ("KEEP_STRIPE_API_KEY", "rk_live_s3cret"),
            WEBHOOK,
        ])
        .unwrap()
        .unwrap();
        assert!(live.livemode());
    }

    #[test]
    fn boot_refusals_name_the_variable_never_a_secret() {
        let key = ("KEEP_STRIPE_API_KEY", "rk_test_s3cret");
        for (pairs, needle) in [
            (vec![("KEEP_STRIPE", "on")], "KEEP_STRIPE="),
            (vec![("KEEP_STRIPE", "Live")], "KEEP_STRIPE="),
            (vec![("KEEP_STRIPE", "sandbox")], "KEEP_STRIPE="),
            (
                vec![("KEEP_STRIPE", "fake"), ("KEEP_ENV", "prod")],
                "KEEP_ENV=prod",
            ),
            (
                vec![("KEEP_STRIPE", "test"), ("KEEP_ENV", "prod"), key, WEBHOOK],
                "KEEP_ENV=prod",
            ),
            (
                vec![
                    ("KEEP_STRIPE", "live"),
                    ("KEEP_ENV", "staging"),
                    key,
                    WEBHOOK,
                ],
                "KEEP_ENV=prod",
            ),
            (vec![("KEEP_STRIPE", "live"), key, WEBHOOK], "KEEP_ENV=prod"),
            (
                vec![("KEEP_STRIPE", "test"), WEBHOOK],
                "KEEP_STRIPE_API_KEY",
            ),
            (
                vec![("KEEP_STRIPE", "test"), key],
                "KEEP_STRIPE_WEBHOOK_SECRET",
            ),
            (
                vec![
                    ("KEEP_STRIPE", "test"),
                    ("KEEP_STRIPE_API_KEY", "  "),
                    WEBHOOK,
                ],
                "KEEP_STRIPE_API_KEY",
            ),
            // A key of the other mode.
            (
                vec![
                    ("KEEP_STRIPE", "test"),
                    ("KEEP_STRIPE_API_KEY", "rk_live_s3cret"),
                    WEBHOOK,
                ],
                "test-mode",
            ),
            (
                vec![("KEEP_STRIPE", "live"), ("KEEP_ENV", "prod"), key, WEBHOOK],
                "live-mode",
            ),
        ] {
            let err = boot(&pairs)
                .err()
                .unwrap_or_else(|| panic!("{pairs:?} booted"));
            assert!(err.contains(needle), "{err}");
            assert!(!err.contains("s3cret"), "{err}");
        }
    }

    #[test]
    fn the_qc_account_is_an_account_id_and_never_on_prod() {
        let qc = |id: &'static str| (QC_ACCOUNT_VAR, id);
        let fake = boot(&[("KEEP_STRIPE", "fake")]).unwrap().unwrap();
        assert_eq!(fake.qc_account, None);
        let test = boot(&[
            ("KEEP_STRIPE", "test"),
            ("KEEP_ENV", "staging"),
            ("KEEP_STRIPE_API_KEY", "rk_test_s3cret"),
            WEBHOOK,
            qc(" acct_1QcAccount "),
        ])
        .unwrap()
        .unwrap();
        assert_eq!(test.qc_account.as_deref(), Some("acct_1QcAccount"));
        // Empty is unset.
        let unset = boot(&[("KEEP_STRIPE", "fake"), qc("  ")]).unwrap().unwrap();
        assert_eq!(unset.qc_account, None);
        // Prod refuses it, whatever Stripe's mode: live never has one.
        for stripe in [
            vec![],
            vec![("KEEP_STRIPE", "off")],
            vec![
                ("KEEP_STRIPE", "live"),
                ("KEEP_STRIPE_API_KEY", "rk_live_s3cret"),
                WEBHOOK,
            ],
        ] {
            let mut pairs = stripe;
            pairs.extend([("KEEP_ENV", "prod"), qc("acct_1QcAccount")]);
            let err = boot(&pairs).err().expect("prod took a QC account");
            assert!(err.contains("KEEP_QC_STRIPE_ACCOUNT"), "{err}");
            assert!(err.contains("KEEP_ENV=prod"), "{err}");
        }
        for bad in ["rk_test_s3cret", "acct_", "acct_has space", "acct_a/b"] {
            let err = boot(&[("KEEP_STRIPE", "fake"), (QC_ACCOUNT_VAR, bad)])
                .err()
                .unwrap_or_else(|| panic!("{bad:?} booted"));
            assert!(err.contains("KEEP_QC_STRIPE_ACCOUNT"), "{err}");
            assert!(!err.contains("s3cret"), "{err}");
        }
    }

    #[test]
    fn secrets_never_print() {
        assert!(!format!("{:?}", Secret::new("s3cret")).contains("s3cret"));
    }
}
