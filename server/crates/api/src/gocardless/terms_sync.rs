//! `regular-terms-sync` (ADR 0026): changes to regular gifts' terms reach
//! GoCardless when they fall due. GoCardless has no effective date (an
//! amount change applies to payments it creates afterwards), so a change
//! is held here and sent [`giving::terms::SEND_AHEAD_DAYS`] before its
//! first payment: after the payment before it was created, before its
//! own is. Hourly, and for one organisation straight after a change is
//! saved.
//!
//! For each due row, one at a time in effective order:
//! - if GoCardless already made the payment it was meant for at the old
//!   terms, it moves to the next payment (`applies_from`);
//! - the job takes it (`sending`: from then staff can't edit or withdraw
//!   it), then tells GoCardless: an amount on the same schedule is
//!   amended in place (`PUT subscriptions/{id}`); a new frequency or day,
//!   or an amount change past GoCardless's 10, makes a new subscription
//!   on the same mandate from the effective date (idempotency key
//!   `keep-sub-{term id}`), which becomes the regular gift's, and cancels
//!   the old one;
//! - then `sent`. GoCardless's `amended` event, or the first payment at
//!   the new terms, makes it `applied` ([`super::process`]).
//!
//! A row left `sending` (GoCardless unreachable, a crash) is finished on
//! the next run: an amendment is checked against the subscription's
//! amount first, and a new subscription is made once whatever the
//! retries. GoCardless emails the donor the advance notice.

use std::sync::Arc;
use std::time::Duration;

use contracts::{ContractError, Source};
use giving::regular::{self, Frequency};
use giving::terms::{self, DueTerm, SyncState, TermStatus, TermView};
use giving::terms_rules;
use store::{Store, TenantId};

use super::GoCardless;
use super::client::{CallError, NewSubscription};
use super::process::{Failed, Org, connected_tenants, open_org};
use crate::jobs::Job;

const MONTHS: [&str; 12] = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

/// Send what is due on `today` (ISO) for every connected organisation,
/// one at a time. How many rows were sent; one organisation's failure is
/// reported and the rest go on.
pub async fn sync_all(
    store: Arc<Store>,
    gc: Arc<GoCardless>,
    today: &str,
) -> Result<usize, String> {
    let _run = gc.terms_syncing.lock().await;
    let mut sent = 0;
    let mut errors = Vec::new();
    for tenant in connected_tenants(&store).await? {
        match one(&store, &gc, &tenant, today).await {
            Ok(n) => sent += n,
            Err(e) => errors.push(format!("{tenant}: {e}")),
        }
    }
    if errors.is_empty() {
        Ok(sent)
    } else {
        Err(errors.join("; "))
    }
}

/// The same for one organisation (after a change is saved).
pub async fn sync_tenant(
    store: Arc<Store>,
    gc: Arc<GoCardless>,
    tenant: TenantId,
    today: &str,
) -> Result<usize, String> {
    let _run = gc.terms_syncing.lock().await;
    let connected = connected_tenants(&store).await?;
    if !connected.contains(&tenant) {
        return Ok(0);
    }
    one(&store, &gc, &tenant, today).await
}

async fn one(
    store: &Arc<Store>,
    gc: &Arc<GoCardless>,
    tenant: &TenantId,
    today: &str,
) -> Result<usize, String> {
    let org = open_org(store, gc, tenant)
        .await
        .map_err(|e| format!("{e:?}"))?;
    let day = today.to_owned();
    let due = org
        .read(move |c| terms::due(c, &day))
        .await
        .map_err(|e| format!("{e:?}"))?;
    let mut sent = 0;
    for d in due {
        match send(&org, gc, &d, today).await {
            Ok(true) => sent += 1,
            Ok(false) => {}
            // Reported; the row stays as it is and is tried next run.
            Err(Failed::Retry(e) | Failed::Permanent(e)) => {
                crate::observe::error(&format!(
                    "regular-terms-sync: {tenant} change {}: {e}",
                    d.term_id
                ));
            }
        }
    }
    Ok(sent)
}

/// Whether `t` needs a new subscription after `before` (the terms
/// GoCardless runs): a new frequency, day or month.
fn new_schedule(before: &TermView, t: &TermView) -> bool {
    (before.frequency, before.day_of_month, before.month) != (t.frequency, t.day_of_month, t.month)
}

/// Send one due row. Whether it was sent now.
async fn send(org: &Org, gc: &GoCardless, d: &DueTerm, today: &str) -> Result<bool, Failed> {
    let (rid, tid) = (d.regular_gift_id.clone(), d.term_id.clone());
    let (facts, chain) = org
        .read(move |c| Ok((regular::facts(c, &rid)?, terms::chain(c, &rid)?)))
        .await?;
    let (Some(facts), Some(t)) = (facts, chain.iter().find(|t| t.id == tid).cloned()) else {
        return Ok(false);
    };
    // Waiting for its first subscription (the donor hasn't signed yet).
    let Some(sub) = facts.mandate.subscription_id.clone() else {
        return Ok(false);
    };
    // What GoCardless runs before this row.
    let Some(before) = chain
        .iter()
        .rfind(|r| {
            r.is_live()
                && r.id != t.id
                && r.status != TermStatus::Scheduled
                && r.effective_on <= t.effective_on
        })
        .cloned()
    else {
        return Ok(false);
    };
    let s = sub.clone();
    let amended = org.read(move |c| terms::amendments(c, &s)).await?;
    // The subscription a new one replaces: the one the row before ran
    // under (on a retry, the regular gift's may be the new one already).
    let old = before
        .subscription_id
        .clone()
        .unwrap_or_else(|| sub.clone());
    let recreate = new_schedule(&before, &t)
        || (t.status == TermStatus::Scheduled && amended >= terms::AMENDMENT_LIMIT);
    let mut t = t;
    if t.status == TermStatus::Scheduled {
        // Take it: from now staff can't edit or withdraw it. If its
        // payment exists already at the old terms, it starts on the next.
        let (rid, tid, sb) = (facts.id.clone(), t.id.clone(), sub.clone());
        let now = contracts::now_ms();
        let taken = org
            .write(move |ctx| {
                let conn = ctx.tx.read();
                let current = terms::get_term(conn, &tid)?.ok_or(ContractError::NotFound)?;
                if current.status != TermStatus::Scheduled {
                    return Ok(None);
                }
                let moved = match terms::payment_on_or_after(conn, &rid, &current.effective_on)? {
                    Some((date, amount)) if amount != current.amount => {
                        terms_rules::next_due(&current.rules(), &date, 1).pop()
                    }
                    _ => None,
                };
                terms::update_sync(ctx, &tid, None, |s| {
                    s.state = SyncState::Sending;
                    s.sent_at = Some(now);
                    s.subscription_id = (!recreate).then_some(sb);
                    if moved.is_some() {
                        s.applies_from = moved;
                    }
                })?;
                Ok(terms::get_term(ctx.tx.read(), &tid)?)
            })
            .await?;
        let Some(taken) = taken else {
            return Ok(false);
        };
        t = taken;
    }
    let token = org.token()?.to_owned();
    if !recreate && t.subscription_id.is_some() {
        let at = gc.api.get_subscription(&token, &sub).await?;
        if at.amount != t.amount {
            match gc.api.update_subscription(&token, &sub, t.amount).await {
                Ok(_) => {}
                Err(CallError::Refused {
                    reason: Some(reason),
                    ..
                }) if reason == "number_of_subscription_amendments_exceeded" => {
                    return replace(org, gc, &facts, &t, &old, today).await;
                }
                Err(e) => return Err(e.into()),
            }
        }
        mark_sent(org, &t.id).await?;
        return Ok(true);
    }
    replace(org, gc, &facts, &t, &old, today).await
}

/// A new subscription on the same mandate from the row's date (once,
/// whatever the retries: the key is the row's), recorded as the regular
/// gift's and the row's, then the old one cancelled.
async fn replace(
    org: &Org,
    gc: &GoCardless,
    facts: &regular::RegularFacts,
    t: &TermView,
    old: &str,
    today: &str,
) -> Result<bool, Failed> {
    let token = org.token()?.to_owned();
    let mandate = match &facts.mandate.mandate_id {
        Some(md) => md.clone(),
        // Adopted from GoCardless: the subscription knows its mandate.
        None => gc
            .api
            .get_subscription(&token, old)
            .await?
            .mandate
            .ok_or_else(|| Failed::Permanent("the subscription names no mandate".into()))?,
    };
    // Never a start before GoCardless could charge.
    let earliest = terms_rules::add_days(today, 3).unwrap_or_default();
    let start = if t.effective_on < earliest {
        terms_rules::next_due(&t.rules(), &earliest, 1)
            .pop()
            .unwrap_or_else(|| t.effective_on.clone())
    } else {
        t.effective_on.clone()
    };
    let name = format!("Regular gift {}", giving::format_pence(t.amount));
    let new = gc
        .api
        .create_subscription(
            &token,
            &NewSubscription {
                mandate: &mandate,
                amount: t.amount,
                interval_unit: t.frequency.as_str(),
                day_of_month: t.day_of_month,
                month: match t.frequency {
                    Frequency::Monthly => None,
                    Frequency::Yearly => t
                        .month
                        .and_then(|m| MONTHS.get(usize::from(m).wrapping_sub(1)).copied()),
                },
                name: &name,
                regular_gift: &facts.id,
                start_date: Some(&start),
                key: Some(&t.id),
            },
        )
        .await?;
    let (rid, tid, sb) = (facts.id.clone(), t.id.clone(), new.clone());
    let moved = (start != t.effective_on).then_some(start);
    org.write(move |ctx| {
        regular::update_mandate(ctx, &rid, None, Source::System, None, |m| {
            m.subscription_id = Some(sb.clone())
        })?;
        terms::update_sync(ctx, &tid, None, |s| {
            s.subscription_id = Some(sb);
            if s.state == SyncState::Sending {
                s.state = SyncState::Sent;
            }
            if moved.is_some() {
                s.applies_from = moved;
            }
        })?;
        Ok(())
    })
    .await?;
    if old != new {
        gc.api.cancel_subscription(&token, old).await?;
    }
    Ok(true)
}

async fn mark_sent(org: &Org, term: &str) -> Result<(), Failed> {
    let tid = term.to_owned();
    org.write(move |ctx| {
        terms::update_sync(ctx, &tid, None, |s| {
            if s.state == SyncState::Sending {
                s.state = SyncState::Sent;
            }
        })?;
        Ok(())
    })
    .await
}

/// `regular-terms-sync`: hourly.
pub struct TermsSyncJob {
    pub store: Arc<Store>,
    pub gc: Arc<GoCardless>,
}

impl Job for TermsSyncJob {
    fn name(&self) -> &'static str {
        "regular-terms-sync"
    }
    fn every(&self) -> Duration {
        Duration::from_secs(60 * 60)
    }
    fn first_after(&self) -> Duration {
        Duration::from_secs(10 * 60)
    }
    fn run(&self) -> std::pin::Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async move {
            let today = terms_rules::date_of_ms(contracts::now_ms());
            sync_all(self.store.clone(), self.gc.clone(), &today).await?;
            Ok(())
        })
    }
}
