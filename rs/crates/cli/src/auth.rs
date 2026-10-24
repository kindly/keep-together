//! The operator's auth commands (ADR 0020 §3), each logged in `auth_log`
//! as actor `operator`.
//!
//! - `keep auth reset-2fa <email> [--reason <text>]`: for someone no admin
//!   can reset (a sole admin, or a member of several organisations).
//!   Confirm who they are out of band first.
//! - `keep auth invite <slug> <email> [--role …]`: a new invite link, e.g.
//!   for the admin `keep tenant create` made when theirs expired or never
//!   arrived. Unlike an admin's invite it is fine for an existing member
//!   (that admin is one, without credentials yet).

use std::path::Path;

use comms::mail::Mail;
use store::{Role, Store, StoreConfig};

fn open(data: &Path) -> Result<Store, String> {
    Store::open_with(
        StoreConfig {
            dir: data.to_path_buf(),
            org_migrations: api::schema::org_migrations(),
            readers: 1,
            max_open: 1,
        },
        api::schema::PLATFORM_SCHEMAS,
    )
    .map_err(|e| e.to_string())
}

/// A new invite to `slug` for `email` as `role`: the mail to send (its
/// text holds the link, starting at `KEEP_APP_ORIGIN`).
pub fn invite(data: &Path, slug: &str, email: &str, role: &str) -> Result<Mail, String> {
    let role = Role::parse(role).ok_or_else(|| format!("role {role:?}: admin, staff or viewer"))?;
    let store = open(data)?;
    let tenant = store
        .platform()
        .tenant_by_slug(slug)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no organisation {slug}"))?;
    store
        .platform()
        .with_write(|tx| {
            ::auth::operator_invite(
                tx,
                tenant.id.as_str(),
                &tenant.name,
                email,
                role.as_str(),
                &crate::tenant::app_origin(),
                contracts::now_ms(),
            )
        })
        .map_err(|e| e.to_string())
}

pub fn reset_2fa(data: &Path, email: &str, reason: &str) -> Result<bool, String> {
    let store = open(data)?;
    store
        .platform()
        .with_write(|tx| ::auth::operator_reset_2fa(tx, email, reason, contracts::now_ms()))
        .map_err(|e| e.to_string())
}
