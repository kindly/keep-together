//! `keep dev seed-demo [--slug demo] [--admin-email <email>]`: a demo
//! group for local work (`convex/platform/devSeed.ts` `demoTenant`): made
//! the way `keep tenant create` makes one, plus three contacts with an
//! email each, all in one go (a failure leaves nothing, so it can simply
//! be run again). The admin is `<slug>-admin@example.com` unless given;
//! sign in as them with dev auth. A taken slug is refused, never
//! duplicated. Refused when `KEEP_ENV` is `prod` or `staging`.
//!
//! Convex's demo also gives the contacts identifiers under two types; they
//! come with the identifiers port (A1).
//!
//! `keep dev seed-riverside`: the manual-test world (`seed::riverside`,
//! as staging's reset seed): only with `KEEP_ENV=dev` (credentials made
//! where `KEEP_RIVERSIDE_<ROLE>_{PASSWORD,TOTP}` aren't set) or `staging`
//! (all six required). Re-runnable; prints each user's sign-in.

use contacts::form::{create, save_form};
use contacts::types::{
    ChannelLabel, CreateContact, Details, EmailRow, Expected, Kind, Methods, SaveForm,
};
use contracts::{ContractError, Source};
use store::Store;

use crate::tenant::{CreateError, Created, create_in_with};

const PEOPLE: [(&str, &str, &str); 3] = [
    ("Ada", "Lovelace", "ada@example.com"),
    ("Charles", "Babbage", "charles@example.com"),
    ("Mary", "Somerville", "mary@example.com"),
];

pub struct Demo {
    pub created: Created,
    pub contact_ids: Vec<String>,
}

/// Dev seeds never run on a hosted environment (as `api::reset`).
pub fn dev_only(keep_env: Option<&str>) -> Result<(), CreateError> {
    match keep_env {
        Some(env @ ("prod" | "staging")) => Err(CreateError::NotDev(env.into())),
        _ => Ok(()),
    }
}

pub fn seed_demo(
    store: &Store,
    slug: &str,
    admin_email: Option<&str>,
) -> Result<Demo, CreateError> {
    dev_only(std::env::var("KEEP_ENV").ok().as_deref())?;
    let email = admin_email.map_or_else(
        || format!("{slug}-admin@example.com"),
        |e| e.trim().to_owned(),
    );
    let mut contact_ids = vec![];
    let created = create_in_with(
        store,
        slug,
        &format!("{slug} demo group"),
        &email,
        |ctx, _| {
            for (first, last, address) in PEOPLE {
                let id = create(
                    ctx,
                    CreateContact {
                        id: None,
                        details: Details {
                            client_key: None,
                            kind: Kind::Individual,
                            title: String::new(),
                            first_name: first.into(),
                            last_name: last.into(),
                            nickname: String::new(),
                            name: String::new(),
                            birth_date: None,
                            is_deceased: false,
                            deceased_date: None,
                        },
                    },
                    Source::Seed,
                )?
                .id;
                let saved = save_form(
                    ctx,
                    &id,
                    SaveForm {
                        methods: Some(Expected {
                            expected: 0,
                            slice: Methods {
                                emails: vec![EmailRow {
                                    key: None,
                                    label: ChannelLabel::Home,
                                    address: address.into(),
                                    is_primary: true,
                                }],
                                phones: vec![],
                            },
                        }),
                        ..Default::default()
                    },
                )?;
                if !saved.problems.is_empty() {
                    return Err(
                        ContractError::invalid("methods", format!("{:?}", saved.problems)).into(),
                    );
                }
                contact_ids.push(id);
            }
            Ok(())
        },
    )?;
    Ok(Demo {
        created,
        contact_ids,
    })
}

/// `keep dev seed-riverside` (`api::reset::riverside_with` with the
/// process env).
pub fn seed_riverside(
    store: &Store,
) -> Result<(seed::riverside::Seeded, Vec<seed::riverside::Credential>), seed::riverside::SeedError>
{
    let keep_env = std::env::var("KEEP_ENV").ok();
    api::reset::riverside_with(store, keep_env.as_deref(), |name| std::env::var(name).ok())
}
