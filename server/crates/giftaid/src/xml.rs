//! The Charities Online claim message: a GovTalk envelope (class
//! `HMRC-CHAR-CLM`) around HMRC's R68 claim (namespace
//! `http://www.govtalk.gov.uk/taxation/charities/r68/2`, the "Charities
//! RIM artefacts version 2.0" schema, `r68-v2-0.xsd`), stamped with its
//! IRmark ([`crate::irmark`]). Generated, never sent: until HMRC
//! recognises the product, a group claims with the schedule spreadsheet,
//! and this XML for HMRC's sample data is the recognition evidence.
//!
//! The message is written the way HMRC's own `GAValidSample.xml` is: the
//! XML declaration, then one line with no whitespace between elements,
//! text escaped as C14N does, so the IRmark is computed over exactly what
//! is sent.

use rusqlite::Connection;

use crate::claim_rules::{OTHER_INFO_MAX, fold, pounds};
use crate::claim_types::{HmrcDetails, Regulator};
use crate::claims::{adjustments, downloadable, lines, summary};
use crate::hmrc::{missing_for_xml, read as read_details};
use crate::irmark::{Irmark, IrmarkError, escape_attribute, escape_text, stamp_irmark};
use contracts::ContractError;

const ENVELOPE_NS: &str = "http://www.govtalk.gov.uk/CM/envelope";
const R68_NS: &str = "http://www.govtalk.gov.uk/taxation/charities/r68/2";

/// The GovTalk header: who sends it, and as what product.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Envelope {
    /// The Government Gateway user id (the group's own, once sending).
    pub sender_id: String,
    pub auth_value: String,
    /// `1` for HMRC's test service.
    pub gateway_test: bool,
    /// `YYYY-MM-DDThh:mm:ss.sss`.
    pub timestamp: String,
    /// HMRC's vendor id for the product (`0000` until recognised).
    pub vendor_id: String,
    pub product: String,
    pub version: String,
    /// IRheader `Sender`: HMRC's sample says `Individual`.
    pub sender: String,
}

impl Envelope {
    /// The envelope for a claim generated here at `at` (ms): no
    /// Government Gateway credentials (never sent), HMRC's test flag on,
    /// vendor `0000` until HMRC recognises the product.
    pub fn generated(at: i64) -> Self {
        Envelope {
            sender_id: String::new(),
            auth_value: String::new(),
            gateway_test: true,
            timestamp: crate::rules::utc_timestamp(at),
            vendor_id: "0000".into(),
            product: "keep-together".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            sender: "Individual".into(),
        }
    }
}

/// Someone's name as HMRC's `r68_NameStructure`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Name {
    pub title: Option<String>,
    pub fore: String,
    pub sur: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Official {
    pub name: Name,
    /// `None`: lives outside the UK (`<Overseas>yes`).
    pub postcode: Option<String>,
    pub phone: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Donation {
    pub donor: Name,
    pub house: String,
    /// `None`: outside the UK (`<Overseas>yes`).
    pub postcode: Option<String>,
    pub date: String,
    pub amount: i64,
}

/// Other income taxed at source (`OtherInc`). keep-together doesn't
/// claim it yet; HMRC's sample has one, so the builder can write it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OtherIncome {
    pub payer: String,
    pub date: String,
    pub gross: i64,
    pub tax: i64,
}

/// One claim (`R68/Claim`) and what its header needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct R68Claim {
    pub hmrc_reference: String,
    pub period_end: String,
    pub official: Official,
    pub org_name: String,
    /// `None`: no `Regulator` element.
    pub regulator: Option<(Regulator, String)>,
    pub donations: Vec<Donation>,
    pub earliest: Option<String>,
    pub other_income: Vec<OtherIncome>,
    /// Tax previously over-claimed, in pence; 0 = none.
    pub adjustment: i64,
    /// Required by HMRC with an adjustment (≤ 350).
    pub other_info: Option<String>,
}

fn el(out: &mut String, name: &str, text: &str) {
    out.push_str(&format!("<{name}>{}</{name}>", escape_text(text)));
}

fn name(out: &mut String, tag: &str, n: &Name) {
    out.push_str(&format!("<{tag}>"));
    if let Some(t) = n.title.as_deref().filter(|t| !t.is_empty()) {
        el(out, "Ttl", t);
    }
    el(out, "Fore", &n.fore);
    el(out, "Sur", &n.sur);
    out.push_str(&format!("</{tag}>"));
}

/// The message, IRmark stamped, and the IRmark.
pub fn claim_message(env: &Envelope, c: &R68Claim) -> Result<(String, Irmark), IrmarkError> {
    let key = format!(
        "<Keys><Key Type=\"CHARID\">{}</Key></Keys>",
        escape_text(&c.hmrc_reference)
    );
    let mut m = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
    m.push_str(&format!(
        "<GovTalkMessage xmlns=\"{}\">",
        escape_attribute(ENVELOPE_NS)
    ));
    el(&mut m, "EnvelopeVersion", "2.0");
    m.push_str("<Header><MessageDetails>");
    el(&mut m, "Class", "HMRC-CHAR-CLM");
    el(&mut m, "Qualifier", "request");
    el(&mut m, "Function", "submit");
    m.push_str("<CorrelationID/>");
    el(&mut m, "Transformation", "XML");
    el(
        &mut m,
        "GatewayTest",
        if env.gateway_test { "1" } else { "0" },
    );
    el(&mut m, "GatewayTimestamp", &env.timestamp);
    m.push_str("</MessageDetails><SenderDetails><IDAuthentication>");
    el(&mut m, "SenderID", &env.sender_id);
    m.push_str("<Authentication>");
    el(&mut m, "Method", "clear");
    el(&mut m, "Role", "principal");
    el(&mut m, "Value", &env.auth_value);
    m.push_str("</Authentication></IDAuthentication></SenderDetails></Header>");
    m.push_str("<GovTalkDetails>");
    m.push_str(&key);
    m.push_str("<TargetDetails><Organisation>HMRC</Organisation></TargetDetails>");
    m.push_str("<ChannelRouting><Channel>");
    el(&mut m, "URI", &env.vendor_id);
    el(&mut m, "Product", &env.product);
    el(&mut m, "Version", &env.version);
    m.push_str("</Channel></ChannelRouting></GovTalkDetails>");

    m.push_str(&format!(
        "<Body><IRenvelope xmlns=\"{}\"><IRheader>",
        escape_attribute(R68_NS)
    ));
    m.push_str(&key);
    el(&mut m, "PeriodEnd", &c.period_end);
    el(&mut m, "DefaultCurrency", "GBP");
    m.push_str("<IRmark Type=\"generic\"></IRmark>");
    el(&mut m, "Sender", &env.sender);
    m.push_str("</IRheader><R68><AuthOfficial>");
    name(&mut m, "OffName", &c.official.name);
    m.push_str("<OffID>");
    match &c.official.postcode {
        Some(p) => el(&mut m, "Postcode", p),
        None => el(&mut m, "Overseas", "yes"),
    }
    m.push_str("</OffID>");
    el(&mut m, "Phone", &c.official.phone);
    m.push_str("</AuthOfficial>");
    el(&mut m, "Declaration", "yes");
    m.push_str("<Claim>");
    el(&mut m, "OrgName", &c.org_name);
    el(&mut m, "HMRCref", &c.hmrc_reference);
    if let Some((regulator, number)) = &c.regulator {
        m.push_str("<Regulator>");
        match regulator {
            Regulator::Ccew => el(&mut m, "RegName", "CCEW"),
            Regulator::Ccni => el(&mut m, "RegName", "CCNI"),
            Regulator::Oscr => el(&mut m, "RegName", "OSCR"),
            Regulator::None => el(&mut m, "NoReg", "yes"),
        }
        if *regulator != Regulator::None && !number.is_empty() {
            el(&mut m, "RegNo", number);
        }
        m.push_str("</Regulator>");
    }
    m.push_str("<Repayment>");
    for d in &c.donations {
        m.push_str("<GAD><Donor>");
        if let Some(t) = d.donor.title.as_deref().filter(|t| !t.is_empty()) {
            el(&mut m, "Ttl", t);
        }
        el(&mut m, "Fore", &d.donor.fore);
        el(&mut m, "Sur", &d.donor.sur);
        el(&mut m, "House", &d.house);
        match &d.postcode {
            Some(p) => el(&mut m, "Postcode", p),
            None => el(&mut m, "Overseas", "yes"),
        }
        m.push_str("</Donor>");
        el(&mut m, "Date", &d.date);
        el(&mut m, "Total", &pounds(d.amount));
        m.push_str("</GAD>");
    }
    if let Some(e) = &c.earliest {
        el(&mut m, "EarliestGAdate", e);
    }
    for o in &c.other_income {
        m.push_str("<OtherInc>");
        el(&mut m, "Payer", &o.payer);
        el(&mut m, "OIDate", &o.date);
        el(&mut m, "Gross", &pounds(o.gross));
        el(&mut m, "Tax", &pounds(o.tax));
        m.push_str("</OtherInc>");
    }
    if c.adjustment > 0 {
        el(&mut m, "Adjustment", &pounds(c.adjustment));
    }
    m.push_str("</Repayment><GASDS>");
    el(&mut m, "ConnectedCharities", "no");
    el(&mut m, "CommBldgs", "no");
    m.push_str("</GASDS>");
    if let Some(info) = c.other_info.as_deref().filter(|i| !i.is_empty()) {
        el(&mut m, "OtherInfo", info);
    }
    m.push_str("</Claim></R68></IRenvelope></Body></GovTalkMessage>");
    stamp_irmark(&m)
}

/// HMRC's `OtherInfo` for a claim with adjustments: how much, for which
/// earlier claims, and why, cut to 350 characters.
fn adjustment_note(total: i64, claims: &[i64], reasons: &[String]) -> String {
    let numbers = claims
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    let mut note = fold(&format!(
        "Adjustment of {} is tax on gifts claimed in our claim {numbers} and voided \
         since: {}",
        pounds(total),
        reasons.join("; ")
    ));
    if note.chars().count() > OTHER_INFO_MAX {
        note = note.chars().take(OTHER_INFO_MAX - 3).collect::<String>() + "...";
    }
    note
}

/// The organisation's name as HMRC's `OrgName` takes it: folded
/// ([`fold`]), starting with a letter or digit, ASCII, at most 160; else
/// refused (`org_name`) for an operator to rename the organisation.
pub fn org_name(name: &str) -> Result<String, ContractError> {
    let n = fold(&name.split_whitespace().collect::<Vec<_>>().join(" "));
    if n.starts_with(|c: char| c.is_ascii_alphanumeric())
        && n.is_ascii()
        && n.chars().count() <= 160
    {
        Ok(n)
    } else {
        Err(ContractError::rejected(
            "org_name",
            format!("HMRC can't take the organisation's name as it is: {name}"),
        ))
    }
}

/// The claim message for a stored claim, ready or later
/// ([`crate::claims::downloadable`]), with the organisation's HMRC
/// details: refused (`missing_hmrc_details`) until they are complete.
/// `org` is the organisation's name ([`org_name`]).
pub fn for_claim(
    conn: &Connection,
    claim_id: &str,
    org: &str,
    env: &Envelope,
) -> Result<(String, Irmark), ContractError> {
    let claim = downloadable(conn, claim_id)?;
    let details: HmrcDetails = read_details(conn)?;
    missing_for_xml(&details)?;
    let adjustments = adjustments(conn, claim_id)?;
    let mut claims: Vec<i64> = Vec::new();
    for a in &adjustments {
        if let Some(c) = summary(conn, &a.original_claim_id)?
            && !claims.contains(&c.number)
        {
            claims.push(c.number);
        }
    }
    let total = claim.totals.adjustment;
    let reasons: Vec<String> = adjustments.iter().map(|a| a.reason.clone()).collect();
    let r68 = R68Claim {
        hmrc_reference: details.hmrc_reference.clone(),
        period_end: claim.period_end.clone(),
        official: Official {
            name: Name {
                title: Some(details.official_title.clone()).filter(|t| !t.is_empty()),
                fore: details.official_first_name.clone(),
                sur: details.official_last_name.clone(),
            },
            postcode: Some(details.official_postcode.clone()),
            phone: details.official_phone.clone(),
        },
        org_name: org_name(org)?,
        regulator: details
            .regulator
            .map(|r| (r, details.regulator_number.clone())),
        donations: lines(conn, claim_id)?
            .into_iter()
            .map(|l| Donation {
                donor: Name {
                    title: Some(l.title).filter(|t| !t.is_empty()),
                    fore: l.first_name,
                    sur: l.last_name,
                },
                house: l.house,
                postcode: (!l.overseas).then_some(l.postcode),
                date: l.received_on,
                amount: l.amount,
            })
            .collect(),
        earliest: Some(claim.earliest_date.clone()),
        other_income: vec![],
        adjustment: total,
        other_info: (total > 0).then(|| adjustment_note(total, &claims, &reasons)),
    };
    claim_message(env, &r68).map_err(|e| ContractError::rejected("xml", e.to_string()))
}

fn person(fore: &str, sur: &str) -> Name {
    Name {
        title: None,
        fore: fore.into(),
        sur: sur.into(),
    }
}

fn gad(
    fore: &str,
    sur: &str,
    house: &str,
    postcode: Option<&str>,
    date: &str,
    amount: i64,
) -> Donation {
    Donation {
        donor: person(fore, sur),
        house: house.into(),
        postcode: postcode.map(Into::into),
        date: date.into(),
        amount,
    }
}

/// HMRC's sample data, as `GAValidSample.xml` (Charities valid
/// samples, gov.uk) carries it: run through [`claim_message`], it is the
/// evidence HMRC's recognition asks for (`keep giftaid-xml --hmrc-sample`).
pub fn hmrc_sample() -> (Envelope, R68Claim) {
    (
        Envelope {
            sender_id: "GIFTAIDCHAR".into(),
            auth_value: "testing2".into(),
            gateway_test: true,
            timestamp: "2014-11-15T10:05:59.005".into(),
            vendor_id: "0000".into(),
            product: "GA Valid Sample".into(),
            version: "1.0".into(),
            sender: "Individual".into(),
        },
        R68Claim {
            hmrc_reference: "AA12345".into(),
            period_end: "2014-10-31".into(),
            official: Official {
                name: person("John", "Smith"),
                postcode: Some("AB12 3CD".into()),
                phone: "01234 567890".into(),
            },
            org_name: "My Organisation".into(),
            regulator: Some((Regulator::Ccew, "A1234".into())),
            donations: vec![
                gad("James", "Bacon", "55", Some("AB23 4CD"), "2014-10-01", 500),
                gad("Mary", "Jones", "12", Some("AB23 9CD"), "2014-10-15", 1000),
                gad(
                    "Bob",
                    "Smith",
                    "1 The Shores, Corfu Town, Corfu, Greece",
                    None,
                    "2014-10-03",
                    250,
                ),
                gad("Jane", "Smith", "1", Some("BA23 9CD"), "2014-10-03", 1200),
            ],
            earliest: Some("2012-10-01".into()),
            other_income: vec![OtherIncome {
                payer: "Peter Other".into(),
                date: "2014-10-31".into(),
                gross: 1312,
                tax: 262,
            }],
            adjustment: 0,
            other_info: None,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = include_str!("../../../../test/fixtures/hmrc/GAValidSample.xml");

    /// The recognition evidence: HMRC's sample data through our builder
    /// is HMRC's valid sample, byte for byte, IRmark included.
    #[test]
    fn hmrcs_sample_data_gives_hmrcs_valid_sample() {
        let (env, claim) = hmrc_sample();
        let (xml, mark) = claim_message(&env, &claim).unwrap();
        assert_eq!(xml, SAMPLE);
        assert_eq!(mark.base64, "nMs6zamBGcmT7n0selJHXuiQUEw=");
    }

    #[test]
    fn titles_no_regulator_adjustments_and_escaping() {
        let (env, mut claim) = hmrc_sample();
        claim.official.name.title = Some("Mrs".into());
        claim.regulator = Some((Regulator::None, String::new()));
        claim.org_name = "Friends & Neighbours <Leeds>".into();
        claim.other_income.clear();
        claim.donations.truncate(1);
        claim.donations[0].donor.title = Some("Dr".into());
        claim.adjustment = 262;
        claim.other_info = Some("Gift voided".into());
        let (xml, _) = claim_message(&env, &claim).unwrap();
        assert!(xml.contains("<OffName><Ttl>Mrs</Ttl><Fore>John</Fore>"));
        assert!(xml.contains("<Regulator><NoReg>yes</NoReg></Regulator>"));
        assert!(xml.contains("<OrgName>Friends &amp; Neighbours &lt;Leeds&gt;</OrgName>"));
        assert!(xml.contains("<Donor><Ttl>Dr</Ttl><Fore>James</Fore>"));
        assert!(xml.contains(
            "<EarliestGAdate>2012-10-01</EarliestGAdate><Adjustment>2.62</Adjustment></Repayment>"
        ));
        assert!(xml.contains("</GASDS><OtherInfo>Gift voided</OtherInfo></Claim>"));
    }

    /// Review L7: the organisation's name folded to HMRC's `OrgName`
    /// pattern, or refused.
    #[test]
    fn org_names_fold_or_are_refused() {
        assert_eq!(org_name("St Mary’s Café").unwrap(), "St Mary's Cafe");
        assert!(org_name("— Friends").is_err());
        assert!(org_name(&"a".repeat(161)).is_err());
    }

    /// Review L7: a generated claim with every shape we write (titles,
    /// NoReg, overseas donors, an adjustment and its OtherInfo, 1,000
    /// lines) is valid against HMRC's r68 schema. Needs `xmllint`; says
    /// so and passes where it isn't installed.
    #[test]
    fn a_generated_claim_is_valid_against_hmrcs_schema() {
        let (env, mut claim) = hmrc_sample();
        claim.official.name.title = Some("Mrs".into());
        claim.regulator = Some((Regulator::None, String::new()));
        claim.other_income.clear();
        let base = claim.donations.clone();
        claim.donations = (0..1000)
            .map(|i| {
                let mut d = base[i % base.len()].clone();
                d.donor.title = (i % 3 == 0).then(|| "Dr".into());
                d
            })
            .collect();
        claim.adjustment = 262;
        claim.other_info = Some(adjustment_note(262, &[1], &["Café refund ’24".into()]));
        let (xml, _) = claim_message(&env, &claim).unwrap();
        let start = xml.find("<IRenvelope").unwrap();
        let end = xml.rfind("</IRenvelope>").unwrap() + "</IRenvelope>".len();
        let dir = tempfile::tempdir().unwrap();
        let body = dir.path().join("body.xml");
        std::fs::write(
            &body,
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>{}",
                &xml[start..end]
            ),
        )
        .unwrap();
        let xsd = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../test/fixtures/hmrc/r68-v2-0.xsd"
        );
        let out = match std::process::Command::new("xmllint")
            .args(["--noout", "--schema", xsd])
            .arg(&body)
            .output()
        {
            Ok(out) => out,
            Err(_) => {
                eprintln!("xmllint not installed: r68 schema check skipped");
                return;
            }
        };
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn the_adjustment_note_fits_hmrcs_limit() {
        let long = vec!["x".repeat(400)];
        let note = adjustment_note(262, &[3, 4], &long);
        assert_eq!(note.chars().count(), OTHER_INFO_MAX);
        assert!(note.ends_with("..."), "ASCII, not …");
        let folded = adjustment_note(262, &[1], &["Café ’refund’".into()]);
        assert!(folded.ends_with("Cafe 'refund'"), "{folded}");
        assert!(note.starts_with("Adjustment of 2.62 is tax on gifts claimed in our claim 3, 4"));
    }
}
