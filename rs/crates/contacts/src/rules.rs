//! Pure contact rules: normalisation, blocking invariants (ADR 0014 / 0015)
//! and the search text. The Rust port of `convex/contacts/rules.ts` and
//! `convex/contacts/search.ts`; no SQL here.

use std::collections::HashSet;

use contracts::{ContractError, Problem, is_client_id, mint_ids};
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

use crate::types::{
    AddressRow, Addresses, Details, EmailRow, FieldValue, FieldValues, Kind, Methods, PhoneRow,
};

/// Lowercased, accents stripped (NFD, then combining marks removed).
pub fn fold(s: &str) -> String {
    s.nfd()
        .filter(|c| !is_combining_mark(*c))
        .collect::<String>()
        .to_lowercase()
}

/// Words the way the search index splits them (on anything not a letter
/// or digit), folded.
pub fn tokens(s: &str) -> Vec<String> {
    fold(s)
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `(displayName, sortName)`.
pub fn computed_names(kind: Kind, first: &str, last: &str, name: &str) -> (String, String) {
    if kind == Kind::Individual {
        let display = [first, last]
            .iter()
            .filter(|s| !s.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(" ");
        let sort = if first.is_empty() {
            last.to_owned()
        } else {
            format!("{last}, {first}")
        };
        return (display, sort);
    }
    (name.to_owned(), name.to_owned())
}

/// The lookup form of an email address: trimmed, whole address lowercased.
pub fn normalise_email(address: &str) -> String {
    address.trim().to_lowercase()
}

/// The matching form of a phone number: digits only, a UK international
/// prefix (`+44`, `0044`, and a `(0)` after it) turned into the leading 0.
pub fn normalise_phone(number: &str) -> String {
    let mut digits: String = number
        .replace("(0)", "")
        .chars()
        .filter(char::is_ascii_digit)
        .collect();
    if let Some(rest) = digits.strip_prefix("00") {
        digits = rest.to_owned();
    }
    if digits.starts_with("44") && digits.len() > 10 {
        digits = format!("0{}", &digits[2..]);
    }
    digits
}

/// How many trailing digits of a phone are indexed on their own.
pub const PHONE_TAIL: usize = 6;

/// How many terms one search takes (Convex's limit, kept for parity).
pub const MAX_SEARCH_TERMS: usize = 16;

fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
}

fn trim(s: &mut String) {
    let t = s.trim();
    if t.len() != s.len() {
        *s = t.to_owned();
    }
}

fn blank_to_none(s: &mut Option<String>) {
    if s.as_deref().is_some_and(|v| v.trim().is_empty()) {
        *s = None;
    }
}

pub fn prepare_details(mut p: Details) -> Result<Details, ContractError> {
    for s in [
        &mut p.title,
        &mut p.first_name,
        &mut p.last_name,
        &mut p.nickname,
        &mut p.name,
    ] {
        trim(s);
    }
    blank_to_none(&mut p.birth_date);
    blank_to_none(&mut p.deceased_date);
    blank_to_none(&mut p.client_key);
    let mut problems = Vec::new();
    if p.kind == Kind::Individual {
        if p.last_name.is_empty() {
            problems.push(Problem::new("lastName", "An individual needs a last name"));
        }
        if !p.name.is_empty() {
            problems.push(Problem::new(
                "name",
                "Name is for organisations and households",
            ));
        }
    } else {
        if p.name.is_empty() {
            problems.push(Problem::new(
                "name",
                format!("A {} needs a name", p.kind.as_str()),
            ));
        }
        for (field, set) in [
            ("firstName", !p.first_name.is_empty()),
            ("lastName", !p.last_name.is_empty()),
            ("birthDate", p.birth_date.is_some()),
        ] {
            if set {
                problems.push(Problem::new(
                    field,
                    format!("{field} only applies to individuals"),
                ));
            }
        }
        if p.is_deceased {
            problems.push(Problem::new(
                "isDeceased",
                "Only individuals can be marked deceased",
            ));
        }
    }
    if p.deceased_date.is_some() && !p.is_deceased {
        problems.push(Problem::new(
            "deceasedDate",
            "A date of death needs the deceased flag",
        ));
    }
    for (field, value) in [
        ("birthDate", &p.birth_date),
        ("deceasedDate", &p.deceased_date),
    ] {
        if value.as_deref().is_some_and(|v| !is_date(v)) {
            problems.push(Problem::new(field, "Dates are YYYY-MM-DD"));
        }
    }
    if problems.is_empty() {
        Ok(p)
    } else {
        Err(ContractError::Invalid(problems))
    }
}

/// A child row with a primary flag.
trait Primary {
    fn primary(&mut self) -> &mut bool;
    fn key(&mut self) -> &mut Option<String>;
}

macro_rules! primary {
    ($($t:ty),*) => {$(
        impl Primary for $t {
            fn primary(&mut self) -> &mut bool { &mut self.is_primary }
            fn key(&mut self) -> &mut Option<String> { &mut self.key }
        }
    )*};
}
primary!(EmailRow, PhoneRow, AddressRow);

/// The most rows of one kind (emails, phones, addresses) a contact holds
/// (L6): enough for any real contact, small enough that a contact stays
/// one cheap read.
pub const MAX_CHILD_ROWS: usize = 50;

/// Mint missing keys, require unique well-formed keys, exactly one primary
/// (none if the list is empty), at most [`MAX_CHILD_ROWS`].
fn prepare_rows<T: Primary>(rows: &mut [T], field: &str) -> Result<(), ContractError> {
    if rows.len() > MAX_CHILD_ROWS {
        return Err(ContractError::invalid(
            field,
            format!("At most {MAX_CHILD_ROWS} entries"),
        ));
    }
    mint_ids(rows, |r| r.key());
    let mut keys = HashSet::new();
    for r in rows.iter_mut() {
        if !r.key().as_deref().is_some_and(is_client_id) {
            return Err(ContractError::invalid(
                field,
                "Row keys are 32 lower-case hex characters",
            ));
        }
        if !keys.insert(r.key().clone()) {
            return Err(ContractError::invalid(field, "Duplicate row key"));
        }
    }
    let primaries = rows.iter_mut().map(|r| *r.primary()).filter(|p| *p).count();
    if primaries > 1 {
        return Err(ContractError::invalid(
            field,
            "Only one entry can be primary",
        ));
    }
    if primaries == 0
        && let Some(first) = rows.first_mut()
    {
        *first.primary() = true;
    }
    Ok(())
}

pub fn prepare_methods(mut p: Methods) -> Result<Methods, ContractError> {
    for e in &mut p.emails {
        trim(&mut e.address);
    }
    prepare_rows(&mut p.emails, "emails")?;
    let mut seen = HashSet::new();
    for e in &p.emails {
        if !seen.insert(normalise_email(&e.address)) {
            return Err(ContractError::invalid("emails", "Duplicate email address"));
        }
    }
    for ph in &mut p.phones {
        trim(&mut ph.number);
    }
    prepare_rows(&mut p.phones, "phones")?;
    Ok(p)
}

pub fn prepare_addresses(mut p: Addresses) -> Result<Addresses, ContractError> {
    for a in &mut p.addresses {
        a.country = a.country.trim().to_uppercase();
        if !(a.country.len() == 2 && a.country.bytes().all(|b| b.is_ascii_uppercase())) {
            return Err(ContractError::invalid(
                "addresses",
                "Country must be a 2-letter ISO code",
            ));
        }
        for s in [&mut a.line1, &mut a.line2, &mut a.line3, &mut a.town] {
            trim(s);
        }
        // Normalised but never rejected: a typo is storable and warned.
        a.postcode = a.postcode.trim().to_uppercase();
    }
    prepare_rows(&mut p.addresses, "addresses")?;
    Ok(p)
}

/// Each field at most once, in field-id order so equal states compare equal.
pub fn prepare_fields(mut p: FieldValues) -> Result<FieldValues, ContractError> {
    let mut seen = HashSet::new();
    for v in &p.values {
        if !seen.insert(v.field_id.clone()) {
            return Err(ContractError::invalid(
                "fields",
                "A field holds one option at most",
            ));
        }
    }
    sort_values(&mut p.values);
    Ok(p)
}

pub fn sort_values(values: &mut [FieldValue]) {
    values.sort_by(|a, b| a.field_id.cmp(&b.field_id));
}

// ── search text ────────────────────────────────────────────────────────────

/// A UK postcode without spaces, and with the space before the inward code.
fn postcode_forms(postcode: &str) -> Vec<String> {
    let compact: String = postcode.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.is_empty() {
        return vec![];
    }
    let chars: Vec<char> = compact.chars().collect();
    let spaced = if chars.len() >= 5 {
        let (out, inw) = chars.split_at(chars.len() - 3);
        format!(
            "{} {}",
            out.iter().collect::<String>(),
            inw.iter().collect::<String>()
        )
    } else {
        String::new()
    };
    vec![compact, spaced]
}

/// The joined forms of a name ("Smith-Jones" → "smithjones", "de la Cruz"
/// → "delacruz"), forms under two characters dropped.
fn joined_forms(name: &str) -> Vec<String> {
    let mut forms: Vec<String> = fold(name)
        .split_whitespace()
        .map(|w| tokens(w).concat())
        .collect();
    forms.push(tokens(name).concat());
    forms.retain(|f| f.chars().count() >= 2);
    forms
}

pub struct SearchContact<'a> {
    pub first_name: &'a str,
    pub last_name: &'a str,
    pub nickname: &'a str,
    pub name: &'a str,
    pub sort_name: &'a str,
}

pub struct SearchAddress<'a> {
    pub line1: &'a str,
    pub town: &'a str,
    pub postcode: &'a str,
}

/// Everything a contact is found by, as de-duplicated folded words (the
/// same text as Convex's `contactSearch.text`): names plus their joined
/// forms, each email whole and split at `@` and `.`, each phone as digits
/// and its last PHONE_TAIL digits, each postcode compact and spaced,
/// address line 1 and town, identifier values. Not dropdown values (the
/// list filters by those), not notes, not relationships.
pub fn search_text(
    c: &SearchContact,
    emails: &[&str],
    phones: &[&str],
    addresses: &[SearchAddress],
    identifiers: &[&str],
) -> String {
    let mut parts: Vec<String> = [c.first_name, c.last_name, c.nickname, c.name, c.sort_name]
        .iter()
        .map(|s| s.to_string())
        .collect();
    for name in [c.first_name, c.last_name, c.nickname, c.name] {
        parts.extend(joined_forms(name));
    }
    for email in emails {
        let whole = email.trim();
        parts.push(whole.to_owned());
        parts.push(whole.replace(['@', '.'], " "));
    }
    for number in phones {
        let digits = normalise_phone(number);
        let tail =
            (digits.len() > PHONE_TAIL).then(|| digits[digits.len() - PHONE_TAIL..].to_owned());
        parts.push(digits);
        parts.extend(tail);
    }
    for a in addresses {
        parts.push(a.line1.to_owned());
        parts.push(a.town.to_owned());
        parts.extend(postcode_forms(a.postcode));
    }
    parts.extend(identifiers.iter().map(|v| v.to_string()));
    let mut seen = HashSet::new();
    let mut words = Vec::new();
    for part in parts {
        for word in fold(&part).split(|c: char| c.is_whitespace() || c == ',') {
            if !word.is_empty() && seen.insert(word.to_owned()) {
                words.push(word.to_owned());
            }
        }
    }
    words.join(" ")
}

/// What a search box entry asks for. A phone-shaped entry (digits and
/// phone punctuation, at least PHONE_TAIL digits) is one normalised
/// number; anything else its folded words.
pub struct ParsedSearch {
    pub terms: Vec<String>,
    pub phone: Option<String>,
}

pub fn parse_search(term: &str) -> ParsedSearch {
    if !term.is_empty()
        && term
            .chars()
            .all(|c| c.is_ascii_digit() || c.is_whitespace() || "+().-".contains(c))
    {
        let phone = normalise_phone(term);
        if phone.len() >= PHONE_TAIL {
            return ParsedSearch {
                terms: vec![phone.clone()],
                phone: Some(phone),
            };
        }
    }
    let mut terms = tokens(term);
    terms.truncate(MAX_SEARCH_TERMS);
    ParsedSearch { terms, phone: None }
}

/// Whether a search text holds every term: whole words, the last one as a
/// prefix.
pub fn matches_all(text: &str, terms: &[String]) -> bool {
    let Some((last, rest)) = terms.split_last() else {
        return false;
    };
    let words = tokens(text);
    rest.iter().all(|t| words.contains(t)) && words.iter().any(|w| w.starts_with(last.as_str()))
}

// ── advisory warnings (ADR 0015 tier 2) ────────────────────────────────────

pub fn looks_like_email(value: &str) -> bool {
    match value.rfind('@') {
        Some(at) if at > 0 => value[at + 1..].contains('.'),
        _ => false,
    }
}

/// `^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$`, case-insensitive.
pub fn looks_like_uk_postcode(value: &str) -> bool {
    let v: Vec<char> = value.trim().to_uppercase().chars().collect();
    let alpha = |c: &char| c.is_ascii_uppercase();
    let digit = |c: &char| c.is_ascii_digit();
    // Inward code: digit + two letters, at the end.
    if v.len() < 5 {
        return false;
    }
    let (out, inw) = v.split_at(v.len() - 3);
    if !(digit(&inw[0]) && alpha(&inw[1]) && alpha(&inw[2])) {
        return false;
    }
    let out: Vec<char> = match out.last() {
        Some(' ') => out[..out.len() - 1].to_vec(),
        _ => out.to_vec(),
    };
    let letters = out.iter().take_while(|c| alpha(c)).count();
    if !(1..=2).contains(&letters) || out.len() <= letters {
        return false;
    }
    let rest = &out[letters..];
    digit(&rest[0])
        && match rest.len() {
            1 => true,
            2 => alpha(&rest[1]) || digit(&rest[1]),
            _ => false,
        }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_and_tokenises_like_convex() {
        assert_eq!(fold("Zoë Ó Briain"), "zoe o briain");
        assert_eq!(tokens("O’Brien, Ann-Marie"), ["o", "brien", "ann", "marie"]);
    }

    #[test]
    fn names() {
        assert_eq!(
            computed_names(Kind::Individual, "Ann", "Smith", ""),
            ("Ann Smith".into(), "Smith, Ann".into())
        );
        assert_eq!(
            computed_names(Kind::Individual, "", "Smith", ""),
            ("Smith".into(), "Smith".into())
        );
        assert_eq!(
            computed_names(Kind::Organization, "", "", "Leeds Trust"),
            ("Leeds Trust".into(), "Leeds Trust".into())
        );
    }

    #[test]
    fn phones_normalise() {
        assert_eq!(normalise_phone("+44 (0)7700 900123"), "07700900123");
        assert_eq!(normalise_phone("0044 7700 900123"), "07700900123");
        assert_eq!(normalise_phone("07700 900123"), "07700900123");
        assert_eq!(normalise_phone("0113 496 0000"), "01134960000");
    }

    #[test]
    fn search_text_holds_every_form() {
        let text = search_text(
            &SearchContact {
                first_name: "Ann-Marie",
                last_name: "O'Brien",
                nickname: "",
                name: "",
                sort_name: "O'Brien, Ann-Marie",
            },
            &["Ann.OBrien@Example.com"],
            &["+44 7700 900123"],
            &[SearchAddress {
                line1: "1 High St",
                town: "Leeds",
                postcode: "LS6 2AB",
            }],
            &["M-123"],
        );
        for word in [
            "ann-marie",
            "annmarie",
            "o'brien",
            "obrien",
            "ann.obrien@example.com",
            "example",
            "07700900123",
            "900123",
            "ls62ab",
            "ls6",
            "2ab",
            "leeds",
            "m-123",
        ] {
            assert!(
                text.split(' ').any(|w| w == word),
                "{word} missing from {text}"
            );
        }
    }

    #[test]
    fn parse_and_match() {
        let p = parse_search("07700 900123");
        assert_eq!(p.terms, ["07700900123"]);
        assert_eq!(p.phone.as_deref(), Some("07700900123"));
        let p = parse_search("john smi");
        assert_eq!(p.terms, ["john", "smi"]);
        assert!(p.phone.is_none());
        assert!(matches_all("john smith leeds", &p.terms));
        assert!(!matches_all("johnny smith", &p.terms));
        assert!(!matches_all("john jones", &p.terms));
    }

    #[test]
    fn postcodes() {
        for ok in ["LS6 2AB", "ls62ab", "M1 1AE", "EC1A 1BB", "W1A 0AX"] {
            assert!(looks_like_uk_postcode(ok), "{ok}");
        }
        for bad in ["LS6", "12345", "LS6 2A", "LSX6 2AB"] {
            assert!(!looks_like_uk_postcode(bad), "{bad}");
        }
    }
}
