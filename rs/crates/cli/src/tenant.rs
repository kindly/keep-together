//! `keep tenant create --slug --name --admin-email`: a new organisation (its
//! `platform.db` row and migrated file) with one admin membership. A3 adds
//! each crate's seed and the emailed invite; until then the admin signs in
//! with dev auth.

use std::path::Path;

use store::{Role, Store, StoreConfig, StoreError, Tenant};

pub fn create(
    data: &Path,
    slug: &str,
    name: &str,
    admin_email: &str,
) -> Result<Tenant, StoreError> {
    let store = Store::open(StoreConfig {
        dir: data.to_path_buf(),
        org_migrations: api::schema::org_migrations(),
        readers: 1,
        max_open: 1,
    })?;
    let tenant = store.create_tenant(slug, name)?;
    let user = store.platform().upsert_user(admin_email)?;
    store
        .platform()
        .set_membership(user, &tenant.id, Role::Admin)?;
    Ok(tenant)
}
