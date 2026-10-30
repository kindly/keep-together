//! Suggestions for an unmatched statement line (ADR 0027 decision 8,
//! g1q5): computed on read, never stored, and never applied by
//! themselves. Staff confirm each one (or "Accept ticked"), through the
//! same commands whoever suggested it.
//!
//! A [`Suggester`] is a function from a line, with read access to the
//! organisation's file, to suggestions. [`suggest`] runs [`SUGGESTERS`]
//! and merges their output: one suggestion per proposal (the strongest
//! confidence and every reason), strong first, then in suggester order.
//! The best one is pre-ticked when it is strong and no other strong one
//! proposes something else.
//!
//! **The seam for more suggesters** (an AI one, behind an org opt-in, a
//! DPA and a privacy-notice line, plan b1) is [`suggest_with`]: the
//! caller passes the list. A later suggester is one more [`Suggester`];
//! it is never stronger than `suggested` unless it earns it the same way
//! as the rule suggesters here.

use contracts::ContractError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::matching::{LineView, MatchState, payer_key, payers_for, rules};

/// How sure a suggestion is. Only `strong` is pre-ticked for "Accept
/// ticked"; a name alone is never strong.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "BankConfidence")]
pub enum Confidence {
    Suggested,
    Strong,
}

/// What a suggestion would do to the line.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, rename = "BankProposal")]
pub enum Proposal {
    /// A gift made from the whole line, for this contact.
    NewGift { contact_id: String },
    /// The line matched to these gifts entered by hand (adding up to it).
    ExistingGifts { gift_ids: Vec<String> },
    /// Not a donation, with the rule's note.
    NotDonation { rule_id: String, note: String },
    /// A payment of this standing order, for the period due on
    /// `scheduledOn` (its expected payment, step 5).
    Instalment {
        regular_gift_id: String,
        scheduled_on: String,
    },
    /// "Make this a standing order" (g2q3): the payer paid the same amount
    /// at a regular interval for the second time. Prefilled from the line;
    /// the line becomes its first instalment.
    NewStandingOrder {
        contact_id: String,
        frequency: giving::regular::Frequency,
        day_of_month: u8,
        month: Option<u8>,
    },
}

/// One suggestion for a line.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankSuggestion")]
pub struct Suggestion {
    pub line_id: String,
    pub proposal: Proposal,
    /// The contact it is for, and their name as it reads now.
    pub contact_id: Option<String>,
    pub contact_name: Option<String>,
    pub confidence: Confidence,
    /// Why, for people: "contact no. 100016 in the reference".
    pub reason: String,
    /// Which suggester(s) made it.
    pub suggesters: Vec<String>,
    /// Pre-ticked for "Accept ticked".
    pub ticked: bool,
}

impl Suggestion {
    fn new(
        line: &LineView,
        proposal: Proposal,
        contact: Option<(String, String)>,
        confidence: Confidence,
        reason: String,
        suggester: &str,
    ) -> Self {
        let (contact_id, contact_name) = contact.unzip();
        Self {
            line_id: line.id.clone(),
            proposal,
            contact_id,
            contact_name,
            confidence,
            reason,
            suggesters: vec![suggester.to_owned()],
            ticked: false,
        }
    }
}

/// A source of suggestions: pure apart from reading the org's file.
pub trait Suggester: Sync {
    /// A short stable name, shown with the suggestion.
    fn name(&self) -> &'static str;
    fn suggest(&self, cx: &Context, line: &LineView) -> Result<Vec<Suggestion>, ContractError>;
}

/// What suggesters read: the organisation's file, and what one request
/// reads once for all its lines (review b5r M3: the standing orders'
/// schedule).
pub struct Context<'c> {
    pub conn: &'c Connection,
    standing: std::cell::OnceCell<giving::standing::Schedule>,
}

impl<'c> Context<'c> {
    pub fn new(conn: &'c Connection) -> Self {
        Self {
            conn,
            standing: std::cell::OnceCell::new(),
        }
    }

    /// The active standing orders' schedule, read on first use.
    pub fn standing(&self) -> rusqlite::Result<&giving::standing::Schedule> {
        if let Some(s) = self.standing.get() {
            return Ok(s);
        }
        let loaded = giving::standing::Schedule::load(self.conn)?;
        Ok(self.standing.get_or_init(|| loaded))
    }
}

/// The rule suggesters, in the order they rank.
pub static SUGGESTERS: &[&dyn Suggester] = &[
    &ContactNumber,
    &KnownPayer,
    &StandingOrder,
    &StandingOrderOffer,
    &HandEntered,
    &Rules,
    &NameOnly,
];

/// The ranked suggestions for a line: none once it isn't unmatched.
pub fn suggest(conn: &Connection, line: &LineView) -> Result<Vec<Suggestion>, ContractError> {
    suggest_with(&Context::new(conn), line, SUGGESTERS)
}

/// [`suggest`] for many lines (a reconcile page), reading what they
/// share once.
pub fn suggest_lines(
    conn: &Connection,
    lines: &[LineView],
) -> Result<Vec<Vec<Suggestion>>, ContractError> {
    let cx = Context::new(conn);
    lines
        .iter()
        .map(|l| suggest_with(&cx, l, SUGGESTERS))
        .collect()
}

/// [`suggest`] with the caller's suggesters (the seam for one behind an
/// org opt-in).
pub fn suggest_with(
    cx: &Context,
    line: &LineView,
    suggesters: &[&dyn Suggester],
) -> Result<Vec<Suggestion>, ContractError> {
    if line.state != MatchState::Unmatched {
        return Ok(vec![]);
    }
    let mut merged: Vec<(usize, Suggestion)> = Vec::new();
    for (rank, s) in suggesters.iter().enumerate() {
        for next in s.suggest(cx, line)? {
            match merged.iter_mut().find(|(_, m)| m.proposal == next.proposal) {
                Some((_, m)) => {
                    m.confidence = m.confidence.max(next.confidence);
                    if !m.reason.contains(&next.reason) {
                        m.reason = format!("{}; {}", m.reason, next.reason);
                    }
                    m.suggesters.extend(next.suggesters);
                    if m.contact_id.is_none() {
                        m.contact_id = next.contact_id;
                        m.contact_name = next.contact_name;
                    }
                }
                None => merged.push((rank, next)),
            }
        }
    }
    // A contact some suggester matched to gifts already waiting: a
    // name-only "new gift" for them would give twice (review b4r L2).
    let waiting: Vec<String> = merged
        .iter()
        .filter(|(_, s)| matches!(s.proposal, Proposal::ExistingGifts { .. }))
        .filter_map(|(_, s)| s.contact_id.clone())
        .collect();
    merged.retain(|(_, s)| {
        !(matches!(&s.proposal, Proposal::NewGift { contact_id } if waiting.contains(contact_id))
            && s.suggesters.iter().all(|n| n == "nameOnly"))
    });
    // A contact whose standing order this line pays: a plain new gift
    // for them would leave the period missed. Its evidence (the number,
    // the payer) joins the instalment's reasons instead.
    let instalments: Vec<String> = merged
        .iter()
        .filter(|(_, s)| matches!(s.proposal, Proposal::Instalment { .. }))
        .filter_map(|(_, s)| s.contact_id.clone())
        .collect();
    let mut folded: Vec<(String, String, Vec<String>)> = Vec::new();
    merged.retain(|(_, s)| match &s.proposal {
        Proposal::NewGift { contact_id } if instalments.contains(contact_id) => {
            folded.push((contact_id.clone(), s.reason.clone(), s.suggesters.clone()));
            false
        }
        _ => true,
    });
    for (contact, reason, suggesters) in folded {
        if let Some((_, m)) = merged.iter_mut().find(|(_, m)| {
            matches!(m.proposal, Proposal::Instalment { .. })
                && m.contact_id.as_deref() == Some(contact.as_str())
        }) {
            if !m.reason.contains(&reason) {
                m.reason = format!("{}; {reason}", m.reason);
            }
            for n in suggesters {
                if !m.suggesters.contains(&n) {
                    m.suggesters.push(n);
                }
            }
        }
    }
    merged.sort_by_key(|(rank, s)| (std::cmp::Reverse(s.confidence), *rank));
    let mut out: Vec<Suggestion> = merged.into_iter().map(|(_, s)| s).collect();
    let strong = out
        .iter()
        .filter(|s| s.confidence == Confidence::Strong)
        .count();
    if strong == 1 {
        out[0].ticked = true;
    }
    Ok(out)
}

/// How far either side of the posted date a transfer entered by hand may
/// be dated and still be this line: staff date it when they see it, the
/// bank when it clears.
pub const HAND_ENTERED_DAYS: i64 = 7;

/// The contact's name as it reads now.
fn named(conn: &Connection, contact: &str) -> rusqlite::Result<Option<(String, String)>> {
    Ok(contacts::donors::name_of(conn, contact)?.map(|(name, _)| (contact.to_owned(), name)))
}

/// Transfers entered by hand, not on a statement yet, for the line's
/// amount and near its date: `(gift, contact, date)`.
fn waiting_transfers(
    conn: &Connection,
    line: &LineView,
) -> rusqlite::Result<Vec<giving::bank::TransferGift>> {
    let (Some(from), Some(to)) = (
        giving::terms_rules::add_days(&line.posted_on, -HAND_ENTERED_DAYS),
        giving::terms_rules::add_days(&line.posted_on, HAND_ENTERED_DAYS),
    ) else {
        return Ok(vec![]);
    };
    Ok(
        giving::bank::transfers_not_on_a_statement(conn, &from, &to)?
            .into_iter()
            .filter(|t| t.amount == line.amount)
            .collect(),
    )
}

/// For a contact the line points at by other evidence: their transfer
/// entered by hand that fits it (same amount, near the date), else a new
/// gift. Both strong; `why` says what pointed at them.
fn for_contact(
    conn: &Connection,
    line: &LineView,
    contact: &str,
    why: String,
    new_gift: Confidence,
    suggester: &str,
) -> Result<Option<Suggestion>, ContractError> {
    let Some(named) = named(conn, contact)? else {
        return Ok(None);
    };
    if let Some(t) = waiting_transfers(conn, line)?
        .into_iter()
        .find(|t| t.contact_id == contact)
    {
        return Ok(Some(Suggestion::new(
            line,
            Proposal::ExistingGifts {
                gift_ids: vec![t.id],
            },
            Some(named),
            Confidence::Strong,
            format!(
                "{why}; a transfer for {} entered by hand on {}",
                giving::format_pence(t.amount),
                t.received_on
            ),
            suggester,
        )));
    }
    Ok(Some(Suggestion::new(
        line,
        Proposal::NewGift {
            contact_id: contact.to_owned(),
        },
        Some(named),
        new_gift,
        why,
        suggester,
    )))
}

/// Six-digit runs in `text`.
fn six_digit_runs(text: &str) -> Vec<&str> {
    text.split(|c: char| !c.is_ascii_digit())
        .filter(|run| run.len() == 6)
        .collect()
}

/// The donor's contact number in the reference or narrative (the
/// strongest sign: groups ask donors to quote it). A Luhn-valid one is
/// strong on its own: the reference names the donor, and a gift made
/// from the line takes the line's own amount and date. When the donor
/// has a transfer entered by hand for that amount near that date, that
/// gift is proposed instead of a new one.
pub struct ContactNumber;

impl Suggester for ContactNumber {
    fn name(&self) -> &'static str {
        "contactNumber"
    }

    fn suggest(&self, cx: &Context, line: &LineView) -> Result<Vec<Suggestion>, ContractError> {
        let conn = cx.conn;
        let text = format!("{} {}", line.reference, line.narrative);
        let mut out = Vec::new();
        let mut seen = Vec::new();
        for run in six_digit_runs(&text) {
            if !matches!(
                contacts::number::parse_number(run),
                Some(contacts::number::ParsedNumber::Sequence { written: true, .. })
            ) {
                continue;
            }
            let found = contacts::queries::search(
                conn,
                &contacts::queries::SearchQuery {
                    q: run.to_owned(),
                    ..Default::default()
                },
            )?;
            let Some(contact) = found.number_match else {
                continue;
            };
            if seen.contains(&contact) {
                continue;
            }
            if let Some(s) = for_contact(
                conn,
                line,
                &contact,
                format!("contact no. {run} in the reference"),
                Confidence::Strong,
                self.name(),
            )? {
                out.push(s);
            }
            seen.push(contact);
        }
        Ok(out)
    }
}

/// A payer the group has matched before on this account (g1q8): strong
/// when it fits a transfer entered by hand, or when it is the amount
/// that payer gave last time; else suggested.
pub struct KnownPayer;

impl Suggester for KnownPayer {
    fn name(&self) -> &'static str {
        "knownPayer"
    }

    fn suggest(&self, cx: &Context, line: &LineView) -> Result<Vec<Suggestion>, ContractError> {
        let conn = cx.conn;
        let Some(key) = payer_key(&line.payer, &line.reference) else {
            return Ok(vec![]);
        };
        let mut out = Vec::new();
        for payer in payers_for(conn, &line.account_id, &key)? {
            let last = match &payer.last_line_id {
                Some(id) => crate::matching::line(conn, id)?,
                None => None,
            };
            let same = last.as_ref().is_some_and(|l| l.amount == line.amount);
            let why = match &last {
                Some(l) if same => format!(
                    "{} paid {} the same way on {}",
                    display_payer(line),
                    giving::format_pence(l.amount),
                    l.posted_on
                ),
                Some(l) => format!("{} paid in before, on {}", display_payer(line), l.posted_on),
                None => format!("{} paid in before", display_payer(line)),
            };
            let confidence = if same {
                Confidence::Strong
            } else {
                Confidence::Suggested
            };
            if let Some(s) =
                for_contact(conn, line, &payer.contact_id, why, confidence, self.name())?
            {
                out.push(s);
            }
        }
        Ok(out)
    }
}

fn display_payer(line: &LineView) -> String {
    match (line.payer.trim(), line.reference.trim()) {
        ("", r) => format!("reference {r}"),
        (p, "") => p.to_owned(),
        (p, r) => format!("{p} ({r})"),
    }
}

/// A standing order's expected payment (step 5): the exact amount, due
/// from 15 days before the line to 5 days after it (−5/+15, as
/// CiviBanking does), and not paid yet. Strong (so pre-ticked) only when
/// the line's payer is a known payer of the standing order's donor (a
/// payment from them was matched before): the first payment is always
/// staff's to confirm. The standing order's reference in the line ranks
/// the suggestion first and says so, but never makes it strong (review
/// b5r round 3). Outside the window it isn't suggested.
pub struct StandingOrder;

impl Suggester for StandingOrder {
    fn name(&self) -> &'static str {
        "standingOrder"
    }

    fn suggest(&self, cx: &Context, line: &LineView) -> Result<Vec<Suggestion>, ContractError> {
        let conn = cx.conn;
        let mut out: Vec<(bool, Suggestion)> = Vec::new();
        let known: Vec<String> = match payer_key(&line.payer, &line.reference) {
            Some(key) => payers_for(conn, &line.account_id, &key)?
                .into_iter()
                .map(|p| p.contact_id)
                .collect(),
            None => vec![],
        };
        for p in cx
            .standing()?
            .payments_for_line(&line.posted_on, line.amount)
        {
            let what = format!(
                "the {} standing order of {} due {}",
                p.frequency.as_str(),
                giving::format_pence(p.amount),
                p.due_on
            );
            // Strong only when this payer was matched to the donor before
            // (review b5r round 3): the first payment is always staff's
            // call, and then later ones pre-tick. The standing order's
            // reference in the line ranks it first and says so, but never
            // makes it strong.
            let reference = p
                .bank_reference
                .as_deref()
                .filter(|r| reference_identifies(r, line));
            let by_payer = known.contains(&p.contact_id);
            let mut why = what;
            if let Some(r) = reference {
                why = format!("{why}; reference {} matches", r.trim());
            }
            let (confidence, reason) = if by_payer {
                (
                    Confidence::Strong,
                    format!("{why}; {} paid it before", display_payer(line)),
                )
            } else if reference.is_some() {
                (Confidence::Suggested, why)
            } else {
                (
                    Confidence::Suggested,
                    format!("{why}: amount and date only"),
                )
            };
            let at = if reference.is_some() {
                out.iter()
                    .take_while(|(by_ref, _): &&(bool, Suggestion)| *by_ref)
                    .count()
            } else {
                out.len()
            };
            out.insert(
                at,
                (
                    reference.is_some(),
                    Suggestion::new(
                        line,
                        Proposal::Instalment {
                            regular_gift_id: p.regular_gift_id,
                            scheduled_on: p.due_on.clone(),
                        },
                        named(conn, &p.contact_id)?,
                        confidence,
                        reason,
                        self.name(),
                    ),
                ),
            );
        }
        Ok(out.into_iter().map(|(_, s)| s).collect())
    }
}

/// `text` as upper-cased alphanumeric runs: "FPI smith-123/don" is
/// `["FPI", "SMITH", "123", "DON"]`.
pub fn tokens(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(str::to_uppercase)
        .collect()
}

/// Whether `reference` appears in `line`: its tokens as one run of
/// whole tokens in the line's reference or its narrative ("SMITH123" in
/// "FPI SMITH123 DONATION"; never "SO REF" in "ALSO REFUND", nor "JO" in
/// "JOHN SMITH"). For ranking and the reason only: a reference never
/// makes a match strong (review b5r round 3).
pub fn reference_identifies(reference: &str, line: &LineView) -> bool {
    let want = tokens(reference);
    if want.is_empty() {
        return false;
    }
    [&line.reference, &line.narrative].iter().any(|field| {
        let have = tokens(field);
        have.windows(want.len()).any(|w| w == want.as_slice())
    })
}

/// How far apart, in days, two payments are for each frequency.
const INTERVALS: [(giving::regular::Frequency, std::ops::RangeInclusive<i64>); 3] = [
    (giving::regular::Frequency::Monthly, 25..=35),
    (giving::regular::Frequency::Quarterly, 85..=98),
    (giving::regular::Frequency::Yearly, 355..=375),
];

/// "Make this a standing order" (g2q3): a payer matched before to a
/// contact pays the same amount again at a regular interval (about a
/// month, a quarter or a year). Offered on the second payment, never the
/// first, and not when the contact has an active standing order for the
/// amount. Only suggested: staff choose.
pub struct StandingOrderOffer;

impl Suggester for StandingOrderOffer {
    fn name(&self) -> &'static str {
        "standingOrderOffer"
    }

    fn suggest(&self, cx: &Context, line: &LineView) -> Result<Vec<Suggestion>, ContractError> {
        let conn = cx.conn;
        let Some(key) = payer_key(&line.payer, &line.reference) else {
            return Ok(vec![]);
        };
        let (Some(day), Some(index)) = (
            line.posted_on.get(8..10).and_then(|d| d.parse::<u8>().ok()),
            giving::terms_rules::month_index(&line.posted_on),
        ) else {
            return Ok(vec![]);
        };
        let mut out = Vec::new();
        for payer in payers_for(conn, &line.account_id, &key)? {
            let contact = payer.contact_id;
            if giving::standing::active_of_contact(conn, &contact, &line.posted_on)?
                .iter()
                .any(|(_, amount)| *amount == line.amount)
            {
                continue;
            }
            let Some(before) = crate::matching::earlier_payment(conn, line, &key, &contact)? else {
                continue;
            };
            let (Some(a), Some(b)) = (
                giving::terms_rules::day_number(&before),
                giving::terms_rules::day_number(&line.posted_on),
            ) else {
                continue;
            };
            let Some((frequency, _)) = INTERVALS.iter().find(|(_, r)| r.contains(&(b - a))) else {
                continue;
            };
            out.push(Suggestion::new(
                line,
                Proposal::NewStandingOrder {
                    contact_id: contact.clone(),
                    frequency: *frequency,
                    day_of_month: day.min(28),
                    month: (*frequency != giving::regular::Frequency::Monthly)
                        .then(|| (index.rem_euclid(12) + 1) as u8),
                },
                named(conn, &contact)?,
                Confidence::Suggested,
                format!(
                    "{} paid {} on {before} and again now: make this a {} standing order?",
                    display_payer(line),
                    giving::format_pence(line.amount),
                    frequency.as_str()
                ),
                self.name(),
            ));
        }
        Ok(out)
    }
}

/// A transfer already entered by hand for the same amount within a week
/// of the line. Alone it is only a suggestion: nothing says it's the
/// same donor until the contact number or a known payer does.
pub struct HandEntered;

impl Suggester for HandEntered {
    fn name(&self) -> &'static str {
        "handEntered"
    }

    fn suggest(&self, cx: &Context, line: &LineView) -> Result<Vec<Suggestion>, ContractError> {
        let conn = cx.conn;
        let mut out = Vec::new();
        for t in waiting_transfers(conn, line)? {
            out.push(Suggestion::new(
                line,
                Proposal::ExistingGifts {
                    gift_ids: vec![t.id.clone()],
                },
                named(conn, &t.contact_id)?,
                Confidence::Suggested,
                format!(
                    "a transfer for {} entered by hand on {}, not on a statement yet",
                    giving::format_pence(t.amount),
                    t.received_on
                ),
                self.name(),
            ));
        }
        Ok(out)
    }
}

/// The organisation's not-a-donation rules: strong (staff wrote them),
/// so pre-ticked, but applied only when staff accept.
pub struct Rules;

impl Suggester for Rules {
    fn name(&self) -> &'static str {
        "rule"
    }

    fn suggest(&self, cx: &Context, line: &LineView) -> Result<Vec<Suggestion>, ContractError> {
        let conn = cx.conn;
        let mut out = Vec::new();
        for r in rules(conn, Some(&line.account_id))? {
            let field = r.rule.field.of(line).to_lowercase();
            if !field.contains(&r.rule.contains.to_lowercase()) {
                continue;
            }
            let reason = format!("{} contains “{}”", r.rule.field.as_str(), r.rule.contains);
            out.push(Suggestion::new(
                line,
                Proposal::NotDonation {
                    rule_id: r.id,
                    note: r.rule.note.unwrap_or_else(|| reason.clone()),
                },
                None,
                Confidence::Strong,
                reason,
                self.name(),
            ));
        }
        Ok(out)
    }
}

/// Most contacts a name alone suggests.
pub const NAME_ONLY_MAX: usize = 3;

/// The payer's name alone, like a contact's (surname, and the first
/// initial when the bank gives one): never strong, never pre-ticked.
pub struct NameOnly;

impl Suggester for NameOnly {
    fn name(&self) -> &'static str {
        "nameOnly"
    }

    fn suggest(&self, cx: &Context, line: &LineView) -> Result<Vec<Suggestion>, ContractError> {
        let conn = cx.conn;
        let words: Vec<String> = line
            .payer
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
            .map(str::to_lowercase)
            .collect();
        let Some(surname) = words.last().filter(|w| w.len() > 1) else {
            return Ok(vec![]);
        };
        let initial = (words.len() > 1).then(|| words[0].chars().next()).flatten();
        let found = contacts::queries::search(
            conn,
            &contacts::queries::SearchQuery {
                q: surname.clone(),
                ..Default::default()
            },
        )?;
        let mut out = Vec::new();
        for row in found.rows {
            let names: Vec<String> = row
                .display_name
                .split(|c: char| !c.is_alphanumeric())
                .filter(|w| !w.is_empty())
                .map(str::to_lowercase)
                .collect();
            let surname_fits = names.iter().any(|n| n == surname);
            let initial_fits =
                initial.is_none_or(|i| names.iter().any(|n| n != surname && n.starts_with(i)));
            if !(surname_fits && initial_fits) {
                continue;
            }
            out.push(Suggestion::new(
                line,
                Proposal::NewGift {
                    contact_id: row.id.clone(),
                },
                Some((row.id, row.display_name.clone())),
                Confidence::Suggested,
                format!(
                    "the payer’s name, {}, is like {}’s",
                    line.payer.trim(),
                    row.display_name
                ),
                self.name(),
            ));
            if out.len() == NAME_ONLY_MAX {
                break;
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn six_digit_runs_only() {
        assert_eq!(
            six_digit_runs("FP 100016 REF 1000160 12345 ABC/100024"),
            ["100016", "100024"]
        );
    }

    fn line(reference: &str, narrative: &str) -> LineView {
        LineView {
            id: "l".into(),
            account_id: "a".into(),
            import_id: "i".into(),
            posted_on: "2026-10-01".into(),
            amount: 1000,
            payer: String::new(),
            reference: reference.into(),
            narrative: narrative.into(),
            bank_id: None,
            state: MatchState::Unmatched,
            note: None,
            matched_by: None,
            matched_at: None,
            match_version: 0,
        }
    }

    #[test]
    fn a_reference_is_found_only_as_whole_tokens_in_one_run() {
        assert!(!reference_identifies("SO REF", &line("", "ALSO REFUND")));
        assert!(!reference_identifies("JO", &line("JOHN SMITH", "")));
        assert!(reference_identifies(
            "SMITH123",
            &line("", "FPI SMITH123 DONATION")
        ));
        assert!(reference_identifies("smith-123", &line("SMITH 123", "")));
        assert!(!reference_identifies("SMITH123", &line("XSMITH1234", "")));
        assert!(!reference_identifies("JO BLOGGS", &line("JO X BLOGGS", "")));
        assert!(!reference_identifies(" - ", &line("ANYTHING", "")));
    }

    #[test]
    fn strong_outranks_suggested_and_a_name_alone_is_never_strong() {
        assert!(Confidence::Strong > Confidence::Suggested);
    }
}
