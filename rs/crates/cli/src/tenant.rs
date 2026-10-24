//! `keep tenant create --slug --name --admin-email`: a new organisation in
//! one go. Its `platform.db` row, its migrated file with every crate's
//! reference data (`api::schema::seed_new_org`), and the admin's
//! membership commit together or not at all; then the admin is invited.
//! The invite is a stub until auth (A4): it prints what it would email,
//! and the admin signs in with dev auth meanwhile.

use std::path::Path;

use contracts::{ContractError, Ctx, transact};
use store::{Platform, Role, Store, StoreConfig, StoreError, Tenant, UserId};

#[derive(Debug, thiserror::Error)]
pub enum CreateError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("seeding the new organisation: {0}")]
    Seed(#[from] ContractError),
    #[error("an admin email address is required")]
    NoEmail,
    #[error("refused when KEEP_ENV={0}: dev only")]
    NotDev(String),
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
    /// The invite's text (stub: printed, not sent).
    pub invite: String,
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
    let email = admin_email.trim();
    if !email.contains('@') {
        return Err(CreateError::NoEmail);
    }
    let mut admin = None;
    let tenant = store.create_tenant_with(slug, name.trim(), |tx, tenant, db| {
        let user = Platform::upsert_user_in(tx, email)?;
        platform::members::add_membership(tx, user, &tenant.id, Role::Admin)?;
        transact(db, Some(user.0), |ctx| {
            api::schema::seed_new_org(ctx)?;
            then(ctx, user)
        })?;
        admin = Some(user);
        Ok::<_, CreateError>(())
    })?;
    // TODO(A4): replace with auth::operator_invite (the emailed invite).
    let invite = invite_stub(email, &tenant);
    Ok(Created {
        admin: admin.expect("set by a successful create"),
        tenant,
        invite,
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

/// The admin's invitation: until auth (A4) sends it, its text.
fn invite_stub(email: &str, tenant: &Tenant) -> String {
    format!(
        "invite (not sent: email arrives with auth): {email} is the admin of {} ({}); \
         until then sign in with dev auth",
        tenant.name, tenant.slug
    )
}
