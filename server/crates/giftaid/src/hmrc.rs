//! The charity's HMRC details (`giftaid.hmrcDetails`): its HMRC
//! reference, regulator and number, and the authorised official who
//! signs a claim. One row at most, created by the first save, like the
//! preferences row. Stored as typed (tier 1 is only length); what HMRC's
//! claim schema would refuse is a warning (ADR 0015 tier 2) and, when
//! the claim XML is generated, a refusal ([`missing_for_xml`]).

use contracts::{
    Command, Contract, ContractError, Ctx, Exec, Executed, OrgTx, Source, WriteTx, execute,
};
use rusqlite::{Connection, OptionalExtension, params};

use crate::claim_rules::{NAME_MAX, is_hmrc_reference, title, uk_postcode};
use crate::claim_types::{HmrcDetails, HmrcDetailsView, Regulator};
use crate::types::Warning;

const ENTITY: &str = "gift_aid_hmrc_details";
pub const FIELD_MAX: usize = 200;

fn read_row(conn: &Connection) -> rusqlite::Result<Option<(String, HmrcDetails, i64)>> {
    conn.prepare_cached(
        "SELECT id, hmrc_reference, regulator, regulator_number, official_title,
                official_first_name, official_last_name, official_postcode, official_phone,
                details_version
         FROM gift_aid_hmrc_details",
    )?
    .query_row([], |r| {
        Ok((
            r.get(0)?,
            HmrcDetails {
                hmrc_reference: r.get(1)?,
                regulator: r
                    .get::<_, Option<String>>(2)?
                    .as_deref()
                    .and_then(Regulator::parse),
                regulator_number: r.get(3)?,
                official_title: r.get(4)?,
                official_first_name: r.get(5)?,
                official_last_name: r.get(6)?,
                official_postcode: r.get(7)?,
                official_phone: r.get(8)?,
            },
            r.get(9)?,
        ))
    })
    .optional()
}

/// The details (empty before the first save).
pub fn read(conn: &Connection) -> rusqlite::Result<HmrcDetails> {
    Ok(read_row(conn)?.map(|(_, d, _)| d).unwrap_or_default())
}

/// `GET giftaid/hmrc-details`
pub fn view(conn: &Connection) -> rusqlite::Result<HmrcDetailsView> {
    let row = read_row(conn)?;
    let version = row.as_ref().map(|(_, _, v)| *v);
    let details = row.map(|(_, d, _)| d).unwrap_or_default();
    Ok(HmrcDetailsView {
        warnings: warnings(&details),
        details,
        version,
    })
}

fn warning(anchor: &str, label: &str, message: impl Into<String>) -> Warning {
    Warning {
        anchor: anchor.into(),
        label: label.into(),
        message: message.into(),
    }
}

/// What HMRC's claim schema (r68 v2.0) would refuse, field by field.
pub fn warnings(d: &HmrcDetails) -> Vec<Warning> {
    let mut out = Vec::new();
    if !is_hmrc_reference(&d.hmrc_reference) {
        out.push(warning(
            "hmrcReference",
            "HMRC reference",
            "HMRC's charity reference: one or two capital letters then up to five digits, e.g. AA12345",
        ));
    }
    match d.regulator {
        None => out.push(warning(
            "regulator",
            "Regulator",
            "Choose the charity's regulator, or none",
        )),
        Some(Regulator::None) => {}
        Some(_) if d.regulator_number.is_empty() => out.push(warning(
            "regulatorNumber",
            "Registered number",
            "The charity's number with its regulator",
        )),
        Some(_) => {
            if d.regulator_number.chars().count() > 20
                || !d
                    .regulator_number
                    .starts_with(|c: char| c.is_ascii_alphanumeric())
            {
                out.push(warning(
                    "regulatorNumber",
                    "Registered number",
                    "Up to 20 characters, starting with a letter or digit",
                ));
            }
        }
    }
    if !d.official_title.is_empty() && title(&d.official_title) != d.official_title {
        out.push(warning(
            "officialTitle",
            "Title",
            "Up to 4 letters, e.g. Mrs or Dr",
        ));
    }
    let letters = |v: &str| {
        let mut c = v.chars();
        c.next().is_some_and(|f| f.is_ascii_alphabetic())
            && c.all(|ch| ch.is_ascii_alphabetic() || ch == '\'' || ch == '-')
    };
    if !letters(&d.official_first_name) || d.official_first_name.chars().count() > NAME_MAX {
        out.push(warning(
            "officialFirstName",
            "Official's first name",
            "One name, letters only (' and - allowed), up to 35",
        ));
    }
    let surname_ok = !d.official_last_name.is_empty()
        && d.official_last_name.chars().count() <= NAME_MAX
        && d.official_last_name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || " ,.()/&-'".contains(c));
    if !surname_ok {
        out.push(warning(
            "officialLastName",
            "Official's last name",
            "Up to 35 letters, digits, spaces and , . ( ) / & - '",
        ));
    }
    if uk_postcode(&d.official_postcode).as_deref() != Some(d.official_postcode.as_str()) {
        out.push(warning(
            "officialPostcode",
            "Official's postcode",
            "A UK postcode in capitals with its space, e.g. AB12 3CD",
        ));
    }
    let phone_ok = (1..=30).contains(&d.official_phone.chars().count())
        && d.official_phone
            .chars()
            .all(|c| c.is_ascii_digit() || "()- ".contains(c));
    if !phone_ok {
        out.push(warning(
            "officialPhone",
            "Official's phone",
            "Digits, spaces, brackets and dashes, up to 30",
        ));
    }
    out
}

/// The details the claim XML needs, or `missing_hmrc_details` naming
/// each field HMRC would refuse.
pub fn missing_for_xml(d: &HmrcDetails) -> Result<(), ContractError> {
    let w = warnings(d);
    if w.is_empty() {
        return Ok(());
    }
    Err(ContractError::rejected(
        "missing_hmrc_details",
        format!(
            "Complete the HMRC details in Settings first: {}",
            w.iter()
                .map(|w| w.label.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    ))
}

/// Save the details (the route checks admin). `expected` is the counter
/// as last read, `None` if the caller saw no row (stale if one exists,
/// as the preferences row is).
pub fn save(
    ctx: &Ctx,
    details: HmrcDetails,
    expected: Option<i64>,
    source: Source,
) -> Result<Executed, ContractError> {
    let id = read_row(ctx.tx.read())?.map(|(id, _, _)| id);
    let opts = match (&id, expected) {
        (None, _) => Exec::create(source),
        (Some(id), Some(expected)) => Exec::update(id, Some(expected), source),
        (Some(id), None) => Exec::update(id, Some(-1), source),
    };
    execute(ctx, &HMRC_DETAILS, details, opts)
}

fn tidy(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Whitespace collapsed; the reference and postcode upper-cased; each
/// field at most [`FIELD_MAX`] characters.
fn prepare_details(d: HmrcDetails) -> Result<HmrcDetails, ContractError> {
    let out = HmrcDetails {
        hmrc_reference: tidy(&d.hmrc_reference).replace(' ', "").to_uppercase(),
        regulator: d.regulator,
        regulator_number: tidy(&d.regulator_number),
        official_title: tidy(&d.official_title),
        official_first_name: tidy(&d.official_first_name),
        official_last_name: tidy(&d.official_last_name),
        official_postcode: uk_postcode(&d.official_postcode)
            .unwrap_or_else(|| tidy(&d.official_postcode).to_uppercase()),
        official_phone: tidy(&d.official_phone),
    };
    let mut problems = Vec::new();
    for (field, value) in [
        ("hmrcReference", &out.hmrc_reference),
        ("regulatorNumber", &out.regulator_number),
        ("officialTitle", &out.official_title),
        ("officialFirstName", &out.official_first_name),
        ("officialLastName", &out.official_last_name),
        ("officialPostcode", &out.official_postcode),
        ("officialPhone", &out.official_phone),
    ] {
        if value.chars().count() > FIELD_MAX {
            problems.push(contracts::Problem::new(
                field,
                format!("At most {FIELD_MAX} characters"),
            ));
        }
    }
    if problems.is_empty() {
        Ok(out)
    } else {
        Err(ContractError::Invalid(problems))
    }
}

pub struct HmrcDetailsContract;
pub static HMRC_DETAILS: HmrcDetailsContract = HmrcDetailsContract;

impl Contract for HmrcDetailsContract {
    const NAME: &'static str = "giftaid.hmrcDetails";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = ENTITY;
    const COUNTER: &'static str = "details_version";
    type Payload = HmrcDetails;
    type State = HmrcDetails;

    fn prepare(&self, d: HmrcDetails) -> Result<HmrcDetails, ContractError> {
        prepare_details(d)
    }

    fn load(&self, tx: &OrgTx, _: &str) -> Result<HmrcDetails, ContractError> {
        read_row(tx.read())?
            .map(|(_, d, _)| d)
            .ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        _: Option<&HmrcDetails>,
        p: &HmrcDetails,
        _: &Command,
    ) -> Result<HmrcDetails, ContractError> {
        Ok(p.clone())
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&HmrcDetails>,
        d: &HmrcDetails,
    ) -> Result<(), ContractError> {
        let values = params![
            id,
            d.hmrc_reference,
            d.regulator.map(Regulator::as_str),
            d.regulator_number,
            d.official_title,
            d.official_first_name,
            d.official_last_name,
            d.official_postcode,
            d.official_phone
        ];
        if before.is_none() {
            tx.prepare_cached(
                "INSERT INTO gift_aid_hmrc_details (id, hmrc_reference, regulator,
                     regulator_number, official_title, official_first_name, official_last_name,
                     official_postcode, official_phone)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )?
            .execute(values)?;
        } else {
            tx.prepare_cached(
                "UPDATE gift_aid_hmrc_details SET hmrc_reference = ?2, regulator = ?3,
                     regulator_number = ?4, official_title = ?5, official_first_name = ?6,
                     official_last_name = ?7, official_postcode = ?8, official_phone = ?9
                 WHERE id = ?1",
            )?
            .execute(values)?;
        }
        Ok(())
    }

    fn empty(&self) -> Option<HmrcDetails> {
        Some(HmrcDetails::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn complete() -> HmrcDetails {
        HmrcDetails {
            hmrc_reference: "AA12345".into(),
            regulator: Some(Regulator::Ccew),
            regulator_number: "A1234".into(),
            official_title: String::new(),
            official_first_name: "John".into(),
            official_last_name: "Smith".into(),
            official_postcode: "AB12 3CD".into(),
            official_phone: "01234 567890".into(),
        }
    }

    #[test]
    fn complete_details_have_no_warnings() {
        assert_eq!(warnings(&complete()), vec![]);
        assert!(missing_for_xml(&complete()).is_ok());
    }

    #[test]
    fn each_field_hmrc_would_refuse_warns() {
        let anchors = |d: &HmrcDetails| {
            warnings(d)
                .into_iter()
                .map(|w| w.anchor)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            anchors(&HmrcDetails::default()),
            [
                "hmrcReference",
                "regulator",
                "officialFirstName",
                "officialLastName",
                "officialPostcode",
                "officialPhone"
            ]
        );
        let mut d = complete();
        d.regulator_number.clear();
        d.official_first_name = "Mary Ann".into();
        assert_eq!(anchors(&d), ["regulatorNumber", "officialFirstName"]);
        d = complete();
        d.regulator = Some(Regulator::None);
        d.regulator_number.clear();
        assert_eq!(anchors(&d), Vec::<String>::new());
    }

    #[test]
    fn prepare_tidies() {
        let mut d = complete();
        d.hmrc_reference = " aa 12345 ".into();
        d.official_postcode = "ab123cd".into();
        let out = prepare_details(d).unwrap();
        assert_eq!(out.hmrc_reference, "AA12345");
        assert_eq!(out.official_postcode, "AB12 3CD");
    }
}
