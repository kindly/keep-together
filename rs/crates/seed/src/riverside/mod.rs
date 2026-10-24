//! `riverside`: the manual-test world (Convex `platform/testSeed.ts`),
//! staging's reset seed and `keep dev seed-riverside`. One organisation,
//! one password + TOTP user per membership role, and the 100 donors of
//! [`data`] with their notes, relationships, identifiers, field values
//! and acquisition codes, all through the contracts (source `seed`, as
//! the admin).
//!
//! Only where `KEEP_ENV` is `dev` or `staging`, said explicitly ([`allowed`]):
//! it makes admins with passwords. Credentials come from env
//! ([`credentials_from_env`]): on staging all six must be set (Fly
//! secrets, so an authenticator survives the reset on every deploy);
//! elsewhere a missing one is generated, and the caller prints it.
//!
//! Re-runnable: the users, organisation and memberships are ensured, a
//! changed password or TOTP secret is applied, and the donors are written
//! once (all in one transaction, so donor 0 existing means they all do).

pub mod data;

use contacts::acquisition::{ACQUISITION, Acquisition};
use contacts::fields::{FIELD, FIELD_OPTION};
use contacts::identifiers::{IDENTIFIER_TYPE, IDENTIFIERS, IdentifierRow, IdentifierTypePayload, Identifiers};
use contacts::notes::{NOTE, NOTE_FLAGS, NoteBody, NoteFlags};
use contacts::relationships::{RELATIONSHIP, RelationshipPayload};
use contacts::types::{Archive, FieldOptionPayload, FieldPayload, FieldValue, FieldValues, Kind};
use contacts::{ADDRESSES, ARCHIVE, DETAILS, FIELD_VALUES, METHODS};
use contracts::{CommandGroup, ContractError, Ctx, Exec, Source, command_group, execute, transact};
use rusqlite::{Connection, OptionalExtension};
use store::{Platform, Role, Store, StoreError, Tenant};

use data::{DONOR_COUNT, DonorSpec, World};

pub const SLUG: &str = "riverside";
pub const NAME: &str = "Riverside Community Trust";

/// One sign-in per membership role (Convex `TEST_USERS`).
pub const USERS: [(Role, &str); 3] = [
    (Role::Admin, "admin@keep-together.example"),
    (Role::Staff, "staff@keep-together.example"),
    (Role::Viewer, "viewer@keep-together.example"),
];

/// Donors per command group, as the Convex batches.
const BATCH: usize = 10;

#[derive(Debug, thiserror::Error)]
pub enum SeedError {
    #[error("the riverside seed runs only with KEEP_ENV=dev or KEEP_ENV=staging{}", .0.as_deref().map(|e| format!(" (it is {e:?})")).unwrap_or_default())]
    Disabled(Option<String>),
    #[error("missing riverside credentials: set {}", .0.join(", "))]
    MissingCredentials(Vec<String>),
    #[error("{0}")]
    BadCredential(String),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Contract(#[from] ContractError),
    #[error(transparent)]
    Auth(#[from] auth::AuthError),
}

impl From<rusqlite::Error> for SeedError {
    fn from(e: rusqlite::Error) -> Self {
        SeedError::Store(e.into())
    }
}

/// The seed runs only where `KEEP_ENV` says `dev` or `staging`; unset is
/// refused too (the Convex seed's `TEST_SEED_ENABLED=1` opt-in).
pub fn allowed(keep_env: Option<&str>) -> Result<(), SeedError> {
    match keep_env {
        Some("dev" | "staging") => Ok(()),
        other => Err(SeedError::Disabled(other.map(Into::into))),
    }
}

/// A seeded user's sign-in.
#[derive(Clone, Debug)]
pub struct Credential {
    pub role: Role,
    pub email: &'static str,
    pub password: String,
    /// Base32, as authenticator apps take it.
    pub totp_secret: String,
    /// Made here, not read from env: the caller prints it.
    pub generated: bool,
}

/// The env var holding a role's password (`what` = `PASSWORD`) or TOTP
/// secret (`TOTP`): `KEEP_RIVERSIDE_ADMIN_PASSWORD` …
pub fn env_name(role: Role, what: &str) -> String {
    format!("KEEP_RIVERSIDE_{}_{what}", role.as_str().to_uppercase())
}

/// Every role's credentials from `env`. With `generate`, a missing one is
/// made (a 64-hex password, a new TOTP secret); without, all are needed
/// and a missing one is refused, naming every missing var, before
/// anything is written.
pub fn credentials_from_env(
    env: impl Fn(&str) -> Option<String>,
    generate: bool,
) -> Result<Vec<Credential>, SeedError> {
    let get = |name: &str| env(name).filter(|v| !v.trim().is_empty());
    let mut missing = vec![];
    let mut out = vec![];
    for (role, email) in USERS {
        let (pw_var, totp_var) = (env_name(role, "PASSWORD"), env_name(role, "TOTP"));
        let (password, totp) = (get(&pw_var), get(&totp_var));
        if !generate {
            missing.extend(password.is_none().then(|| pw_var.clone()));
            missing.extend(totp.is_none().then(|| totp_var.clone()));
        }
        let generated = password.is_none() || totp.is_none();
        let password = password.unwrap_or_else(auth::secret::token);
        let totp_secret = totp
            .map(|s| s.trim().to_uppercase())
            .unwrap_or_else(auth::totp::new_secret);
        if let Some(p) = auth::password::problem(&password) {
            return Err(SeedError::BadCredential(format!("{pw_var}: {p}")));
        }
        if auth::totp::code_at(&totp_secret, 0).is_none() {
            return Err(SeedError::BadCredential(format!(
                "{totp_var}: not a base32 TOTP secret"
            )));
        }
        out.push(Credential {
            role,
            email,
            password,
            totp_secret,
            generated,
        });
    }
    if !missing.is_empty() {
        return Err(SeedError::MissingCredentials(missing));
    }
    Ok(out)
}

#[derive(Debug)]
pub struct Seeded {
    pub tenant: Tenant,
    /// The organisation was made by this run.
    pub created: bool,
    pub donors_created: usize,
}

/// Seed riverside into `store` (opened with the api's schemas), running
/// `init` (each crate's `seed_new_org`, `api::schema::seed_new_org`) in
/// the org's transaction first. `credentials` must hold every role.
/// Doesn't check `KEEP_ENV`: callers do ([`allowed`]).
pub fn seed(
    store: &Store,
    credentials: &[Credential],
    init: impl Fn(&Ctx) -> Result<(), ContractError>,
) -> Result<Seeded, SeedError> {
    let missing: Vec<String> = USERS
        .iter()
        .filter(|(role, _)| !credentials.iter().any(|c| c.role == *role))
        .map(|(role, _)| env_name(*role, "PASSWORD"))
        .collect();
    if !missing.is_empty() {
        return Err(SeedError::MissingCredentials(missing));
    }
    let p = store.platform();
    let existing = p.tenant_by_slug(SLUG)?;
    let created = existing.is_none();
    let mut admin = None;
    let mut donors_created = 0;
    let tenant = match existing {
        Some(tenant) => {
            admin = p.with_write(|tx| members(tx, &tenant, credentials))?;
            tenant
        }
        None => store.create_tenant_with(SLUG, NAME, |tx, tenant, db| {
            let a = members(tx, tenant, credentials)?;
            admin = a;
            donors_created = transact(db, a, |ctx| {
                init(ctx)?;
                world(ctx)
            })?;
            Ok::<_, SeedError>(())
        })?,
    };
    if !created {
        let db = store.org(&tenant.id)?;
        donors_created = transact(&db, admin, |ctx| {
            init(ctx)?;
            world(ctx)
        })?;
    }
    Ok(Seeded {
        tenant,
        created,
        donors_created,
    })
}

/// Users, their credentials and memberships, in one platform transaction.
/// A password or TOTP secret already stored is left as it is (an argon2
/// hash is salted, so re-hashing would change it). Returns the admin.
fn members(
    tx: &Connection,
    tenant: &Tenant,
    credentials: &[Credential],
) -> Result<Option<i64>, SeedError> {
    let now = contracts::now_ms();
    let mut admin = None;
    for c in credentials {
        let user = Platform::upsert_user_in(tx, c.email)?;
        let stored = auth::accounts::credentials(tx, user.0)?;
        let same_password = stored
            .as_ref()
            .is_some_and(|s| auth::password::verify(&c.password, &s.password_hash));
        if !same_password {
            auth::accounts::set_password(tx, user.0, &c.password, now)?;
        }
        let same_totp = stored.as_ref().is_some_and(|s| {
            s.second_factor == Some(auth::SecondFactor::Totp)
                && s.totp_secret.as_deref() == Some(c.totp_secret.as_str())
        });
        if !same_totp {
            auth::accounts::set_second_factor(
                tx,
                user.0,
                auth::SecondFactor::Totp,
                Some((&c.totp_secret, 0)),
                now,
            )?;
        }
        platform::members::add_membership(tx, user, &tenant.id, c.role)?;
        if c.role == Role::Admin {
            admin = Some(user.0);
        }
    }
    Ok(admin)
}

fn exec_in<'a>(id: &'a str, group: &'a CommandGroup) -> Exec<'a> {
    Exec::update(id, Some(0), Source::Seed).in_group(group)
}

/// The reference data and the donors, unless donor 0 exists. Returns how
/// many donors it made.
pub fn world(ctx: &Ctx) -> Result<usize, ContractError> {
    let w = data::generate();
    let first: Option<String> = ctx
        .tx
        .read()
        .query_row(
            "SELECT id FROM contacts WHERE client_key = ?1",
            [&w.donors[0].client_key],
            |r| r.get(0),
        )
        .optional()?;
    if first.is_some() {
        return Ok(0);
    }
    let refs = reference_data(ctx)?;
    let extras = data::extras(&w);
    let mut ids: Vec<String> = Vec::with_capacity(DONOR_COUNT);
    for (n, batch) in w.donors.chunks(BATCH).zip(extras.chunks(BATCH)).enumerate() {
        let from = n * BATCH;
        let to = from + batch.0.len() - 1;
        let group = command_group(ctx, &format!("riverside seed: donors {from}–{to}"))?;
        for (d, extra) in batch.0.iter().zip(batch.1) {
            ids.push(donor(ctx, &group, &refs, d, extra)?);
        }
    }
    relationships(ctx, &w, &ids)?;
    Ok(w.donors.len())
}

/// Ids of what the donors point at.
struct Refs {
    /// By [`data::IDENTIFIER_TYPES`] name: active types only (an archived
    /// one's rows are skipped, as the Convex seed's).
    identifier_types: Vec<(&'static str, String)>,
    field: String,
    options: Vec<String>,
    /// (detail, version) → version id.
    codes: Vec<((&'static str, &'static str), String)>,
}

fn reference_data(ctx: &Ctx) -> Result<Refs, ContractError> {
    let group = command_group(ctx, "riverside seed: reference data")?;
    let details: Vec<sources::SeedDetail> = data::SOURCE_DETAILS
        .iter()
        .map(|d| sources::SeedDetail {
            category: d.category.into(),
            name: d.name.into(),
            description: d.description.map(Into::into),
            start_date: d.start_date.map(Into::into),
            end_date: d.end_date.map(Into::into),
            versions: d
                .versions
                .iter()
                .map(|(name, description, start, end)| sources::SeedVersion {
                    name: (*name).into(),
                    description: description.map(Into::into),
                    start_date: start.map(Into::into),
                    end_date: end.map(Into::into),
                })
                .collect(),
            archived: d.archived,
        })
        .collect();
    sources::seed_details(ctx, &details, Some(&group))?;

    let mut identifier_types = vec![];
    for name in data::IDENTIFIER_TYPES {
        let found = contacts::identifiers::identifier_types(ctx.tx.read(), true)?
            .into_iter()
            .find(|t| t.name == name);
        match found {
            Some(t) if t.is_active => identifier_types.push((name, t.id)),
            Some(_) => {}
            None => {
                let made = execute(
                    ctx,
                    &IDENTIFIER_TYPE,
                    IdentifierTypePayload {
                        name: name.into(),
                        is_active: true,
                    },
                    Exec::create(Source::Seed).in_group(&group),
                )?;
                identifier_types.push((name, made.id));
            }
        }
    }

    let existing = contacts::fields::definitions(ctx.tx.read())?
        .into_iter()
        .find(|f| f.label == data::FIELD);
    let (field, options) = match existing {
        Some(f) => (f.id, f.options.into_iter().map(|o| o.id).collect()),
        None => {
            let field = execute(
                ctx,
                &FIELD,
                FieldPayload {
                    label: data::FIELD.into(),
                    applies_to: vec![Kind::Individual],
                    is_active: true,
                },
                Exec::create(Source::Seed).in_group(&group),
            )?
            .id;
            let mut options = vec![];
            for (position, label) in data::FIELD_OPTIONS.iter().enumerate() {
                options.push(
                    execute(
                        ctx,
                        &FIELD_OPTION,
                        FieldOptionPayload {
                            field_id: field.clone(),
                            label: (*label).into(),
                            position: position as u32,
                            is_active: true,
                        },
                        Exec::create(Source::Seed).in_group(&group),
                    )?
                    .id,
                );
            }
            (field, options)
        }
    };

    let mut codes = vec![];
    for code in data::active_codes() {
        let id: Option<String> = ctx
            .tx
            .read()
            .query_row(
                "SELECT v.id FROM source_codes v JOIN source_codes d ON d.id = v.parent_id
                 WHERE d.name = ?1 AND v.name = ?2 AND v.is_active AND d.is_active",
                rusqlite::params![code.0, code.1],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = id {
            codes.push((code, id));
        }
    }
    Ok(Refs {
        identifier_types,
        field,
        options,
        codes,
    })
}

fn donor(
    ctx: &Ctx,
    group: &CommandGroup,
    refs: &Refs,
    d: &DonorSpec,
    extra: &data::Extras,
) -> Result<String, ContractError> {
    let mut details = d.details.clone();
    details.client_key = Some(d.client_key.clone());
    let id = execute(
        ctx,
        &DETAILS,
        details,
        Exec::create(Source::Seed).in_group(group),
    )?
    .id;
    // Child keys are the contracts' to mint (client keys are 32 hex).
    let mut methods = d.methods.clone();
    methods.emails.iter_mut().for_each(|e| e.key = None);
    methods.phones.iter_mut().for_each(|p| p.key = None);
    execute(ctx, &METHODS, methods, exec_in(&id, group))?;
    let mut addresses = d.addresses.clone();
    addresses.addresses.iter_mut().for_each(|a| a.key = None);
    execute(ctx, &ADDRESSES, addresses, exec_in(&id, group))?;

    let rows: Vec<IdentifierRow> = d
        .identifiers
        .iter()
        .filter_map(|x| {
            let (_, type_id) = refs.identifier_types.iter().find(|(n, _)| *n == x.type_name)?;
            Some(IdentifierRow {
                key: None,
                type_id: type_id.clone(),
                value: x.value.clone(),
            })
        })
        .collect();
    if !rows.is_empty() {
        execute(
            ctx,
            &IDENTIFIERS,
            Identifiers { identifiers: rows },
            exec_in(&id, group),
        )?;
    }
    if let Some(option) = extra.volunteer.and_then(|o| refs.options.get(o)) {
        execute(
            ctx,
            &FIELD_VALUES,
            FieldValues {
                values: vec![FieldValue {
                    field_id: refs.field.clone(),
                    option_id: option.clone(),
                }],
            },
            exec_in(&id, group),
        )?;
    }
    if let Some((_, code)) = extra
        .acquisition
        .and_then(|c| refs.codes.iter().find(|(k, _)| *k == c))
    {
        execute(
            ctx,
            &ACQUISITION,
            Acquisition {
                code_id: Some(code.clone()),
            },
            exec_in(&id, group),
        )?;
    }
    if d.archived {
        execute(
            ctx,
            &ARCHIVE,
            Archive { archived: true },
            exec_in(&id, group),
        )?;
    }
    for n in &d.notes {
        let note = execute(
            ctx,
            &NOTE,
            NoteBody {
                contact_id: Some(id.clone()),
                body: n.body.into(),
            },
            Exec::create(Source::Seed).in_group(group),
        )?
        .id;
        if n.pinned || n.archived {
            execute(
                ctx,
                &NOTE_FLAGS,
                NoteFlags {
                    pinned: n.pinned,
                    archived: n.archived,
                },
                exec_in(&note, group),
            )?;
        }
    }
    Ok(id)
}

fn relationships(ctx: &Ctx, w: &World, ids: &[String]) -> Result<(), ContractError> {
    let types = contacts::relationships::relationship_types(ctx.tx.read())?;
    let group = command_group(ctx, "riverside seed: relationships")?;
    for rel in &w.relationships {
        let type_id = types
            .iter()
            .find(|t| t.payload.label_ab == rel.type_label)
            .map(|t| t.id.clone())
            .ok_or_else(|| {
                ContractError::rejected(
                    "seed",
                    format!("no relationship type {:?}", rel.type_label),
                )
            })?;
        execute(
            ctx,
            &RELATIONSHIP,
            RelationshipPayload {
                contact_a: ids[rel.a].clone(),
                contact_b: ids[rel.b].clone(),
                type_id,
                start_date: rel.start_date.clone(),
                end_date: None,
                is_active: true,
                description: rel.description.into(),
            },
            Exec::create(Source::Seed).in_group(&group),
        )?;
    }
    Ok(())
}
