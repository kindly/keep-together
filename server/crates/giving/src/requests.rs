//! What staff asked a payment provider for (ADR 0025, review M2): a
//! one-off charge on a donor's mandate, or an Instant Bank Pay link. Each
//! request is recorded as the staff member, *before* the provider is
//! called, so who asked is on record whatever happens next; the
//! provider's id for what it made is added when it answers. The gift
//! that follows (from the provider's events) is made with the requester
//! as its actor ([`crate::regular::record_payment`]), so its history
//! names them. Nothing here is money: the request says what was asked.
//!
//! `giving.providerRequest` (`provider_requests`, counter `version`):
//! create-only facts, plus the provider's reference set once.

use contracts::{
    Command, Contract, ContractError, Ctx, Exec, OrgTx, Problem, Source, WriteTx, command_group,
    execute,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::rules::{PENCE_MAX, format_pence, is_iso_date};
use crate::types::Provider;

pub const TABLE: &str = "provider_requests";

/// What was asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "ProviderRequestKind")]
pub enum RequestKind {
    /// Charge an existing mandate once.
    OneOff,
    /// A link for the donor to pay once by bank (Instant Bank Pay).
    Instant,
}

impl RequestKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RequestKind::OneOff => "one_off",
            RequestKind::Instant => "instant",
        }
    }

    pub fn parse(s: &str) -> Self {
        if s == "instant" {
            RequestKind::Instant
        } else {
            RequestKind::OneOff
        }
    }
}

/// `giving.providerRequest`: the request's facts (fixed) and the
/// provider's reference for what it made (a payment id for a one-off, a
/// billing request id for a link), set once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProviderRequestPayload {
    pub kind: RequestKind,
    pub provider: Provider,
    pub contact_id: String,
    /// The regular gift whose mandate a one-off charges.
    pub regular_gift_id: Option<String>,
    #[ts(type = "number")]
    pub amount: i64,
    pub source_code_id: String,
    /// A one-off's charge date, if staff chose one.
    pub charge_date: Option<String>,
    pub provider_ref: Option<String>,
}

/// The request as stored, plus who asked and when (system-owned).
#[derive(Clone, Debug, Serialize)]
pub struct RequestState {
    #[serde(flatten)]
    pub request: ProviderRequestPayload,
    #[serde(skip)]
    requested_by: Option<i64>,
    #[serde(skip)]
    requested_at: i64,
}

pub struct ProviderRequest;
pub static PROVIDER_REQUEST: ProviderRequest = ProviderRequest;

fn load(conn: &Connection, id: &str) -> rusqlite::Result<Option<RequestState>> {
    conn.prepare_cached(
        "SELECT kind, provider, contact_id, regular_gift_id, amount, source_code_id, charge_date,
             provider_ref, requested_by, requested_at
         FROM provider_requests WHERE id = ?1",
    )?
    .query_row([id], |r| {
        Ok(RequestState {
            request: ProviderRequestPayload {
                kind: RequestKind::parse(&r.get::<_, String>(0)?),
                provider: Provider::parse(&r.get::<_, String>(1)?).unwrap_or(Provider::Gocardless),
                contact_id: r.get(2)?,
                regular_gift_id: r.get(3)?,
                amount: r.get(4)?,
                source_code_id: r.get(5)?,
                charge_date: r.get(6)?,
                provider_ref: r.get(7)?,
            },
            requested_by: r.get(8)?,
            requested_at: r.get(9)?,
        })
    })
    .optional()
}

impl Contract for ProviderRequest {
    const NAME: &'static str = "giving.providerRequest";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "version";
    type Payload = ProviderRequestPayload;
    type State = RequestState;

    fn prepare(&self, p: ProviderRequestPayload) -> Result<ProviderRequestPayload, ContractError> {
        let mut problems = vec![];
        if p.amount <= 0 || p.amount > PENCE_MAX {
            problems.push(Problem::new("amount", "The amount must be over £0"));
        }
        if p.charge_date.as_deref().is_some_and(|d| !is_iso_date(d)) {
            problems.push(Problem::new("chargeDate", "Dates are YYYY-MM-DD"));
        }
        if problems.is_empty() {
            Ok(p)
        } else {
            Err(ContractError::Invalid(problems))
        }
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<RequestState, ContractError> {
        load(tx.read(), id)?.ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&RequestState>,
        p: &ProviderRequestPayload,
        command: &Command,
    ) -> Result<RequestState, ContractError> {
        let Some(current) = current else {
            // A new request (never one on record from before the cap).
            if p.amount > crate::rules::ONE_OFF_MAX {
                return Err(ContractError::invalid(
                    "amount",
                    crate::rules::ONE_OFF_MAX_MESSAGE,
                ));
            }
            return Ok(RequestState {
                request: p.clone(),
                requested_by: command.actor,
                requested_at: command.at,
            });
        };
        let fixed = ProviderRequestPayload {
            provider_ref: p.provider_ref.clone(),
            ..current.request.clone()
        };
        if &fixed != p
            || (current.request.provider_ref.is_some()
                && current.request.provider_ref != p.provider_ref)
        {
            return Err(ContractError::rejected(
                "identity_immutable",
                "What was asked of the provider can’t change",
            ));
        }
        Ok(RequestState {
            request: p.clone(),
            ..current.clone()
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&RequestState>,
        next: &RequestState,
    ) -> Result<(), ContractError> {
        let p = &next.request;
        if before.is_some() {
            tx.prepare_cached("UPDATE provider_requests SET provider_ref = ?2 WHERE id = ?1")?
                .execute(params![id, p.provider_ref])?;
            return Ok(());
        }
        if contacts::donors::kind_of(tx, &p.contact_id)?.is_none() {
            return Err(ContractError::rejected(
                "unknown_contact",
                "Contact must exist",
            ));
        }
        tx.prepare_cached(
            "INSERT INTO provider_requests (id, kind, provider, contact_id, regular_gift_id,
                 amount, source_code_id, charge_date, provider_ref, requested_by, requested_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )?
        .execute(params![
            id,
            p.kind.as_str(),
            p.provider.as_str(),
            p.contact_id,
            p.regular_gift_id,
            p.amount,
            p.source_code_id,
            p.charge_date,
            p.provider_ref,
            next.requested_by,
            next.requested_at
        ])?;
        Ok(())
    }
}

/// Record that staff asked (`id`: the form's client key, so a retry is
/// the same request), as the caller, before the provider is called. A
/// repeat answers the request as first recorded.
pub fn record_request(
    ctx: &Ctx,
    id: &str,
    payload: ProviderRequestPayload,
    source: Source,
) -> Result<ProviderRequestPayload, ContractError> {
    let what = match payload.kind {
        RequestKind::OneOff => "one-off charge",
        RequestKind::Instant => "Instant Bank Pay link",
    };
    let group = command_group(
        ctx,
        &format!(
            "{what} {} asked of GoCardless",
            format_pence(payload.amount)
        ),
    )?;
    match execute(
        ctx,
        &PROVIDER_REQUEST,
        payload,
        Exec::create_with_id(id, source).in_group(&group),
    ) {
        Ok(_) => {}
        Err(ContractError::Duplicate { .. }) => {}
        Err(e) => return Err(e),
    }
    Ok(load(ctx.tx.read(), id)?
        .ok_or(ContractError::NotFound)?
        .request)
}

/// The provider's reference for what the request made, once.
pub fn set_provider_ref(ctx: &Ctx, id: &str, provider_ref: &str) -> Result<(), ContractError> {
    let current = load(ctx.tx.read(), id)?.ok_or(ContractError::NotFound)?;
    if current.request.provider_ref.as_deref() == Some(provider_ref) {
        return Ok(());
    }
    execute(
        ctx,
        &PROVIDER_REQUEST,
        ProviderRequestPayload {
            provider_ref: Some(provider_ref.to_owned()),
            ..current.request
        },
        Exec::update(id, None, Source::System),
    )?;
    Ok(())
}

/// Who asked for request `id`: `None` for an unknown request.
pub fn requested_by(conn: &Connection, id: &str) -> rusqlite::Result<Option<Option<i64>>> {
    conn.prepare_cached("SELECT requested_by FROM provider_requests WHERE id = ?1")?
        .query_row([id], |r| r.get(0))
        .optional()
}
