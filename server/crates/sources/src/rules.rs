//! Pure source-code rules: names, the full code, dates and the picker's
//! order (Convex `sources/rules.ts`). No reads; the contract and the
//! queries call these.

use contracts::{ContractError, Problem};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::types::SourceCodePayload;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, rename = "SourceLevel")]
pub enum Level {
    Category,
    Detail,
    Version,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Category => "category",
            Level::Detail => "detail",
            Level::Version => "version",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "category" => Some(Level::Category),
            "detail" => Some(Level::Detail),
            "version" => Some(Level::Version),
            _ => None,
        }
    }
}

/// The level under `parent` (none: a category); `None` under a version.
pub fn child_level(parent: Option<Level>) -> Option<Level> {
    match parent {
        None => Some(Level::Category),
        Some(Level::Category) => Some(Level::Detail),
        Some(Level::Detail) => Some(Level::Version),
        Some(Level::Version) => None,
    }
}

/// What a new detail's first version is called (plan g2q4).
pub const FIRST_VERSION_NAME: &str = "001";

/// Every new organisation's categories, each deletable while unused
/// (plan g1q5). "Door-to-door" loses its hyphens: a name can't have one.
pub const SEED_CATEGORIES: [&str; 7] = [
    "Street",
    "Door to door",
    "Online",
    "Event",
    "Direct mail",
    "Telephone",
    "Community",
];

/// The most parts an organisation can hold, all levels, archived ones
/// included. The tree and the picker read them all in one pass.
pub const SOURCE_CODE_LIMIT: i64 = 2000;

/// The longest a part's name can be: it is part of a printed code.
pub const SOURCE_NAME_MAX: usize = 40;

/// The longest a description can be.
pub const SOURCE_DESCRIPTION_MAX: usize = 1000;

/// Sibling names are unique case-insensitively.
pub fn normalise_name(name: &str) -> String {
    name.to_lowercase()
}

/// The full code: the names from the category down, joined by hyphens.
pub fn join_code<S: AsRef<str>>(names: &[S]) -> String {
    names
        .iter()
        .map(AsRef::as_ref)
        .collect::<Vec<_>>()
        .join("-")
}

fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
}

fn blank_to_none(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
}

/// Name tidied (trimmed, inner whitespace collapsed), required, no hyphen
/// (the full code's separator); description and dates blank → absent;
/// dates YYYY-MM-DD and in order. Which levels may carry dates is the
/// contract's check: the payload doesn't know its level.
pub fn prepare_source_code(p: SourceCodePayload) -> Result<SourceCodePayload, ContractError> {
    let out = SourceCodePayload {
        name: p.name.split_whitespace().collect::<Vec<_>>().join(" "),
        description: blank_to_none(p.description),
        start_date: blank_to_none(p.start_date),
        end_date: blank_to_none(p.end_date),
        ..p
    };
    let mut problems = Vec::new();
    if out.name.is_empty() {
        problems.push(Problem::new("name", "A source code needs a name"));
    } else if out.name.contains('-') {
        problems.push(Problem::new(
            "name",
            "A name can’t contain a hyphen: it separates the parts",
        ));
    } else if out.name.chars().count() > SOURCE_NAME_MAX {
        problems.push(Problem::new(
            "name",
            format!("At most {SOURCE_NAME_MAX} characters"),
        ));
    }
    if out
        .description
        .as_ref()
        .is_some_and(|d| d.chars().count() > SOURCE_DESCRIPTION_MAX)
    {
        problems.push(Problem::new(
            "description",
            format!("At most {SOURCE_DESCRIPTION_MAX} characters"),
        ));
    }
    for (field, value) in [("startDate", &out.start_date), ("endDate", &out.end_date)] {
        if value.as_deref().is_some_and(|v| !is_iso_date(v)) {
            problems.push(Problem::new(field, "Dates are YYYY-MM-DD"));
        }
    }
    if let (Some(start), Some(end)) = (&out.start_date, &out.end_date)
        && end < start
    {
        problems.push(Problem::new("endDate", "End date is before start date"));
    }
    if problems.is_empty() {
        Ok(out)
    } else {
        Err(ContractError::Invalid(problems))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "SourceDateStatus")]
pub enum DateStatus {
    Current,
    NotStarted,
    Ended,
}

/// A code's dates: a version's own, or each bound falling back to its
/// detail's.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Dates {
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

/// Where `today` falls in a code's dates. Dates guide, never block.
pub fn date_status(dates: &Dates, today: &str) -> DateStatus {
    if dates.start_date.as_deref().is_some_and(|s| today < s) {
        return DateStatus::NotStarted;
    }
    if dates.end_date.as_deref().is_some_and(|e| today > e) {
        return DateStatus::Ended;
    }
    DateStatus::Current
}

/// A version's dates for the picker: its own, each bound falling back to
/// its detail's (a detail's dates cover its runs unless a run says
/// otherwise).
pub fn effective_dates(version: &Dates, detail: &Dates) -> Dates {
    Dates {
        start_date: version.start_date.clone().or(detail.start_date.clone()),
        end_date: version.end_date.clone().or(detail.end_date.clone()),
    }
}

/// In date first, then not started, then ended; by code within each,
/// any case.
pub fn picker_order(a: (DateStatus, &str), b: (DateStatus, &str)) -> std::cmp::Ordering {
    a.0.cmp(&b.0)
        .then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase()))
}

/// Whether a picker search matches: anywhere in the full code, any case.
pub fn code_matches(code: &str, search: &str) -> bool {
    let needle = search.trim().to_lowercase();
    needle.is_empty() || code.to_lowercase().contains(&needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dates(start: Option<&str>, end: Option<&str>) -> Dates {
        Dates {
            start_date: start.map(Into::into),
            end_date: end.map(Into::into),
        }
    }

    // sources.test.ts › rules › date status: dates guide, inclusive at both ends
    #[test]
    fn date_status_is_inclusive_at_both_ends() {
        let d = dates(Some("2026-01-01"), Some("2026-01-31"));
        assert_eq!(date_status(&d, "2025-12-31"), DateStatus::NotStarted);
        assert_eq!(date_status(&d, "2026-01-01"), DateStatus::Current);
        assert_eq!(date_status(&d, "2026-01-31"), DateStatus::Current);
        assert_eq!(date_status(&d, "2026-02-01"), DateStatus::Ended);
        assert_eq!(
            date_status(&Dates::default(), "2026-02-01"),
            DateStatus::Current
        );
    }

    // sources.test.ts › rules › picker order: in date, not started, ended; by code in each
    #[test]
    fn picker_order_is_status_then_code() {
        let mut v = [
            (DateStatus::Ended, "A-a-001"),
            (DateStatus::Current, "b-x-001"),
            (DateStatus::NotStarted, "A-z-001"),
            (DateStatus::Current, "A-y-001"),
        ];
        v.sort_by(|a, b| picker_order(*a, *b));
        assert_eq!(
            v.iter().map(|x| x.1).collect::<Vec<_>>(),
            ["A-y-001", "b-x-001", "A-z-001", "A-a-001"]
        );
    }

    // sources.test.ts › rules › a search matches anywhere in the code, any case
    #[test]
    fn search_matches_anywhere_any_case() {
        assert!(code_matches("Street-Wesser-001", "wess"));
        assert!(code_matches("Street-Wesser-001", " T-WE "));
        assert!(code_matches("Street-Wesser-001", ""));
        assert!(!code_matches("Street-Wesser-001", "online"));
    }

    #[test]
    fn effective_dates_fall_back_per_bound() {
        let d = effective_dates(
            &dates(None, Some("2026-03-01")),
            &dates(Some("2026-01-01"), Some("2026-12-31")),
        );
        assert_eq!(d, dates(Some("2026-01-01"), Some("2026-03-01")));
    }

    #[test]
    fn prepare_tidies_and_checks() {
        let p = prepare_source_code(SourceCodePayload {
            parent_id: None,
            name: "  Big   Walk ".into(),
            description: Some("  ".into()),
            start_date: Some(" 2026-01-01 ".into()),
            end_date: None,
            is_active: true,
        })
        .unwrap();
        assert_eq!(p.name, "Big Walk");
        assert_eq!(p.description, None);
        assert_eq!(p.start_date.as_deref(), Some("2026-01-01"));

        let bad = |name: &str, start: Option<&str>, end: Option<&str>| match prepare_source_code(
            SourceCodePayload {
                parent_id: None,
                name: name.into(),
                description: None,
                start_date: start.map(Into::into),
                end_date: end.map(Into::into),
                is_active: true,
            },
        ) {
            Err(ContractError::Invalid(p)) => p.into_iter().map(|p| p.field).collect::<Vec<_>>(),
            other => panic!("{other:?}"),
        };
        assert_eq!(bad("", None, None), vec!["name"]);
        assert_eq!(bad("A-B", None, None), vec!["name"]);
        assert_eq!(bad(&"x".repeat(41), None, None), vec!["name"]);
        assert_eq!(bad("ok", Some("1/1/2026"), None), vec!["startDate"]);
        assert_eq!(
            bad("ok", Some("2026-02-01"), Some("2026-01-01")),
            vec!["endDate"]
        );
    }
}
