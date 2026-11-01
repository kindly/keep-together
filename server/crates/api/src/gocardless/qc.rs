//! What the QC GoCardless surface (`routes::qc_gocardless`, plan
//! gocardless-sandbox-qc.sv, G2) asks of GoCardless: the QC account's
//! token, the donor's side of a billing request through the API, the
//! sandbox's scenario simulators, a trimmed view of a resource, and
//! cleaning up customers.
//!
//! Every call here goes through [`Api::qc_call`]: an `Idempotency-Key`
//! of its own and one retry (same key) on a 5xx, a 429 or a timeout.

use std::collections::BTreeSet;

use reqwest::Method;
use serde_json::{Value, json};

use super::client::{Api, CallError, Secret};

/// The QC account's variables (G1's script stages them on keep-qc).
pub const VARS: [&str; 2] = [
    "KEEP_QC_GOCARDLESS_TOKEN",
    "KEEP_QC_GOCARDLESS_ORGANISATION",
];

/// Customers the QC surface made carry this metadata key (the run's
/// org slug), so the sweep finds them.
pub const TAG: &str = "keep_qc";

/// How old a tagged customer is before any run's cleanup sweeps it.
pub const SWEEP_AFTER_MS: i64 = 2 * 24 * 60 * 60 * 1000;

/// The sandbox's test bank account (docs: test-bank-details).
pub const SORT_CODE: &str = "200000";
pub const ACCOUNT_NUMBER: &str = "55779911";

/// The scenario simulators QC may run, and what each acts on.
pub const SCENARIOS: [(&str, giving::regular::ProviderKind); 7] = {
    use giving::regular::ProviderKind::{Mandate, Payment};
    [
        ("mandate_activated", Mandate),
        ("mandate_failed", Mandate),
        ("payment_confirmed", Payment),
        ("payment_failed", Payment),
        ("payment_charged_back", Payment),
        ("payment_late_failure", Payment),
        ("payment_paid_out", Payment),
    ]
};

/// What `scenario` acts on, if QC may run it.
pub fn scenario(name: &str) -> Option<giving::regular::ProviderKind> {
    SCENARIOS.iter().find(|(n, _)| *n == name).map(|(_, k)| *k)
}

/// The QC GoCardless account: its permanent token (never printed) and
/// organisation id.
pub struct QcAccount {
    token: Secret,
    pub organisation_id: String,
}

impl std::fmt::Debug for QcAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("QcAccount")
            .field("organisation_id", &self.organisation_id)
            .finish_non_exhaustive()
    }
}

impl QcAccount {
    pub fn new(token: &str, organisation_id: &str) -> Self {
        Self {
            token: Secret::new(token),
            organisation_id: organisation_id.to_owned(),
        }
    }

    /// Both variables, or neither (`None`); one alone stops the boot.
    /// Errors name the variable, never its value.
    pub fn from_vars(var: &impl Fn(&str) -> Option<String>) -> Result<Option<Self>, String> {
        let get = |n: &str| {
            var(n)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        match (get(VARS[0]), get(VARS[1])) {
            (None, None) => Ok(None),
            (Some(token), Some(org)) => {
                if !org.starts_with("OR") || !org.bytes().all(|b| b.is_ascii_alphanumeric()) {
                    return Err(format!(
                        "{} must be a GoCardless organisation id (OR…)",
                        VARS[1]
                    ));
                }
                if !token.bytes().all(|b| b.is_ascii_graphic()) {
                    return Err(format!("{} must be printable ASCII", VARS[0]));
                }
                Ok(Some(Self::new(&token, &org)))
            }
            (Some(_), None) => Err(format!("{} needs {}", VARS[0], VARS[1])),
            (None, Some(_)) => Err(format!("{} needs {}", VARS[1], VARS[0])),
        }
    }

    pub(crate) fn token(&self) -> &str {
        self.token.expose()
    }
}

/// The donor, as `sign` fills GoCardless's billing request.
pub struct Payer<'a> {
    pub given_name: &'a str,
    pub family_name: &'a str,
    pub email: &'a str,
    /// The [`TAG`] value: the org's slug.
    pub tag: &'a str,
}

/// The billing request's actions (customer details with a fixed UK
/// address, the sandbox's test bank account, confirm) and fulfil, as a
/// donor's browser would on GoCardless's page. Answers the mandate made.
pub async fn sign(
    api: &Api,
    token: &str,
    billing_request: &str,
    payer: &Payer<'_>,
) -> Result<String, CallError> {
    let action = |name: &'static str, data: Value| {
        let path = ["billing_requests", billing_request, "actions", name];
        async move {
            api.qc_call(
                Method::POST,
                token,
                &path,
                &[],
                Some(json!({ "data": data })),
            )
            .await
        }
    };
    action(
        "collect_customer_details",
        json!({
            "customer": {
                "email": payer.email,
                "given_name": payer.given_name,
                "family_name": payer.family_name,
                "metadata": { TAG: payer.tag }
            },
            "customer_billing_detail": {
                "address_line1": "1 Test Street",
                "city": "London",
                "postal_code": "SW1A 1AA",
                "country_code": "GB"
            }
        }),
    )
    .await?;
    action(
        "collect_bank_account",
        json!({
            "account_holder_name": format!("{} {}", payer.given_name, payer.family_name),
            "account_number": ACCOUNT_NUMBER,
            "branch_code": SORT_CODE,
            "country_code": "GB"
        }),
    )
    .await?;
    action("confirm_payer_details", json!({})).await?;
    let done = action("fulfil", json!({})).await?;
    done.pointer("/billing_requests/links/mandate_request_mandate")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| CallError::Malformed("no mandate in the fulfilled request".into()))
}

/// Run a scenario simulator on `resource`.
pub async fn run_scenario(
    api: &Api,
    token: &str,
    scenario: &str,
    resource: &str,
) -> Result<(), CallError> {
    api.qc_call(
        Method::POST,
        token,
        &["scenario_simulators", scenario, "actions", "run"],
        &[],
        Some(json!({ "data": { "links": { "resource": resource } } })),
    )
    .await
    .map(|_| ())
}

/// Every page of `GET <resources>?<filter>`.
async fn list_all(
    api: &Api,
    token: &str,
    resources: &str,
    filter: &[(&str, &str)],
) -> Result<Vec<Value>, CallError> {
    let mut out = Vec::new();
    let mut after: Option<String> = None;
    loop {
        let mut query: Vec<(&str, &str)> = filter.to_vec();
        query.push(("limit", "500"));
        if let Some(a) = &after {
            query.push(("after", a));
        }
        let v = api
            .qc_call(Method::GET, token, &[resources], &query, None)
            .await?;
        let page = v
            .get(resources)
            .and_then(Value::as_array)
            .ok_or_else(|| CallError::Malformed(format!("no {resources} in the answer")))?;
        out.extend(page.iter().cloned());
        match v.pointer("/meta/cursors/after").and_then(Value::as_str) {
            Some(next) if !page.is_empty() => after = Some(next.to_owned()),
            _ => return Ok(out),
        }
    }
}

async fn get_one(api: &Api, token: &str, resources: &str, id: &str) -> Result<Value, CallError> {
    let v = api
        .qc_call(Method::GET, token, &[resources, id], &[], None)
        .await?;
    v.get(resources)
        .cloned()
        .ok_or_else(|| CallError::Malformed(format!("no {resources} in the answer")))
}

/// What GoCardless says of one resource, trimmed (`peek`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Seen {
    pub id: String,
    pub status: String,
    pub amount: Option<i64>,
    pub charge_date: Option<String>,
    pub next_possible_charge_date: Option<String>,
    /// A subscription's: (charge date, pence).
    pub upcoming: Vec<(String, i64)>,
    /// A mandate's or subscription's payments: id, status, charge date,
    /// pence.
    pub payments: Vec<Seen>,
}

fn text(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned)
}

fn pence(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_str()?.parse().ok())
}

fn seen_payment(p: &Value) -> Seen {
    Seen {
        id: text(p, "id").unwrap_or_default(),
        status: text(p, "status").unwrap_or_default(),
        amount: p.get("amount").and_then(pence),
        charge_date: text(p, "charge_date"),
        ..Seen::default()
    }
}

/// A mandate (with its payments), a subscription (with its upcoming and
/// made payments) or a payment, as GoCardless has it now.
pub async fn peek(
    api: &Api,
    token: &str,
    kind: giving::regular::ProviderKind,
    id: &str,
) -> Result<Seen, CallError> {
    use giving::regular::ProviderKind;
    match kind {
        ProviderKind::Payment => Ok(seen_payment(&get_one(api, token, "payments", id).await?)),
        ProviderKind::Mandate => {
            let m = get_one(api, token, "mandates", id).await?;
            let payments = list_all(api, token, "payments", &[("mandate", id)]).await?;
            Ok(Seen {
                id: text(&m, "id").unwrap_or_default(),
                status: text(&m, "status").unwrap_or_default(),
                next_possible_charge_date: text(&m, "next_possible_charge_date"),
                payments: payments.iter().map(seen_payment).collect(),
                ..Seen::default()
            })
        }
        ProviderKind::Subscription => {
            let s = get_one(api, token, "subscriptions", id).await?;
            let payments = list_all(api, token, "payments", &[("subscription", id)]).await?;
            Ok(Seen {
                id: text(&s, "id").unwrap_or_default(),
                status: text(&s, "status").unwrap_or_default(),
                amount: s.get("amount").and_then(pence),
                upcoming: s
                    .get("upcoming_payments")
                    .and_then(Value::as_array)
                    .map(|list| {
                        list.iter()
                            .filter_map(|u| Some((text(u, "charge_date")?, pence(&u["amount"])?)))
                            .collect()
                    })
                    .unwrap_or_default(),
                payments: payments.iter().map(seen_payment).collect(),
                ..Seen::default()
            })
        }
        ProviderKind::BillingRequest => {
            let b = get_one(api, token, "billing_requests", id).await?;
            Ok(Seen {
                id: text(&b, "id").unwrap_or_default(),
                status: text(&b, "status").unwrap_or_default(),
                ..Seen::default()
            })
        }
    }
}

/// What `cleanup` did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Cleaned {
    /// This org's customers deleted (or gone already).
    pub own: usize,
    /// Older QC-tagged customers swept.
    pub swept: usize,
    /// Customers GoCardless refused to delete (a 4xx), left as they are.
    pub refused: usize,
}

/// Delete one customer: gone already counts as deleted; another refusal
/// is counted, not an error.
async fn delete_customer(
    api: &Api,
    token: &str,
    id: &str,
    out: &mut usize,
    refused: &mut usize,
) -> Result<(), CallError> {
    match api
        .qc_call(Method::DELETE, token, &["customers", id], &[], None)
        .await
    {
        Ok(_) | Err(CallError::Refused { status: 404, .. }) => *out += 1,
        Err(CallError::Refused { status, .. }) if status < 500 => *refused += 1,
        Err(e) => return Err(e),
    }
    Ok(())
}

/// Delete the customers behind `mandates` (this org's), then sweep
/// customers tagged [`TAG`] created before `older_than` (RFC 3339).
pub async fn cleanup(
    api: &Api,
    token: &str,
    mandates: &[String],
    older_than: &str,
) -> Result<Cleaned, CallError> {
    let mut customers = BTreeSet::new();
    for md in mandates {
        match get_one(api, token, "mandates", md).await {
            Ok(m) => {
                if let Some(c) = m.pointer("/links/customer").and_then(Value::as_str) {
                    customers.insert(c.to_owned());
                }
            }
            // Removed with its customer already.
            Err(CallError::Refused { status: 404, .. }) => {}
            Err(e) => return Err(e),
        }
    }
    let mut out = Cleaned::default();
    for c in &customers {
        delete_customer(api, token, c, &mut out.own, &mut out.refused).await?;
    }
    let old = list_all(api, token, "customers", &[("created_at[lt]", older_than)]).await?;
    for c in old {
        let tagged = c.pointer(&format!("/metadata/{TAG}")).is_some();
        if let (true, Some(id)) = (tagged, c.get("id").and_then(Value::as_str))
            && !customers.contains(id)
        {
            delete_customer(api, token, id, &mut out.swept, &mut out.refused).await?;
        }
    }
    Ok(out)
}
