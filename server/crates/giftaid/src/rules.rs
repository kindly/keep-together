//! Gift Aid declaration rules, pure (`convex/giftaid/rules.ts`). The law
//! is HMRC's *Charities detailed guidance notes*, chapter 3, as the cash
//! gifts plan recorded it (factory/plans/cash-gifts.sv, "What the law
//! says").
//!
//! Coverage (rule 1: a dated chain, not a boolean): a gift dated `d` is
//! covered if some declaration of its donor has a window containing `d`
//! and isn't cancelled at or before `d`. Windows:
//!
//! ```text
//!   futureAndPast4y  [madeOn − 4 years, ∞)
//!   future           [madeOn, ∞)
//!   thisGift         exactly its own gift
//! ```
//!
//! Whatever the scope, a declaration also covers the gift it was made with
//! (`contributionId`: "I want to Gift Aid my donation of £x and …"), even
//! one dated before `madeOn`.
//!
//! A cancellation with `cancelledFrom` ≤ `d` removes coverage for gifts on
//! or after that date (3.8.2). A voided declaration (recorded in error)
//! covers nothing, whatever its window. Dates are ISO `YYYY-MM-DD`, so they
//! compare as strings.

use contracts::{ContractError, Problem};

use crate::types::{
    CancellationPayload, DeclarationPayload, DetailsPayload, Method, Scope, VoidPayload,
};

/// The most declarations one contact may have (each read on every coverage check).
pub const DECLARATION_LIMIT: usize = 100;
pub const SNAPSHOT_FIELD_MAX: usize = 200;
pub const CANCELLATION_NOTE_MAX: usize = 1000;
pub const VOID_REASON_MAX: usize = 1000;
pub const WORDING_VERSION_MAX: usize = 50;

/// The HMRC model declaration wording the donor agreed to (3.6.2 needs the
/// tax explanation). HMRC revised the model declarations in October 2015
/// for use from 6 April 2016:
/// <https://www.gov.uk/guidance/gift-aid-declarations-claiming-tax-back-on-donations>.
/// Bump this when HMRC publishes new wording; each declaration keeps the
/// version it was made under.
pub const HMRC_MODEL_WORDING_VERSION: &str = "hmrc-2016-04";

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn parts(value: &str) -> Option<(i64, i64, i64)> {
    let b = value.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let digits = |r: std::ops::Range<usize>| {
        b[r.clone()]
            .iter()
            .all(u8::is_ascii_digit)
            .then(|| value[r].parse::<i64>().ok())
            .flatten()
    };
    Some((digits(0..4)?, digits(5..7)?, digits(8..10)?))
}

/// A real calendar date written `YYYY-MM-DD`.
pub fn is_iso_date(value: &str) -> bool {
    parts(value)
        .is_some_and(|(y, m, d)| (1..=12).contains(&m) && d >= 1 && d <= days_in_month(y, m))
}

/// The same day `years` years earlier. 29 February with no such day that
/// year becomes 1 March: the narrower window, so a gift is never counted
/// as covered on a day the wording doesn't reach.
pub fn years_before(date: &str, years: i64) -> String {
    let Some((year, month, day)) = parts(date) else {
        return date.to_owned();
    };
    let y = year - years;
    if day > days_in_month(y, month) {
        return format!("{y:04}-{:02}-01", month + 1);
    }
    format!("{y:04}-{month:02}-{day:02}")
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian.
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// (year, month, day) → days since 1970-01-01.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

const DAY_MS: i64 = 86_400_000;

/// 01:00 UTC on the last Sunday of `month`: when UK clocks change.
fn last_sunday_1am(year: i64, month: i64) -> i64 {
    let last = days_from_civil(year, month, days_in_month(year, month));
    // 1970-01-01 was a Thursday: (days + 4) % 7 is 0 on a Sunday.
    let sunday = last - (last + 4).rem_euclid(7);
    sunday * DAY_MS + 3_600_000
}

/// The UK calendar date at `at` (ms since the epoch), `YYYY-MM-DD`: what
/// "today" means to the staff entering a declaration. British Summer Time
/// runs from 01:00 UTC on the last Sunday of March to 01:00 UTC on the
/// last Sunday of October (the rule since 1996).
pub fn uk_date(at: i64) -> String {
    let (year, _, _) = civil(at.div_euclid(DAY_MS));
    let bst = at >= last_sunday_1am(year, 3) && at < last_sunday_1am(year, 10);
    let local = at + if bst { 3_600_000 } else { 0 };
    let (y, m, d) = civil(local.div_euclid(DAY_MS));
    format!("{y:04}-{m:02}-{d:02}")
}

/// UTC `YYYY-MM-DDThh:mm:ss.sss` at `at` (ms since the epoch): GovTalk's
/// `GatewayTimestamp`.
pub fn utc_timestamp(at: i64) -> String {
    let (y, m, d) = civil(at.div_euclid(DAY_MS));
    let ms = at.rem_euclid(DAY_MS);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}",
        ms / 3_600_000,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        ms % 1000
    )
}

/// An ISO date as staff read it: "3 Mar 2026". Anything else is given
/// back as it is.
pub fn uk_date_label(date: &str) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    match parts(date) {
        Some((y, m, d)) if (1..=12).contains(&m) => format!("{d} {} {y}", MONTHS[m as usize - 1]),
        _ => date.to_owned(),
    }
}

/// What coverage needs to know about one declaration.
pub trait Window {
    fn scope(&self) -> Scope;
    fn made_on(&self) -> &str;
    /// The gift it was made with (always, for `thisGift`).
    fn gift_id(&self) -> Option<&str>;
    fn cancelled_from(&self) -> Option<&str>;
    /// Voided (recorded in error): it never applied.
    fn voided(&self) -> bool;
}

/// The gift being asked about: its date and, once saved, its id.
#[derive(Clone, Copy, Debug)]
pub struct GiftRef<'a> {
    pub date: &'a str,
    pub gift_id: Option<&'a str>,
}

/// The first day the declaration covers; `None` for `thisGift` (no range).
pub fn window_start(d: &impl Window) -> Option<String> {
    match d.scope() {
        Scope::FutureAndPast4y => Some(years_before(d.made_on(), 4)),
        Scope::Future => Some(d.made_on().to_owned()),
        Scope::ThisGift => None,
    }
}

pub fn covers(d: &impl Window, gift: GiftRef) -> bool {
    if d.voided() {
        return false;
    }
    if d.cancelled_from().is_some_and(|c| c <= gift.date) {
        return false;
    }
    if d.gift_id().is_some() && d.gift_id() == gift.gift_id {
        return true;
    }
    window_start(d).is_some_and(|start| start.as_str() <= gift.date)
}

/// The declaration that covers the gift, or `None`. Of several, the one
/// made last (the evidence a reviewer would look at first).
pub fn covering_declaration<'a, T: Window>(declarations: &'a [T], gift: GiftRef) -> Option<&'a T> {
    let mut best: Option<&T> = None;
    for d in declarations {
        if covers(d, gift) && best.is_none_or(|b| d.made_on() >= b.made_on()) {
            best = Some(d);
        }
    }
    best
}

/// The enduring declaration in force on `today`: one that would cover a
/// new gift made today. A `thisGift` declaration never is (it covers one
/// gift), so the gift form offers the tick again (g2q6).
pub fn current_of<'a, T: Window>(declarations: &'a [T], today: &str) -> Option<&'a T> {
    let mut best: Option<&T> = None;
    let gift = GiftRef {
        date: today,
        gift_id: None,
    };
    for d in declarations.iter().filter(|d| d.scope() != Scope::ThisGift) {
        if covers(d, gift) && best.is_none_or(|b| d.made_on() >= b.made_on()) {
            best = Some(d);
        }
    }
    best
}

/// Whether a cancellation from `date` applies to the declaration: it had
/// been made by then, isn't void and wasn't already cancelled on or
/// before it. A later cancellation date is moved earlier; a declaration
/// made after `date` is left alone (the donor declared again since).
pub fn open_at(d: &impl Window, date: &str) -> bool {
    !d.voided() && d.made_on() <= date && d.cancelled_from().is_none_or(|c| c > date)
}

fn tidy(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The snapshot tidied (whitespace collapsed, postcode upper-cased), and
/// a problem for each field over SNAPSHOT_FIELD_MAX. The same rules at
/// create and on every later [`prepare_details`].
fn tidy_snapshot(p: DetailsPayload, problems: &mut Vec<Problem>) -> DetailsPayload {
    let out = DetailsPayload {
        first_name: tidy(&p.first_name),
        last_name: tidy(&p.last_name),
        address_line1: tidy(&p.address_line1),
        postcode: tidy(&p.postcode).to_uppercase(),
    };
    for (field, value) in [
        ("firstName", &out.first_name),
        ("lastName", &out.last_name),
        ("addressLine1", &out.address_line1),
        ("postcode", &out.postcode),
    ] {
        if value.chars().count() > SNAPSHOT_FIELD_MAX {
            problems.push(Problem::new(
                field,
                format!("At most {SNAPSHOT_FIELD_MAX} characters"),
            ));
        }
    }
    out
}

/// Snapshot fields tidied ([`tidy_snapshot`]); `madeOn` a real date; a
/// wording version given; a gift named when the scope is `thisGift` (any
/// scope may name the gift it was made with); never `onScreenByDonor`
/// while no donor-facing screen exists (staff can't make that true). A
/// future `madeOn` is refused by the contract, which knows the time.
/// Empty snapshot fields are storable: they warn ([`crate::warnings`]),
/// because staff may tick before they have the address (g3q3), and fill
/// them in later ([`prepare_details`]).
pub fn prepare_declaration(p: DeclarationPayload) -> Result<DeclarationPayload, ContractError> {
    let mut problems = Vec::new();
    let snapshot = tidy_snapshot(p.details(), &mut problems);
    let out = DeclarationPayload {
        made_on: p.made_on.trim().to_owned(),
        wording_version: p.wording_version.trim().to_owned(),
        first_name: snapshot.first_name,
        last_name: snapshot.last_name,
        address_line1: snapshot.address_line1,
        postcode: snapshot.postcode,
        ..p
    };
    if !is_iso_date(&out.made_on) {
        problems.push(Problem::new("madeOn", "Enter a date (YYYY-MM-DD)"));
    }
    if out.method == Method::OnScreenByDonor {
        problems.push(Problem::new(
            "method",
            "There is no screen for donors to declare on yet: record how staff took the declaration",
        ));
    }
    if out.wording_version.is_empty() {
        problems.push(Problem::new(
            "wordingVersion",
            "Say which declaration wording the donor agreed to",
        ));
    } else if out.wording_version.chars().count() > WORDING_VERSION_MAX {
        problems.push(Problem::new(
            "wordingVersion",
            format!("At most {WORDING_VERSION_MAX} characters"),
        ));
    }
    if out.scope == Scope::ThisGift && out.gift_id.is_none() {
        problems.push(Problem::new(
            "contributionId",
            "A “this gift only” declaration needs its gift",
        ));
    }
    if problems.is_empty() {
        Ok(out)
    } else {
        Err(ContractError::Invalid(problems))
    }
}

/// The snapshot changed after the declaration was saved: the same tidying
/// and widths as at create. Blanks stay storable (and warn).
pub fn prepare_details(p: DetailsPayload) -> Result<DetailsPayload, ContractError> {
    let mut problems = Vec::new();
    let out = tidy_snapshot(p, &mut problems);
    if problems.is_empty() {
        Ok(out)
    } else {
        Err(ContractError::Invalid(problems))
    }
}

fn blank_none(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

/// Date a real date when present; a note only with a date; blanks → absent.
pub fn prepare_cancellation(p: CancellationPayload) -> Result<CancellationPayload, ContractError> {
    let out = CancellationPayload {
        cancelled_from: blank_none(p.cancelled_from),
        note: blank_none(p.note),
    };
    let mut problems = Vec::new();
    if out
        .cancelled_from
        .as_deref()
        .is_some_and(|d| !is_iso_date(d))
    {
        problems.push(Problem::new("cancelledFrom", "Enter a date (YYYY-MM-DD)"));
    }
    if out.note.is_some() && out.cancelled_from.is_none() {
        problems.push(Problem::new("note", "A note needs a cancellation"));
    }
    if out
        .note
        .as_deref()
        .is_some_and(|n| n.chars().count() > CANCELLATION_NOTE_MAX)
    {
        problems.push(Problem::new(
            "note",
            format!("At most {CANCELLATION_NOTE_MAX} characters"),
        ));
    }
    if problems.is_empty() {
        Ok(out)
    } else {
        Err(ContractError::Invalid(problems))
    }
}

/// A reason is required: the void is the audit record of the mistake.
pub fn prepare_void(p: VoidPayload) -> Result<VoidPayload, ContractError> {
    let reason = p.reason.trim().to_owned();
    if reason.is_empty() {
        return Err(ContractError::invalid(
            "reason",
            "Say why the declaration was made in error",
        ));
    }
    if reason.chars().count() > VOID_REASON_MAX {
        return Err(ContractError::invalid(
            "reason",
            format!("At most {VOID_REASON_MAX} characters"),
        ));
    }
    Ok(VoidPayload { reason })
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIFT: &str = "gift1";
    const OTHER_GIFT: &str = "gift2";
    const MADE: &str = "2026-03-03";

    #[derive(Clone, Debug, PartialEq)]
    struct D {
        scope: Scope,
        made_on: String,
        gift_id: Option<String>,
        cancelled_from: Option<String>,
        voided: bool,
    }

    impl Window for D {
        fn scope(&self) -> Scope {
            self.scope
        }
        fn made_on(&self) -> &str {
            &self.made_on
        }
        fn gift_id(&self) -> Option<&str> {
            self.gift_id.as_deref()
        }
        fn cancelled_from(&self) -> Option<&str> {
            self.cancelled_from.as_deref()
        }
        fn voided(&self) -> bool {
            self.voided
        }
    }

    fn decl(scope: Scope) -> D {
        D {
            scope,
            made_on: MADE.into(),
            gift_id: (scope == Scope::ThisGift).then(|| GIFT.into()),
            cancelled_from: None,
            voided: false,
        }
    }

    fn cancelled(scope: Scope, from: &str) -> D {
        D {
            cancelled_from: Some(from.into()),
            ..decl(scope)
        }
    }

    fn made(scope: Scope, on: &str) -> D {
        D {
            made_on: on.into(),
            ..decl(scope)
        }
    }

    fn at<'a>(date: &'a str, gift_id: Option<&'a str>) -> GiftRef<'a> {
        GiftRef { date, gift_id }
    }

    const ALL: [Scope; 3] = [Scope::ThisGift, Scope::Future, Scope::FutureAndPast4y];

    #[test]
    fn is_iso_date_accepts_real_calendar_dates_only() {
        assert!(is_iso_date("2026-03-03"));
        assert!(is_iso_date("2024-02-29"));
        assert!(!is_iso_date("2025-02-29"));
        assert!(!is_iso_date("2026-13-01"));
        assert!(!is_iso_date("2026-04-31"));
        assert!(!is_iso_date("2026-3-3"));
        assert!(!is_iso_date(""));
        assert!(!is_iso_date("2026-0a-01"));
    }

    #[test]
    fn years_before_same_day_and_29_feb_becomes_1_mar() {
        assert_eq!(years_before("2026-03-03", 4), "2022-03-03");
        assert_eq!(years_before("2028-02-29", 4), "2024-02-29");
        assert_eq!(years_before("2024-02-29", 1), "2023-03-01");
        assert_eq!(years_before("2026-12-31", 4), "2022-12-31");
    }

    fn utc(y: i64, m: i64, d: i64, h: i64, min: i64) -> i64 {
        days_from_civil(y, m, d) * DAY_MS + h * 3_600_000 + min * 60_000
    }

    #[test]
    fn utc_timestamps_and_date_labels() {
        assert_eq!(utc_timestamp(1_416_045_959_005), "2014-11-15T10:05:59.005");
        assert_eq!(uk_date_label("2026-03-03"), "3 Mar 2026");
        assert_eq!(uk_date_label("nonsense"), "nonsense");
    }

    #[test]
    fn uk_date_is_the_london_calendar_date_bst_included() {
        assert_eq!(uk_date(utc(2026, 7, 1, 22, 59)), "2026-07-01");
        assert_eq!(uk_date(utc(2026, 7, 1, 23, 0)), "2026-07-02");
        assert_eq!(uk_date(utc(2026, 12, 31, 23, 59)), "2026-12-31");
        // 2026's clocks change on 29 March and 25 October, at 01:00 UTC.
        assert_eq!(uk_date(utc(2026, 3, 28, 23, 30)), "2026-03-28");
        assert_eq!(uk_date(utc(2026, 3, 29, 23, 30)), "2026-03-30");
        assert_eq!(uk_date(utc(2026, 10, 24, 23, 30)), "2026-10-25");
        assert_eq!(uk_date(utc(2026, 10, 25, 23, 30)), "2026-10-25");
        assert_eq!(uk_date(0), "1970-01-01");
    }

    #[test]
    fn coverage_truth_table() {
        for (scope, date, covered) in [
            (Scope::FutureAndPast4y, "2022-03-02", false), // a day before madeOn − 4y
            (Scope::FutureAndPast4y, "2022-03-03", true),  // exactly madeOn − 4y
            (Scope::FutureAndPast4y, "2024-01-01", true),
            (Scope::FutureAndPast4y, MADE, true),
            (Scope::FutureAndPast4y, "2030-01-01", true),
            (Scope::Future, "2026-03-02", false),
            (Scope::Future, MADE, true),
            (Scope::Future, "2030-01-01", true),
        ] {
            assert_eq!(
                covers(&decl(scope), at(date, None)),
                covered,
                "{scope:?} {date}"
            );
        }
    }

    #[test]
    fn this_gift_covers_its_own_gift_only_whatever_the_date() {
        let d = decl(Scope::ThisGift);
        assert!(covers(&d, at(MADE, Some(GIFT))));
        assert!(covers(&d, at("2020-01-01", Some(GIFT))));
        assert!(!covers(&d, at(MADE, Some(OTHER_GIFT))));
        assert!(!covers(&d, at(MADE, None)));
        // A thisGift declaration without its gift (never stored) covers nothing.
        let bare = D { gift_id: None, ..d };
        assert!(!covers(&bare, at(MADE, None)));
    }

    #[test]
    fn an_enduring_declaration_made_with_a_gift_covers_it_even_before_its_window() {
        for scope in [Scope::Future, Scope::FutureAndPast4y] {
            let with = D {
                gift_id: Some(GIFT.into()),
                ..decl(scope)
            };
            // Back-dated gift entered today: before madeOn − 4y and before madeOn.
            assert!(covers(&with, at("2020-01-01", Some(GIFT))));
            assert!(!covers(&with, at("2020-01-01", Some(OTHER_GIFT))));
            assert!(!covers(&with, at("2020-01-01", None)));
            // The window is unchanged for every other gift.
            assert!(covers(&with, at(MADE, Some(OTHER_GIFT))));
            let chain = [with.clone()];
            assert_eq!(
                covering_declaration(&chain, at("2020-01-01", Some(GIFT))),
                Some(&chain[0])
            );
            // Cancelled on or before its gift's date: not covered.
            let gone = D {
                cancelled_from: Some("2020-01-01".into()),
                ..with.clone()
            };
            assert!(!covers(&gone, at("2020-01-01", Some(GIFT))));
            let voided = D {
                voided: true,
                ..with
            };
            assert!(!covers(&voided, at("2020-01-01", Some(GIFT))));
        }
    }

    #[test]
    fn cancellation_on_or_before_the_gift_date_removes_coverage_after_keeps_it() {
        for scope in ALL {
            let gift = at("2026-06-01", Some(GIFT));
            assert!(covers(&decl(scope), gift));
            assert!(!covers(&cancelled(scope, "2026-05-31"), gift));
            assert!(!covers(&cancelled(scope, "2026-06-01"), gift));
            assert!(covers(&cancelled(scope, "2026-06-02"), gift));
        }
    }

    #[test]
    fn voided_covers_nothing_and_is_never_current_or_open() {
        for scope in ALL {
            let voided = D {
                voided: true,
                ..decl(scope)
            };
            for date in ["2022-03-03", MADE, "2030-01-01"] {
                assert!(!covers(&voided, at(date, Some(GIFT))));
            }
            let chain = [voided.clone()];
            assert!(covering_declaration(&chain, at(MADE, Some(GIFT))).is_none());
            assert!(current_of(&chain, MADE).is_none());
            assert!(!open_at(&voided, MADE));
        }
    }

    #[test]
    fn a_later_declaration_covers_again_after_a_cancellation() {
        let chain = [
            D {
                cancelled_from: Some("2022-01-01".into()),
                ..made(Scope::Future, "2020-01-01")
            },
            made(Scope::Future, "2024-01-01"),
        ];
        assert_eq!(
            covering_declaration(&chain, at("2021-06-01", None)),
            Some(&chain[0])
        );
        assert_eq!(covering_declaration(&chain, at("2023-06-01", None)), None);
        assert_eq!(
            covering_declaration(&chain, at("2025-06-01", None)),
            Some(&chain[1])
        );
    }

    #[test]
    fn of_several_the_one_made_last_is_reported() {
        let chain = [
            made(Scope::Future, "2020-01-01"),
            made(Scope::FutureAndPast4y, "2024-01-01"),
        ];
        assert_eq!(
            covering_declaration(&chain, at("2025-01-01", None)),
            Some(&chain[1])
        );
        assert_eq!(
            covering_declaration(&chain, at("2020-06-01", None)),
            Some(&chain[1])
        );
        assert_eq!(
            covering_declaration(&chain, at("2020-01-01", None)),
            Some(&chain[1])
        );
        assert_eq!(covering_declaration(&chain, at("2019-12-31", None)), None);
    }

    #[test]
    fn current_is_enduring_and_in_force_today_this_gift_never() {
        assert!(current_of(&[decl(Scope::ThisGift)], MADE).is_none());
        assert!(current_of(&[decl(Scope::Future)], MADE).is_some());
        assert!(current_of(&[decl(Scope::Future)], "2026-03-02").is_none());
        assert!(current_of(&[cancelled(Scope::Future, MADE)], MADE).is_none());
        // A cancellation dated later doesn't apply yet.
        assert!(current_of(&[cancelled(Scope::Future, "2027-01-01")], MADE).is_some());
    }

    #[test]
    fn open_at_made_by_the_date_and_not_already_cancelled() {
        assert!(open_at(&decl(Scope::Future), MADE));
        assert!(!open_at(&decl(Scope::Future), "2026-03-02"));
        assert!(open_at(&cancelled(Scope::Future, "2026-04-01"), MADE));
        assert!(!open_at(&cancelled(Scope::Future, MADE), MADE));
    }

    fn payload() -> DeclarationPayload {
        DeclarationPayload {
            contact_id: "c".into(),
            scope: Scope::Future,
            gift_id: None,
            made_on: " 2026-03-03 ".into(),
            method: Method::PaperForm,
            wording_version: format!(" {HMRC_MODEL_WORDING_VERSION} "),
            first_name: "  Jo ".into(),
            last_name: "Bloggs".into(),
            address_line1: " 12   High St ".into(),
            postcode: "sw1a 1aa".into(),
        }
    }

    #[test]
    fn prepare_tidies_the_snapshot_and_upper_cases_the_postcode() {
        assert_eq!(
            prepare_declaration(payload()).unwrap(),
            DeclarationPayload {
                made_on: "2026-03-03".into(),
                wording_version: HMRC_MODEL_WORDING_VERSION.into(),
                first_name: "Jo".into(),
                address_line1: "12 High St".into(),
                postcode: "SW1A 1AA".into(),
                ..payload()
            }
        );
    }

    #[test]
    fn prepare_refuses_a_bad_date_and_a_this_gift_with_no_gift() {
        assert!(
            prepare_declaration(DeclarationPayload {
                made_on: "2026-02-30".into(),
                ..payload()
            })
            .is_err()
        );
        assert!(
            prepare_declaration(DeclarationPayload {
                scope: Scope::ThisGift,
                ..payload()
            })
            .is_err()
        );
        // An enduring scope may name its gift.
        let named = prepare_declaration(DeclarationPayload {
            gift_id: Some(GIFT.into()),
            ..payload()
        })
        .unwrap();
        assert_eq!(named.gift_id.as_deref(), Some(GIFT));
    }

    #[test]
    fn prepare_refuses_on_screen_and_a_blank_wording_version() {
        let err = prepare_declaration(DeclarationPayload {
            method: Method::OnScreenByDonor,
            ..payload()
        })
        .unwrap_err();
        assert!(err.to_string().contains("no screen for donors"), "{err}");
        assert!(
            prepare_declaration(DeclarationPayload {
                wording_version: " ".into(),
                ..payload()
            })
            .is_err()
        );
        let ticked = prepare_declaration(DeclarationPayload {
            method: Method::StaffTickedNoEvidence,
            ..payload()
        })
        .unwrap();
        assert_eq!(ticked.method, Method::StaffTickedNoEvidence);
    }

    #[test]
    fn details_tidy_as_at_create_blanks_store_and_widths_refuse() {
        let tidied = prepare_details(payload().details()).unwrap();
        assert_eq!(tidied, prepare_declaration(payload()).unwrap().details());
        let blank = DetailsPayload {
            first_name: " ".into(),
            last_name: String::new(),
            address_line1: String::new(),
            postcode: String::new(),
        };
        assert_eq!(prepare_details(blank).unwrap().first_name, "");
        let wide = "x".repeat(SNAPSHOT_FIELD_MAX + 1);
        let ContractError::Invalid(problems) = prepare_details(DetailsPayload {
            address_line1: wide.clone(),
            postcode: wide,
            ..payload().details()
        })
        .unwrap_err() else {
            panic!("not invalid");
        };
        let fields: Vec<&str> = problems.iter().map(|p| p.field.as_str()).collect();
        assert_eq!(fields, ["addressLine1", "postcode"]);
        let at_max = "x".repeat(SNAPSHOT_FIELD_MAX);
        assert!(
            prepare_details(DetailsPayload {
                first_name: at_max,
                ..payload().details()
            })
            .is_ok()
        );
    }

    #[test]
    fn void_needs_a_reason_tidied() {
        assert_eq!(
            prepare_void(VoidPayload {
                reason: " wrong Jo ".into()
            })
            .unwrap()
            .reason,
            "wrong Jo"
        );
        assert!(
            prepare_void(VoidPayload {
                reason: "  ".into()
            })
            .is_err()
        );
    }

    #[test]
    fn cancellation_blanks_absent_a_real_date_a_note_only_with_a_date() {
        assert_eq!(
            prepare_cancellation(CancellationPayload {
                cancelled_from: Some(" ".into()),
                note: Some(String::new()),
            })
            .unwrap(),
            CancellationPayload {
                cancelled_from: None,
                note: None
            }
        );
        assert!(
            prepare_cancellation(CancellationPayload {
                cancelled_from: Some("2026-02-30".into()),
                note: None,
            })
            .is_err()
        );
        assert!(
            prepare_cancellation(CancellationPayload {
                cancelled_from: None,
                note: Some("phoned".into()),
            })
            .is_err()
        );
    }
}
