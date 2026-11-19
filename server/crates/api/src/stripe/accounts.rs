//! `stripe_accounts` in `platform.db`: which Stripe account is which
//! organisation's, and how far its onboarding has got.
//!
//! One row per organisation, and an account is only ever one
//! organisation's (we made it for them; there is no OAuth, so no account
//! arrives from elsewhere). "Connected" is a row with an account id and
//! no `disconnected_at`: only then are the account's events run.
//! Disconnecting keeps the row, so connecting again is the same account
//! and the events that came meanwhile are replayed.

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use store::{Store, StoreError, TenantId};

use super::client::Account;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    /// None until Stripe has made the account.
    pub account_id: Option<String>,
    /// The idempotency key of the create that makes (or made) it.
    pub create_key: String,
    pub connected_at: i64,
    pub connected_by: i64,
    pub disconnected_at: Option<i64>,
    pub details_submitted: bool,
    pub charges_enabled: bool,
    pub payouts_enabled: bool,
    pub requirements_due: i64,
    pub disabled_reason: Option<String>,
    pub status_at: Option<i64>,
}

impl Row {
    /// The organisation holds this account and its events are run.
    pub fn connected(&self) -> bool {
        self.account_id.is_some() && self.disconnected_at.is_none()
    }

    /// The account, while connected.
    pub fn live_account(&self) -> Option<&str> {
        self.account_id.as_deref().filter(|_| self.connected())
    }
}

const COLUMNS: &str = "account_id, create_key, connected_at, connected_by, disconnected_at,
    details_submitted, charges_enabled, payouts_enabled, requirements_due, disabled_reason,
    status_at";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Row> {
    Ok(Row {
        account_id: r.get(0)?,
        create_key: r.get(1)?,
        connected_at: r.get(2)?,
        connected_by: r.get(3)?,
        disconnected_at: r.get(4)?,
        details_submitted: r.get(5)?,
        charges_enabled: r.get(6)?,
        payouts_enabled: r.get(7)?,
        requirements_due: r.get(8)?,
        disabled_reason: r.get(9)?,
        status_at: r.get(10)?,
    })
}

pub fn get(conn: &Connection, tenant: &TenantId) -> rusqlite::Result<Option<Row>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM stripe_accounts WHERE tenant_id = ?1"),
        [tenant.as_str()],
        row,
    )
    .optional()
}

/// The organisation's row, connected or not.
pub fn account(store: &Store, tenant: &TenantId) -> Result<Option<Row>, StoreError> {
    store.platform().with_read(|c| Ok(get(c, tenant)?))
}

/// The organisation's Stripe account id while it is connected: what a
/// call on its behalf sends as `Stripe-Account`.
pub fn connected_account(store: &Store, tenant: &TenantId) -> Result<Option<String>, StoreError> {
    Ok(account(store, tenant)?.and_then(|r| r.live_account().map(str::to_owned)))
}

/// Our organisation for a Stripe account id, if it is connected.
pub fn tenant_for(store: &Store, account_id: &str) -> Result<Option<TenantId>, StoreError> {
    let id: Option<String> = store.platform().with_read(|c| {
        Ok::<_, StoreError>(
            c.query_row(
                "SELECT tenant_id FROM stripe_accounts
                 WHERE account_id = ?1 AND disconnected_at IS NULL",
                [account_id],
                |r| r.get(0),
            )
            .optional()?,
        )
    })?;
    match id {
        Some(id) => crate::gocardless::known_tenant(store, &id),
        None => Ok(None),
    }
}

/// The organisation's row, made if it has none (no account yet, its
/// create key chosen), so the create that follows is the same create
/// however often it is tried.
pub fn reserve(store: &Store, tenant: &TenantId, user: i64, now: i64) -> Result<Row, StoreError> {
    store.platform().with_write(|tx| {
        tx.execute(
            "INSERT OR IGNORE INTO stripe_accounts (tenant_id, create_key, connected_at,
                 connected_by)
             VALUES (?1, ?2, ?3, ?4)",
            params![tenant.as_str(), new_key(), now, user],
        )?;
        Ok(get(tx, tenant)?.expect("just inserted"))
    })
}

fn new_key() -> String {
    format!("keep-account-{}", uuid::Uuid::new_v4().simple())
}

/// A new create key for an organisation with no account yet: the create
/// under the old one failed in a way Stripe answers again for as long as
/// it keeps the key ([`super::client::CallError::same_key_again`]).
pub fn renew_key(store: &Store, tenant: &TenantId) -> Result<(), StoreError> {
    store.platform().with_write(|tx| {
        tx.execute(
            "UPDATE stripe_accounts SET create_key = ?2
             WHERE tenant_id = ?1 AND account_id IS NULL",
            params![tenant.as_str(), new_key()],
        )?;
        Ok(())
    })
}

/// Forget an account Stripe no longer knows as ours (a sandbox wiped, a
/// change of mode): the row is as new, with a new create key. Only if
/// the row still names `account_id`.
pub fn forget_account(
    store: &Store,
    tenant: &TenantId,
    account_id: &str,
) -> Result<(), StoreError> {
    store.platform().with_write(|tx| {
        tx.execute(
            "UPDATE stripe_accounts SET account_id = NULL, create_key = ?3,
                 details_submitted = 0, charges_enabled = 0, payouts_enabled = 0,
                 requirements_due = 0, disabled_reason = NULL, status_at = NULL
             WHERE tenant_id = ?1 AND account_id = ?2",
            params![tenant.as_str(), account_id, new_key()],
        )?;
        Ok(())
    })
}

/// Record the organisation as connected to `account` (just made, or the
/// one it had), with what Stripe says of it now, and put back in the
/// queue the events kept while it wasn't. A connect after a disconnect is
/// a new connection (who and when); one that only carries on with the
/// form isn't.
pub fn connect(
    store: &Store,
    tenant: &TenantId,
    account: &Account,
    user: i64,
    now: i64,
) -> Result<Row, StoreError> {
    store.platform().with_write(|tx| {
        tx.execute(
            "UPDATE stripe_accounts SET
                 connected_at = CASE WHEN account_id IS NULL OR disconnected_at IS NOT NULL
                     THEN ?3 ELSE connected_at END,
                 connected_by = CASE WHEN account_id IS NULL OR disconnected_at IS NOT NULL
                     THEN ?4 ELSE connected_by END,
                 account_id = ?2, disconnected_at = NULL
             WHERE tenant_id = ?1 AND (account_id IS NULL OR account_id = ?2)",
            params![tenant.as_str(), account.id, now, user],
        )?;
        set_status(tx, account, now)?;
        requeue_set_aside(tx, tenant, &account.id)?;
        Ok(get(tx, tenant)?.expect("reserved before connecting"))
    })
}

/// What Stripe says of `account` now, onto its row (whoever holds it,
/// connected or not). Whether a row took it.
pub fn set_status(tx: &Transaction, account: &Account, now: i64) -> rusqlite::Result<bool> {
    Ok(tx.execute(
        "UPDATE stripe_accounts SET details_submitted = ?2, charges_enabled = ?3,
             payouts_enabled = ?4, requirements_due = ?5, disabled_reason = ?6, status_at = ?7
         WHERE account_id = ?1",
        params![
            account.id,
            account.details_submitted,
            account.charges_enabled,
            account.payouts_enabled,
            account.requirements_due,
            account.disabled_reason,
            now
        ],
    )? > 0)
}

/// Disconnect: the routing is forgotten, the row and the account stay.
/// Whether it was connected.
pub fn disconnect(store: &Store, tenant: &TenantId, now: i64) -> Result<bool, StoreError> {
    store.platform().with_write(|tx| {
        Ok(tx.execute(
            "UPDATE stripe_accounts SET disconnected_at = ?2
             WHERE tenant_id = ?1 AND account_id IS NOT NULL AND disconnected_at IS NULL",
            params![tenant.as_str(), now],
        )? > 0)
    })
}

/// The events kept for `account_id` while this organisation wasn't
/// connected to it, back in the queue in arrival order: those set aside
/// (`not_connected`), and those that came before we had stored the id
/// Stripe gave the account (`unknown_account`; the account was made for
/// this organisation and no other). How many.
pub fn requeue_set_aside(
    tx: &Transaction,
    tenant: &TenantId,
    account_id: &str,
) -> rusqlite::Result<usize> {
    tx.execute(
        "UPDATE stripe_events SET tenant_id = ?1, processed_at = NULL, outcome = NULL,
             attempts = 0, next_attempt_at = NULL, last_error = NULL
         WHERE account_id = ?2
           AND ((outcome = 'not_connected' AND tenant_id = ?1) OR outcome = 'unknown_account')",
        params![tenant.as_str(), account_id],
    )
}
