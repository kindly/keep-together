//! The payment events (plan stripe.sv, S3): what a stored event about a
//! Checkout Session, a PaymentIntent, a refund or a dispute does to one
//! organisation's file. [`super::process`] runs the queue and calls
//! [`handle`]; the staff's "Card payments to match" routes call
//! [`match_by_staff`].
//!
//! **Gifts only on Stripe's word.** An event is good for ids, never for
//! state: it names a PaymentIntent, which is read from Stripe as it is
//! *now* (with its charge and disputes) and recorded
//! ([`giving::stripe::record_payment`]). Any order of the same events,
//! and any replay, ends in the same state. A donor's submission makes
//! nothing; a payment that hasn't succeeded makes a payment row and
//! nothing else.
//!
//! **A payment that has succeeded** becomes records in one transaction
//! under one command group, [`GROUP`]:
//! - the submission it came from is found: the one a session event names
//!   (by its Checkout Session, else `client_reference_id` /
//!   `metadata.keep_submission`), or the one the PaymentIntent's own
//!   `metadata.keep_submission` names; it must be for the same amount and
//!   nobody else's;
//! - the donor is matched ([`giving::stripe::match_donor`]): nobody has
//!   their email → a new contact (name, email, and the home address when
//!   Gift Aid was ticked); one live contact has it under the same last
//!   name → that contact (never one marked deceased); otherwise the
//!   payment waits in the staff queue with why, and no gift;
//! - the gift (`provider = stripe`, `method = card`, to the page's source
//!   code when they gave), with the status the payment gives it;
//! - the donor's Gift Aid declaration, when they ticked it
//!   ([`giftaid::make_donor_declaration`]): always kept, whatever older
//!   declaration covers the gift; if Gift Aid's rules refuse it, the gift
//!   stands and the match says why (`declarationRefused`);
//! - the match, and the submission marked paid.
//!
//! If a contract refuses anything on the way (what the donor typed
//! can't be made a contact), nothing of that try is kept and the payment
//! is recorded and queued as `contact_refused`: a succeeded payment is
//! always a gift or in the queue.
//!
//! A payment that succeeded with no submission behind it (taken some
//! other way on the group's Stripe account) goes to the queue as
//! `no_submission`; it is picked up from there if a later event names
//! its submission.
//!
//! **Afterwards the gift follows its payment**
//! ([`giving::stripe::follow_payment`]): refunded in full → `refunded`;
//! in part → `completed` at what the group kept (a gift in a Gift Aid
//! claim keeps its amount and is flagged for staff); a dispute →
//! `charged_back`, `completed` again if the group wins.
//!
//! A payment that isn't in pounds is reported and never recorded.

use std::sync::Arc;
use std::time::Duration;

use contracts::{CommandGroup, Contract, ContractError, Ctx, Source, command_group};
use giving::stripe::{
    self as cards, DisputeState, DonorMatch, PaymentRecord, STRIPE_PAYMENT,
    StripePaymentMatchPayload, StripePaymentPayload, StripePaymentStatus, Submission,
    UnmatchedReason,
};
use serde_json::Value;
use store::{Store, TenantId};

use super::Stripe;
use super::client::{
    CHARGE_EVENTS, Dispute, PAYMENT_INTENT_EVENTS, PaymentIntent, SESSION_EVENTS, SESSION_EXPIRED,
};
use super::process::{Event, Failed};
use crate::jobs::Job;

/// The command group of the command that turns a paid submission into
/// its records.
pub const GROUP: &str = "stripe.donation";

/// Whether `kind` is an event this module handles.
pub fn handles(kind: &str) -> bool {
    SESSION_EVENTS.contains(&kind)
        || PAYMENT_INTENT_EVENTS.contains(&kind)
        || CHARGE_EVENTS.contains(&kind)
}

/// What an event says about a payment before Stripe is asked: ids only.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Named {
    /// The PaymentIntent (`pi_…`).
    pub payment: Option<String>,
    /// The Checkout Session (`cs_…`), on a session's own events.
    pub session: Option<String>,
    /// The submission a session event names.
    pub submissions: Vec<String>,
}

/// The ids in an event of `kind` about `object`.
pub fn named(kind: &str, object: &Value) -> Named {
    let text = |p: &str| object.pointer(p).and_then(Value::as_str).map(str::to_owned);
    if SESSION_EVENTS.contains(&kind) {
        Named {
            payment: text("/payment_intent"),
            session: text("/id"),
            submissions: [
                text("/client_reference_id"),
                text("/metadata/keep_submission"),
            ]
            .into_iter()
            .flatten()
            .collect(),
        }
    } else if PAYMENT_INTENT_EVENTS.contains(&kind) {
        Named {
            payment: text("/id"),
            ..Named::default()
        }
    } else {
        // A charge, a refund or a dispute: each names its PaymentIntent.
        Named {
            payment: text("/payment_intent"),
            ..Named::default()
        }
    }
}

/// The payment as we keep it, from Stripe's PaymentIntent and its
/// disputes (newest first). Pure. `paid_on` is the UK date its charge
/// was made.
pub fn report(intent: &PaymentIntent, disputes: &[Dispute]) -> StripePaymentPayload {
    let status = match intent.status.as_str() {
        "succeeded" => StripePaymentStatus::Succeeded,
        "canceled" => StripePaymentStatus::Cancelled,
        "requires_payment_method" if intent.attempt_failed => StripePaymentStatus::Failed,
        _ => StripePaymentStatus::Pending,
    };
    let succeeded = status == StripePaymentStatus::Succeeded;
    // An inquiry (`warning_…`) moves no money: not a dispute yet.
    let dispute = disputes.iter().find_map(|d| {
        let state = match d.status.as_str() {
            "needs_response" | "under_review" => DisputeState::Open,
            "won" => DisputeState::Won,
            "lost" => DisputeState::Lost,
            _ => return None,
        };
        Some((state, d.reason.clone()))
    });
    let dispute = dispute.filter(|_| succeeded);
    let reason = match (&dispute, status) {
        (Some((DisputeState::Open | DisputeState::Lost, why)), _) => why.clone(),
        (_, StripePaymentStatus::Failed | StripePaymentStatus::Cancelled) => intent.failure.clone(),
        _ => None,
    };
    StripePaymentPayload {
        payment_id: intent.id.clone(),
        submission_id: None,
        amount: intent.amount,
        currency: intent.currency.clone(),
        status,
        paid_on: succeeded.then(|| giftaid::uk_date(intent.paid_at * 1000)),
        refunded_amount: if succeeded {
            intent.refunded.clamp(0, intent.amount)
        } else {
            0
        },
        dispute: dispute.map(|(state, _)| state),
        reason,
    }
}

async fn write<T: Send + 'static>(
    store: &Arc<Store>,
    tenant: &TenantId,
    f: impl FnOnce(&Ctx) -> Result<T, ContractError> + Send + 'static,
) -> Result<T, Failed> {
    let (s, t) = (store.clone(), tenant.clone());
    tokio::task::spawn_blocking(move || {
        let db = s.org(&t).map_err(|e| Failed::Retry(format!("{e:?}")))?;
        contracts::transact(&db, None, f).map_err(Failed::from)
    })
    .await
    .map_err(|e| Failed::Retry(e.to_string()))?
}

/// Handle one payment event of `tenant`'s connected account; the outcome
/// stored with it: `done` (a gift made or brought up to date, or nothing
/// to change), `recorded` (a payment that hasn't succeeded), `unmatched`
/// (in the staff queue), `expired`, `ignored` (names no payment, or not
/// in pounds), `unknown_resource` (an expired session no submission here
/// holds).
pub async fn handle(
    store: &Arc<Store>,
    stripe: &Arc<Stripe>,
    tenant: &TenantId,
    ev: &Event,
) -> Result<&'static str, Failed> {
    let named = named(&ev.kind, &ev.object);
    if ev.kind == SESSION_EXPIRED {
        return write(store, tenant, move |ctx| expire(ctx, &named)).await;
    }
    let Some(payment) = named.payment.clone() else {
        // A session with no payment yet, a charge outside a PaymentIntent.
        return Ok("ignored");
    };
    let intent = stripe.api.get_payment_intent(&ev.account, &payment).await?;
    if intent.currency != "gbp" {
        // Gifts are pence sterling: say so, never drop it unheard.
        crate::observe::warning(&format!(
            "stripe payment {} for {tenant} is in {}, not GBP: not recorded",
            intent.id, intent.currency
        ));
        return Ok("ignored");
    }
    let disputes = if intent.status == "succeeded" {
        stripe.api.list_disputes(&ev.account, &payment).await?
    } else {
        vec![]
    };
    let mut hints = named.clone();
    hints.submissions.extend(intent.submission.clone());
    let now_is = report(&intent, &disputes);
    let (s, who) = (store.clone(), tenant.clone());
    tokio::task::spawn_blocking(move || {
        let db = s.org(&who).map_err(|e| Failed::Retry(format!("{e:?}")))?;
        let (first, hinted) = (now_is.clone(), hints.clone());
        match contracts::transact(&db, None, |ctx| {
            apply(ctx, first, &hinted, &who, Donor::Find)
        }) {
            // A contract refused something on the way to the gift (what
            // the donor typed can't be made a contact, say) and the whole
            // transaction is gone. Stripe has the money all the same: the
            // payment is recorded and queued for staff, never lost.
            Err(e @ (ContractError::Invalid(_) | ContractError::Rejected { .. })) => {
                crate::observe::warning(&format!(
                    "stripe: {who}: payment {} couldn't be made a gift ({e}): queued for staff",
                    now_is.payment_id
                ));
                contracts::transact(&db, None, |ctx| {
                    apply(ctx, now_is, &hints, &who, Donor::Queue)
                })
                .map_err(Failed::from)
            }
            other => other.map_err(Failed::from),
        }
    })
    .await
    .map_err(|e| Failed::Retry(e.to_string()))?
}

/// What [`apply`] does about a succeeded payment's donor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Donor {
    /// Match them and make their records, or queue the payment with why.
    Find,
    /// Queue the payment as `contact_refused`, trying nothing: the try
    /// was refused.
    Queue,
}

/// A Checkout Session ran out unpaid: the submission that session was
/// made for is `expired` (one already paid stays paid). Tied by the
/// session's own id as stored on the submission, never by
/// `client_reference_id`: a session whose create answer was lost carries
/// a real submission's id, and its expiry must not end the attempt the
/// donor is still making on another session (S4 review, L3).
fn expire(ctx: &Ctx, named: &Named) -> Result<&'static str, ContractError> {
    let found = match named.session.as_deref() {
        Some(session) => cards::submission_by_session(ctx.tx.read(), session)?,
        None => None,
    };
    let Some(submission) = found else {
        return Ok("unknown_resource");
    };
    cards::mark_expired(ctx, &submission.id)?;
    Ok("expired")
}

/// Whether the payment still wants its donor found: it succeeded, has no
/// gift, and either nobody has looked or it waits only for a submission
/// that has now turned up.
fn wants_donor(record: &PaymentRecord) -> bool {
    record.matched.gift_id.is_none()
        && record.payment.status == StripePaymentStatus::Succeeded
        && match record.matched.unmatched {
            None => true,
            Some(UnmatchedReason::NoSubmission) => record.payment.submission_id.is_some(),
            Some(_) => false,
        }
}

/// Record `now_is` (the payment as Stripe has it) and everything that
/// follows from it, in the caller's transaction (module docs). A report
/// that changes nothing writes nothing.
pub fn apply(
    ctx: &Ctx,
    mut now_is: StripePaymentPayload,
    hints: &Named,
    tenant: &TenantId,
    donor: Donor,
) -> Result<&'static str, ContractError> {
    let conn = ctx.tx.read();
    let held = cards::payment_by_stripe_id(conn, &now_is.payment_id)?;
    now_is.submission_id = match held.as_ref().and_then(|h| h.payment.submission_id.clone()) {
        Some(known) => Some(known),
        None => {
            let mut candidates = Vec::new();
            if let Some(session) = hints.session.as_deref()
                && let Some(s) = cards::submission_by_session(conn, session)?
            {
                candidates.push(s.id);
            }
            candidates.extend(hints.submissions.iter().cloned());
            cards::submission_for_payment(conn, &candidates, &now_is.payment_id, now_is.amount)?
        }
    };
    let now_is = STRIPE_PAYMENT.prepare(now_is)?;
    if let Some(h) = &held {
        let after = PaymentRecord {
            payment: now_is.clone(),
            ..h.clone()
        };
        if h.payment == now_is && !wants_donor(&after) {
            return Ok(outcome(h));
        }
    }
    // Only when a donor is about to be looked for: a refund or a dispute
    // on a payment still in the queue donates nothing.
    let donating = match &held {
        None => now_is.status == StripePaymentStatus::Succeeded,
        Some(h) => wants_donor(&PaymentRecord {
            payment: now_is.clone(),
            ..h.clone()
        }),
    };
    let group = command_group(
        ctx,
        &if donating {
            GROUP.to_owned()
        } else {
            format!(
                "Card payment {} {}",
                giving::format_pence(now_is.amount),
                cards::said(&now_is)
            )
        },
    )?;
    let (record, _) = cards::record_payment(ctx, now_is, &group)?;
    if record.matched.gift_id.is_some() {
        cards::follow_payment(ctx, &record, &group)?;
    } else if wants_donor(&record) {
        match donor {
            Donor::Find => donate(ctx, &record, &group, tenant)?,
            Donor::Queue => {
                queue(ctx, &record, UnmatchedReason::ContactRefused, &group)?;
                if let Some(submission) = record.payment.submission_id.as_deref() {
                    cards::mark_paid(ctx, submission, &record.id, &group)?;
                }
            }
        }
    }
    let after = cards::payment(ctx.tx.read(), &record.id)?.ok_or(ContractError::NotFound)?;
    Ok(outcome(&after))
}

fn outcome(record: &PaymentRecord) -> &'static str {
    if record.matched.gift_id.is_some() {
        "done"
    } else if record.matched.unmatched.is_some() {
        "unmatched"
    } else {
        "recorded"
    }
}

/// Put the payment in the staff queue with `why`.
fn queue(
    ctx: &Ctx,
    record: &PaymentRecord,
    why: UnmatchedReason,
    group: &CommandGroup,
) -> Result<(), ContractError> {
    if record.matched.unmatched != Some(why) {
        cards::set_match(
            ctx,
            &record.id,
            StripePaymentMatchPayload {
                unmatched: Some(why),
                ..StripePaymentMatchPayload::default()
            },
            None,
            Source::System,
            Some(group),
        )?;
    }
    Ok(())
}

/// A payment that succeeded and has no gift: find its donor and make its
/// records, or queue it for staff.
fn donate(
    ctx: &Ctx,
    record: &PaymentRecord,
    group: &CommandGroup,
    tenant: &TenantId,
) -> Result<(), ContractError> {
    let conn = ctx.tx.read();
    let Some(submission) = cards::typed_for(conn, &record.payment)? else {
        return queue(ctx, record, UnmatchedReason::NoSubmission, group);
    };
    let typed = &submission.typed;
    let (candidates, truncated) = cards::donor_candidates(conn, &typed.email)?;
    let (contact_id, first_name_typed) =
        match cards::match_donor(&typed.first_name, &typed.last_name, &candidates, truncated) {
            DonorMatch::Unmatched(why) => {
                queue(ctx, record, why, group)?;
                // Stripe took the money: the submission is paid, whoever
                // it turns out to be from.
                cards::mark_paid(ctx, &submission.id, &record.id, group)?;
                return Ok(());
            }
            DonorMatch::Linked {
                contact_id,
                first_name_typed,
            } => (contact_id, first_name_typed),
            DonorMatch::New => {
                // The page's code is the new donor's acquisition code,
                // unless it was archived since they gave.
                let code = sources::describe(conn, &typed.source_code_id)?
                    .filter(|c| c.is_active)
                    .map(|_| typed.source_code_id.clone());
                let made = contacts::donors::create_contact(
                    ctx,
                    contacts::types::Details {
                        client_key: None,
                        kind: contacts::types::Kind::Individual,
                        title: String::new(),
                        first_name: typed.first_name.clone(),
                        last_name: typed.last_name.clone(),
                        nickname: String::new(),
                        name: String::new(),
                        birth_date: None,
                        is_deceased: false,
                        deceased_date: None,
                    },
                    code,
                    Source::System,
                    group,
                )?;
                contacts::donors::add_first_email(
                    ctx,
                    &made.id,
                    &typed.email,
                    Source::System,
                    group,
                )?;
                (made.id, None)
            }
        };
    complete(
        ctx,
        record,
        Some(&submission),
        Matched {
            contact_id: &contact_id,
            source_code_id: &typed.source_code_id,
            first_name_typed,
            expected: None,
            source: Source::System,
        },
        group,
        tenant.as_str(),
    )?;
    Ok(())
}

/// Whose a payment turned out to be.
struct Matched<'a> {
    contact_id: &'a str,
    source_code_id: &'a str,
    /// The first name the donor typed, when it isn't the contact's.
    first_name_typed: Option<String>,
    /// `matchVersion` as staff read it; the system passes none.
    expected: Option<i64>,
    source: Source,
}

/// The records of a succeeded payment once its contact is known, in
/// `group`: the gift, the donor's home address and declaration when they
/// ticked Gift Aid, the match, the submission marked paid. The gift's id.
fn complete(
    ctx: &Ctx,
    record: &PaymentRecord,
    submission: Option<&Submission>,
    m: Matched<'_>,
    group: &CommandGroup,
    whose: &str,
) -> Result<String, ContractError> {
    let gift = cards::make_gift(ctx, record, m.contact_id, m.source_code_id, group)?;
    let mut declaration_refused = None;
    if let Some(aid) = submission.and_then(|s| s.typed.gift_aid.as_ref().map(|aid| (s, aid))) {
        let (s, aid) = aid;
        // Claims use the contact's current address: one with no postcode
        // takes the home address the donor typed. An address the contact
        // already has is staff's, and stays; and when the first name
        // differs the donor may be someone else at that email address,
        // so nothing of theirs is written onto the contact. The
        // declaration keeps what the donor typed either way.
        let home = contacts::donors::describe_donor(ctx.tx.read(), m.contact_id)?
            .map(|d| d.home)
            .unwrap_or_default();
        if home.postcode.trim().is_empty() && m.first_name_typed.is_none() {
            // One command under its own savepoint: refused (a submission
            // from before the widths were aligned), it leaves nothing,
            // and the gift goes on without it.
            match contacts::donors::set_home_address(
                ctx,
                m.contact_id,
                &aid.address_line1,
                &aid.postcode,
                m.source,
                group,
            ) {
                Ok(_) | Err(ContractError::Invalid(_) | ContractError::Rejected { .. }) => {}
                Err(other) => return Err(other),
            }
        }
        let declared = giftaid::make_donor_declaration(
            ctx,
            giftaid::DonorDeclaration {
                contact_id: m.contact_id.to_owned(),
                gift_id: gift.clone(),
                scope: giftaid::types::Scope::parse(aid.scope.as_str()),
                made_on: giftaid::uk_date(s.submitted_at),
                wording_version: aid.wording_version.clone(),
                first_name: s.typed.first_name.clone(),
                last_name: s.typed.last_name.clone(),
                address_line1: aid.address_line1.clone(),
                postcode: aid.postcode.clone(),
            },
            group,
        );
        match declared {
            Ok(_) => {}
            // The gift stands without it; the match says so for staff
            // (`declarationRefused`), the submission keeps what the donor
            // ticked, and Sentry is told. Ids only.
            Err(e @ (ContractError::Rejected { .. } | ContractError::Invalid(_))) => {
                let why = match &e {
                    ContractError::Rejected { reason, .. } => reason.clone(),
                    _ => "invalid".to_owned(),
                };
                crate::observe::warning(&format!(
                    "stripe: {whose}: the donor's Gift Aid declaration for gift {gift} \
                     (submission {}) was refused ({why}): the gift is recorded without it",
                    s.id
                ));
                declaration_refused = Some(why);
            }
            Err(other) => return Err(other),
        }
    }
    cards::set_match(
        ctx,
        &record.id,
        StripePaymentMatchPayload {
            contact_id: Some(m.contact_id.to_owned()),
            gift_id: Some(gift.clone()),
            unmatched: None,
            first_name_typed: m.first_name_typed,
            partial_refund_claimed: false,
            declaration_refused,
            dismissed: None,
        },
        m.expected,
        m.source,
        Some(group),
    )?;
    if let Some(s) = submission {
        cards::mark_paid(ctx, &s.id, &record.id, group)?;
    }
    Ok(gift)
}

/// Staff say whose a queued payment is (`POST
/// stripe/unmatched/{id}/match`): `contact_id`'s gift, with the payment's
/// amount, date and status, to the code the donor's page had (or
/// `source_code_id`, which must be live; needed when the payment has no
/// submission). The donor's declaration is made if they ticked Gift Aid,
/// in the name they typed, and the gift is marked with the first name
/// they typed when it isn't the contact's. Refused for an archived
/// contact (`archived_contact`), and for a Gift Aid payment matched to a
/// contact that isn't a person (`not_individual`). `expected`:
/// `matchVersion` as listed (`409 stale`). The gift's id.
pub fn match_by_staff(
    ctx: &Ctx,
    id: &str,
    expected: i64,
    contact_id: &str,
    source_code_id: Option<&str>,
    whose: &str,
) -> Result<String, ContractError> {
    let conn = ctx.tx.read();
    let record = cards::payment(conn, id)?.ok_or(ContractError::NotFound)?;
    if record.matched.gift_id.is_some() {
        return Err(ContractError::rejected(
            "already_matched",
            "This payment is already a donor’s gift",
        ));
    }
    let Some(donor) = contacts::donors::describe_donor(conn, contact_id)? else {
        return Err(ContractError::rejected(
            "unknown_contact",
            "Contact must exist",
        ));
    };
    if contacts::donors::is_archived(conn, contact_id)? == Some(true) {
        return Err(ContractError::rejected(
            "archived_contact",
            "This contact is archived: restore it, or choose another",
        ));
    }
    let submission = cards::typed_for(conn, &record.payment)?;
    // The donor ticked Gift Aid, and only a person can make a
    // declaration: say so now, rather than drop it quietly.
    if submission
        .as_ref()
        .is_some_and(|s| s.typed.gift_aid.is_some())
        && donor.kind != contacts::types::Kind::Individual
    {
        return Err(ContractError::rejected(
            "not_individual",
            "This donor ticked Gift Aid, and only a person can make a declaration: \
             match the payment to a person",
        ));
    }
    let code = match source_code_id.map(str::trim).filter(|c| !c.is_empty()) {
        Some(chosen) => match sources::describe(conn, chosen)? {
            None => {
                return Err(ContractError::rejected(
                    "unknown_source_code",
                    "The source code must be a full code (category, detail and version)",
                ));
            }
            Some(code) if !code.is_active => {
                return Err(ContractError::rejected(
                    "archived_source_code",
                    format!("{} is archived: choose another", code.code),
                ));
            }
            Some(_) => chosen.to_owned(),
        },
        None => match &submission {
            Some(s) => s.typed.source_code_id.clone(),
            None => {
                return Err(ContractError::invalid(
                    "sourceCodeId",
                    "Choose a source code for this gift",
                ));
            }
        },
    };
    let first_name_typed = submission.as_ref().and_then(|s| {
        (cards::name_key(&s.typed.first_name) != cards::name_key(&donor.first_name))
            .then(|| s.typed.first_name.clone())
    });
    let group = command_group(
        ctx,
        &format!(
            "Card payment {} matched to a donor",
            giving::format_pence(cards::gift_amount(&record.payment))
        ),
    )?;
    complete(
        ctx,
        &record,
        submission.as_ref(),
        Matched {
            contact_id,
            source_code_id: &code,
            first_name_typed,
            expected: Some(expected),
            source: Source::Ui,
        },
        &group,
        whose,
    )
}

/// How many submissions one organisation's retention run clears at most.
pub const RETENTION_BATCH: usize = 500;

/// Clear the personal fields of every organisation's unpaid submissions
/// that are past their 30 days ([`giving::stripe::clear_unpaid`]), one
/// file at a time, as of now.
pub async fn run_retention(store: &Arc<Store>) -> Result<(), String> {
    crate::jobs::each_org(store, |_, db| {
        contracts::transact(db, None, |ctx| cards::clear_unpaid(ctx, RETENTION_BATCH))
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
}

/// `donation-retention`: daily ([`run_retention`]). Runs whether or not
/// Stripe is on: what donors typed doesn't outlive its 30 days because
/// card donations were switched off.
pub struct RetentionJob(pub Arc<Store>);

impl Job for RetentionJob {
    fn name(&self) -> &'static str {
        "donation-retention"
    }
    fn every(&self) -> Duration {
        Duration::from_secs(24 * 60 * 60)
    }
    fn first_after(&self) -> Duration {
        Duration::from_secs(20 * 60)
    }
    fn run(&self) -> std::pin::Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async move { run_retention(&self.0).await })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn intent(status: &str) -> PaymentIntent {
        PaymentIntent {
            id: "pi_1".into(),
            amount: 2500,
            currency: "gbp".into(),
            status: status.into(),
            // 2026-11-18T23:30:00Z: still the 18th in the UK.
            paid_at: 1_795_044_600,
            refunded: 0,
            failure: None,
            attempt_failed: false,
            submission: None,
        }
    }

    fn dispute(status: &str, created: i64) -> Dispute {
        Dispute {
            id: format!("dp_{created}"),
            status: status.into(),
            reason: Some("fraudulent".into()),
            created,
        }
    }

    #[test]
    fn only_succeeded_is_paid_and_it_is_dated_in_the_uk() {
        let paid = report(&intent("succeeded"), &[]);
        assert_eq!(paid.status, StripePaymentStatus::Succeeded);
        assert_eq!(paid.paid_on.as_deref(), Some("2026-11-18"));
        for (status, failed, want) in [
            ("processing", false, StripePaymentStatus::Pending),
            ("requires_action", false, StripePaymentStatus::Pending),
            (
                "requires_payment_method",
                false,
                StripePaymentStatus::Pending,
            ),
            ("requires_payment_method", true, StripePaymentStatus::Failed),
            ("canceled", false, StripePaymentStatus::Cancelled),
        ] {
            let p = report(
                &PaymentIntent {
                    attempt_failed: failed,
                    failure: Some("card_declined".into()),
                    ..intent(status)
                },
                &[],
            );
            assert_eq!(p.status, want, "{status}");
            assert_eq!(p.paid_on, None, "{status}");
        }
        // A summer evening: the UK is a day ahead of UTC's date.
        let summer = report(
            &PaymentIntent {
                paid_at: 1_782_948_600, // 2026-07-01T23:30:00Z
                ..intent("succeeded")
            },
            &[],
        );
        assert_eq!(summer.paid_on.as_deref(), Some("2026-07-02"));
    }

    #[test]
    fn a_refund_is_never_more_than_the_payment() {
        let over = report(
            &PaymentIntent {
                refunded: 9999,
                ..intent("succeeded")
            },
            &[],
        );
        assert_eq!(over.refunded_amount, 2500);
    }

    #[test]
    fn the_newest_real_dispute_decides_and_an_inquiry_is_not_one() {
        let open = report(&intent("succeeded"), &[dispute("needs_response", 2)]);
        assert_eq!(open.dispute, Some(DisputeState::Open));
        assert_eq!(open.reason.as_deref(), Some("fraudulent"));
        let won = report(&intent("succeeded"), &[dispute("won", 2)]);
        assert_eq!((won.dispute, won.reason), (Some(DisputeState::Won), None));
        let inquiry = report(
            &intent("succeeded"),
            &[dispute("warning_needs_response", 2)],
        );
        assert_eq!(inquiry.dispute, None);
        let lost = report(
            &intent("succeeded"),
            &[dispute("warning_closed", 3), dispute("lost", 2)],
        );
        assert_eq!(lost.dispute, Some(DisputeState::Lost));
    }

    #[test]
    fn an_event_names_its_payment_and_a_session_its_submission() {
        let session = named(
            "checkout.session.completed",
            &json!({ "id": "cs_1", "payment_intent": "pi_1", "client_reference_id": "abc",
                "metadata": { "keep_submission": "abc" } }),
        );
        assert_eq!(session.payment.as_deref(), Some("pi_1"));
        assert_eq!(session.session.as_deref(), Some("cs_1"));
        assert_eq!(session.submissions, ["abc", "abc"]);
        assert_eq!(
            named("payment_intent.succeeded", &json!({ "id": "pi_2" }))
                .payment
                .as_deref(),
            Some("pi_2")
        );
        assert_eq!(
            named(
                "charge.dispute.created",
                &json!({ "id": "dp_1", "payment_intent": "pi_3" })
            )
            .payment
            .as_deref(),
            Some("pi_3")
        );
        assert_eq!(
            named("charge.refunded", &json!({ "id": "ch_1" })).payment,
            None
        );
        assert!(handles("charge.refunded") && !handles("account.updated"));
    }
}
