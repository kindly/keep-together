//! Emailed links: password reset and invites. Tokens travel in request
//! bodies (the SPA reads them from the link's `#fragment`), never in a
//! URL the server logs.

use auth::accounts;
use auth::limits::allow;
use auth::notices::Notice;
use auth::{failures, secret, sessions};
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use comms::mail::Mail;
use platform::members;
use serde::{Deserialize, Serialize};
use store::{Role, UserId};
use ts_rs::TS;

use super::flows::{code_mail, start_partial, user_agent, user_password_limits, verify_password};
use super::{ClientIp, Revoked, session_token, users, with_session};
use crate::error::{ApiError, Body};
use crate::{AppState, RoleName, blocking};

fn link_expired() -> ApiError {
    ApiError::Rejected {
        reason: "link_expired".into(),
        message: "This link has expired or was already used. Ask for a new one.".into(),
    }
}

fn link_limit(state: &AppState, ip: &str) -> Result<(), ApiError> {
    if allow(&state.auth.limits.links_ip, ip) {
        Ok(())
    } else {
        Err(ApiError::RateLimited)
    }
}

fn password_problem(state: &AppState, p: &str) -> Result<(), ApiError> {
    match state.auth.password_problem(p) {
        Some(message) => Err(ApiError::Invalid {
            problems: vec![contracts::Problem::new("password", message)],
        }),
        None => Ok(()),
    }
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct ResetRequest {
    pub email: String,
}

/// `POST /api/auth/reset/request {email}` → `{ok: true}` whatever the
/// address: a known one with a password gets a link (15 minutes, single
/// use), an unknown one gets nothing, and the answer can't tell them
/// apart: the lookup, the link and the mail all happen after the response
/// (S1 codex C7), and an address that can't be one is answered without
/// becoming a limiter key (C6). With mail off for the address typed
/// (`KEEP_MAIL=off`, or not in `KEEP_MAIL_ONLY_TO`): `mail_off`, before
/// any lookup, so it says nothing about which accounts exist.
pub async fn reset_request(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Body(req): Body<ResetRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    link_limit(&state, &ip)?;
    state.auth.require_mail(&req.email)?;
    let ok = Json(serde_json::json!({ "ok": true }));
    let Some(email) = users::normalise_email(&req.email) else {
        return Ok(ok);
    };
    if !allow(&state.auth.limits.email, &email) {
        return Err(ApiError::RateLimited);
    }
    tokio::spawn(async move {
        let st = state.clone();
        let to = email.clone();
        let token = blocking(move || {
            let now = contracts::now_ms();
            st.store.platform().with_write(|tx| {
                let Some(user) = users::by_email(tx, &to)? else {
                    return Ok::<_, ApiError>(None);
                };
                if accounts::credentials(tx, user)?.is_none() {
                    return Ok(None);
                }
                accounts::log(tx, now, "reset_requested", Some(user), "self", None, "")?;
                Ok(Some(accounts::create_reset(tx, user, now)?))
            })
        })
        .await;
        match token {
            Ok(Some(token)) => {
                let origin = &state.auth.config.app_origin;
                state.auth.send(Mail {
                    to: email,
                    subject: "Reset your keep-together password".into(),
                    text: format!(
                        "Someone asked to reset the password for this address.\n\nSet a new one here (the link works once, for 15 minutes):\n{origin}/reset#{token}\n\nIf it wasn't you, ignore this email: your password hasn't changed.\n"
                    ),
                });
            }
            Ok(None) => {}
            Err(e) => eprintln!("reset request: {e:?}"),
        }
    });
    Ok(ok)
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct LinkToken {
    pub token: String,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct LinkValid {
    pub valid: bool,
}

/// `POST /api/auth/reset/check {token}` → `{valid}`, without spending it.
pub async fn reset_check(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Body(req): Body<LinkToken>,
) -> Result<Json<LinkValid>, ApiError> {
    link_limit(&state, &ip)?;
    let st = state.clone();
    let valid = blocking(move || {
        st.store
            .platform()
            .with_read(|c| accounts::reset_user(c, &req.token, contracts::now_ms()))
    })
    .await?
    .is_some();
    Ok(Json(LinkValid { valid }))
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct ResetComplete {
    pub token: String,
    pub password: String,
}

/// `POST /api/auth/reset/complete {token, password}`: the new password is
/// set, every link and every session of the user ends (signed out
/// everywhere), and a second-factor lock is lifted. The second factor is
/// kept: sign in as usual. The user is emailed a notice.
pub async fn reset_complete(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Body(req): Body<ResetComplete>,
) -> Result<Json<serde_json::Value>, ApiError> {
    link_limit(&state, &ip)?;
    password_problem(&state, &req.password)?;
    let st = state.clone();
    let (user, email) = blocking(move || {
        let now = contracts::now_ms();
        st.store.platform().with_write(|tx| {
            let user = accounts::redeem_reset(tx, &req.token, now)?.ok_or_else(link_expired)?;
            accounts::set_password(tx, user, &req.password, now).map_err(ApiError::internal)?;
            sessions::revoke_user(tx, user)?;
            failures::clear(tx, user)?;
            accounts::log(tx, now, "password_reset", Some(user), "self", None, "")?;
            let email: String =
                tx.query_row("SELECT email FROM users WHERE id = ?1", [user], |r| {
                    r.get(0)
                })?;
            Ok::<_, ApiError>((user, email))
        })
    })
    .await?;
    state.auth.revoked(Revoked::User(user));
    state.auth.notify(&email, Notice::PasswordReset);
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InviteInfo {
    pub email: String,
    /// The organisation's name.
    pub group: String,
    pub role: RoleName,
    /// The address already has a password: accept with it.
    pub has_account: bool,
}

struct OpenInvite {
    invite: accounts::Invite,
    slug: String,
    group: String,
    user: Option<i64>,
    has_account: bool,
}

fn open_invite(state: &AppState, token: &str) -> Result<OpenInvite, ApiError> {
    state.store.platform().with_read(|c| {
        let invite =
            accounts::invite_by_token(c, token, contracts::now_ms())?.ok_or_else(link_expired)?;
        let (slug, group): (String, String) = c.query_row(
            "SELECT slug, name FROM tenants WHERE id = ?1",
            [&invite.tenant_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let user = users::by_email(c, &invite.email)?;
        let has_account = match user {
            Some(u) => accounts::credentials(c, u)?.is_some(),
            None => false,
        };
        Ok(OpenInvite {
            invite,
            slug,
            group,
            user,
            has_account,
        })
    })
}

fn role_name(role: &str) -> RoleName {
    store::Role::parse(role)
        .unwrap_or(store::Role::Viewer)
        .into()
}

/// `POST /api/auth/invite/check {token}` → `InviteInfo`, without spending
/// it.
pub async fn invite_check(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Body(req): Body<LinkToken>,
) -> Result<Json<InviteInfo>, ApiError> {
    link_limit(&state, &ip)?;
    let st = state.clone();
    let open = blocking(move || open_invite(&st, &req.token)).await?;
    Ok(Json(InviteInfo {
        role: role_name(&open.invite.role),
        email: open.invite.email,
        group: open.group,
        has_account: open.has_account,
    }))
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct AcceptInvite {
    pub token: String,
    /// A new password, or the existing account's.
    pub password: String,
}

/// `POST /api/auth/invite/accept {token, password}`: the invited address
/// becomes a member with the invited role. New to keep-together: the
/// password is set and the session goes on to enrol a second factor. An
/// existing account: the password must be theirs, and the session goes
/// on to the second factor as in a sign-in. Whether the account exists is
/// decided again inside the write (S1 L2), and an invite can't take away
/// a group's last admin (S1 L8).
pub async fn invite_accept(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    Body(req): Body<AcceptInvite>,
) -> Result<Response, ApiError> {
    link_limit(&state, &ip)?;
    let old = session_token(&headers).map(secret::hash);
    let ua = user_agent(&headers);
    let st = state.clone();
    let (partial, ended) = blocking(move || {
        let now = contracts::now_ms();
        let open = open_invite(&st, &req.token)?;
        let email = open.invite.email.clone();
        let wrong_password = || ApiError::Rejected {
            reason: "invalid_credentials".into(),
            message: "Wrong password for this address.".into(),
        };
        let verified = if open.has_account {
            if let Some(user) = open.user {
                user_password_limits(&st, &ip, user)?;
            }
            match verify_password(&st, &email, &req.password)? {
                Some(v) if Some(v.user) == open.user => Some(v),
                _ => return Err(wrong_password()),
            }
        } else {
            password_problem(&st, &req.password)?;
            None
        };
        let tenant = st
            .store
            .platform()
            .tenant_by_slug(&open.slug)?
            .ok_or_else(link_expired)?;
        let role = Role::parse(&open.invite.role).unwrap_or(Role::Viewer);
        st.store.platform().with_write(|tx| {
            if !accounts::accept_invite(tx, &open.invite.id, now)? {
                return Err(link_expired());
            }
            let user = users::upsert(tx, &email)?;
            // L2: the password was checked (or not) on a read before this
            // transaction; an account that appeared since, or vanished,
            // means that check was of the wrong kind. Nothing is written.
            let has_account = accounts::credentials(tx, user)?.is_some();
            if has_account != open.has_account || open.user.is_some_and(|u| u != user) {
                return Err(ApiError::Rejected {
                    reason: "try_again".into(),
                    message: "This address's account changed while you were accepting. Open the link again.".into(),
                });
            }
            match &verified {
                // C3: the password checked is still the account's.
                Some(v) if !v.still(tx)? => return Err(wrong_password()),
                Some(_) => {}
                None => accounts::set_password(tx, user, &req.password, now)
                    .map_err(ApiError::internal)?,
            }
            // L8: re-inviting a member (the operator's `keep auth invite`)
            // changes their role; the group keeps an admin.
            if members::role_of(tx, UserId(user), &tenant.id)? == Some(Role::Admin)
                && role != Role::Admin
                && members::admin_count(tx, &tenant.id)? <= 1
            {
                return Err(ApiError::Rejected {
                    reason: "last_admin".into(),
                    message: "You're this group's only admin, so this invite can't change your role. Make someone else admin first.".into(),
                });
            }
            members::add_membership(tx, UserId(user), &tenant.id, role)?;
            accounts::log(
                tx,
                now,
                "invite_accepted",
                Some(user),
                "self",
                Some(tenant.id.as_str()),
                role.as_str(),
            )?;
            if let Some(old) = &old {
                sessions::revoke(tx, old)?;
            }
            let partial = start_partial(
                tx,
                &st.auth.keys,
                st.auth.policy,
                user,
                ua.as_deref(),
                false,
                now,
            )?;
            Ok::<_, ApiError>((partial, old.clone()))
        })
    })
    .await?;
    // L6: the browser's previous session's streams close now.
    if let Some(old) = ended {
        state.auth.revoked(Revoked::Session(old));
    }
    if let (Some(code), Some(to)) = (partial.code, partial.state.email.as_deref()) {
        state.auth.send(code_mail(to, &code));
    }
    with_session(
        Json(partial.state).into_response(),
        &headers,
        &partial.token,
        partial.stage,
    )
}
