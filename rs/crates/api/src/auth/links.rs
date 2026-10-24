//! Emailed links: password reset and invites. Tokens travel in request
//! bodies (the SPA reads them from the link's `#fragment`), never in a
//! URL the server logs.

use auth::accounts::{self, SecondFactor};
use auth::limits::allow;
use auth::{Stage, codes, password, secret, sessions};
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use comms::mail::Mail;
use serde::{Deserialize, Serialize};
use store::UserId;
use ts_rs::TS;

use super::flows::{AuthState, check_password, code_mail, password_limits, state_of};
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

fn password_problem(p: &str) -> Result<(), ApiError> {
    match password::problem(p) {
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
/// apart (the mail goes out in the background).
pub async fn reset_request(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Body(req): Body<ResetRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    link_limit(&state, &ip)?;
    let email =
        users::normalise_email(&req.email).unwrap_or_else(|| req.email.trim().to_lowercase());
    if !allow(&state.auth.limits.email, &email) {
        return Err(ApiError::RateLimited);
    }
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
    .await?;
    if let Some(token) = token {
        let origin = &state.auth.config.app_origin;
        state.auth.send(Mail {
            to: email,
            subject: "Reset your keep-together password".into(),
            text: format!(
                "Someone asked to reset the password for this address.\n\nSet a new one here (the link works once, for 15 minutes):\n{origin}/reset#{token}\n\nIf it wasn't you, ignore this email: your password hasn't changed.\n"
            ),
        });
    }
    Ok(Json(serde_json::json!({ "ok": true })))
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
/// everywhere). The second factor is kept: sign in as usual.
pub async fn reset_complete(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Body(req): Body<ResetComplete>,
) -> Result<Json<serde_json::Value>, ApiError> {
    link_limit(&state, &ip)?;
    password_problem(&req.password)?;
    let st = state.clone();
    let user = blocking(move || {
        let now = contracts::now_ms();
        st.store.platform().with_write(|tx| {
            let user = accounts::redeem_reset(tx, &req.token, now)?.ok_or_else(link_expired)?;
            accounts::set_password(tx, user, &req.password, now).map_err(ApiError::internal)?;
            sessions::revoke_user(tx, user)?;
            accounts::log(tx, now, "password_reset", Some(user), "self", None, "")?;
            Ok::<_, ApiError>(user)
        })
    })
    .await?;
    state.auth.revoked(Revoked::User(user));
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
/// on to the second factor as in a sign-in.
pub async fn invite_accept(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    Body(req): Body<AcceptInvite>,
) -> Result<Response, ApiError> {
    link_limit(&state, &ip)?;
    let old = session_token(&headers).map(secret::hash);
    let st = state.clone();
    let (token, stage, out, code) = blocking(move || {
        let now = contracts::now_ms();
        let open = open_invite(&st, &req.token)?;
        let email = open.invite.email.clone();
        if open.has_account {
            password_limits(&st, &ip, &email)?;
            if check_password(&st, &email, &req.password)? != open.user {
                return Err(ApiError::Rejected {
                    reason: "invalid_credentials".into(),
                    message: "Wrong password for this address.".into(),
                });
            }
        } else {
            password_problem(&req.password)?;
        }
        let tenant = st
            .store
            .platform()
            .tenant_by_slug(&open.slug)?
            .ok_or_else(link_expired)?;
        let role = store::Role::parse(&open.invite.role).unwrap_or(store::Role::Viewer);
        st.store.platform().with_write(|tx| {
            if !accounts::accept_invite(tx, &open.invite.id, now)? {
                return Err(link_expired());
            }
            let user = users::upsert(tx, &email)?;
            if !open.has_account {
                accounts::set_password(tx, user, &req.password, now).map_err(ApiError::internal)?;
            }
            platform::members::add_membership(tx, UserId(user), &tenant.id, role)?;
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
            let factor = accounts::credentials(tx, user)?.and_then(|c| c.second_factor);
            let stage = if factor.is_some() {
                Stage::SecondFactor
            } else {
                Stage::Enrol
            };
            let token = sessions::create(tx, user, stage, now)?;
            let id = secret::hash(&token);
            let code = if factor == Some(SecondFactor::Email) {
                let code = codes::email_code();
                sessions::set_email_code(tx, &id, &code, now)?;
                Some(code)
            } else {
                None
            };
            let s = sessions::by_id(tx, &id, now)?.ok_or(ApiError::Internal)?;
            Ok::<(String, Stage, AuthState, Option<String>), ApiError>((
                token,
                stage,
                state_of(tx, &s)?,
                code,
            ))
        })
    })
    .await?;
    if let (Some(code), Some(to)) = (code, out.email.as_deref()) {
        state.auth.send(code_mail(to, &code));
    }
    with_session(Json(out).into_response(), &headers, &token, stage)
}
