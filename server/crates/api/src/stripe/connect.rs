//! Connecting an organisation to Stripe, and disconnecting it
//! (`Tenant::stripe_connect`, `stripe_disconnect`, `stripe_status`: the
//! routes are in `routes::stripe`).
//!
//! **Connect** is Stripe-hosted onboarding only: we make a Stripe account
//! for the organisation and send its admin to Stripe's own form. There
//! is no OAuth, so an account the organisation already had can't be
//! connected. One connect or disconnect at a time, in this order:
//!
//! 1. the organisation's row is reserved in `platform.db` with the
//!    idempotency key its account will be made under, so a create whose
//!    answer never reached us makes the same account when the admin
//!    tries again (Stripe keeps keys a day; v2's, 30). Stripe also
//!    answers a *failed* create again under its key (a 500 included),
//!    so a create Stripe refused or failed gets a new key for the next
//!    try; only no answer, a 429 or a 409 keeps it;
//! 2. the account is made if it has none, and its id stored the moment
//!    Stripe answers. Then it is read from Stripe. An account Stripe
//!    says isn't ours any more (`403 account_invalid`: a sandbox wiped,
//!    another mode's id, the owner removed us) is forgotten and a new
//!    one made;
//! 3. the organisation is recorded as connected to it, with what Stripe
//!    says of it now, and the events kept while it wasn't are requeued
//!    (read and recorded with event runs held off, so an older reading
//!    never lands on a newer one);
//! 4. unless Stripe already takes payments for it, a link to its form is
//!    made and answered. A link works once and lasts minutes, so every
//!    press of "Connect Stripe" (or "Continue") makes another. Stripe
//!    sends the browser back to the group's settings with
//!    `?stripe=return` (finished or left: proof of nothing, the state
//!    comes from `account.updated`) or `?stripe=refresh` (the link was
//!    spent or expired: ask for a new one).
//!
//! Stripe failing or unreachable at any step is `503 stripe_unavailable`;
//! what was reserved stays, and the next try carries on from it.
//!
//! **Disconnect** forgets the routing on our side and calls nothing: the
//! account is the organisation's own and stays so (a live account with
//! the full Dashboard can't be deleted by a platform anyway). Its events
//! from then on are kept, not run, and connecting again is the same
//! account, replaying them in order.

use std::sync::Arc;

use store::{Store, TenantId};

use super::client::CallError;
use super::{Stripe, StripeConnectStart, StripeStatus, accounts, process};
use crate::{ApiError, blocking};

/// The organisation as a connect needs it.
pub struct Org {
    pub tenant: TenantId,
    pub slug: String,
    /// The admin connecting.
    pub user: i64,
}

fn unavailable(slug: &str, what: &str, e: CallError) -> ApiError {
    // The status and Stripe's error code only.
    crate::observe::warning(&format!("stripe connect ({slug}): {what}: {e}"));
    ApiError::StripeUnavailable
}

/// `GET stripe`: on or off here, and this organisation's account.
pub async fn status(
    store: &Arc<Store>,
    stripe: Option<&Arc<Stripe>>,
    tenant: &TenantId,
) -> Result<StripeStatus, ApiError> {
    let Some(stripe) = stripe else {
        return Ok(StripeStatus::new(super::Mode::Off, None, 0));
    };
    let (s, t) = (store.clone(), tenant.clone());
    let (row, failed) = blocking(move || {
        Ok::<_, ApiError>((accounts::account(&s, &t)?, process::failed_count(&s, &t)?))
    })
    .await?;
    Ok(StripeStatus::new(stripe.mode, row.as_ref(), failed))
}

/// `POST stripe/connect` (module docs). The caller has checked the admin.
pub async fn start(
    store: &Arc<Store>,
    stripe: &Arc<Stripe>,
    org: Org,
) -> Result<StripeConnectStart, ApiError> {
    let _connecting = stripe.connecting.lock().await;
    let now = contracts::now_ms();
    let (s, t, user) = (store.clone(), org.tenant.clone(), org.user);
    let mut row = blocking(move || accounts::reserve(&s, &t, user, now)).await?;

    // At most twice round: the account it had may turn out not to be
    // ours any more, and then a new one is made.
    let mut replaced = false;
    let (row, account) = loop {
        let id = match row.account_id.clone() {
            Some(id) => id,
            None => make_account(store, stripe, &org, &row.create_key, now).await?,
        };
        // Read and recorded with processing runs held off: no run
        // between the organisation becoming connected and its kept
        // events going back in the queue, and no `account.updated` run
        // can store a newer reading that this older one then overwrites.
        let _processing = stripe.processing.lock().await;
        match stripe.api.get_account(&id).await {
            Ok(account) => {
                let (s, t, a) = (store.clone(), org.tenant.clone(), account.clone());
                let row = blocking(move || accounts::connect(&s, &t, &a, user, now)).await?;
                break (row, account);
            }
            Err(e) if e.account_gone() && !replaced => {
                crate::observe::warning(&format!(
                    "stripe connect ({}): account {id} is no longer ours at Stripe: \
                     making a new one",
                    org.slug
                ));
                replaced = true;
                let (s, t) = (store.clone(), org.tenant.clone());
                row = blocking(move || {
                    accounts::forget_account(&s, &t, &id)?;
                    accounts::reserve(&s, &t, user, now)
                })
                .await?;
            }
            Err(e) => return Err(unavailable(&org.slug, "reading the account", e)),
        }
    };
    if row.account_id.as_deref() != Some(&account.id) {
        // The row named another account by the time we wrote: a connect
        // from another process. Nothing of ours to answer with.
        return Err(ApiError::internal(format!(
            "stripe connect ({}): the organisation's account changed under the connect",
            org.slug
        )));
    }
    super::webhook::spawn_processing(store.clone(), stripe.clone());

    let url = if account.charges_enabled && account.details_submitted {
        None
    } else {
        Some(
            stripe
                .api
                .create_onboarding_link(
                    &account.id,
                    &stripe.landing(&org.slug, "refresh"),
                    &stripe.landing(&org.slug, "return"),
                )
                .await
                .map_err(|e| unavailable(&org.slug, "making the onboarding link", e))?,
        )
    };
    let (s, t) = (store.clone(), org.tenant.clone());
    let failed = blocking(move || process::failed_count(&s, &t)).await?;
    Ok(StripeConnectStart {
        url,
        status: StripeStatus::new(stripe.mode, Some(&row), failed),
    })
}

/// Make the organisation's account at Stripe under `create_key`, and
/// store its id at once: from here on the account is found by the id we
/// hold, not by an idempotency key Stripe forgets in time. A create that
/// failed for good gets a new key for the next try.
async fn make_account(
    store: &Arc<Store>,
    stripe: &Arc<Stripe>,
    org: &Org,
    create_key: &str,
    now: i64,
) -> Result<String, ApiError> {
    let id = match stripe
        .api
        .create_account(org.tenant.as_str(), create_key)
        .await
    {
        Ok(id) => id,
        Err(e) => {
            if !e.same_key_again() {
                let (s, t) = (store.clone(), org.tenant.clone());
                blocking(move || accounts::renew_key(&s, &t)).await?;
            }
            return Err(unavailable(&org.slug, "making the account", e));
        }
    };
    // As Stripe makes it: nothing sent in, nothing enabled. What Stripe
    // says of it is read next; if that read fails the account is still
    // ours and the next try reads it.
    let blank = super::client::Account {
        id: id.clone(),
        details_submitted: false,
        charges_enabled: false,
        payouts_enabled: false,
        requirements_due: 0,
        disabled_reason: None,
    };
    let _processing = stripe.processing.lock().await;
    let (s, t, user) = (store.clone(), org.tenant.clone(), org.user);
    blocking(move || accounts::connect(&s, &t, &blank, user, now)).await?;
    Ok(id)
}

/// `POST stripe/disconnect` (module docs). The caller has checked the
/// admin.
pub async fn disconnect(
    store: &Arc<Store>,
    stripe: &Arc<Stripe>,
    tenant: &TenantId,
) -> Result<StripeStatus, ApiError> {
    let _connecting = stripe.connecting.lock().await;
    let (s, t) = (store.clone(), tenant.clone());
    blocking(move || accounts::disconnect(&s, &t, contracts::now_ms())).await?;
    status(store, Some(stripe), tenant).await
}
