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
    fn suggest(&self, conn: &Connection, line: &LineView)
    -> Result<Vec<Suggestion>, ContractError>;
}

/// The rule suggesters, in the order they rank. Step 5 adds the standing
/// order's expected payment after `knownPayer`.
pub static SUGGESTERS: &[&dyn Suggester] = &[
    &ContactNumber,
    &KnownPayer,
    // Step 5: the standing order's expected payment goes here.
    &HandEntered,
    &Rules,
    &NameOnly,
];

/// The ranked suggestions for a line: none once it isn't unmatched.
pub fn suggest(conn: &Connection, line: &LineView) -> Result<Vec<Suggestion>, ContractError> {
    suggest_with(conn, line, SUGGESTERS)
}

/// [`suggest`] with the caller's suggesters (the seam for one behind an
/// org opt-in).
pub fn suggest_with(
    conn: &Connection,
    line: &LineView,
    suggesters: &[&dyn Suggester],
) -> Result<Vec<Suggestion>, ContractError> {
    if line.state != MatchState::Unmatched {
        return Ok(vec![]);
    }
    let mut merged: Vec<(usize, Suggestion)> = Vec::new();
    for (rank, s) in suggesters.iter().enumerate() {
        for next in s.suggest(conn, line)? {
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
/// strongest sign: groups ask donors to quote it). Only a Luhn-valid one
/// counts; the amount is the line's own and the date its posting, so a
/// new gift fits them, and a transfer entered by hand must match both.
pub struct ContactNumber;

impl Suggester for ContactNumber {
    fn name(&self) -> &'static str {
        "contactNumber"
    }

    fn suggest(
        &self,
        conn: &Connection,
        line: &LineView,
    ) -> Result<Vec<Suggestion>, ContractError> {
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

    fn suggest(
        &self,
        conn: &Connection,
        line: &LineView,
    ) -> Result<Vec<Suggestion>, ContractError> {
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

/// A transfer already entered by hand for the same amount within a week
/// of the line. Alone it is only a suggestion: nothing says it's the
/// same donor until the contact number or a known payer does.
pub struct HandEntered;

impl Suggester for HandEntered {
    fn name(&self) -> &'static str {
        "handEntered"
    }

    fn suggest(
        &self,
        conn: &Connection,
        line: &LineView,
    ) -> Result<Vec<Suggestion>, ContractError> {
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

    fn suggest(
        &self,
        conn: &Connection,
        line: &LineView,
    ) -> Result<Vec<Suggestion>, ContractError> {
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

    fn suggest(
        &self,
        conn: &Connection,
        line: &LineView,
    ) -> Result<Vec<Suggestion>, ContractError> {
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

    #[test]
    fn strong_outranks_suggested_and_a_name_alone_is_never_strong() {
        assert!(Confidence::Strong > Confidence::Suggested);
    }
}
