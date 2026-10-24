//! `keep auth reset-2fa <email> [--reason <text>]`: the operator's 2FA
//! reset (ADR 0020 §3), for someone no admin can reset (a sole admin, or
//! a member of several organisations). Confirm who they are out of band
//! first; the reset is logged in `auth_log` with the reason.

use std::path::Path;

use store::{Store, StoreConfig};

pub fn reset_2fa(data: &Path, email: &str, reason: &str) -> Result<bool, String> {
    let store = Store::open_with(
        StoreConfig {
            dir: data.to_path_buf(),
            org_migrations: api::schema::org_migrations(),
            readers: 1,
            max_open: 1,
        },
        api::schema::PLATFORM_SCHEMAS,
    )
    .map_err(|e| e.to_string())?;
    store
        .platform()
        .with_write(|tx| ::auth::operator_reset_2fa(tx, email, reason, contracts::now_ms()))
        .map_err(|e| e.to_string())
}
