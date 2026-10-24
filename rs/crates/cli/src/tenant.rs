//! `keep tenant create --slug --name --admin-email`: a new organisation in
//! one go. Its `platform.db` row, its migrated file with every crate's
//! reference data (`api::schema::seed_new_org`), and the admin's
//! membership commit together or not at all, with the admin's invite
//! (`auth::operator_invite`: 7 days, single use). `main` sends the invite
//! (`KEEP_MAIL=smtp`) or prints it, link included (`KEEP_MAIL=log`).
//! Links start at `KEEP_APP_ORIGIN` (default `http://localhost:3000`).

use std::path::Path;

use contracts::{ContractError, Ctx, transact};
use store::{Platform, Role, Store, StoreConfig, StoreError, Tenant, UserId};

#[derive(Debug, thiserror::Error)]
pub enum CreateError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("seeding the new organisation: {0}")]
    Seed(#[from] ContractError),
    #[error(transparent)]
    Auth(#[from] auth::AuthError),
    #[error("an admin email address is required")]
    NoEmail,
    #[error("refused when KEEP_ENV={0}: dev only")]
    NotDev(String),
    #[error("the qc- prefix is reserved for the QC seed")]
    ReservedSlug,
}

impl From<rusqlite::Error> for CreateError {
    fn from(e: rusqlite::Error) -> Self {
        CreateError::Store(e.into())
    }
}

/// What `tenant create` made.
#[derive(Debug)]
pub struct Created {
    pub tenant: Tenant,
    pub admin: UserId,
    /// The admin's invite, to send (its text holds the link).
    pub invite: comms::mail::Mail,
}

pub fn open(data: &Path) -> Result<Store, StoreError> {
    Store::open_with(
        StoreConfig {
            dir: data.to_path_buf(),
            org_migrations: api::schema::org_migrations(),
            readers: 1,
            max_open: 1,
        },
        api::schema::PLATFORM_SCHEMAS,
    )
}

/// A new organisation with its reference data and `admin_email` as its
/// admin (a user created if new), then the invite.
pub fn create_in(
    store: &Store,
    slug: &str,
    name: &str,
    admin_email: &str,
) -> Result<Created, CreateError> {
    create_in_with(store, slug, name, admin_email, |_, _| Ok(()))
}

/// [`create_in`], with `then` run in the new file's first transaction
/// after the seeds, as the admin: its writes commit with the organisation
/// or not at all (`keep dev seed-demo`'s contacts).
pub fn create_in_with(
    store: &Store,
    slug: &str,
    name: &str,
    admin_email: &str,
    then: impl FnOnce(&Ctx, UserId) -> Result<(), CreateError>,
) -> Result<Created, CreateError> {
    if api::routes::qc_seed::is_qc_slug(slug) {
        return Err(CreateError::ReservedSlug);
    }
    let email = admin_email.trim();
    if !email.contains('@') {
        return Err(CreateError::NoEmail);
    }
    let mut admin = None;
    let mut invite = None;
    let tenant = store.create_tenant_with(slug, name.trim(), |tx, tenant, db| {
        let user = Platform::upsert_user_in(tx, email)?;
        platform::members::add_membership(tx, user, &tenant.id, Role::Admin)?;
        transact(db, Some(user.0), |ctx| {
            api::schema::seed_new_org(ctx)?;
            then(ctx, user)
        })?;
        invite = Some(auth::operator_invite(
            tx,
            tenant.id.as_str(),
            &tenant.name,
            email,
            Role::Admin.as_str(),
            &app_origin(),
            contracts::now_ms(),
        )?);
        admin = Some(user);
        Ok::<_, CreateError>(())
    })?;
    Ok(Created {
        admin: admin.expect("set by a successful create"),
        invite: invite.expect("set by a successful create"),
        tenant,
    })
}

pub fn create(
    data: &Path,
    slug: &str,
    name: &str,
    admin_email: &str,
) -> Result<Created, CreateError> {
    create_in(&open(data)?, slug, name, admin_email)
}

/// Where links in emails point: `KEEP_APP_ORIGIN`, as the api reads it.
pub fn app_origin() -> String {
    std::env::var("KEEP_APP_ORIGIN")
        .map(|o| o.trim_end_matches('/').to_owned())
        .unwrap_or_else(|_| "http://localhost:3000".into())
}
