//! `keep dev seed-demo [--slug demo] [--admin-email <email>]`: a demo
//! group for local work (`convex/platform/devSeed.ts` `demoTenant`): made
//! the way `keep tenant create` makes one, plus three contacts with an
//! email each. The admin is `<slug>-admin@example.com` unless given; sign
//! in as them with dev auth. A taken slug is refused, never duplicated.
//!
//! Convex's demo also gives the contacts identifiers under two types; they
//! come with the identifiers port (A1).

use contacts::form::{create, save_form};
use contacts::types::{
    ChannelLabel, CreateContact, Details, EmailRow, Expected, Kind, Methods, SaveForm,
};
use contracts::{ContractError, Source, transact};
use store::Store;

use crate::tenant::{CreateError, Created, create_in};

const PEOPLE: [(&str, &str, &str); 3] = [
    ("Ada", "Lovelace", "ada@example.com"),
    ("Charles", "Babbage", "charles@example.com"),
    ("Mary", "Somerville", "mary@example.com"),
];

pub struct Demo {
    pub created: Created,
    pub contact_ids: Vec<String>,
}

pub fn seed_demo(
    store: &Store,
    slug: &str,
    admin_email: Option<&str>,
) -> Result<Demo, CreateError> {
    let email = admin_email.map_or_else(
        || format!("{slug}-admin@example.com"),
        |e| e.trim().to_owned(),
    );
    let created = create_in(store, slug, &format!("{slug} demo group"), &email)?;
    let db = store.org(&created.tenant.id)?;
    let contact_ids = transact(&db, Some(created.admin.0), |ctx| {
        let mut ids = vec![];
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
            save_form(
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
            )
            .and_then(|r| match r.problems.is_empty() {
                true => Ok(()),
                false => Err(ContractError::invalid(
                    "methods",
                    format!("{:?}", r.problems),
                )),
            })?;
            ids.push(id);
        }
        Ok::<_, CreateError>(ids)
    })?;
    Ok(Demo {
        created,
        contact_ids,
    })
}
