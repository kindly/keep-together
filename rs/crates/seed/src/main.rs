//! `seed`: load the perf generator's contacts (JSONL from
//! `scripts/perf-search10k-rs/export-jsonl.mjs`) into one organisation,
//! in-process, through the same contract functions the API calls: create
//! (details), then the form save (methods, addresses, the "Volunteer
//! status" value), then archive. One transaction per contact, as a user's
//! saves would be. Re-runnable: a contact already made (by clientKey) is
//! skipped.
//!
//!   cargo run --release -p seed -- --data data --slug perf-a --name "Perf A" \
//!     --admin perf-a@example.com --jsonl $TMPDIR/rs10k/a.jsonl --prefix perfa

use std::io::BufRead;
use std::path::PathBuf;
use std::time::Instant;

use api::schema;
use contacts::form::{create, save_form, set_archived};
use contacts::types::{
    AddressRow, Addresses, CreateContact, Details, EmailRow, Expected, FieldOptionPayload,
    FieldPayload, FieldValue, FieldValues, Kind, Methods, PhoneRow, SaveForm,
};
use contracts::{ContractError, Ctx, Exec, Source, execute};
use serde::Deserialize;
use store::{OrgDb, Role, Store, StoreConfig};

/// One line of the JSONL: the generator's person (its acquisition `code`
/// is ignored: source codes aren't in the spike).
#[derive(Deserialize)]
struct Person {
    details: Details,
    emails: Vec<EmailRow>,
    phones: Vec<PhoneRow>,
    addresses: Vec<AddressRow>,
    option: Option<usize>,
    archived: bool,
}

const FIELD: &str = "Volunteer status";
const OPTIONS: [&str; 3] = ["Active", "Lapsed", "Prospect"];

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == &format!("--{name}"))
        .and_then(|i| args.get(i + 1).cloned())
}

fn required(name: &str) -> String {
    arg(name).unwrap_or_else(|| panic!("--{name} is required"))
}

/// The organisation's "Volunteer status" field and its options, made on
/// the first run (for every kind, as the QC fixture's).
fn volunteer_field(db: &OrgDb) -> Result<(String, Vec<String>), ContractError> {
    db.write(|tx| {
        let ctx = Ctx::new(tx, None);
        if let Some(f) = contacts::fields::definitions(tx)?
            .into_iter()
            .find(|f| f.label == FIELD)
        {
            return Ok((f.id, f.options.into_iter().map(|o| o.id).collect()));
        }
        let field = execute(
            &ctx,
            &contacts::fields::FIELD,
            FieldPayload {
                label: FIELD.into(),
                applies_to: Kind::ALL.to_vec(),
                is_active: true,
            },
            Exec::create(Source::Seed),
        )?;
        let mut options = vec![];
        for (position, label) in OPTIONS.iter().enumerate() {
            options.push(
                execute(
                    &ctx,
                    &contacts::fields::FIELD_OPTION,
                    FieldOptionPayload {
                        field_id: field.id.clone(),
                        label: (*label).into(),
                        position: position as u32,
                        is_active: true,
                    },
                    Exec::create(Source::Seed),
                )?
                .id,
            );
        }
        Ok((field.id, options))
    })
}

fn one(
    db: &OrgDb,
    p: Person,
    client_key: String,
    field: &(String, Vec<String>),
) -> Result<bool, ContractError> {
    db.write(|tx| {
        let ctx = Ctx::new(tx, None);
        let details = Details {
            client_key: Some(client_key),
            ..p.details
        };
        let id = match create(&ctx, CreateContact { id: None, details }, Source::Seed) {
            Ok(created) => created.id,
            Err(ContractError::Duplicate { .. }) => return Ok(false),
            Err(e) => return Err(e),
        };
        let values = p
            .option
            .and_then(|o| field.1.get(o))
            .map(|option| FieldValue {
                field_id: field.0.clone(),
                option_id: option.clone(),
            })
            .into_iter()
            .collect();
        let out = save_form(
            &ctx,
            &id,
            SaveForm {
                source: None,
                details: None,
                methods: Some(Expected {
                    expected: 0,
                    slice: Methods {
                        emails: p.emails,
                        phones: p.phones,
                    },
                }),
                addresses: Some(Expected {
                    expected: 0,
                    slice: Addresses {
                        addresses: p.addresses,
                    },
                }),
                fields: Some(Expected {
                    expected: 0,
                    slice: FieldValues { values },
                }),
            },
        )?;
        if !out.problems.is_empty() || !out.stale.is_empty() {
            return Err(ContractError::rejected(
                "seed",
                format!("{:?} {:?}", out.problems, out.stale),
            ));
        }
        if p.archived {
            set_archived(&ctx, &id, 0, true)?;
        }
        Ok(true)
    })
}

fn main() {
    let dir = PathBuf::from(arg("data").unwrap_or_else(|| "data".into()));
    let slug = required("slug");
    let admin = required("admin");
    let jsonl = required("jsonl");
    let prefix = arg("prefix").unwrap_or_else(|| slug.clone());

    let store = Store::open(StoreConfig {
        dir,
        org_migrations: schema::org_migrations(),
        readers: 1,
    })
    .expect("open data dir");
    let tenant = match store.platform().tenant_by_slug(&slug).expect("platform") {
        Some(t) => t,
        None => store
            .create_tenant(&slug, &arg("name").unwrap_or_else(|| slug.clone()))
            .expect("create organisation"),
    };
    let user = store.platform().upsert_user(&admin).expect("user");
    store
        .platform()
        .set_membership(user, &tenant.id, Role::Admin)
        .expect("membership");
    let db = store.org(&tenant.id).expect("org file");
    let field = volunteer_field(&db).expect("field");

    let file = std::fs::File::open(&jsonl).expect("open jsonl");
    let started = Instant::now();
    let (mut made, mut skipped) = (0, 0);
    for (i, line) in std::io::BufReader::new(file).lines().enumerate() {
        let line = line.expect("read jsonl");
        if line.trim().is_empty() {
            continue;
        }
        let person: Person = serde_json::from_str(&line).expect("parse person");
        match one(&db, person, format!("{prefix}-{i}"), &field) {
            Ok(true) => made += 1,
            Ok(false) => skipped += 1,
            Err(e) => panic!("#{i}: {e}"),
        }
        if (made + skipped) % 2000 == 0 {
            eprintln!(
                "{} in {:.1} s",
                made + skipped,
                started.elapsed().as_secs_f64()
            );
        }
    }
    let s = started.elapsed().as_secs_f64();
    println!(
        "{slug}: {made} created, {skipped} already there, {s:.1} s ({:.2} ms a contact)",
        if made > 0 {
            s * 1000.0 / made as f64
        } else {
            0.0
        }
    );
}
