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

use std::collections::HashSet;
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
        match one(&store, &gc, &tenant, today, true).await {
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

/// The same for one organisation. `finish_sending`: also finish rows a
/// run took and didn't finish (the hourly job's work); after a change is
/// saved only what is newly due is sent, and a gift with a row still
/// being sent is left to the job.
pub async fn sync_tenant(
    store: Arc<Store>,
    gc: Arc<GoCardless>,
    tenant: TenantId,
    today: &str,
    finish_sending: bool,
) -> Result<usize, String> {
    let _run = gc.terms_syncing.lock().await;
    let connected = connected_tenants(&store).await?;
    if !connected.contains(&tenant) {
        return Ok(0);
    }
    one(&store, &gc, &tenant, today, finish_sending).await
}

async fn one(
    store: &Arc<Store>,
    gc: &Arc<GoCardless>,
    tenant: &TenantId,
    today: &str,
    finish_sending: bool,
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
    // A gift whose earlier row didn't go through this run sends none of
    // its later rows (review M4): they would land on the wrong
    // subscription or overtake it.
    let mut held: HashSet<String> = HashSet::new();
    for d in due {
        if held.contains(&d.regular_gift_id) {
            continue;
        }
        if d.sending && !finish_sending {
            held.insert(d.regular_gift_id.clone());
            continue;
        }
        match send(&org, gc, &d, today).await {
            Ok(Sent::Yes) => sent += 1,
            Ok(Sent::Done) => {}
            Ok(Sent::Waiting) => {
                held.insert(d.regular_gift_id.clone());
            }
            // Reported; the row stays as it is and is tried next run.
            Err(Failed::Retry(e) | Failed::Permanent(e)) => {
                held.insert(d.regular_gift_id.clone());
                crate::observe::error(&format!(
                    "regular-terms-sync: {tenant} change {}: {e}",
                    d.term_id
                ));
            }
        }
    }
    Ok(sent)
}

/// What sending one row came to.
enum Sent {
    /// GoCardless has it now.
    Yes,
    /// Nothing more to do for it (finished, refused for good, or its gift
    /// ended).
    Done,
    /// Not yet (no subscription yet, or another run took it): its gift's
    /// later rows wait too.
    Waiting,
}

/// Whether `t` needs a new subscription after `before` (the terms
/// GoCardless runs): a new frequency, day or month.
fn new_schedule(before: &TermView, t: &TermView) -> bool {
    (before.frequency, before.day_of_month, before.month) != (t.frequency, t.day_of_month, t.month)
}

/// GoCardless said no to this request itself (a 4xx other than a rate
/// limit): no retry mends it. A refused token, an outage or a garbled
/// answer is retried.
fn refused_for_good(e: &CallError) -> bool {
    matches!(e, CallError::Refused { status, .. } if *status < 500 && *status != 429)
}

/// GoCardless refused the row for good: back to `scheduled` with why,
/// for staff to edit or withdraw; the job tries again only once it is
/// edited (review M6).
async fn refused(org: &Org, t: &TermView, why: String) -> Result<Sent, Failed> {
    let (tid, version) = (t.id.clone(), t.terms_version);
    org.write(move |ctx| {
        terms::update_sync(ctx, &tid, None, |s| {
            s.state = SyncState::Scheduled;
            s.sent_at = None;
            s.error = Some(why);
            s.error_terms_version = Some(version);
        })?;
        Ok(())
    })
    .await?;
    // Its later rows wait: they would run on terms GoCardless never had.
    Ok(Sent::Waiting)
}

/// Send one due row.
async fn send(org: &Org, gc: &GoCardless, d: &DueTerm, today: &str) -> Result<Sent, Failed> {
    let (rid, tid) = (d.regular_gift_id.clone(), d.term_id.clone());
    let (facts, chain) = org
        .read(move |c| Ok((regular::facts(c, &rid)?, terms::chain(c, &rid)?)))
        .await?;
    let (Some(facts), Some(t)) = (facts, chain.iter().find(|t| t.id == tid).cloned()) else {
        return Ok(Sent::Done);
    };
    // What GoCardless runs before this row: never a row still being
    // sent.
    let before = chain
        .iter()
        .rfind(|r| {
            r.is_live()
                && r.id != t.id
                && matches!(r.status, TermStatus::Applied | TermStatus::Sent)
                && r.effective_on <= t.effective_on
        })
        .cloned();
    // The subscription a new one replaces: the one the row before ran
    // under (on a retry, the regular gift's may be the new one already).
    let old = before
        .as_ref()
        .and_then(|b| b.subscription_id.clone())
        .or_else(|| facts.mandate.subscription_id.clone());
    if facts.mandate.status().is_ended() {
        // Ended while the job was sending it: undo a new subscription it
        // made, and finish the row (review M5, L5).
        // A new subscription in flight (the row isn't under the old one):
        // cancel it, found again by the row's key if a crash lost its id
        // (round 2, R2), and the old one too, which a failed cancel may
        // have left live (R1).
        if t.status == TermStatus::Sending && t.subscription_id != old {
            let token = org.token()?.to_owned();
            let made = match &t.subscription_id {
                Some(made) => Some(made.clone()),
                None => match old.as_deref() {
                    Some(o) => match create(gc, &token, &facts, &t, o, &t.effective_on).await? {
                        Some(Ok(made)) => Some(made),
                        // Nothing was made, and the mandate takes none now.
                        Some(Err(e)) if refused_for_good(&e) => None,
                        Some(Err(e)) => return Err(e.into()),
                        None => None,
                    },
                    None => None,
                },
            };
            for sb in made.iter().chain(old.iter()) {
                gc.api.cancel_subscription(&token, sb).await?;
            }
        }
        if t.status == TermStatus::Sending {
            mark_sent(org, &t.id).await?;
        }
        return Ok(Sent::Done);
    }
    // An earlier row GoCardless refused, back with staff: this one waits
    // for it (round 2).
    if chain.iter().any(|r| {
        r.status == TermStatus::Scheduled
            && r.sync_error.is_some()
            && r.id != t.id
            && r.effective_on <= t.effective_on
    }) {
        return Ok(Sent::Waiting);
    }
    // Waiting for its first subscription (the donor hasn't signed yet).
    let (Some(sub), Some(before), Some(old)) = (facts.mandate.subscription_id.clone(), before, old)
    else {
        return Ok(Sent::Waiting);
    };
    let s = old.clone();
    let amended = org.read(move |c| terms::amendments(c, &s)).await?;
    let recreate = match t.status {
        TermStatus::Scheduled => new_schedule(&before, &t) || amended >= terms::AMENDMENT_LIMIT,
        // Taken already: a new subscription was (being) made unless the
        // row runs under the old one.
        _ => t.subscription_id.as_deref() != Some(old.as_str()),
    };
    let mut t = t;
    if t.status == TermStatus::Scheduled {
        // Take it: from now staff can't edit or withdraw it. If its
        // payment exists already at the old terms (or on the old
        // schedule), it starts on the next.
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
                    Some((date, amount)) if amount != current.amount || recreate => {
                        terms_rules::next_due(&current.rules(), &date, 1).pop()
                    }
                    _ => None,
                };
                terms::update_sync(ctx, &tid, None, |s| {
                    s.state = SyncState::Sending;
                    s.sent_at = Some(now);
                    s.subscription_id = (!recreate).then_some(sb);
                    s.error = None;
                    s.error_terms_version = None;
                    if moved.is_some() {
                        s.applies_from = moved;
                    }
                })?;
                Ok(terms::get_term(ctx.tx.read(), &tid)?)
            })
            .await?;
        let Some(taken) = taken else {
            return Ok(Sent::Waiting);
        };
        t = taken;
    }
    if recreate {
        return replace(org, gc, &facts, &t, &old, today).await;
    }
    let token = org.token()?.to_owned();
    let at = match gc.api.get_subscription(&token, &sub).await {
        Ok(at) => at,
        Err(e) if refused_for_good(&e) => {
            return refused(org, &t, format!("GoCardless: {e}")).await;
        }
        Err(e) => return Err(e.into()),
    };
    if at.amount != t.amount {
        match gc.api.update_subscription(&token, &sub, t.amount).await {
            Ok(_) => {}
            Err(CallError::Refused {
                reason: Some(reason),
                ..
            }) if reason == "number_of_subscription_amendments_exceeded" => {
                // A new subscription after all: the row is taken under the
                // old one, so say it isn't before replacing.
                let tid = t.id.clone();
                org.write(move |ctx| {
                    terms::update_sync(ctx, &tid, None, |s| s.subscription_id = None)?;
                    Ok(())
                })
                .await?;
                return replace(org, gc, &facts, &t, &old, today).await;
            }
            Err(e) if refused_for_good(&e) => {
                return refused(org, &t, format!("GoCardless: {e}")).await;
            }
            Err(e) => return Err(e.into()),
        }
    }
    mark_sent(org, &t.id).await?;
    Ok(Sent::Yes)
}

/// The first date the new subscription charges: the row's own payment
/// date on its schedule (never a weekend-moved one: GoCardless takes
/// `start_date` on `day_of_month`), and never sooner than GoCardless
/// could (`today` + 5 days, about 3 working days).
fn start_date(t: &TermView, today: &str) -> String {
    let rules = t.rules();
    let own = terms_rules::month_index(&t.effective_on)
        .map(|m| terms_rules::day_in(m, t.day_of_month))
        .unwrap_or_else(|| t.effective_on.clone());
    let earliest = terms_rules::add_days(today, 5).unwrap_or_default();
    if own >= earliest {
        return own;
    }
    let day_before = terms_rules::add_days(&earliest, -1).unwrap_or_default();
    terms_rules::next_due(&rules, &day_before, 1)
        .pop()
        .unwrap_or(own)
}

/// Make (or, with the row's key, find again) the row's new subscription
/// on the gift's mandate (an adopted gift's: the one `old` names),
/// starting `start`. `None`: no mandate to make it on.
async fn create(
    gc: &GoCardless,
    token: &str,
    facts: &regular::RegularFacts,
    t: &TermView,
    old: &str,
    start: &str,
) -> Result<Option<Result<String, CallError>>, Failed> {
    let mandate = match &facts.mandate.mandate_id {
        Some(md) => md.clone(),
        // Adopted from GoCardless: the subscription knows its mandate.
        None => match gc.api.get_subscription(token, old).await?.mandate {
            Some(md) => md,
            None => return Ok(None),
        },
    };
    let name = format!("Regular gift {}", giving::format_pence(t.amount));
    Ok(Some(
        gc.api
            .create_subscription(
                token,
                &NewSubscription {
                    mandate: &mandate,
                    amount: t.amount,
                    interval_unit: t.frequency.as_str(),
                    day_of_month: t.day_of_month,
                    // Quarterly never reaches GoCardless: the terms contract
                    // refuses it on a Direct Debit.
                    month: match t.frequency {
                        Frequency::Monthly | Frequency::Quarterly => None,
                        Frequency::Yearly => t
                            .month
                            .and_then(|m| MONTHS.get(usize::from(m).wrapping_sub(1)).copied()),
                    },
                    name: &name,
                    regular_gift: &facts.id,
                    start_date: Some(start),
                    key: Some(&t.id),
                },
            )
            .await,
    ))
}

/// A new subscription on the same mandate from the row's date (once,
/// whatever the retries: the key is the row's), recorded as the regular
/// gift's and the row's; then the old one cancelled; only then is the row
/// `sent` (review H1: a cancel that fails leaves it `sending`, and the
/// next run cancels again until the old one is gone). If the gift ended
/// meanwhile, the new one is cancelled instead (review M5).
async fn replace(
    org: &Org,
    gc: &GoCardless,
    facts: &regular::RegularFacts,
    t: &TermView,
    old: &str,
    today: &str,
) -> Result<Sent, Failed> {
    let token = org.token()?.to_owned();
    // Read again: a payment may have moved it since (review L4).
    let tid = t.id.clone();
    let Some(t) = org.read(move |c| terms::get_term(c, &tid)).await? else {
        return Ok(Sent::Done);
    };
    // Once made (a retry), it starts where it was made to start: never
    // computed again (review round 2).
    let start = if t.subscription_id.is_some() {
        t.effective_on.clone()
    } else {
        start_date(&t, today)
    };
    let made = match create(gc, &token, facts, &t, old, &start).await? {
        Some(made) => made,
        None => return refused(org, &t, "the subscription names no mandate".into()).await,
    };
    let new = match made {
        Ok(new) => new,
        Err(e) if refused_for_good(&e) => {
            return refused(org, &t, format!("GoCardless: {e}")).await;
        }
        Err(e) => return Err(e.into()),
    };
    let (rid, tid, sb) = (facts.id.clone(), t.id.clone(), new.clone());
    let moved = (start != t.effective_on).then_some(start);
    let ended = org
        .write(move |ctx| {
            let now = regular::facts(ctx.tx.read(), &rid)?.ok_or(ContractError::NotFound)?;
            if now.mandate.status().is_ended() {
                return Ok(true);
            }
            regular::update_mandate(ctx, &rid, None, Source::System, None, |m| {
                m.subscription_id = Some(sb.clone())
            })?;
            terms::update_sync(ctx, &tid, None, |s| {
                s.subscription_id = Some(sb);
                if moved.is_some() {
                    s.applies_from = moved;
                }
            })?;
            Ok(false)
        })
        .await?;
    if ended {
        gc.api.cancel_subscription(&token, &new).await?;
        mark_sent(org, &t.id).await?;
        return Ok(Sent::Done);
    }
    if old != new {
        match gc.api.cancel_subscription(&token, old).await {
            Ok(()) => {}
            // It can't be cancelled by us (gone at GoCardless): reported.
            Err(e) if refused_for_good(&e) => crate::observe::error(&format!(
                "regular-terms-sync: old subscription {old} not cancelled: {e}"
            )),
            Err(e) => return Err(e.into()),
        }
    }
    mark_sent(org, &t.id).await?;
    Ok(Sent::Yes)
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
