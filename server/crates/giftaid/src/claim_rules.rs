//! Gift Aid claim rules, pure: what HMRC's schedule and claim XML accept
//! for one donation (HMRC "Schedule spreadsheet to claim back tax on Gift
//! Aid donations", gov.uk, updated 2025-11-28; the Charities RIM schema
//! r68 v2.0, `GAD/Donor`), and the reclaim.
//!
//! A line is the donor as the claim snapshots them: title (optional, ≤ 4
//! letters), first name (one word, ≤ 35), last name (≤ 35, a hyphen
//! becomes a space as HMRC asks), house name or number (≤ 40) and a UK
//! postcode in capitals with its space, or, for a donor living outside the
//! UK (the Isle of Man and the Channel Islands included), the address in
//! the house column and `X` for the postcode.

use contacts::types::Kind;

use crate::rules::{uk_date_label, years_before};

/// HMRC's Gift Aid schedule takes at most this many donations, and each
/// schedule is its own Charities Online claim: so a claim holds at most
/// this many lines, and more eligible gifts make several claims.
pub const SCHEDULE_ROW_LIMIT: usize = 1000;
/// A gift can be claimed up to this many years after it was received.
pub const CLAIM_LIMIT_YEARS: i64 = 4;
pub const TITLE_MAX: usize = 4;
pub const NAME_MAX: usize = 35;
pub const HOUSE_MAX: usize = 40;
/// HMRC's `OtherInfo` (where an adjustment is explained).
pub const OTHER_INFO_MAX: usize = 350;
pub const HMRC_REFERENCE_MAX: usize = 7;
pub const REJECTED_REASON_MAX: usize = 1000;

/// The tax reclaimed on a gift: 25% of it in pence, rounded down.
pub fn reclaim(amount: i64) -> i64 {
    amount.div_euclid(4)
}

/// The earliest gift date a claim made on `today` may include.
pub fn claimable_from(today: &str) -> String {
    years_before(today, CLAIM_LIMIT_YEARS)
}

/// A donor as a claim line snapshots them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DonorLine {
    pub title: String,
    pub first_name: String,
    pub last_name: String,
    pub house: String,
    /// Empty when `overseas`.
    pub postcode: String,
    pub overseas: bool,
}

fn tidy(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn too_long(value: &str, max: usize) -> bool {
    value.chars().count() > max
}

/// HMRC's title pattern: a letter, then letters, `'` or `-`, ≤ 4. A full
/// stop is dropped ("Mrs." → "Mrs"); anything else that doesn't fit is
/// left out (the title is optional), never a reason to leave a gift out.
pub fn title(value: &str) -> String {
    let t = tidy(value).replace('.', "");
    let mut chars = t.chars();
    let fits = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphabetic() || c == '\'' || c == '-')
        && !too_long(&t, TITLE_MAX);
    if fits { t } else { String::new() }
}

/// A UK postcode as HMRC wants it (`r68_PostCodeType`): capitals, one
/// space before the inward code, or `None` if it isn't one.
pub fn uk_postcode(value: &str) -> Option<String> {
    let compact: String = value
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_ascii_uppercase();
    if compact == "GIR0AA" {
        return Some("GIR 0AA".into());
    }
    if !(5..=7).contains(&compact.len()) || !compact.is_ascii() {
        return None;
    }
    let (outward, inward) = compact.split_at(compact.len() - 3);
    let i = inward.as_bytes();
    if !(i[0].is_ascii_digit() && i[1].is_ascii_uppercase() && i[2].is_ascii_uppercase()) {
        return None;
    }
    let o = outward.as_bytes();
    let letter = |b: u8| b.is_ascii_uppercase();
    let digit = |b: u8| b.is_ascii_digit();
    // HMRC's second letter of a two-letter area: A–H, J–Y (no I, no Z).
    let second = |b: u8| letter(b) && b != b'I' && b != b'Z';
    let ok = match *o {
        [a, b] => letter(a) && digit(b),
        [a, b, c] => {
            (letter(a) && digit(b) && digit(c))
                || (letter(a) && second(b) && digit(c))
                || (letter(a) && digit(b) && letter(c))
        }
        [a, b, c, d] => {
            (letter(a) && second(b) && digit(c) && digit(d))
                || (letter(a) && second(b) && digit(c) && letter(d))
        }
        _ => false,
    };
    ok.then(|| format!("{outward} {inward}"))
}

/// Crown dependencies: addresses there are non-UK for Gift Aid ("donors
/// living in the Isle of Man and Channel Islands"), with no postcode.
fn crown_dependency(postcode: &str) -> bool {
    let p = postcode.trim().to_ascii_uppercase();
    ["IM", "JE", "GY"].iter().any(|area| {
        p.strip_prefix(area)
            .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
    })
}

/// "House name or number" from an address's first line: the number that
/// starts it ("12A High Street" → "12A", "12-14 Mill Lane" → "12-14"),
/// else the part before the first comma ("Rose Cottage, Mill Lane" →
/// "Rose Cottage"), keeping a flat's building number ("Flat 3, 12 High
/// Street" → "Flat 3, 12").
pub fn house_name_or_number(line1: &str) -> String {
    let line = tidy(line1);
    let first = line.split(' ').next().unwrap_or("");
    if first.starts_with(|c: char| c.is_ascii_digit()) {
        return first.trim_end_matches(',').to_owned();
    }
    let mut parts = line.splitn(2, ',');
    let head = parts.next().unwrap_or("").trim().to_owned();
    let flat = ["flat", "apartment", "apt", "unit", "room"]
        .iter()
        .any(|w| head.to_ascii_lowercase().starts_with(&format!("{w} ")));
    if flat
        && let Some(rest) = parts.next()
        && let Some(number) = rest.split_whitespace().next()
        && number.starts_with(|c: char| c.is_ascii_digit())
    {
        return format!("{head}, {}", number.trim_end_matches(','));
    }
    head
}

/// The contact facts a line is built from.
#[derive(Clone, Copy, Debug)]
pub struct DonorFacts<'a> {
    pub kind: Kind,
    pub title: &'a str,
    pub first_name: &'a str,
    pub last_name: &'a str,
    pub line1: &'a str,
    pub town: &'a str,
    pub postcode: &'a str,
    /// ISO alpha-2; empty reads as `GB`.
    pub country: &'a str,
}

/// The claim line for a donor, or every reason it can't be one, each
/// worded for the staff who will fix it.
pub fn donor_line(d: DonorFacts) -> Result<DonorLine, Vec<String>> {
    match d.kind {
        Kind::Individual => {}
        Kind::Organization => return Err(vec!["The donor is an organisation".into()]),
        Kind::Household => return Err(vec!["The donor is a household".into()]),
    }
    let mut reasons = Vec::new();
    let first_name = tidy(d.first_name)
        .split(' ')
        .next()
        .unwrap_or("")
        .to_owned();
    if first_name.is_empty() {
        reasons.push("No first name".to_owned());
    } else if too_long(&first_name, NAME_MAX) {
        reasons.push(format!("First name is over {NAME_MAX} characters"));
    }
    let last_name = tidy(&d.last_name.replace('-', " "));
    if last_name.is_empty() {
        reasons.push("No last name".to_owned());
    } else if too_long(&last_name, NAME_MAX) {
        reasons.push(format!("Last name is over {NAME_MAX} characters"));
    }
    let country = d.country.trim().to_ascii_uppercase();
    let overseas = !(country.is_empty() || country == "GB") || crown_dependency(d.postcode);
    let line1 = tidy(d.line1);
    let (house, postcode) = if overseas {
        let town = tidy(d.town);
        let full = if town.is_empty() {
            line1.clone()
        } else {
            format!("{line1}, {town}")
        };
        let house = if too_long(&full, HOUSE_MAX) {
            line1.clone()
        } else {
            full
        };
        if line1.is_empty() {
            reasons.push("No address".to_owned());
        } else if too_long(&house, HOUSE_MAX) {
            reasons.push(format!(
                "The address's first line is over {HOUSE_MAX} characters"
            ));
        }
        (house, String::new())
    } else {
        let house = house_name_or_number(&line1);
        if house.is_empty() {
            reasons.push("No house name or number".to_owned());
        } else if too_long(&house, HOUSE_MAX) {
            reasons.push(format!(
                "House name or number is over {HOUSE_MAX} characters"
            ));
        }
        let postcode = match uk_postcode(d.postcode) {
            Some(p) => p,
            None if d.postcode.trim().is_empty() => {
                reasons.push("No postcode".to_owned());
                String::new()
            }
            None => {
                reasons.push(format!("Postcode {} isn't a UK postcode", tidy(d.postcode)));
                String::new()
            }
        };
        (house, postcode)
    };
    if !reasons.is_empty() {
        return Err(reasons);
    }
    Ok(DonorLine {
        title: title(d.title),
        first_name,
        last_name,
        house,
        postcode,
        overseas,
    })
}

/// "No declaration covers 3 Mar 2026".
pub fn no_declaration(date: &str) -> String {
    format!("No declaration covers {}", uk_date_label(date))
}

/// HMRC's charity reference (`HMRCref`): one or two capitals, then one
/// to five digits.
pub fn is_hmrc_reference(value: &str) -> bool {
    let letters = value.bytes().take_while(u8::is_ascii_uppercase).count();
    let digits = &value[letters..];
    (1..=2).contains(&letters)
        && (1..=5).contains(&digits.len())
        && digits.bytes().all(|b| b.is_ascii_digit())
}

/// Pence as HMRC writes money: "1234.50", never a £ sign.
pub fn pounds(pence: i64) -> String {
    let sign = if pence < 0 { "-" } else { "" };
    let p = pence.unsigned_abs();
    format!("{sign}{}.{:02}", p / 100, p % 100)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts<'a>(
        first: &'a str,
        last: &'a str,
        line1: &'a str,
        postcode: &'a str,
    ) -> DonorFacts<'a> {
        DonorFacts {
            kind: Kind::Individual,
            title: "Mrs.",
            first_name: first,
            last_name: last,
            line1,
            town: "Leeds",
            postcode,
            country: "GB",
        }
    }

    #[test]
    fn reclaim_is_a_quarter_rounded_down() {
        assert_eq!(reclaim(2000), 500);
        assert_eq!(reclaim(1001), 250);
        assert_eq!(reclaim(3), 0);
        assert_eq!(reclaim(1), 0);
    }

    #[test]
    fn four_years_back() {
        assert_eq!(claimable_from("2026-10-28"), "2022-10-28");
        assert_eq!(claimable_from("2028-02-29"), "2024-02-29");
    }

    #[test]
    fn postcodes_take_hmrcs_shape() {
        assert_eq!(uk_postcode("ls11aa").as_deref(), Some("LS1 1AA"));
        assert_eq!(uk_postcode(" M99 2QD ").as_deref(), Some("M99 2QD"));
        assert_eq!(uk_postcode("EC1A1BB").as_deref(), Some("EC1A 1BB"));
        assert_eq!(uk_postcode("W1A 0AX").as_deref(), Some("W1A 0AX"));
        assert_eq!(uk_postcode("gir0aa").as_deref(), Some("GIR 0AA"));
        for bad in [
            "",
            "X",
            "12345",
            "LS1",
            "LSI 1AA",
            "LZ1 1AA",
            "LS1 AAA",
            "LS11 1AAA",
        ] {
            assert_eq!(uk_postcode(bad), None, "{bad}");
        }
    }

    #[test]
    fn house_name_or_number_from_line_one() {
        assert_eq!(house_name_or_number("12A High Street"), "12A");
        assert_eq!(house_name_or_number("12-14, Mill Lane"), "12-14");
        assert_eq!(
            house_name_or_number("Rose Cottage, Mill Lane"),
            "Rose Cottage"
        );
        assert_eq!(house_name_or_number("The Old Forge"), "The Old Forge");
        assert_eq!(house_name_or_number("Flat 3, 12 High Street"), "Flat 3, 12");
        assert_eq!(house_name_or_number("Flat 3, Rose Court"), "Flat 3");
        assert_eq!(house_name_or_number("  "), "");
    }

    #[test]
    fn titles_fit_hmrcs_pattern_or_are_left_out() {
        assert_eq!(title("Mrs."), "Mrs");
        assert_eq!(title("Prof"), "Prof");
        assert_eq!(title("Revd Dr"), "");
        assert_eq!(title("Lady"), "Lady");
        assert_eq!(title("Sir1"), "");
    }

    #[test]
    fn a_uk_donor_line() {
        let line = donor_line(facts("Mary Ann", "Smith-Jones", "12 High St", "ls1 1aa")).unwrap();
        assert_eq!(
            line,
            DonorLine {
                title: "Mrs".into(),
                first_name: "Mary".into(),
                last_name: "Smith Jones".into(),
                house: "12".into(),
                postcode: "LS1 1AA".into(),
                overseas: false,
            }
        );
    }

    #[test]
    fn overseas_and_crown_dependency_donors_have_no_postcode() {
        let mut f = facts("Bob", "Smith", "1 The Shores", "");
        f.country = "GR";
        f.town = "Corfu Town";
        let line = donor_line(f).unwrap();
        assert!(line.overseas);
        assert_eq!(line.house, "1 The Shores, Corfu Town");
        assert_eq!(line.postcode, "");
        let jersey = donor_line(facts("Ann", "Le Brun", "4 Rue", "JE2 3AB")).unwrap();
        assert!(jersey.overseas);
        assert_eq!(jersey.postcode, "");
    }

    #[test]
    fn every_reason_is_listed() {
        let err = donor_line(facts("", "", "", "")).unwrap_err();
        assert_eq!(
            err,
            [
                "No first name",
                "No last name",
                "No house name or number",
                "No postcode"
            ]
        );
        let err = donor_line(facts("Jo", "Bloggs", "1 Road", "SW1")).unwrap_err();
        assert_eq!(err, ["Postcode SW1 isn't a UK postcode"]);
        let mut org = facts("", "", "", "");
        org.kind = Kind::Organization;
        assert_eq!(
            donor_line(org).unwrap_err(),
            ["The donor is an organisation"]
        );
    }

    #[test]
    fn hmrc_references_and_money() {
        assert!(is_hmrc_reference("AA12345"));
        assert!(is_hmrc_reference("X1"));
        assert!(!is_hmrc_reference("ABC1"));
        assert!(!is_hmrc_reference("AA123456"));
        assert!(!is_hmrc_reference("aa123"));
        assert_eq!(pounds(500), "5.00");
        assert_eq!(pounds(1205), "12.05");
        assert_eq!(pounds(-262), "-2.62");
    }
}
