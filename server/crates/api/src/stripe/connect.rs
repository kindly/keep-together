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
//!    answer was lost makes the same account when the admin tries again
//!    (Stripe keeps keys a day; v2's, 30);
//! 2. the account it already has is read from Stripe, or a new one made
//!    and then read. An account Stripe says isn't ours any more (`403
//!    account_invalid`: a sandbox wiped, another mode's id, the owner
//!    removed us) is forgotten and a new one made;
//! 3. the organisation is recorded as connected to it, with what Stripe
//!    says of it now, and the events kept while it wasn't are requeued;
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
    pub name: String,
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

    // The account it has, as Stripe has it now.
    let mut account = None;
    if let Some(id) = row.account_id.clone() {
        match stripe.api.get_account(&id).await {
            Ok(a) => account = Some(a),
            Err(e) if e.account_gone() => {
                crate::observe::warning(&format!(
                    "stripe connect ({}): account {id} is no longer ours at Stripe: \
                     making a new one",
                    org.slug
                ));
                let (s, t) = (store.clone(), org.tenant.clone());
                row = blocking(move || {
                    accounts::forget_account(&s, &t, &id)?;
                    accounts::reserve(&s, &t, user, now)
                })
                .await?;
            }
            Err(e) => return Err(unavailable(&org.slug, "reading the account", e)),
        }
    }
    let account = match account {
        Some(a) => a,
        None => {
            let id = stripe
                .api
                .create_account(&org.name, org.tenant.as_str(), &row.create_key)
                .await
                .map_err(|e| unavailable(&org.slug, "making the account", e))?;
            stripe
                .api
                .get_account(&id)
                .await
                .map_err(|e| unavailable(&org.slug, "reading the new account", e))?
        }
    };

    // No processing run between the organisation becoming connected and
    // its kept events going back in the queue: one transaction does both,
    // and runs are held off while it lands.
    let row = {
        let _processing = stripe.processing.lock().await;
        let (s, t, a) = (store.clone(), org.tenant.clone(), account.clone());
        blocking(move || accounts::connect(&s, &t, &a, user, now)).await?
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
