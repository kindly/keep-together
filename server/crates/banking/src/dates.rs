//! Statement dates to YYYY-MM-DD, read day-first: a UK statement's
//! `03/11/2026` is 3 November.

use giving::rules::is_iso_date;

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/// Takes `03/11/2026`, `3/11/26`, `03-11-2026`, `03.11.2026`, `3 Nov 2026`,
/// `03-Nov-26`, `3 November 2026`, QIF's `3/11'26`, ISO `2026-11-03` (or
/// `2026/11/03`), and any of them followed by a time. Two-digit years are
/// 20xx.
pub fn day_first(value: &str) -> Result<String, String> {
    let original = value.trim();
    let bad = || format!("Not a date: {original:?}");
    let has_time = |(_, time): &(&str, &str)| time.contains(':');
    let date = original
        .rsplit_once(' ')
        .filter(has_time)
        .map_or(original, |(date, _)| date.trim_end());
    let date = date
        .split_once('T')
        .filter(has_time)
        .map_or(date, |(d, _)| d);
    let date = date.replace('\'', "/");
    let parts: Vec<&str> = date
        .split(['/', '-', '.', ' '])
        .filter(|p| !p.is_empty())
        .collect();
    let [a, b, c] = parts[..] else {
        return Err(bad());
    };
    let (year, month, day) = if a.len() == 4 { (a, b, c) } else { (c, b, a) };
    let number = |s: &str| {
        (!s.is_empty() && s.len() <= 4 && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse::<u32>().ok())
            .flatten()
    };
    let month = number(month)
        .or_else(|| {
            let m = month.to_ascii_lowercase();
            (m.len() >= 3)
                .then(|| MONTHS.iter().position(|name| m.starts_with(name)))
                .flatten()
                .map(|i| i as u32 + 1)
        })
        .ok_or_else(bad)?;
    let day = number(day).ok_or_else(bad)?;
    let year = match (year.len(), number(year)) {
        (2, Some(y)) => 2000 + y,
        (4, Some(y)) => y,
        _ => return Err(bad()),
    };
    let iso = format!("{year:04}-{month:02}-{day:02}");
    if is_iso_date(&iso) {
        Ok(iso)
    } else {
        Err(bad())
    }
}

/// OFX's `YYYYMMDD`, with or without a time and zone after it.
pub fn ofx(value: &str) -> Result<String, String> {
    let v = value.trim();
    let iso = v
        .get(..8)
        .filter(|d| d.bytes().all(|b| b.is_ascii_digit()))
        .map(|d| format!("{}-{}-{}", &d[..4], &d[4..6], &d[6..8]));
    match iso {
        Some(iso) if is_iso_date(&iso) => Ok(iso),
        _ => Err(format!("Not a date: {v:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_are_day_first() {
        for v in [
            "03/11/2026",
            "3/11/26",
            "03-11-2026",
            "03.11.2026",
            "3 Nov 2026",
            "03-Nov-26",
            "3 November 2026",
            "3/11'26",
            "2026-11-03",
            "2026/11/03",
            "03/11/2026 14:05",
            "2026-11-03T14:05:00",
        ] {
            assert_eq!(day_first(v).as_deref(), Ok("2026-11-03"), "{v}");
        }
        // Month-first would make this 2 December.
        assert_eq!(day_first("12/02/2026").as_deref(), Ok("2026-02-12"));
    }

    #[test]
    fn impossible_dates_are_refused() {
        for v in [
            "31/02/2026",
            "13/13/2026",
            "29/02/2025",
            "Total",
            "",
            "3/11",
            "3 Smarch 2026",
            "1/1/123",
        ] {
            assert!(day_first(v).is_err(), "{v}");
        }
        assert_eq!(day_first("29/02/2028").as_deref(), Ok("2028-02-29"));
    }

    #[test]
    fn ofx_dates() {
        assert_eq!(ofx("20261103").as_deref(), Ok("2026-11-03"));
        assert_eq!(ofx("20261103120000[0:GMT]").as_deref(), Ok("2026-11-03"));
        assert!(ofx("2026113").is_err());
        assert!(ofx("20261131").is_err());
    }
}
