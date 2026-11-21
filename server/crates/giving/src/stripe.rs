//! Card gifts through Stripe (plan `factory/plans/stripe.sv`, step S2):
//! what a donor typed on the group's donation page, Stripe's record of
//! the payment it became, whose that payment is, and the page's settings.
//! Nothing here calls Stripe or names a Stripe account: routing by
//! account id and by page slug is the api's (rule 6). Nothing here makes
//! a gift either: the command that turns a paid submission into a
//! contact, a gift and a declaration spans modules, so it is the api's
//! (`api::stripe::process`), built from these contracts.
//!
//! Two roots, each partitioned by two contracts, and a one-row table:
//!
//! ```text
//!   donation_submissions
//!     giving.donationSubmission        — what the donor typed: create-only,
//!                                        the evidence (`version`)
//!     giving.donationSubmissionOutcome — where it stands: the Checkout
//!                                        session, started → paid / expired,
//!                                        the payment it became, personal
//!                                        data cleared (`outcome_version`)
//!   stripe_payments
//!     giving.stripePayment             — Stripe's raw record (`version`)
//!     giving.stripePaymentMatch        — whose it is: contact and gift, or
//!                                        unmatched and why; the staff flags
//!                                        (`match_version`)
//!   donation_page
//!     giving.donationPage              — the three amounts, minimum,
//!                                        maximum, the page's source code
//!                                        (`version`)
//! ```
//!
//! **Never optimistic**: a submission is not a gift and makes none. Only
//! a payment Stripe reports as succeeded is money received
//! ([`gift_status`]).
//!
//! **Retention** (rule 3): an unpaid submission's personal fields are
//! cleared 30 days after it was made, from its row and from its
//! revisions; the row stays. A paid one's never are: it is the evidence
//! for its gift and declaration.

use contacts::rules::fold;
use contracts::{
    Command, CommandGroup, Contract, ContractError, Ctx, Exec, Executed, OrgTx, Problem, Source,
    WriteTx, execute,
};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::regular::{REASON_MAX, check_live_code};
use crate::rules::{ONE_OFF_MAX, format_pence, is_iso_date};
use crate::types::Status;

pub const SUBMISSIONS: &str = "donation_submissions";
pub const PAYMENTS: &str = "stripe_payments";
pub const PAGE: &str = "donation_page";

/// The least a donation page ever takes, whatever the group sets: £1.
pub const DONATION_FLOOR: i64 = 100;
/// The most: a staff-taken one-off's cap ("ask for a bank transfer").
pub const DONATION_CEILING: i64 = ONE_OFF_MAX;
/// A new group's page: £10, £25 and £50 buttons, £2 to £1,000.
pub const DEFAULT_AMOUNTS: [i64; 3] = [1000, 2500, 5000];
pub const DEFAULT_MINIMUM: i64 = 200;
pub const DEFAULT_MAXIMUM: i64 = DONATION_CEILING;
/// How long an unpaid submission keeps what the donor typed.
pub const UNPAID_RETENTION_DAYS: i64 = 30;
const DAY_MS: i64 = 86_400_000;

pub const NAME_MAX: usize = 200;
pub const EMAIL_MAX: usize = 320;
pub const WORDING_VERSION_MAX: usize = 50;
pub const PROVIDER_ID_MAX: usize = 255;
/// "Card payments to match", newest first.
pub const UNMATCHED_LIMIT: usize = 500;

/// Org schema step: new tables only (`gifts` already has `provider` and
/// `method = 'card'`). The two roots point at each other (a payment at
/// the submission it came from, a paid submission at its payment): each
/// side is set by its own contract, the payment first.
pub const MIGRATION: &str = "
CREATE TABLE donation_submissions (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    amount INTEGER NOT NULL CHECK (amount > 0),
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL,
    gift_aid INTEGER NOT NULL CHECK (gift_aid IN (0, 1)),
    declaration_scope TEXT
        CHECK (declaration_scope IN ('thisGift', 'future', 'futureAndPast4y')),
    wording_version TEXT,
    address_line1 TEXT NOT NULL DEFAULT '',
    postcode TEXT NOT NULL DEFAULT '',
    source_code_id TEXT NOT NULL REFERENCES source_codes (id),
    submitted_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 0,
    checkout_session_id TEXT UNIQUE,
    state TEXT NOT NULL DEFAULT 'started' CHECK (state IN ('started', 'paid', 'expired')),
    stripe_payment_id TEXT REFERENCES stripe_payments (id),
    personal_cleared_at INTEGER,
    outcome_version INTEGER NOT NULL DEFAULT 0,
    CHECK ((gift_aid = 1) = (declaration_scope IS NOT NULL)),
    CHECK ((gift_aid = 1) = (wording_version IS NOT NULL)),
    CHECK ((state = 'paid') = (stripe_payment_id IS NOT NULL)),
    CHECK (state <> 'paid' OR personal_cleared_at IS NULL)
) STRICT;
CREATE INDEX donation_submissions_unpaid ON donation_submissions (submitted_at)
    WHERE state <> 'paid' AND personal_cleared_at IS NULL;

CREATE TABLE stripe_payments (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    payment_id TEXT NOT NULL UNIQUE,
    submission_id TEXT REFERENCES donation_submissions (id),
    amount INTEGER NOT NULL CHECK (amount > 0),
    currency TEXT NOT NULL CHECK (currency = 'gbp'),
    status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled')),
    paid_on TEXT,
    refunded_amount INTEGER NOT NULL DEFAULT 0
        CHECK (refunded_amount >= 0 AND refunded_amount <= amount),
    dispute_state TEXT CHECK (dispute_state IN ('open', 'won', 'lost')),
    reason TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    contact_id TEXT REFERENCES contacts (id),
    gift_id TEXT UNIQUE REFERENCES gifts (id),
    unmatched_reason TEXT CHECK (unmatched_reason IN ('ambiguous', 'name_differs')),
    first_name_typed TEXT,
    partial_refund_claimed INTEGER NOT NULL DEFAULT 0 CHECK (partial_refund_claimed IN (0, 1)),
    matched_by INTEGER,
    matched_at INTEGER,
    match_version INTEGER NOT NULL DEFAULT 0,
    CHECK ((contact_id IS NULL) = (gift_id IS NULL)),
    CHECK (gift_id IS NULL OR unmatched_reason IS NULL)
) STRICT;
CREATE INDEX stripe_payments_by_submission ON stripe_payments (submission_id)
    WHERE submission_id IS NOT NULL;
CREATE INDEX stripe_payments_unmatched ON stripe_payments (seq)
    WHERE gift_id IS NULL AND unmatched_reason IS NOT NULL;

CREATE TABLE donation_page (
    id TEXT PRIMARY KEY,
    singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
    first_amount INTEGER NOT NULL CHECK (first_amount > 0),
    second_amount INTEGER NOT NULL CHECK (second_amount > 0),
    third_amount INTEGER NOT NULL CHECK (third_amount > 0),
    minimum_amount INTEGER NOT NULL CHECK (minimum_amount > 0),
    maximum_amount INTEGER NOT NULL CHECK (maximum_amount >= minimum_amount),
    source_code_id TEXT REFERENCES source_codes (id),
    version INTEGER NOT NULL DEFAULT 0
) STRICT;
";

fn tidy(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn too_long(problems: &mut Vec<Problem>, field: &str, value: &str, max: usize) {
    if value.chars().count() > max {
        problems.push(Problem::new(field, format!("At most {max} characters")));
    }
}

fn checked<T>(out: T, problems: Vec<Problem>) -> Result<T, ContractError> {
    if problems.is_empty() {
        Ok(out)
    } else {
        Err(ContractError::Invalid(problems))
    }
}

fn no_restore(command: &Command, what: &str) -> Result<(), ContractError> {
    if command.source == Source::Restore {
        return Err(ContractError::rejected(
            "not_restorable",
            format!("{what} can’t be restored"),
        ));
    }
    Ok(())
}

// ── giving.donationPage ────────────────────────────────────────────────────

/// `giving.donationPage`: the group's page settings. Every amount is
/// pence. The page takes no donations until `sourceCodeId` is set.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DonationPagePayload {
    /// The three buttons, as shown.
    #[ts(type = "[number, number, number]")]
    pub amounts: [i64; 3],
    /// The least and the most "other amount" takes.
    #[ts(type = "number")]
    pub minimum: i64,
    #[ts(type = "number")]
    pub maximum: i64,
    /// The source code every gift from the page is given to.
    pub source_code_id: Option<String>,
}

impl Default for DonationPagePayload {
    fn default() -> Self {
        DonationPagePayload {
            amounts: DEFAULT_AMOUNTS,
            minimum: DEFAULT_MINIMUM,
            maximum: DEFAULT_MAXIMUM,
            source_code_id: None,
        }
    }
}

/// The page's settings as Settings and the public page read them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DonationPage {
    #[serde(flatten)]
    #[ts(flatten)]
    pub page: DonationPagePayload,
    /// The counter a save sends as `expected`; `null` before any save
    /// (every default; the save then sends none).
    #[ts(type = "number | null")]
    pub version: Option<i64>,
    /// A source code is set and still live: the page takes donations.
    pub taking_donations: bool,
}

fn page_row(conn: &Connection) -> rusqlite::Result<Option<(String, DonationPagePayload, i64)>> {
    conn.prepare_cached(
        "SELECT id, first_amount, second_amount, third_amount, minimum_amount, maximum_amount,
                source_code_id, version
         FROM donation_page",
    )?
    .query_row([], |r| {
        Ok((
            r.get(0)?,
            DonationPagePayload {
                amounts: [r.get(1)?, r.get(2)?, r.get(3)?],
                minimum: r.get(4)?,
                maximum: r.get(5)?,
                source_code_id: r.get(6)?,
            },
            r.get(7)?,
        ))
    })
    .optional()
}

/// The group's donation page (every default when never saved).
pub fn page(conn: &Connection) -> rusqlite::Result<DonationPage> {
    let (page, version) = match page_row(conn)? {
        Some((_, page, version)) => (page, Some(version)),
        None => (DonationPagePayload::default(), None),
    };
    let taking_donations = match page.source_code_id.as_deref() {
        Some(code) => sources::describe(conn, code)?.is_some_and(|c| c.is_active),
        None => false,
    };
    Ok(DonationPage {
        page,
        version,
        taking_donations,
    })
}

/// The page's rules, pure: a minimum of at least £1, a maximum of at
/// most £1,000, the minimum no more than the maximum, and three different
/// buttons inside them.
pub fn prepare_page(mut p: DonationPagePayload) -> Result<DonationPagePayload, ContractError> {
    p.source_code_id = p
        .source_code_id
        .map(|c| c.trim().to_owned())
        .filter(|c| !c.is_empty());
    let mut problems = Vec::new();
    if p.minimum < DONATION_FLOOR {
        problems.push(Problem::new(
            "minimum",
            format!("The minimum is at least {}", format_pence(DONATION_FLOOR)),
        ));
    }
    if p.maximum > DONATION_CEILING {
        problems.push(Problem::new(
            "maximum",
            format!(
                "The maximum is at most {}: larger gifts come by bank transfer",
                format_pence(DONATION_CEILING)
            ),
        ));
    }
    if p.minimum > p.maximum {
        problems.push(Problem::new(
            "minimum",
            "The minimum can’t be more than the maximum",
        ));
    }
    if problems.is_empty() {
        for (i, amount) in p.amounts.iter().enumerate() {
            if *amount < p.minimum || *amount > p.maximum {
                problems.push(Problem::new(
                    format!("amounts.{i}"),
                    format!(
                        "Between {} and {}",
                        format_pence(p.minimum),
                        format_pence(p.maximum)
                    ),
                ));
            } else if p.amounts[..i].contains(amount) {
                problems.push(Problem::new(
                    format!("amounts.{i}"),
                    "Each button needs its own amount",
                ));
            }
        }
    }
    checked(p, problems)
}

pub struct DonationPageContract;
pub static DONATION_PAGE: DonationPageContract = DonationPageContract;

impl Contract for DonationPageContract {
    const NAME: &'static str = "giving.donationPage";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = PAGE;
    const COUNTER: &'static str = "version";
    type Payload = DonationPagePayload;
    type State = DonationPagePayload;

    fn prepare(&self, p: DonationPagePayload) -> Result<DonationPagePayload, ContractError> {
        prepare_page(p)
    }

    fn load(&self, tx: &OrgTx, _: &str) -> Result<DonationPagePayload, ContractError> {
        Ok(page_row(tx.read())?.ok_or(ContractError::NotFound)?.1)
    }

    fn apply(
        &self,
        _: Option<&DonationPagePayload>,
        p: &DonationPagePayload,
        _: &Command,
    ) -> Result<DonationPagePayload, ContractError> {
        Ok(p.clone())
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&DonationPagePayload>,
        next: &DonationPagePayload,
    ) -> Result<(), ContractError> {
        // A newly picked code must be live; one picked earlier and
        // archived since stays (the page then takes no donations).
        if let Some(code) = next.source_code_id.as_deref()
            && before.and_then(|b| b.source_code_id.as_deref()) != Some(code)
        {
            check_live_code(tx, code)?;
        }
        let values = params![
            id,
            next.amounts[0],
            next.amounts[1],
            next.amounts[2],
            next.minimum,
            next.maximum,
            next.source_code_id
        ];
        if before.is_none() {
            tx.prepare_cached(
                "INSERT INTO donation_page (id, first_amount, second_amount, third_amount,
                     minimum_amount, maximum_amount, source_code_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?
            .execute(values)?;
        } else {
            tx.prepare_cached(
                "UPDATE donation_page SET first_amount = ?2, second_amount = ?3,
                     third_amount = ?4, minimum_amount = ?5, maximum_amount = ?6,
                     source_code_id = ?7
                 WHERE id = ?1",
            )?
            .execute(values)?;
        }
        Ok(())
    }
}

/// Save the page's settings (the route checks admin). `expected` is the
/// counter as last read, `None` if the caller saw no row; seeing none
/// when another admin has since saved is stale, as a preference's is.
pub fn save_page(
    ctx: &Ctx,
    payload: DonationPagePayload,
    expected: Option<i64>,
    source: Source,
) -> Result<Executed, ContractError> {
    let id = page_row(ctx.tx.read())?.map(|(id, ..)| id);
    let opts = match (&id, expected) {
        (None, _) => Exec::create(source),
        (Some(id), Some(expected)) => Exec::update(id, Some(expected), source),
        (Some(id), None) => Exec::update(id, Some(-1), source),
    };
    execute(ctx, &DONATION_PAGE, payload, opts)
}

// ── giving.donationSubmission ──────────────────────────────────────────────

/// Which gifts the declaration a donor ticked covers, in Gift Aid's own
/// words (`giftaid::Scope` parses them): giving can't name that crate.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "DonationDeclarationScope")]
pub enum DeclarationScope {
    ThisGift,
    Future,
    FutureAndPast4y,
}

impl DeclarationScope {
    pub fn as_str(self) -> &'static str {
        match self {
            DeclarationScope::ThisGift => "thisGift",
            DeclarationScope::Future => "future",
            DeclarationScope::FutureAndPast4y => "futureAndPast4y",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "thisGift" => DeclarationScope::ThisGift,
            "future" => DeclarationScope::Future,
            _ => DeclarationScope::FutureAndPast4y,
        }
    }
}

/// The Gift Aid declaration a donor ticked on the page, with the home
/// address they gave for it (HMRC 3.6.2: house name or number and
/// postcode).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SubmissionGiftAid {
    pub scope: DeclarationScope,
    /// The wording the page showed.
    pub wording_version: String,
    pub address_line1: String,
    pub postcode: String,
}

/// `giving.donationSubmission`: what the donor typed, as typed. Created
/// once and never edited: it is the evidence for the gift and for the
/// declaration. When it was made is the command's time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DonationSubmissionPayload {
    /// Pence.
    #[ts(type = "number")]
    pub amount: i64,
    pub first_name: String,
    pub last_name: String,
    pub email: String,
    /// Present = the donor ticked Gift Aid.
    pub gift_aid: Option<SubmissionGiftAid>,
    /// The page's source code when the donor gave.
    pub source_code_id: String,
}

impl DonationSubmissionPayload {
    /// The submission with every personal field blank: what stays once
    /// its personal data is cleared.
    fn cleared(&self) -> Self {
        DonationSubmissionPayload {
            amount: self.amount,
            first_name: String::new(),
            last_name: String::new(),
            email: String::new(),
            gift_aid: self.gift_aid.as_ref().map(|g| SubmissionGiftAid {
                scope: g.scope,
                wording_version: g.wording_version.clone(),
                address_line1: String::new(),
                postcode: String::new(),
            }),
            source_code_id: self.source_code_id.clone(),
        }
    }
}

/// A submission's rules, pure: an amount from £1 to £1,000 (the group's
/// own range is narrower: [`submit`]), a first and a last name, an email
/// address, and with Gift Aid ticked the wording shown, a house name or
/// number and a postcode. Whitespace is tidied; nothing else is changed.
pub fn prepare_submission(
    p: DonationSubmissionPayload,
) -> Result<DonationSubmissionPayload, ContractError> {
    let out = DonationSubmissionPayload {
        amount: p.amount,
        first_name: tidy(&p.first_name),
        last_name: tidy(&p.last_name),
        email: p.email.trim().to_owned(),
        gift_aid: p.gift_aid.map(|g| SubmissionGiftAid {
            scope: g.scope,
            wording_version: g.wording_version.trim().to_owned(),
            address_line1: tidy(&g.address_line1),
            postcode: tidy(&g.postcode).to_uppercase(),
        }),
        source_code_id: p.source_code_id.trim().to_owned(),
    };
    let mut problems = Vec::new();
    if out.amount < DONATION_FLOOR {
        problems.push(Problem::new(
            "amount",
            format!("The least is {}", format_pence(DONATION_FLOOR)),
        ));
    } else if out.amount > DONATION_CEILING {
        problems.push(Problem::new(
            "amount",
            format!(
                "The most is {}: please give more by bank transfer",
                format_pence(DONATION_CEILING)
            ),
        ));
    }
    for (field, value, what, max) in [
        (
            "firstName",
            &out.first_name,
            "Enter your first name",
            NAME_MAX,
        ),
        ("lastName", &out.last_name, "Enter your last name", NAME_MAX),
        ("email", &out.email, "Enter your email address", EMAIL_MAX),
    ] {
        if value.is_empty() {
            problems.push(Problem::new(field, what));
        }
        too_long(&mut problems, field, value, max);
    }
    if out.source_code_id.is_empty() {
        problems.push(Problem::new("sourceCodeId", "A gift needs a source code"));
    }
    if let Some(g) = &out.gift_aid {
        if g.wording_version.is_empty() {
            problems.push(Problem::new(
                "giftAid.wordingVersion",
                "Say which declaration wording the page showed",
            ));
        }
        too_long(
            &mut problems,
            "giftAid.wordingVersion",
            &g.wording_version,
            WORDING_VERSION_MAX,
        );
        for (field, value, what) in [
            (
                "giftAid.addressLine1",
                &g.address_line1,
                "Enter your house name or number",
            ),
            ("giftAid.postcode", &g.postcode, "Enter your postcode"),
        ] {
            if value.is_empty() {
                problems.push(Problem::new(field, what));
            }
            too_long(&mut problems, field, value, NAME_MAX);
        }
    }
    checked(out, problems)
}

/// A submission as stored, with when it was made (the command's time).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SubmissionState {
    #[serde(flatten)]
    pub payload: DonationSubmissionPayload,
    #[serde(skip)]
    submitted_at: i64,
}

const SUBMISSION_COLUMNS: &str = "amount, first_name, last_name, email, gift_aid, \
     declaration_scope, wording_version, address_line1, postcode, source_code_id, submitted_at";

fn submission_at(r: &Row, i: usize) -> rusqlite::Result<SubmissionState> {
    let gift_aid: bool = r.get(i + 4)?;
    Ok(SubmissionState {
        payload: DonationSubmissionPayload {
            amount: r.get(i)?,
            first_name: r.get(i + 1)?,
            last_name: r.get(i + 2)?,
            email: r.get(i + 3)?,
            gift_aid: if gift_aid {
                Some(SubmissionGiftAid {
                    scope: DeclarationScope::parse(
                        &r.get::<_, Option<String>>(i + 5)?.unwrap_or_default(),
                    ),
                    wording_version: r.get::<_, Option<String>>(i + 6)?.unwrap_or_default(),
                    address_line1: r.get(i + 7)?,
                    postcode: r.get(i + 8)?,
                })
            } else {
                None
            },
            source_code_id: r.get(i + 9)?,
        },
        submitted_at: r.get(i + 10)?,
    })
}

fn load_submission(conn: &Connection, id: &str) -> rusqlite::Result<Option<SubmissionState>> {
    conn.prepare_cached(&format!(
        "SELECT {SUBMISSION_COLUMNS} FROM donation_submissions WHERE id = ?1"
    ))?
    .query_row([id], |r| submission_at(r, 0))
    .optional()
}

pub struct DonationSubmission;
pub static DONATION_SUBMISSION: DonationSubmission = DonationSubmission;

impl Contract for DonationSubmission {
    const NAME: &'static str = "giving.donationSubmission";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = SUBMISSIONS;
    const COUNTER: &'static str = "version";
    type Payload = DonationSubmissionPayload;
    type State = SubmissionState;

    fn prepare(
        &self,
        p: DonationSubmissionPayload,
    ) -> Result<DonationSubmissionPayload, ContractError> {
        prepare_submission(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<SubmissionState, ContractError> {
        load_submission(tx.read(), id)?.ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&SubmissionState>,
        p: &DonationSubmissionPayload,
        command: &Command,
    ) -> Result<SubmissionState, ContractError> {
        if current.is_some() {
            return Err(ContractError::rejected(
                "immutable",
                "A donor’s submission is never changed: it is the evidence for their gift",
            ));
        }
        Ok(SubmissionState {
            payload: p.clone(),
            submitted_at: command.at,
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&SubmissionState>,
        next: &SubmissionState,
    ) -> Result<(), ContractError> {
        let p = &next.payload;
        check_live_code(tx, &p.source_code_id)?;
        let aid = p.gift_aid.as_ref();
        tx.prepare_cached(
            "INSERT INTO donation_submissions (id, amount, first_name, last_name, email,
                 gift_aid, declaration_scope, wording_version, address_line1, postcode,
                 source_code_id, submitted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        )?
        .execute(params![
            id,
            p.amount,
            p.first_name,
            p.last_name,
            p.email,
            aid.is_some(),
            aid.map(|g| g.scope.as_str()),
            aid.map(|g| g.wording_version.as_str()),
            aid.map_or("", |g| g.address_line1.as_str()),
            aid.map_or("", |g| g.postcode.as_str()),
            p.source_code_id,
            next.submitted_at
        ])?;
        Ok(())
    }
}

/// What the page's form sends: a submission without its source code,
/// which is the page's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DonorForm {
    #[ts(type = "number")]
    pub amount: i64,
    pub first_name: String,
    pub last_name: String,
    pub email: String,
    #[serde(default)]
    #[ts(optional)]
    pub gift_aid: Option<SubmissionGiftAid>,
}

/// Store what a donor sent from the page, before Stripe is asked for
/// anything. `id` is the page's key for the attempt (32 hex): a repeat
/// answers the submission first stored under it. Nobody is signed in, so
/// the caller's `ctx` has no actor.
///
/// Refused when the page takes no donations (no source code, or its code
/// archived since: `not_taking_donations`), when the amount is outside
/// the group's range (`422 invalid amount`), and when Gift Aid is ticked
/// though the group doesn't claim it (`claims_gift_aid` false, the
/// organisation's preference, which the api reads: `gift_aid_not_offered`).
/// Writes no gift: only a payment Stripe reports does.
pub fn submit(
    ctx: &Ctx,
    id: &str,
    form: DonorForm,
    claims_gift_aid: bool,
) -> Result<Submission, ContractError> {
    let conn = ctx.tx.read();
    if let Some(held) = submission(conn, id)? {
        return Ok(held);
    }
    let settings = page(conn)?;
    let Some(source_code_id) = settings
        .page
        .source_code_id
        .clone()
        .filter(|_| settings.taking_donations)
    else {
        return Err(ContractError::rejected(
            "not_taking_donations",
            "This page isn’t taking donations",
        ));
    };
    if form.gift_aid.is_some() && !claims_gift_aid {
        return Err(ContractError::rejected(
            "gift_aid_not_offered",
            "This group doesn’t claim Gift Aid",
        ));
    }
    if form.amount < settings.page.minimum || form.amount > settings.page.maximum {
        return Err(ContractError::invalid(
            "amount",
            format!(
                "Between {} and {}",
                format_pence(settings.page.minimum),
                format_pence(settings.page.maximum)
            ),
        ));
    }
    execute(
        ctx,
        &DONATION_SUBMISSION,
        DonationSubmissionPayload {
            amount: form.amount,
            first_name: form.first_name,
            last_name: form.last_name,
            email: form.email,
            gift_aid: form.gift_aid,
            source_code_id,
        },
        Exec::create_with_id(id, Source::System),
    )?;
    submission(ctx.tx.read(), id)?.ok_or(ContractError::NotFound)
}

// ── giving.donationSubmissionOutcome ───────────────────────────────────────

/// Where a submission stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SubmissionStatus {
    /// Stored; the donor was sent to Stripe (or is about to be).
    Started,
    /// Stripe reported its payment.
    Paid,
    /// The Checkout session ran out unpaid.
    Expired,
}

impl SubmissionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SubmissionStatus::Started => "started",
            SubmissionStatus::Paid => "paid",
            SubmissionStatus::Expired => "expired",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "paid" => SubmissionStatus::Paid,
            "expired" => SubmissionStatus::Expired,
            _ => SubmissionStatus::Started,
        }
    }
}

/// `giving.donationSubmissionOutcome`: the system's record of what became
/// of a submission. Never part of what the donor typed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SubmissionOutcomePayload {
    /// Stripe's Checkout session (`cs_…`), set once.
    pub checkout_session_id: Option<String>,
    pub state: SubmissionStatus,
    /// The payment it became (a `stripe_payments` row id): with `paid`
    /// only, set once.
    pub stripe_payment_id: Option<String>,
    /// When its personal fields were cleared (ms); never on a paid one.
    #[ts(type = "number | null")]
    pub personal_cleared_at: Option<i64>,
}

/// The outcome, with when the submission was made (what retention counts
/// from; not serialised).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OutcomeState {
    #[serde(flatten)]
    pub outcome: SubmissionOutcomePayload,
    #[serde(skip)]
    submitted_at: i64,
}

const OUTCOME_COLUMNS: &str =
    "checkout_session_id, state, stripe_payment_id, personal_cleared_at, submitted_at";

fn outcome_at(r: &Row, i: usize) -> rusqlite::Result<OutcomeState> {
    Ok(OutcomeState {
        outcome: SubmissionOutcomePayload {
            checkout_session_id: r.get(i)?,
            state: SubmissionStatus::parse(&r.get::<_, String>(i + 1)?),
            stripe_payment_id: r.get(i + 2)?,
            personal_cleared_at: r.get(i + 3)?,
        },
        submitted_at: r.get(i + 4)?,
    })
}

/// Whether a payment that succeeded names the submission: Stripe took
/// the donor's money for it, whether or not it is marked paid yet.
fn paid_for(conn: &Connection, submission_id: &str) -> rusqlite::Result<bool> {
    conn.prepare_cached(
        "SELECT EXISTS (SELECT 1 FROM stripe_payments
                        WHERE submission_id = ?1 AND status = 'succeeded')",
    )?
    .query_row([submission_id], |r| r.get(0))
}

pub struct DonationSubmissionOutcome;
pub static DONATION_SUBMISSION_OUTCOME: DonationSubmissionOutcome = DonationSubmissionOutcome;

impl Contract for DonationSubmissionOutcome {
    const NAME: &'static str = "giving.donationSubmissionOutcome";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = SUBMISSIONS;
    const COUNTER: &'static str = "outcome_version";
    type Payload = SubmissionOutcomePayload;
    type State = OutcomeState;

    fn prepare(&self, mut p: SubmissionOutcomePayload) -> Result<Self::Payload, ContractError> {
        p.checkout_session_id = p
            .checkout_session_id
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
        let mut problems = Vec::new();
        if let Some(s) = &p.checkout_session_id {
            too_long(&mut problems, "checkoutSessionId", s, PROVIDER_ID_MAX);
        }
        if (p.state == SubmissionStatus::Paid) != p.stripe_payment_id.is_some() {
            problems.push(Problem::new(
                "stripePaymentId",
                "A paid submission names its payment, and no other does",
            ));
        }
        checked(p, problems)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<OutcomeState, ContractError> {
        tx.read()
            .prepare_cached(&format!(
                "SELECT {OUTCOME_COLUMNS} FROM donation_submissions WHERE id = ?1"
            ))?
            .query_row([id], |r| outcome_at(r, 0))
            .optional()?
            .ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&OutcomeState>,
        p: &SubmissionOutcomePayload,
        command: &Command,
    ) -> Result<OutcomeState, ContractError> {
        no_restore(command, "What became of a submission")?;
        // The root is the submission's: an outcome never creates one.
        let current = current.ok_or(ContractError::NotFound)?;
        let held = &current.outcome;
        if held.checkout_session_id.is_some() && held.checkout_session_id != p.checkout_session_id {
            return Err(ContractError::rejected(
                "identity_immutable",
                "A submission keeps its Checkout session",
            ));
        }
        if held.state == SubmissionStatus::Paid
            && (p.state != SubmissionStatus::Paid || held.stripe_payment_id != p.stripe_payment_id)
        {
            return Err(ContractError::rejected(
                "paid",
                "A paid submission stays paid, by the same payment",
            ));
        }
        if held.state == SubmissionStatus::Expired && p.state == SubmissionStatus::Started {
            return Err(ContractError::rejected(
                "expired",
                "An expired submission can’t start again",
            ));
        }
        if held.personal_cleared_at.is_some() {
            if held.personal_cleared_at != p.personal_cleared_at {
                return Err(ContractError::rejected(
                    "cleared",
                    "Personal data, once cleared, stays cleared",
                ));
            }
            if p.state == SubmissionStatus::Paid {
                return Err(ContractError::rejected(
                    "cleared",
                    "A submission whose personal data was cleared can’t become a gift",
                ));
            }
        } else if p.personal_cleared_at.is_some() {
            if p.state == SubmissionStatus::Paid {
                return Err(ContractError::rejected(
                    "paid",
                    "A paid submission is the evidence for its gift: it is kept",
                ));
            }
            if p.personal_cleared_at != Some(command.at) {
                return Err(ContractError::invalid(
                    "personalClearedAt",
                    "Cleared now, or not at all",
                ));
            }
            if command.at - current.submitted_at < UNPAID_RETENTION_DAYS * DAY_MS {
                return Err(ContractError::rejected(
                    "retention_running",
                    format!("An unpaid submission is kept {UNPAID_RETENTION_DAYS} days"),
                ));
            }
        }
        Ok(OutcomeState {
            outcome: p.clone(),
            submitted_at: current.submitted_at,
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&OutcomeState>,
        next: &OutcomeState,
    ) -> Result<(), ContractError> {
        let o = &next.outcome;
        if let Some(session) = o.checkout_session_id.as_deref() {
            let held: Option<String> = tx
                .prepare_cached(
                    "SELECT id FROM donation_submissions
                     WHERE checkout_session_id = ?1 AND id <> ?2",
                )?
                .query_row([session, id], |r| r.get(0))
                .optional()?;
            if let Some(id) = held {
                return Err(ContractError::Duplicate { id });
            }
        }
        if let Some(payment) = o.stripe_payment_id.as_deref() {
            let found: Option<(Option<String>, String)> = tx
                .prepare_cached("SELECT submission_id, status FROM stripe_payments WHERE id = ?1")?
                .query_row([payment], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()?;
            let Some((_, status)) = found.filter(|(from, _)| from.as_deref() == Some(id)) else {
                return Err(ContractError::rejected(
                    "unknown_payment",
                    "A submission is paid by the payment that came from it",
                ));
            };
            // Paid is for good, so only money that arrived makes it so.
            let newly =
                before.and_then(|b| b.outcome.stripe_payment_id.as_deref()) != Some(payment);
            if newly && StripePaymentStatus::parse(&status) != StripePaymentStatus::Succeeded {
                return Err(ContractError::rejected(
                    "payment_not_succeeded",
                    "A submission is paid once its payment has succeeded",
                ));
            }
        }
        tx.prepare_cached(
            "UPDATE donation_submissions SET checkout_session_id = ?2, state = ?3,
                 stripe_payment_id = ?4, personal_cleared_at = ?5
             WHERE id = ?1",
        )?
        .execute(params![
            id,
            o.checkout_session_id,
            o.state.as_str(),
            o.stripe_payment_id,
            o.personal_cleared_at
        ])?;
        let clearing = o.personal_cleared_at.is_some()
            && before.is_some_and(|b| b.outcome.personal_cleared_at.is_none());
        if clearing && paid_for(tx, id)? {
            // Stripe took the money, whatever `state` says yet (a payment
            // waiting in the staff queue): what the donor typed is the
            // evidence for the gift it will become.
            return Err(ContractError::rejected(
                "paid_for",
                "A submission a payment succeeded for is kept",
            ));
        }
        if clearing {
            // Erasure reaches into the submission's slice: its personal
            // columns and every revision that holds them (ADR 0013). The
            // row, the amount and what was ticked stay (rule 3).
            let typed = load_submission(tx, id)?.ok_or(ContractError::NotFound)?;
            tx.prepare_cached(
                "UPDATE donation_submissions SET first_name = '', last_name = '', email = '',
                     address_line1 = '', postcode = ''
                 WHERE id = ?1",
            )?
            .execute([id])?;
            tx.redact_revisions::<DonationSubmission>(id, &typed.payload.cleared())?;
        }
        Ok(())
    }
}

/// A submission as the api reads it: what the donor typed, when, and
/// what became of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Submission {
    pub id: String,
    pub typed: DonationSubmissionPayload,
    /// ms since the epoch; a declaration made from it is dated that day.
    pub submitted_at: i64,
    pub outcome: SubmissionOutcomePayload,
    pub outcome_version: i64,
}

fn submission_where(
    conn: &Connection,
    filter: &str,
    key: &str,
) -> rusqlite::Result<Option<Submission>> {
    conn.prepare_cached(&format!(
        "SELECT id, outcome_version, {SUBMISSION_COLUMNS}, {OUTCOME_COLUMNS}
         FROM donation_submissions WHERE {filter} = ?1"
    ))?
    .query_row([key], |r| {
        let typed = submission_at(r, 2)?;
        Ok(Submission {
            id: r.get(0)?,
            outcome_version: r.get(1)?,
            submitted_at: typed.submitted_at,
            typed: typed.payload,
            outcome: outcome_at(r, 13)?.outcome,
        })
    })
    .optional()
}

/// One submission, or `None`.
pub fn submission(conn: &Connection, id: &str) -> rusqlite::Result<Option<Submission>> {
    submission_where(conn, "id", id)
}

/// The submission a Checkout session was made for, or `None`.
pub fn submission_by_session(
    conn: &Connection,
    checkout_session_id: &str,
) -> rusqlite::Result<Option<Submission>> {
    submission_where(conn, "checkout_session_id", checkout_session_id)
}

fn change_outcome(
    ctx: &Ctx,
    id: &str,
    group: Option<&CommandGroup>,
    change: impl FnOnce(&mut SubmissionOutcomePayload),
) -> Result<Option<Executed>, ContractError> {
    let held = submission(ctx.tx.read(), id)?.ok_or(ContractError::NotFound)?;
    let mut next = held.outcome.clone();
    change(&mut next);
    if next == held.outcome {
        return Ok(None);
    }
    let exec = Exec::update(id, None, Source::System);
    let exec = match group {
        Some(g) => exec.in_group(g),
        None => exec,
    };
    execute(ctx, &DONATION_SUBMISSION_OUTCOME, next, exec).map(Some)
}

/// The Checkout session Stripe made for the submission, once. A repeat
/// with the same session changes nothing (`None`).
pub fn set_checkout_session(
    ctx: &Ctx,
    id: &str,
    checkout_session_id: &str,
) -> Result<Option<Executed>, ContractError> {
    change_outcome(ctx, id, None, |o| {
        o.checkout_session_id = Some(checkout_session_id.trim().to_owned());
    })
}

/// Stripe says the session ran out unpaid. A paid submission stays paid
/// (events arrive in any order); a repeat changes nothing.
pub fn mark_expired(ctx: &Ctx, id: &str) -> Result<Option<Executed>, ContractError> {
    change_outcome(ctx, id, None, |o| {
        if o.state == SubmissionStatus::Started {
            o.state = SubmissionStatus::Expired;
        }
    })
}

/// The submission became `stripe_payment_id` (a `stripe_payments` row
/// that names it and has succeeded: `payment_not_succeeded` otherwise),
/// in the caller's command group. An expired submission
/// may still turn out paid: the money decides. A repeat changes nothing.
pub fn mark_paid(
    ctx: &Ctx,
    id: &str,
    stripe_payment_id: &str,
    group: &CommandGroup,
) -> Result<Option<Executed>, ContractError> {
    change_outcome(ctx, id, Some(group), |o| {
        o.state = SubmissionStatus::Paid;
        o.stripe_payment_id = Some(stripe_payment_id.to_owned());
    })
}

/// Retention: clear the personal fields of at most `limit` unpaid
/// submissions made [`UNPAID_RETENTION_DAYS`] or more before now (the
/// caller's `ctx.at`), oldest first. Each is its own command; the rows
/// stay. A paid submission is never touched, and nor is one a payment
/// succeeded for that isn't marked paid yet (a payment waiting in the
/// staff queue): the contract refuses those too. The ids it cleared.
pub fn clear_unpaid(ctx: &Ctx, limit: usize) -> Result<Vec<String>, ContractError> {
    let before = ctx.at - UNPAID_RETENTION_DAYS * DAY_MS;
    let due: Vec<String> = ctx
        .tx
        .read()
        .prepare_cached(
            "SELECT id FROM donation_submissions INDEXED BY donation_submissions_unpaid
             WHERE state <> 'paid' AND personal_cleared_at IS NULL AND submitted_at <= ?1
               AND NOT EXISTS (SELECT 1 FROM stripe_payments p
                               WHERE p.submission_id = donation_submissions.id
                                 AND p.status = 'succeeded')
             ORDER BY submitted_at LIMIT ?2",
        )?
        .query_map(params![before, limit as i64], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in &due {
        change_outcome(ctx, id, None, |o| o.personal_cleared_at = Some(ctx.at))?;
    }
    Ok(due)
}

// ── giving.stripePayment ───────────────────────────────────────────────────

/// A Stripe payment's status, in our words for a PaymentIntent's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum StripePaymentStatus {
    Pending,
    Succeeded,
    Failed,
    Cancelled,
}

impl StripePaymentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            StripePaymentStatus::Pending => "pending",
            StripePaymentStatus::Succeeded => "succeeded",
            StripePaymentStatus::Failed => "failed",
            StripePaymentStatus::Cancelled => "cancelled",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "succeeded" => StripePaymentStatus::Succeeded,
            "failed" => StripePaymentStatus::Failed,
            "cancelled" => StripePaymentStatus::Cancelled,
            _ => StripePaymentStatus::Pending,
        }
    }
}

/// Where a card dispute on the payment stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "StripeDisputeState")]
pub enum DisputeState {
    Open,
    Won,
    Lost,
}

impl DisputeState {
    pub fn as_str(self) -> &'static str {
        match self {
            DisputeState::Open => "open",
            DisputeState::Won => "won",
            DisputeState::Lost => "lost",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "open" => Some(DisputeState::Open),
            "won" => Some(DisputeState::Won),
            "lost" => Some(DisputeState::Lost),
            _ => None,
        }
    }
}

/// `giving.stripePayment`: one Stripe payment as Stripe reports it, the
/// provider's raw record beside its gift (ADR 0025). Amounts are Stripe's
/// minor units: pence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StripePaymentPayload {
    /// Stripe's PaymentIntent id (`pi_…`); fixed.
    pub payment_id: String,
    /// The submission it came from; none for a payment made some other
    /// way on the group's account. Set once.
    pub submission_id: Option<String>,
    #[ts(type = "number")]
    pub amount: i64,
    /// Always `gbp`: a payment in another currency is never recorded.
    pub currency: String,
    pub status: StripePaymentStatus,
    /// The UK date it succeeded (ISO): its gift's date.
    pub paid_on: Option<String>,
    /// How much of it was refunded, in all.
    #[ts(type = "number")]
    pub refunded_amount: i64,
    pub dispute: Option<DisputeState>,
    /// Why it failed, was refunded or disputed (Stripe's words).
    pub reason: Option<String>,
}

/// The status a payment's gift has: the gift follows its payment (ADR
/// 0025). A full refund is `refunded`; a partial one leaves the gift
/// `completed` at [`kept_amount`]; a dispute, open or lost, is
/// `charged_back`, and `completed` again if the group wins.
pub fn gift_status(p: &StripePaymentPayload) -> Status {
    match p.status {
        StripePaymentStatus::Pending => Status::Pending,
        StripePaymentStatus::Failed => Status::Failed,
        StripePaymentStatus::Cancelled => Status::Cancelled,
        StripePaymentStatus::Succeeded if p.refunded_amount >= p.amount => Status::Refunded,
        StripePaymentStatus::Succeeded => match p.dispute {
            Some(DisputeState::Open | DisputeState::Lost) => Status::ChargedBack,
            Some(DisputeState::Won) | None => Status::Completed,
        },
    }
}

/// What the group kept of a payment, in pence: its amount less refunds.
/// The amount of its gift after a partial refund (a gift already in a
/// Gift Aid claim keeps its claimed amount and is flagged instead:
/// [`StripePaymentMatchPayload::partial_refund_claimed`]).
pub fn kept_amount(p: &StripePaymentPayload) -> i64 {
    p.amount - p.refunded_amount
}

const PAYMENT_COLUMNS: &str = "payment_id, submission_id, amount, currency, status, paid_on, \
     refunded_amount, dispute_state, reason";

fn payment_at(r: &Row, i: usize) -> rusqlite::Result<StripePaymentPayload> {
    Ok(StripePaymentPayload {
        payment_id: r.get(i)?,
        submission_id: r.get(i + 1)?,
        amount: r.get(i + 2)?,
        currency: r.get(i + 3)?,
        status: StripePaymentStatus::parse(&r.get::<_, String>(i + 4)?),
        paid_on: r.get(i + 5)?,
        refunded_amount: r.get(i + 6)?,
        dispute: r
            .get::<_, Option<String>>(i + 7)?
            .as_deref()
            .and_then(DisputeState::parse),
        reason: r.get(i + 8)?,
    })
}

pub struct StripePayment;
pub static STRIPE_PAYMENT: StripePayment = StripePayment;

impl Contract for StripePayment {
    const NAME: &'static str = "giving.stripePayment";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = PAYMENTS;
    const COUNTER: &'static str = "version";
    type Payload = StripePaymentPayload;
    type State = StripePaymentPayload;

    fn prepare(&self, mut p: StripePaymentPayload) -> Result<StripePaymentPayload, ContractError> {
        p.payment_id = p.payment_id.trim().to_owned();
        p.currency = p.currency.trim().to_lowercase();
        p.reason = p
            .reason
            .map(|r| r.trim().chars().take(REASON_MAX).collect::<String>())
            .filter(|r| !r.is_empty());
        let mut problems = Vec::new();
        if p.payment_id.is_empty() {
            problems.push(Problem::new("paymentId", "A payment has its provider id"));
        }
        too_long(&mut problems, "paymentId", &p.payment_id, PROVIDER_ID_MAX);
        if p.currency != "gbp" {
            problems.push(Problem::new("currency", "Only payments in pounds are kept"));
        }
        if p.amount <= 0 || p.amount > crate::rules::PENCE_MAX {
            problems.push(Problem::new("amount", "The amount must be over £0"));
        }
        if p.refunded_amount < 0 || p.refunded_amount > p.amount {
            problems.push(Problem::new(
                "refundedAmount",
                "A refund is at most the payment",
            ));
        }
        if p.paid_on.as_deref().is_some_and(|d| !is_iso_date(d)) {
            problems.push(Problem::new("paidOn", "Dates are YYYY-MM-DD"));
        }
        if p.status == StripePaymentStatus::Succeeded && p.paid_on.is_none() {
            problems.push(Problem::new(
                "paidOn",
                "A payment that succeeded has its date",
            ));
        }
        checked(p, problems)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<StripePaymentPayload, ContractError> {
        tx.read()
            .prepare_cached(&format!(
                "SELECT {PAYMENT_COLUMNS} FROM stripe_payments WHERE id = ?1"
            ))?
            .query_row([id], |r| payment_at(r, 0))
            .optional()?
            .ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&StripePaymentPayload>,
        p: &StripePaymentPayload,
        command: &Command,
    ) -> Result<StripePaymentPayload, ContractError> {
        no_restore(command, "A payment’s record")?;
        if let Some(current) = current
            && (current.payment_id != p.payment_id
                || (current.submission_id.is_some() && current.submission_id != p.submission_id))
        {
            return Err(ContractError::rejected(
                "identity_immutable",
                "A payment’s provider id and submission can’t change",
            ));
        }
        Ok(p.clone())
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&StripePaymentPayload>,
        next: &StripePaymentPayload,
    ) -> Result<(), ContractError> {
        if let Some(submission) = next.submission_id.as_deref()
            && before.and_then(|b| b.submission_id.as_deref()) != Some(submission)
            && load_submission(tx, submission)?.is_none()
        {
            return Err(ContractError::rejected(
                "unknown_submission",
                "A payment can only come from a submission on record",
            ));
        }
        if before.is_none() {
            let held: Option<String> = tx
                .prepare_cached("SELECT id FROM stripe_payments WHERE payment_id = ?1")?
                .query_row([&next.payment_id], |r| r.get(0))
                .optional()?;
            if let Some(id) = held {
                return Err(ContractError::Duplicate { id });
            }
            tx.prepare_cached(
                "INSERT INTO stripe_payments (id, payment_id, submission_id, amount, currency,
                     status, paid_on, refunded_amount, dispute_state, reason)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )?
            .execute(params![
                id,
                next.payment_id,
                next.submission_id,
                next.amount,
                next.currency,
                next.status.as_str(),
                next.paid_on,
                next.refunded_amount,
                next.dispute.map(DisputeState::as_str),
                next.reason
            ])?;
        } else {
            tx.prepare_cached(
                "UPDATE stripe_payments SET submission_id = ?2, amount = ?3, status = ?4,
                     paid_on = ?5, refunded_amount = ?6, dispute_state = ?7, reason = ?8
                 WHERE id = ?1",
            )?
            .execute(params![
                id,
                next.submission_id,
                next.amount,
                next.status.as_str(),
                next.paid_on,
                next.refunded_amount,
                next.dispute.map(DisputeState::as_str),
                next.reason
            ])?;
        }
        Ok(())
    }
}

// ── giving.stripePaymentMatch ──────────────────────────────────────────────

/// Why a payment went to the staff queue instead of a contact.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum UnmatchedReason {
    /// More than one contact has the donor's email address.
    Ambiguous,
    /// One contact has it, under another last name.
    NameDiffers,
}

impl UnmatchedReason {
    pub fn as_str(self) -> &'static str {
        match self {
            UnmatchedReason::Ambiguous => "ambiguous",
            UnmatchedReason::NameDiffers => "name_differs",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "ambiguous" => Some(UnmatchedReason::Ambiguous),
            "name_differs" => Some(UnmatchedReason::NameDiffers),
            _ => None,
        }
    }
}

/// `giving.stripePaymentMatch`: whose the payment is. Matched = a contact
/// and that contact's gift, together; the gift is the payment's for its
/// whole life. Unmatched = neither, with why once someone looked.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StripePaymentMatchPayload {
    pub contact_id: Option<String>,
    pub gift_id: Option<String>,
    /// Why it is in the staff queue; none once matched.
    pub unmatched: Option<UnmatchedReason>,
    /// For staff: the first name the donor typed, when it isn't the
    /// contact's ("first name differs: Jane"). Staff clear it once they
    /// have looked, or move the gift.
    pub first_name_typed: Option<String>,
    /// For staff: part of the payment was refunded after its gift went
    /// into a Gift Aid claim, which keeps the amount it claimed.
    #[serde(default)]
    pub partial_refund_claimed: bool,
}

/// The match, with who matched it and when (the command's, set with the
/// gift; not serialised).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MatchState {
    #[serde(flatten)]
    pub matched: StripePaymentMatchPayload,
    #[serde(skip)]
    matched_by: Option<i64>,
    #[serde(skip)]
    matched_at: Option<i64>,
}

const MATCH_COLUMNS: &str = "contact_id, gift_id, unmatched_reason, first_name_typed, \
     partial_refund_claimed, matched_by, matched_at";

fn match_at(r: &Row, i: usize) -> rusqlite::Result<MatchState> {
    Ok(MatchState {
        matched: StripePaymentMatchPayload {
            contact_id: r.get(i)?,
            gift_id: r.get(i + 1)?,
            unmatched: r
                .get::<_, Option<String>>(i + 2)?
                .as_deref()
                .and_then(UnmatchedReason::parse),
            first_name_typed: r.get(i + 3)?,
            partial_refund_claimed: r.get(i + 4)?,
        },
        matched_by: r.get(i + 5)?,
        matched_at: r.get(i + 6)?,
    })
}

pub struct StripePaymentMatch;
pub static STRIPE_PAYMENT_MATCH: StripePaymentMatch = StripePaymentMatch;

impl Contract for StripePaymentMatch {
    const NAME: &'static str = "giving.stripePaymentMatch";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = PAYMENTS;
    const COUNTER: &'static str = "match_version";
    type Payload = StripePaymentMatchPayload;
    type State = MatchState;

    fn prepare(
        &self,
        mut p: StripePaymentMatchPayload,
    ) -> Result<StripePaymentMatchPayload, ContractError> {
        p.first_name_typed = p
            .first_name_typed
            .map(|n| tidy(&n))
            .filter(|n| !n.is_empty());
        let mut problems = Vec::new();
        if p.contact_id.is_some() != p.gift_id.is_some() {
            problems.push(Problem::new(
                "giftId",
                "A matched payment has its contact and its gift, together",
            ));
        }
        if p.gift_id.is_some() && p.unmatched.is_some() {
            problems.push(Problem::new(
                "unmatched",
                "A matched payment has no reason to be in the queue",
            ));
        }
        if p.gift_id.is_none() && (p.first_name_typed.is_some() || p.partial_refund_claimed) {
            problems.push(Problem::new(
                "giftId",
                "Only a matched payment carries flags for staff",
            ));
        }
        if let Some(n) = &p.first_name_typed {
            too_long(&mut problems, "firstNameTyped", n, NAME_MAX);
        }
        checked(p, problems)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<MatchState, ContractError> {
        tx.read()
            .prepare_cached(&format!(
                "SELECT {MATCH_COLUMNS} FROM stripe_payments WHERE id = ?1"
            ))?
            .query_row([id], |r| match_at(r, 0))
            .optional()?
            .ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&MatchState>,
        p: &StripePaymentMatchPayload,
        command: &Command,
    ) -> Result<MatchState, ContractError> {
        no_restore(command, "A payment’s match")?;
        // The root is the payment's: a match never creates one.
        let current = current.ok_or(ContractError::NotFound)?;
        if current.matched.gift_id.is_some() && current.matched.gift_id != p.gift_id {
            return Err(ContractError::rejected(
                "already_matched",
                "A payment keeps its gift for its whole life",
            ));
        }
        let newly = current.matched.gift_id.is_none() && p.gift_id.is_some();
        Ok(MatchState {
            matched: p.clone(),
            matched_by: if newly {
                command.actor
            } else {
                current.matched_by
            },
            matched_at: if newly {
                Some(command.at)
            } else {
                current.matched_at
            },
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&MatchState>,
        next: &MatchState,
    ) -> Result<(), ContractError> {
        let m = &next.matched;
        if let (Some(contact), Some(gift)) = (m.contact_id.as_deref(), m.gift_id.as_deref()) {
            if contacts::donors::kind_of(tx, contact)?.is_none() {
                return Err(ContractError::rejected(
                    "unknown_contact",
                    "Contact must exist",
                ));
            }
            if crate::describe_gift(tx, gift)?.is_none_or(|g| g.contact_id != contact) {
                return Err(ContractError::rejected(
                    "unknown_gift",
                    "A payment’s gift is one of its contact’s gifts",
                ));
            }
            let taken: bool = tx
                .prepare_cached(
                    "SELECT EXISTS (SELECT 1 FROM stripe_payments WHERE gift_id = ?1 AND id <> ?2)",
                )?
                .query_row([gift, id], |r| r.get(0))?;
            if taken {
                return Err(ContractError::rejected(
                    "gift_taken",
                    "That gift is another payment’s",
                ));
            }
        }
        tx.prepare_cached(
            "UPDATE stripe_payments SET contact_id = ?2, gift_id = ?3, unmatched_reason = ?4,
                 first_name_typed = ?5, partial_refund_claimed = ?6, matched_by = ?7,
                 matched_at = ?8
             WHERE id = ?1",
        )?
        .execute(params![
            id,
            m.contact_id,
            m.gift_id,
            m.unmatched.map(UnmatchedReason::as_str),
            m.first_name_typed,
            m.partial_refund_claimed,
            next.matched_by,
            next.matched_at
        ])?;
        Ok(())
    }
}

/// A payment row as the api reads it: Stripe's record, whose it is, and
/// both counters.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentRecord {
    /// Our row id (not Stripe's).
    pub id: String,
    pub payment: StripePaymentPayload,
    pub version: i64,
    pub matched: StripePaymentMatchPayload,
    pub match_version: i64,
}

fn payment_where(
    conn: &Connection,
    filter: &str,
    key: &str,
) -> rusqlite::Result<Option<PaymentRecord>> {
    conn.prepare_cached(&format!(
        "SELECT id, version, match_version, {PAYMENT_COLUMNS}, {MATCH_COLUMNS}
         FROM stripe_payments WHERE {filter} = ?1"
    ))?
    .query_row([key], |r| {
        Ok(PaymentRecord {
            id: r.get(0)?,
            version: r.get(1)?,
            match_version: r.get(2)?,
            payment: payment_at(r, 3)?,
            matched: match_at(r, 12)?.matched,
        })
    })
    .optional()
}

/// One payment by our row id, or `None`.
pub fn payment(conn: &Connection, id: &str) -> rusqlite::Result<Option<PaymentRecord>> {
    payment_where(conn, "id", id)
}

/// The payment for Stripe's PaymentIntent id, or `None`.
pub fn payment_by_stripe_id(
    conn: &Connection,
    payment_id: &str,
) -> rusqlite::Result<Option<PaymentRecord>> {
    payment_where(conn, "payment_id", payment_id)
}

/// The payment a gift is, or `None` (not a Stripe gift).
pub fn payment_of_gift(
    conn: &Connection,
    gift_id: &str,
) -> rusqlite::Result<Option<PaymentRecord>> {
    payment_where(conn, "gift_id", gift_id)
}

/// Record a payment as Stripe now reports it, as the system, in the
/// caller's command group: a new row the first time its id is seen, an
/// update when anything changed, nothing on a replay. `submission_id`
/// may be left out of a later report: the row keeps the one it has. The
/// row as it now is, and whether this call changed it.
///
/// A payment that isn't in pounds is `422 invalid currency`: the caller
/// logs it and records nothing.
pub fn record_payment(
    ctx: &Ctx,
    mut report: StripePaymentPayload,
    group: &CommandGroup,
) -> Result<(PaymentRecord, bool), ContractError> {
    let payment_id = report.payment_id.trim().to_owned();
    let changed = match payment_by_stripe_id(ctx.tx.read(), &payment_id)? {
        None => {
            execute(
                ctx,
                &STRIPE_PAYMENT,
                report,
                Exec::create(Source::System).in_group(group),
            )?;
            true
        }
        Some(held) => {
            if report.submission_id.is_none() {
                report.submission_id = held.payment.submission_id.clone();
            }
            let report = STRIPE_PAYMENT.prepare(report)?;
            if report == held.payment {
                false
            } else {
                execute(
                    ctx,
                    &STRIPE_PAYMENT,
                    report,
                    Exec::update(&held.id, None, Source::System).in_group(group),
                )?;
                true
            }
        }
    };
    let now = payment_by_stripe_id(ctx.tx.read(), &payment_id)?.ok_or(ContractError::NotFound)?;
    Ok((now, changed))
}

/// Say whose payment `id` (our row id) is, or why nobody's yet.
/// `expected` is `matchVersion` as staff last read it (`409 stale` with
/// the match as it now is otherwise); the system passes `None`.
pub fn set_match(
    ctx: &Ctx,
    id: &str,
    matched: StripePaymentMatchPayload,
    expected: Option<i64>,
    source: Source,
    group: Option<&CommandGroup>,
) -> Result<Executed, ContractError> {
    let exec = Exec::update(id, expected, source);
    let exec = match group {
        Some(g) => exec.in_group(g),
        None => exec,
    };
    execute(ctx, &STRIPE_PAYMENT_MATCH, matched, exec)
}

/// "Card payments to match": payments nobody could be matched to (no
/// gift), newest first, at most [`UNMATCHED_LIMIT`]. One indexed read.
pub fn unmatched(conn: &Connection) -> rusqlite::Result<Vec<PaymentRecord>> {
    conn.prepare_cached(&format!(
        "SELECT id, version, match_version, {PAYMENT_COLUMNS}, {MATCH_COLUMNS}
         FROM stripe_payments INDEXED BY stripe_payments_unmatched
         WHERE gift_id IS NULL AND unmatched_reason IS NOT NULL
         ORDER BY seq DESC LIMIT {UNMATCHED_LIMIT}"
    ))?
    .query_map([], |r| {
        Ok(PaymentRecord {
            id: r.get(0)?,
            version: r.get(1)?,
            match_version: r.get(2)?,
            payment: payment_at(r, 3)?,
            matched: match_at(r, 12)?.matched,
        })
    })?
    .collect()
}

// ── the matching rule ──────────────────────────────────────────────────────

/// A live contact that has the donor's email address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub contact_id: String,
    pub first_name: String,
    pub last_name: String,
}

/// Whose a donor's gift is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DonorMatch {
    /// No contact has the email address: a new contact.
    New,
    /// Exactly one contact has it, under the same last name.
    Linked {
        contact_id: String,
        /// The first name the donor typed, when it isn't the contact's:
        /// the gift is linked all the same and marked for staff (a
        /// couple sharing an address).
        first_name_typed: Option<String>,
    },
    /// The staff queue.
    Unmatched(UnmatchedReason),
}

/// A name as matching compares it: case, accents, spacing and
/// punctuation ignored ("O’Brien" = "o brien" = "OBRIEN"; "Zoë" = "Zoe").
pub fn name_key(name: &str) -> String {
    fold(name).chars().filter(|c| c.is_alphanumeric()).collect()
}

/// The donor-matching rule, pure. `candidates` are the live contacts
/// that have the email address the donor typed; `truncated` says the
/// lookup read no further (more may exist).
///
/// - nobody has the address → a new contact;
/// - exactly one contact has it and the last name agrees ([`name_key`])
///   → linked, whatever the first name, which is carried for staff when
///   it differs;
/// - anything else → the staff queue: more than one contact or a
///   truncated lookup (`ambiguous`), or another last name
///   (`name_differs`; a last name that is blank on either side never
///   agrees).
///
/// The public page's answer never depends on which.
pub fn match_donor(
    first_name: &str,
    last_name: &str,
    candidates: &[Candidate],
    truncated: bool,
) -> DonorMatch {
    if truncated || candidates.len() > 1 {
        return DonorMatch::Unmatched(UnmatchedReason::Ambiguous);
    }
    let Some(only) = candidates.first() else {
        return DonorMatch::New;
    };
    let last = name_key(last_name);
    if last.is_empty() || last != name_key(&only.last_name) {
        return DonorMatch::Unmatched(UnmatchedReason::NameDiffers);
    }
    let typed = tidy(first_name);
    DonorMatch::Linked {
        contact_id: only.contact_id.clone(),
        first_name_typed: (name_key(&typed) != name_key(&only.first_name)).then_some(typed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ann() -> Candidate {
        Candidate {
            contact_id: "ann".into(),
            first_name: "Ann".into(),
            last_name: "O’Brien-Müller".into(),
        }
    }

    fn linked(first_name_typed: Option<&str>) -> DonorMatch {
        DonorMatch::Linked {
            contact_id: "ann".into(),
            first_name_typed: first_name_typed.map(Into::into),
        }
    }

    #[test]
    fn nobody_with_the_email_is_a_new_contact() {
        assert_eq!(match_donor("Ann", "Smith", &[], false), DonorMatch::New);
    }

    #[test]
    fn one_contact_with_the_same_last_name_is_linked() {
        assert_eq!(
            match_donor("Ann", "O’Brien-Müller", &[ann()], false),
            linked(None)
        );
    }

    #[test]
    fn last_names_agree_ignoring_case_accents_spacing_and_punctuation() {
        for typed in [
            "o'brien-muller",
            "OBRIEN MULLER",
            "  O Brien  Müller ",
            "O’Brien–Muller.",
            "ObrienMu\u{308}ller",
        ] {
            assert_eq!(
                match_donor("ann", typed, &[ann()], false),
                linked(None),
                "{typed}"
            );
        }
    }

    #[test]
    fn a_different_first_name_still_links_and_is_marked_for_staff() {
        assert_eq!(
            match_donor("  Jane ", "O'Brien Muller", &[ann()], false),
            linked(Some("Jane"))
        );
        // An initial, or a longer form, is a different first name too.
        assert_eq!(
            match_donor("A", "O'Brien Muller", &[ann()], false),
            linked(Some("A"))
        );
    }

    #[test]
    fn the_same_first_name_is_not_marked_whatever_its_case_or_accents() {
        let zoe = Candidate {
            contact_id: "ann".into(),
            first_name: "Zoë".into(),
            last_name: "Smith".into(),
        };
        assert_eq!(match_donor("ZOE", "smith", &[zoe], false), linked(None));
    }

    #[test]
    fn a_different_last_name_goes_to_the_staff_queue() {
        for typed in ["Smith", "O’Brien", "Müller", "O’Brien-Müllers"] {
            assert_eq!(
                match_donor("Ann", typed, &[ann()], false),
                DonorMatch::Unmatched(UnmatchedReason::NameDiffers),
                "{typed}"
            );
        }
    }

    #[test]
    fn a_blank_last_name_never_agrees() {
        let organisation = Candidate {
            contact_id: "org".into(),
            first_name: String::new(),
            last_name: String::new(),
        };
        assert_eq!(
            match_donor("Ann", " - ", std::slice::from_ref(&organisation), false),
            DonorMatch::Unmatched(UnmatchedReason::NameDiffers)
        );
        assert_eq!(
            match_donor("Ann", "Smith", &[organisation], false),
            DonorMatch::Unmatched(UnmatchedReason::NameDiffers)
        );
    }

    #[test]
    fn two_contacts_with_the_email_are_ambiguous_even_when_one_agrees() {
        let other = Candidate {
            contact_id: "bob".into(),
            first_name: "Bob".into(),
            last_name: "Jones".into(),
        };
        assert_eq!(
            match_donor("Ann", "O’Brien-Müller", &[ann(), other], false),
            DonorMatch::Unmatched(UnmatchedReason::Ambiguous)
        );
    }

    #[test]
    fn a_truncated_lookup_is_ambiguous_whatever_it_found() {
        assert_eq!(
            match_donor("Ann", "O’Brien-Müller", &[ann()], true),
            DonorMatch::Unmatched(UnmatchedReason::Ambiguous)
        );
        assert_eq!(
            match_donor("Ann", "Smith", &[], true),
            DonorMatch::Unmatched(UnmatchedReason::Ambiguous)
        );
    }

    fn payment(status: StripePaymentStatus) -> StripePaymentPayload {
        StripePaymentPayload {
            payment_id: "pi_1".into(),
            submission_id: None,
            amount: 2500,
            currency: "gbp".into(),
            status,
            paid_on: Some("2026-11-18".into()),
            refunded_amount: 0,
            dispute: None,
            reason: None,
        }
    }

    #[test]
    fn only_a_payment_that_succeeded_is_a_completed_gift() {
        assert_eq!(
            gift_status(&payment(StripePaymentStatus::Succeeded)),
            Status::Completed
        );
        assert_eq!(
            gift_status(&payment(StripePaymentStatus::Pending)),
            Status::Pending
        );
        assert_eq!(
            gift_status(&payment(StripePaymentStatus::Failed)),
            Status::Failed
        );
        assert_eq!(
            gift_status(&payment(StripePaymentStatus::Cancelled)),
            Status::Cancelled
        );
    }

    #[test]
    fn a_full_refund_is_refunded_and_a_partial_one_stays_completed_at_what_was_kept() {
        let partial = StripePaymentPayload {
            refunded_amount: 1000,
            ..payment(StripePaymentStatus::Succeeded)
        };
        assert_eq!(gift_status(&partial), Status::Completed);
        assert_eq!(kept_amount(&partial), 1500);
        let full = StripePaymentPayload {
            refunded_amount: 2500,
            ..payment(StripePaymentStatus::Succeeded)
        };
        assert_eq!(gift_status(&full), Status::Refunded);
        assert_eq!(kept_amount(&full), 0);
    }

    #[test]
    fn a_dispute_is_charged_back_until_the_group_wins() {
        let with = |dispute| StripePaymentPayload {
            dispute: Some(dispute),
            ..payment(StripePaymentStatus::Succeeded)
        };
        assert_eq!(gift_status(&with(DisputeState::Open)), Status::ChargedBack);
        assert_eq!(gift_status(&with(DisputeState::Lost)), Status::ChargedBack);
        assert_eq!(gift_status(&with(DisputeState::Won)), Status::Completed);
    }

    fn page_fields(p: DonationPagePayload) -> Vec<String> {
        match prepare_page(p) {
            Ok(_) => vec![],
            Err(ContractError::Invalid(problems)) => {
                problems.into_iter().map(|p| p.field).collect()
            }
            Err(e) => panic!("{e}"),
        }
    }

    #[test]
    fn the_default_page_is_ten_twenty_five_and_fifty_pounds_from_two_to_a_thousand() {
        let page = DonationPagePayload::default();
        assert_eq!(page.amounts, [1000, 2500, 5000]);
        assert_eq!((page.minimum, page.maximum), (200, 100_000));
        assert!(page_fields(page).is_empty());
    }

    #[test]
    fn a_group_cannot_set_a_minimum_under_a_pound_or_a_maximum_over_a_thousand() {
        let page = DonationPagePayload::default;
        assert_eq!(
            page_fields(DonationPagePayload {
                minimum: 99,
                ..page()
            }),
            ["minimum"]
        );
        assert!(
            page_fields(DonationPagePayload {
                minimum: 100,
                ..page()
            })
            .is_empty()
        );
        assert_eq!(
            page_fields(DonationPagePayload {
                maximum: 100_001,
                ..page()
            }),
            ["maximum"]
        );
        assert_eq!(
            page_fields(DonationPagePayload {
                amounts: [1000, 1500, 2000],
                minimum: 3000,
                maximum: 2000,
                ..page()
            }),
            ["minimum"]
        );
    }

    #[test]
    fn the_three_buttons_are_different_amounts_inside_the_groups_range() {
        let page = DonationPagePayload::default;
        assert_eq!(
            page_fields(DonationPagePayload {
                amounts: [100, 2500, 100_001],
                ..page()
            }),
            ["amounts.0", "amounts.2"]
        );
        assert_eq!(
            page_fields(DonationPagePayload {
                amounts: [1000, 1000, 5000],
                ..page()
            }),
            ["amounts.1"]
        );
    }

    fn typed() -> DonationSubmissionPayload {
        DonationSubmissionPayload {
            amount: 2500,
            first_name: " Jane ".into(),
            last_name: "Smith".into(),
            email: " jane@example.org ".into(),
            gift_aid: Some(SubmissionGiftAid {
                scope: DeclarationScope::FutureAndPast4y,
                wording_version: "hmrc-2016-04".into(),
                address_line1: " 12  High Street".into(),
                postcode: "ab1  2cd".into(),
            }),
            source_code_id: "code".into(),
        }
    }

    fn submission_fields(p: DonationSubmissionPayload) -> Vec<String> {
        match prepare_submission(p) {
            Ok(_) => vec![],
            Err(ContractError::Invalid(problems)) => {
                problems.into_iter().map(|p| p.field).collect()
            }
            Err(e) => panic!("{e}"),
        }
    }

    #[test]
    fn a_submission_is_tidied_and_otherwise_kept_as_typed() {
        let out = prepare_submission(typed()).unwrap();
        assert_eq!(out.first_name, "Jane");
        assert_eq!(out.email, "jane@example.org");
        let aid = out.gift_aid.unwrap();
        assert_eq!(aid.address_line1, "12 High Street");
        assert_eq!(aid.postcode, "AB1 2CD");
    }

    #[test]
    fn the_server_never_takes_under_a_pound_or_over_a_thousand() {
        for (amount, ok) in [(99, false), (100, true), (100_000, true), (100_001, false)] {
            let fields = submission_fields(DonationSubmissionPayload { amount, ..typed() });
            assert_eq!(fields.is_empty(), ok, "{amount}: {fields:?}");
        }
    }

    #[test]
    fn a_submission_needs_a_name_and_an_email_address() {
        assert_eq!(
            submission_fields(DonationSubmissionPayload {
                first_name: " ".into(),
                last_name: String::new(),
                email: " ".into(),
                ..typed()
            }),
            ["firstName", "lastName", "email"]
        );
    }

    #[test]
    fn the_home_address_is_needed_only_when_gift_aid_is_ticked() {
        assert!(
            submission_fields(DonationSubmissionPayload {
                gift_aid: None,
                ..typed()
            })
            .is_empty()
        );
        assert_eq!(
            submission_fields(DonationSubmissionPayload {
                gift_aid: Some(SubmissionGiftAid {
                    scope: DeclarationScope::FutureAndPast4y,
                    wording_version: " ".into(),
                    address_line1: String::new(),
                    postcode: " ".into(),
                }),
                ..typed()
            }),
            [
                "giftAid.wordingVersion",
                "giftAid.addressLine1",
                "giftAid.postcode"
            ]
        );
    }

    #[test]
    fn stored_words_round_trip() {
        for s in [
            SubmissionStatus::Started,
            SubmissionStatus::Paid,
            SubmissionStatus::Expired,
        ] {
            assert_eq!(SubmissionStatus::parse(s.as_str()), s);
        }
        for s in [
            StripePaymentStatus::Pending,
            StripePaymentStatus::Succeeded,
            StripePaymentStatus::Failed,
            StripePaymentStatus::Cancelled,
        ] {
            assert_eq!(StripePaymentStatus::parse(s.as_str()), s);
        }
        for s in [DisputeState::Open, DisputeState::Won, DisputeState::Lost] {
            assert_eq!(DisputeState::parse(s.as_str()), Some(s));
        }
        for s in [UnmatchedReason::Ambiguous, UnmatchedReason::NameDiffers] {
            assert_eq!(UnmatchedReason::parse(s.as_str()), Some(s));
        }
        for s in [
            DeclarationScope::ThisGift,
            DeclarationScope::Future,
            DeclarationScope::FutureAndPast4y,
        ] {
            assert_eq!(DeclarationScope::parse(s.as_str()), s);
        }
    }
}
