//! Contact numbers (`convex/contacts/number.ts`): a per-organisation
//! sequence from FIRST_NUMBER, written with a Luhn check digit that isn't
//! stored. System-owned: no payload carries it; the details contract's
//! create takes the next one.

use rusqlite::{Connection, OptionalExtension};

/// An organisation's first contact number.
pub const FIRST_NUMBER: i64 = 10001;

/// The Luhn check digit for `sequence`.
pub fn check_digit(sequence: i64) -> u32 {
    let digits = sequence.to_string();
    let sum: u32 = digits
        .bytes()
        .rev()
        .enumerate()
        .map(|(i, b)| {
            let mut d = u32::from(b - b'0');
            if i % 2 == 0 {
                d *= 2;
                if d > 9 {
                    d -= 9;
                }
            }
            d
        })
        .sum();
    (10 - sum % 10) % 10
}

/// The number as staff see and write it: the sequence and its check digit.
pub fn format_number(sequence: i64) -> String {
    format!("{sequence}{}", check_digit(sequence))
}

#[derive(Debug, PartialEq, Eq)]
pub enum ParsedNumber {
    /// Five digits (`written: false`) or six whose last digit checks.
    Sequence { sequence: i64, written: bool },
    /// Six digits whose check digit is wrong: a hint for the list.
    Invalid { hint: String },
}

/// What a search entry says about contact numbers, spaces and hyphens
/// ignored. Exact only, never a prefix.
pub fn parse_number(term: &str) -> Option<ParsedNumber> {
    let digits: String = term.chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    if !(5..=6).contains(&digits.len()) || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let sequence: i64 = digits[..5].parse().ok()?;
    if sequence < FIRST_NUMBER {
        return None;
    }
    if digits.len() == 5 {
        return Some(ParsedNumber::Sequence {
            sequence,
            written: false,
        });
    }
    if check_digit(sequence) == u32::from(digits.as_bytes()[5] - b'0') {
        return Some(ParsedNumber::Sequence {
            sequence,
            written: true,
        });
    }
    Some(ParsedNumber::Invalid {
        hint: format!("{digits} isn’t a valid contact number. Check the last digit."),
    })
}

/// Take the next number from the organisation's sequence (in the create's
/// transaction, after its duplicate check, so every number taken goes on a
/// contact).
pub(crate) fn take_number(conn: &Connection) -> rusqlite::Result<i64> {
    let next: Option<i64> = conn
        .query_row("SELECT next FROM contact_number_sequence WHERE id = 1", [], |r| {
            r.get(0)
        })
        .optional()?;
    let number = next.unwrap_or(FIRST_NUMBER);
    conn.execute(
        "INSERT INTO contact_number_sequence (id, next) VALUES (1, ?1)
         ON CONFLICT (id) DO UPDATE SET next = excluded.next",
        [number + 1],
    )?;
    Ok(number)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn luhn() {
        // The value the Convex measure script uses: 15123 → 151233.
        assert_eq!(format_number(15123), "151233");
        assert_eq!(format_number(10001), "100016");
    }

    #[test]
    fn parses() {
        assert_eq!(
            parse_number("151233"),
            Some(ParsedNumber::Sequence {
                sequence: 15123,
                written: true
            })
        );
        assert_eq!(
            parse_number("15123"),
            Some(ParsedNumber::Sequence {
                sequence: 15123,
                written: false
            })
        );
        assert!(matches!(
            parse_number("151234"),
            Some(ParsedNumber::Invalid { .. })
        ));
        assert_eq!(parse_number("09999"), None);
        assert_eq!(parse_number("smith"), None);
        assert_eq!(parse_number("1234567"), None);
    }
}
