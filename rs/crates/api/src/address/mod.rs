//! UK address lookup: a postcode in, the addresses at it out, for the
//! contact form's "Find address" (`factory/plans/address-lookup.sv`, ADR
//! 0014 amendment 2026-10-25). It only fills the form's fields: nothing
//! is stored, cached or logged, postcodes and addresses included (PAF
//! licence terms).
//!
//! Env ([`from_vars`]):
//!
//! | var | |
//! |---|---|
//! | `KEEP_ADDRESS_LOOKUP` | `off` (default: the route is 404 and the SPA hides the control), `fake` ([`fake::Fake`]: fixed addresses, no network), `ideal` ([`ideal::Ideal`]: Ideal Postcodes). Anything else stops the boot; `KEEP_ENV=prod` refuses `fake` |
//! | `KEEP_IDEAL_POSTCODES_KEY` | the platform's key; required for `ideal` (the boot stops without it). Never logged or sent to the browser |
//! | `KEEP_ADDRESS_LOOKUP_CAP` | lookups per organisation per calendar month (UTC), default 100: then `429 lookup_cap` |
//! | `KEEP_ADDRESS_LOOKUP_DAILY_CEILING` | lookups across the whole platform per UTC day, default 2000: then `503 lookup_unavailable` |
//!
//! Usage is counted in `platform.db` ([`SCHEMA`]), not in an org file: it
//! is the platform's spend, not the organisation's data, and the cap has
//! to hold across organisations for the ceiling. A lookup is counted
//! before the provider is called (so two at once can't both take the last
//! one) and given back if the request never reached the provider.

pub mod fake;
pub mod ideal;

use std::sync::Arc;

use futures_util::future::BoxFuture;
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use store::{PlatformSchema, Store, StoreError, TenantId};
use ts_rs::TS;

/// One address at a postcode, as the form's fields take it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct LookupAddress {
    pub line1: String,
    pub line2: String,
    pub line3: String,
    pub town: String,
    pub postcode: String,
}

/// `POST /api/t/{slug}/address-lookup`'s answer.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct AddressLookupResult {
    pub addresses: Vec<LookupAddress>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum LookupError {
    /// No addresses at that postcode.
    NotFound,
    /// The provider is down, slow, out of credit or refusing the key.
    /// The detail is for the server log: never the key, the postcode or
    /// an address.
    Unavailable(String),
    /// This organisation's lookups for the month are used up.
    CapReached,
}

/// A postcode → addresses provider. `postcode` is already
/// [`normalise`]d.
pub trait AddressLookup: Send + Sync {
    fn lookup<'a>(&'a self, postcode: &'a str) -> BoxFuture<'a, Result<Vec<LookupAddress>, Sent>>;
}

/// A provider's failure, and whether the request reached the provider
/// (only those are counted).
#[derive(Debug, PartialEq, Eq)]
pub struct Sent {
    pub error: LookupError,
    pub reached: bool,
}

impl Sent {
    pub fn reached(error: LookupError) -> Self {
        Self {
            error,
            reached: true,
        }
    }
}

/// A UK postcode, trimmed, upper-cased, with one space before the inward
/// code; `None` if it isn't the shape of one (`A9 9AA`, `A99 9AA`,
/// `AA9 9AA`, `AA99 9AA`, `A9A 9AA`, `AA9A 9AA`, and `GIR 0AA`).
pub fn normalise(raw: &str) -> Option<String> {
    let compact: String = raw
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if !compact.is_ascii() || !(5..=7).contains(&compact.len()) {
        return None;
    }
    let (outward, inward) = compact.split_at(compact.len() - 3);
    let shape = |s: &str| -> String {
        s.chars()
            .map(|c| match c {
                'A'..='Z' => 'A',
                '0'..='9' => '9',
                _ => '?',
            })
            .collect()
    };
    let ok = (compact == "GIR0AA")
        || (shape(inward) == "9AA"
            && ["A9", "A99", "AA9", "AA99", "A9A", "AA9A"].contains(&shape(outward).as_str()));
    ok.then(|| format!("{outward} {inward}"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Off,
    Fake,
    Ideal,
}

pub const DEFAULT_CAP: i64 = 100;
pub const DEFAULT_DAILY_CEILING: i64 = 2000;

/// The configured lookup, or `None` when `KEEP_ADDRESS_LOOKUP` is `off`.
/// Refusals name the variable, never the key.
pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> Result<Option<Lookup>, String> {
    let mode = match var("KEEP_ADDRESS_LOOKUP").as_deref() {
        None | Some("off") => Mode::Off,
        Some("fake") => Mode::Fake,
        Some("ideal") => Mode::Ideal,
        Some(other) => {
            return Err(format!(
                "KEEP_ADDRESS_LOOKUP={other:?}: expected off, fake or ideal"
            ));
        }
    };
    let count = |name: &str, default: i64| match var(name) {
        None => Ok(default),
        Some(v) => v
            .parse::<i64>()
            .ok()
            .filter(|n| *n >= 0)
            .ok_or_else(|| format!("{name}={v:?}: expected a whole number, 0 or more")),
    };
    let cap = count("KEEP_ADDRESS_LOOKUP_CAP", DEFAULT_CAP)?;
    let ceiling = count("KEEP_ADDRESS_LOOKUP_DAILY_CEILING", DEFAULT_DAILY_CEILING)?;
    let provider: Arc<dyn AddressLookup> = match mode {
        Mode::Off => return Ok(None),
        Mode::Fake => {
            if var("KEEP_ENV").as_deref() == Some("prod") {
                return Err("KEEP_ADDRESS_LOOKUP=fake is refused with KEEP_ENV=prod".into());
            }
            Arc::new(fake::Fake::default())
        }
        Mode::Ideal => {
            let key = var("KEEP_IDEAL_POSTCODES_KEY")
                .filter(|k| !k.trim().is_empty())
                .ok_or("KEEP_ADDRESS_LOOKUP=ideal needs KEEP_IDEAL_POSTCODES_KEY")?;
            Arc::new(ideal::Ideal::new(key.trim(), ideal::BASE_URL)?)
        }
    };
    Ok(Some(Lookup {
        mode,
        provider,
        cap,
        ceiling,
    }))
}

/// A provider with its limits. `AppState::address`.
#[derive(Clone)]
pub struct Lookup {
    pub mode: Mode,
    provider: Arc<dyn AddressLookup>,
    /// Per organisation per calendar month (UTC).
    pub cap: i64,
    /// Across the platform per UTC day.
    pub ceiling: i64,
}

impl Lookup {
    pub fn new(mode: Mode, provider: Arc<dyn AddressLookup>, cap: i64, ceiling: i64) -> Self {
        Self {
            mode,
            provider,
            cap,
            ceiling,
        }
    }

    /// Look `postcode` (normalised) up for `tenant`: counted against its
    /// month and the platform's day first, given back if the provider was
    /// never reached.
    pub async fn lookup(
        &self,
        store: Arc<Store>,
        tenant: TenantId,
        postcode: &str,
    ) -> Result<Vec<LookupAddress>, LookupError> {
        let now = contracts::now_ms();
        let (cap, ceiling) = (self.cap, self.ceiling);
        let (s, t) = (store.clone(), tenant.clone());
        let reserved = tokio::task::spawn_blocking(move || reserve(&s, &t, now, cap, ceiling))
            .await
            .map_err(|e| LookupError::Unavailable(format!("usage: {e}")))?
            .map_err(|e| LookupError::Unavailable(format!("usage: {e}")))?;
        match reserved {
            Reserve::Taken => {}
            Reserve::Cap => return Err(LookupError::CapReached),
            Reserve::Ceiling => {
                return Err(LookupError::Unavailable(
                    "the platform's daily ceiling is reached".into(),
                ));
            }
        }
        match self.provider.lookup(postcode).await {
            Ok(found) => Ok(found),
            Err(Sent { error, reached }) => {
                if !reached {
                    match tokio::task::spawn_blocking(move || give_back(&store, &tenant, now)).await
                    {
                        Ok(Ok(())) => {}
                        Ok(Err(e)) => eprintln!("address lookup: giving a lookup back: {e}"),
                        Err(e) => eprintln!("address lookup: giving a lookup back: {e}"),
                    }
                }
                Err(error)
            }
        }
    }
}

/// `platform.db`: lookups per organisation per month and per UTC day
/// across the platform. Counts only; never a postcode.
pub const SCHEMA: PlatformSchema = PlatformSchema {
    name: "address_lookup",
    steps: &[
        // 1: the monthly per-organisation count and the daily platform count
        "CREATE TABLE address_lookup_months (
             tenant_id TEXT NOT NULL REFERENCES tenants (id),
             month TEXT NOT NULL,
             used INTEGER NOT NULL,
             PRIMARY KEY (tenant_id, month)
         ) STRICT;
         CREATE TABLE address_lookup_days (
             day TEXT PRIMARY KEY,
             used INTEGER NOT NULL
         ) STRICT;",
    ],
};

#[derive(Debug, PartialEq, Eq)]
pub enum Reserve {
    Taken,
    /// The organisation's month is used up.
    Cap,
    /// The platform's day is used up.
    Ceiling,
}

/// `YYYY-MM` and `YYYY-MM-DD` of `now_ms`, UTC.
fn month_and_day(now_ms: i64) -> (String, String) {
    let at = time::OffsetDateTime::from_unix_timestamp(now_ms.div_euclid(1000))
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    let month = format!("{:04}-{:02}", at.year(), u8::from(at.month()));
    let day = format!("{month}-{:02}", at.day());
    (month, day)
}

/// Take one lookup from `tenant`'s month and the platform's day, in one
/// `platform.db` transaction, unless either is used up.
pub fn reserve(
    store: &Store,
    tenant: &TenantId,
    now_ms: i64,
    cap: i64,
    ceiling: i64,
) -> Result<Reserve, StoreError> {
    let (month, day) = month_and_day(now_ms);
    store.platform().with_write(|tx| {
        let used_month: i64 = tx
            .query_row(
                "SELECT used FROM address_lookup_months WHERE tenant_id = ?1 AND month = ?2",
                params![tenant.as_str(), month],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0);
        if used_month >= cap {
            return Ok(Reserve::Cap);
        }
        let used_day: i64 = tx
            .query_row(
                "SELECT used FROM address_lookup_days WHERE day = ?1",
                [&day],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0);
        if used_day >= ceiling {
            return Ok(Reserve::Ceiling);
        }
        tx.execute(
            "INSERT INTO address_lookup_months (tenant_id, month, used) VALUES (?1, ?2, 1)
             ON CONFLICT (tenant_id, month) DO UPDATE SET used = used + 1",
            params![tenant.as_str(), month],
        )?;
        tx.execute(
            "INSERT INTO address_lookup_days (day, used) VALUES (?1, 1)
             ON CONFLICT (day) DO UPDATE SET used = used + 1",
            [&day],
        )?;
        Ok(Reserve::Taken)
    })
}

/// Undo a [`reserve`] made at `now_ms` whose request never reached the
/// provider.
pub fn give_back(store: &Store, tenant: &TenantId, now_ms: i64) -> Result<(), StoreError> {
    let (month, day) = month_and_day(now_ms);
    store.platform().with_write(|tx| {
        tx.execute(
            "UPDATE address_lookup_months SET used = max(used - 1, 0)
             WHERE tenant_id = ?1 AND month = ?2",
            params![tenant.as_str(), month],
        )?;
        tx.execute(
            "UPDATE address_lookup_days SET used = max(used - 1, 0) WHERE day = ?1",
            [&day],
        )?;
        Ok(())
    })
}

/// `tenant`'s lookups in the month of `now_ms` (tests, operators).
pub fn used_this_month(store: &Store, tenant: &TenantId, now_ms: i64) -> Result<i64, StoreError> {
    let (month, _) = month_and_day(now_ms);
    store.platform().with_read(|c| {
        Ok(c.query_row(
            "SELECT used FROM address_lookup_months WHERE tenant_id = ?1 AND month = ?2",
            params![tenant.as_str(), month],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn postcodes_are_shape_checked_and_normalised() {
        for (raw, want) in [
            ("sw1a 1aa", "SW1A 1AA"),
            ("  SW1A1AA ", "SW1A 1AA"),
            ("m1 1ae", "M1 1AE"),
            ("B33 8TH", "B33 8TH"),
            ("cr2 6xh", "CR2 6XH"),
            ("DN55 1PT", "DN55 1PT"),
            ("W1A 0AX", "W1A 0AX"),
            ("id1 1qd", "ID1 1QD"),
            ("gir 0aa", "GIR 0AA"),
        ] {
            assert_eq!(normalise(raw).as_deref(), Some(want), "{raw}");
        }
        for bad in [
            "",
            "SW1A",
            "12345",
            "SW1A 1A",
            "SW1A 1AAA",
            "1W1A 1AA",
            "SW1A 11A",
            "SW1A-1AA",
            "ŚW1A 1AA",
            "SW1A1AA1",
            "AAAA 1AA",
        ] {
            assert_eq!(normalise(bad), None, "{bad:?}");
        }
    }

    fn vars(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |name| {
            pairs
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone())
        }
    }

    #[test]
    fn boot_reads_the_mode_key_and_limits() {
        assert!(from_vars(vars(&[])).unwrap().is_none());
        assert!(
            from_vars(vars(&[("KEEP_ADDRESS_LOOKUP", "off")]))
                .unwrap()
                .is_none()
        );
        let fake = from_vars(vars(&[("KEEP_ADDRESS_LOOKUP", "fake")]))
            .unwrap()
            .unwrap();
        assert_eq!((fake.mode, fake.cap, fake.ceiling), (Mode::Fake, 100, 2000));
        let ideal = from_vars(vars(&[
            ("KEEP_ADDRESS_LOOKUP", "ideal"),
            ("KEEP_IDEAL_POSTCODES_KEY", "ak_test"),
            ("KEEP_ADDRESS_LOOKUP_CAP", "250"),
            ("KEEP_ADDRESS_LOOKUP_DAILY_CEILING", "0"),
        ]))
        .unwrap()
        .unwrap();
        assert_eq!(
            (ideal.mode, ideal.cap, ideal.ceiling),
            (Mode::Ideal, 250, 0)
        );
    }

    #[test]
    fn boot_refusals_name_the_variable_never_the_key() {
        for (pairs, needle) in [
            (vec![("KEEP_ADDRESS_LOOKUP", "on")], "KEEP_ADDRESS_LOOKUP="),
            (
                vec![("KEEP_ADDRESS_LOOKUP", "Ideal")],
                "KEEP_ADDRESS_LOOKUP=",
            ),
            (
                vec![("KEEP_ADDRESS_LOOKUP", "ideal")],
                "KEEP_IDEAL_POSTCODES_KEY",
            ),
            (
                vec![
                    ("KEEP_ADDRESS_LOOKUP", "ideal"),
                    ("KEEP_IDEAL_POSTCODES_KEY", "  "),
                ],
                "KEEP_IDEAL_POSTCODES_KEY",
            ),
            (
                vec![("KEEP_ADDRESS_LOOKUP", "fake"), ("KEEP_ENV", "prod")],
                "KEEP_ENV=prod",
            ),
            (
                vec![
                    ("KEEP_ADDRESS_LOOKUP", "ideal"),
                    ("KEEP_IDEAL_POSTCODES_KEY", "ak_bad\"key"),
                ],
                "KEEP_IDEAL_POSTCODES_KEY",
            ),
            (
                vec![("KEEP_ADDRESS_LOOKUP_CAP", "-1")],
                "KEEP_ADDRESS_LOOKUP_CAP",
            ),
            (
                vec![("KEEP_ADDRESS_LOOKUP_CAP", "lots")],
                "KEEP_ADDRESS_LOOKUP_CAP",
            ),
            (
                vec![("KEEP_ADDRESS_LOOKUP_DAILY_CEILING", "2k")],
                "KEEP_ADDRESS_LOOKUP_DAILY_CEILING",
            ),
        ] {
            let err = from_vars(vars(&pairs))
                .err()
                .unwrap_or_else(|| panic!("{pairs:?}"));
            assert!(err.contains(needle), "{err}");
        }
        // A key alongside a bad value is never echoed.
        let err = from_vars(vars(&[
            ("KEEP_ADDRESS_LOOKUP", "ideal"),
            ("KEEP_IDEAL_POSTCODES_KEY", "ak_secret123"),
            ("KEEP_ADDRESS_LOOKUP_CAP", "x"),
        ]))
        .err()
        .unwrap();
        assert!(!err.contains("ak_secret123"));
        let err = from_vars(vars(&[
            ("KEEP_ADDRESS_LOOKUP", "ideal"),
            ("KEEP_IDEAL_POSTCODES_KEY", "ak_secret 123"),
        ]))
        .err()
        .unwrap();
        assert!(!err.contains("ak_secret"), "{err}");
    }

    #[test]
    fn months_and_days_are_utc() {
        // 2026-10-31T23:59:59Z and a second later.
        assert_eq!(
            month_and_day(1_793_491_199_000),
            ("2026-10".into(), "2026-10-31".into())
        );
        assert_eq!(
            month_and_day(1_793_491_200_000),
            ("2026-11".into(), "2026-11-01".into())
        );
    }
}
