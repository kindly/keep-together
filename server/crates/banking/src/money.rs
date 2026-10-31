//! Statement amounts to signed integer pence, by string arithmetic: no
//! float anywhere (rule 7).

use giving::PENCE_MAX;

/// Which character separates pence. UK CSVs use `.` (a `,` groups
/// thousands); OFX from some banks uses `,`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decimal {
    Point,
    /// `.` or `,`, whichever is last with one or two digits after it.
    PointOrComma,
}

/// Signed pence from a statement amount, `None` for a blank cell.
///
/// Takes `1234.56`, `1,234.56`, `-12.5`, `12` (Barclays writes whole
/// pounds bare), `£12.00`, `+12.00`, `12.00-`, `(12.00)`, `12.00 CR`,
/// `12.00 DR`. More than two decimal places is refused unless the extra
/// digits are zeros.
pub fn parse_pence(value: &str, decimal: Decimal) -> Result<Option<i64>, String> {
    let original = value.trim();
    let mut s = original;
    if s.is_empty() {
        return Ok(None);
    }
    let bad = || format!("Not an amount: {original:?}");
    let mut negative = false;
    let sign = |neg: bool, negative: &mut bool| {
        if *negative && neg {
            return Err(bad());
        }
        *negative |= neg;
        Ok(())
    };
    if let Some(inner) = s.strip_prefix('(').and_then(|r| r.strip_suffix(')')) {
        sign(true, &mut negative)?;
        s = inner.trim();
    }
    let upper = s.to_ascii_uppercase();
    if upper.ends_with("CR") || upper.ends_with("DR") {
        sign(upper.ends_with("DR"), &mut negative)?;
        s = s[..s.len() - 2].trim_end();
    }
    if let Some(rest) = s.strip_suffix('-') {
        sign(true, &mut negative)?;
        s = rest.trim_end();
    }
    if let Some(rest) = s.strip_prefix('-') {
        sign(true, &mut negative)?;
        s = rest.trim_start();
    } else if let Some(rest) = s.strip_prefix('+') {
        s = rest.trim_start();
    }
    s = s.strip_prefix('£').unwrap_or(s).trim_start();
    if let Some(rest) = s.strip_prefix('-') {
        sign(true, &mut negative)?;
        s = rest;
    }

    let decimal_at = match decimal {
        Decimal::Point => s.rfind('.'),
        Decimal::PointOrComma => s
            .rfind(['.', ','])
            .filter(|&i| s.as_bytes()[i] == b'.' || (1..=2).contains(&(s.len() - i - 1))),
    };
    let (whole, fraction) = match decimal_at {
        Some(i) => (&s[..i], &s[i + 1..]),
        None => (s, ""),
    };
    let whole = ungroup(whole).ok_or_else(bad)?;
    if !fraction.bytes().all(|b| b.is_ascii_digit()) || (whole.is_empty() && fraction.is_empty()) {
        return Err(bad());
    }
    let (pence_digits, extra) = fraction.split_at(fraction.len().min(2));
    if extra.bytes().any(|b| b != b'0') {
        return Err(format!("More than two decimal places: {original:?}"));
    }
    let digits = format!("{whole}{pence_digits:0<2}");
    let digits = digits.trim_start_matches('0');
    let too_big = || format!("Amount too large: {original:?}");
    let pence = if digits.is_empty() {
        0
    } else if digits.len() > 16 {
        return Err(too_big());
    } else {
        digits.parse::<i64>().map_err(|_| bad())?
    };
    if pence > PENCE_MAX {
        return Err(too_big());
    }
    Ok(Some(if negative { -pence } else { pence }))
}

/// The digits of a whole-pounds part, with `,` thousands groups removed
/// (only when every group after the first is three digits).
fn ungroup(whole: &str) -> Option<String> {
    let mut groups = whole.split(',');
    let first = groups.next()?;
    let rest: Vec<&str> = groups.collect();
    let ok = first.bytes().all(|b| b.is_ascii_digit())
        && (rest.is_empty() || !first.is_empty())
        && rest
            .iter()
            .all(|g| g.len() == 3 && g.bytes().all(|b| b.is_ascii_digit()));
    ok.then(|| whole.replace(',', ""))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(value: &str) -> Result<Option<i64>, String> {
        parse_pence(value, Decimal::Point)
    }

    #[test]
    fn amounts_are_integer_pence() {
        assert_eq!(p("1234.56"), Ok(Some(123_456)));
        assert_eq!(p("1,234.56"), Ok(Some(123_456)));
        assert_eq!(p("12"), Ok(Some(1200)));
        assert_eq!(p("12.5"), Ok(Some(1250)));
        assert_eq!(p(".50"), Ok(Some(50)));
        assert_eq!(p("£10.00"), Ok(Some(1000)));
        assert_eq!(p("0.10"), Ok(Some(10)));
        assert_eq!(p("12.500"), Ok(Some(1250)));
        assert_eq!(p("  "), Ok(None));
        // 0.1 + 0.2 in a float is not 0.3; here it can't come up.
        assert_eq!(p("0.30"), Ok(Some(30)));
    }

    #[test]
    fn signs_in_every_spelling() {
        for neg in [
            "-12.00", "12.00-", "(12.00)", "12.00 DR", "-£12.00", "£-12.00",
        ] {
            assert_eq!(p(neg), Ok(Some(-1200)), "{neg}");
        }
        for pos in ["+12.00", "12.00 CR", "12.00cr"] {
            assert_eq!(p(pos), Ok(Some(1200)), "{pos}");
        }
        assert!(p("--12").is_err());
        assert!(p("(12.00) DR").is_err());
    }

    #[test]
    fn junk_is_refused() {
        for bad in [
            "12.345", "1,23.00", "abc", "12.3.4", "£", "-", "1e5", "12,5",
        ] {
            assert!(p(bad).is_err(), "{bad}");
        }
        assert!(p("99999999999999999999").is_err());
        assert!(p(&format!("{}", PENCE_MAX)).is_err());
    }

    #[test]
    fn a_decimal_comma_where_allowed() {
        let c = |v| parse_pence(v, Decimal::PointOrComma);
        assert_eq!(c("12,50"), Ok(Some(1250)));
        assert_eq!(c("-12,5"), Ok(Some(-1250)));
        assert_eq!(c("1,234.56"), Ok(Some(123_456)));
        assert_eq!(c("1,234"), Ok(Some(123_400)));
    }
}
