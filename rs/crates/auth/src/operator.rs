//! What the operator does from the `keep` CLI, outside any request.

use comms::mail::Mail;
use rusqlite::Connection;

use crate::{AuthError, accounts, sessions, users};

/// `keep auth reset-2fa <email>`: clear the second factor and recovery
/// codes and end every session, logged as the operator's with `reason`.
/// For a sole admin who lost theirs, after confirming who they are out of
/// band (ADR 0020). False if there is no such user. A running server's
/// live streams notice within `api::auth::STREAM_RECHECK`.
pub fn operator_reset_2fa(
    tx: &Connection,
    email: &str,
    reason: &str,
    now: i64,
) -> Result<bool, AuthError> {
    let Some(email) = users::normalise_email(email) else {
        return Ok(false);
    };
    let Some(user) = users::by_email(tx, &email)? else {
        return Ok(false);
    };
    accounts::clear_second_factor(tx, user, now)?;
    sessions::revoke_user(tx, user)?;
    accounts::log(
        tx,
        now,
        "second_factor_reset",
        Some(user),
        "operator",
        None,
        reason,
    )?;
    Ok(true)
}

/// An invite from the operator (`keep tenant create`'s first admin):
/// writes the invite (7 days, single use, logged) and returns the mail to
/// send, whose text holds the link (print it when there's no mailer).
pub fn operator_invite(
    tx: &Connection,
    tenant_id: &str,
    group: &str,
    email: &str,
    role: &str,
    app_origin: &str,
    now: i64,
) -> Result<Mail, AuthError> {
    let email =
        users::normalise_email(email).ok_or_else(|| AuthError::InvalidEmail(email.into()))?;
    let (_, token) = accounts::create_invite(tx, tenant_id, &email, role, None, now)?;
    accounts::log(
        tx,
        now,
        "invited",
        None,
        "operator",
        Some(tenant_id),
        &format!("{email} as {role}"),
    )?;
    Ok(Mail {
        to: email,
        subject: format!("You're invited to {group} on keep-together"),
        text: format!(
            "You're invited to run {group} on keep-together as {role}.\n\nAccept here (the link works once, for 7 days):\n{app_origin}/invite#{token}\n"
        ),
    })
}
