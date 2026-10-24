//! `/api/t/{slug}/members…`: who belongs to the organisation, and (admins
//! within the step-up window) invite, re-role, remove and reset 2FA. A
//! tenant always keeps at least one admin; the check runs in the same
//! transaction as the change.

use auth::{accounts, sessions};
use axum::extract::Path;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use comms::mail::Mail;
use platform::members;
use serde::{Deserialize, Serialize};
use store::{Role, TenantId, UserId};
use ts_rs::TS;

use super::{Account, Revoked, fresh, users, with_session};
use crate::error::{ApiError, Body};
use crate::{IdParam, RoleName, Tenant, blocking};

pub(super) fn routes() -> Router {
    Router::new()
        .route("/members", get(list))
        .route("/members/invite", post(invite))
        .route("/members/invites/{id}/revoke", post(revoke_invite))
        .route("/members/{id}/role", post(set_role))
        .route("/members/{id}/remove", post(remove))
        .route("/members/{id}/reset-2fa", post(reset_2fa))
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MemberInfo {
    /// The platform user id (the `{id}` in member routes).
    #[ts(type = "number")]
    pub user_id: i64,
    pub email: String,
    pub role: RoleName,
    pub you: bool,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InviteInfoRow {
    pub id: String,
    pub email: String,
    pub role: RoleName,
    #[ts(type = "number")]
    pub expires_at: i64,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MembersPage {
    pub members: Vec<MemberInfo>,
    /// Pending invites (expired ones too, so they can be sent again).
    pub invites: Vec<InviteInfoRow>,
}

fn invite_row(i: accounts::Invite) -> InviteInfoRow {
    InviteInfoRow {
        id: i.id,
        email: i.email,
        role: Role::parse(&i.role).unwrap_or(Role::Viewer).into(),
        expires_at: i.expires_at,
    }
}

/// This request's tenant id (the membership the middleware found).
fn tenant_id(account: &Account, slug: &str) -> Result<TenantId, ApiError> {
    account
        .store
        .platform()
        .member(UserId(account.session.user), slug)?
        .map(|m| m.tenant.id)
        .ok_or(ApiError::Forbidden)
}

/// Admin, and signed in (or stepped up) within the hour.
fn require_admin(t: &Tenant, account: &Account) -> Result<(), ApiError> {
    if t.role < Role::Admin {
        return Err(ApiError::Forbidden);
    }
    if !fresh(account.session(), contracts::now_ms()) {
        return Err(ApiError::StepUpRequired);
    }
    Ok(())
}

/// `GET members` (any member).
async fn list(
    Extension(t): Extension<Tenant>,
    Extension(account): Extension<Account>,
) -> Result<Json<MembersPage>, ApiError> {
    let me = account.session.user;
    let a = account.clone();
    let page = blocking(move || {
        let id = tenant_id(&a, &t.slug)?;
        a.store.platform().with_read(|c| {
            Ok::<_, ApiError>(MembersPage {
                members: members::members(c, &id)?
                    .into_iter()
                    .map(|m| MemberInfo {
                        user_id: m.user.0,
                        email: m.email,
                        role: m.role.into(),
                        you: m.user.0 == me,
                    })
                    .collect(),
                invites: accounts::pending_invites(c, id.as_str())?
                    .into_iter()
                    .map(invite_row)
                    .collect(),
            })
        })
    })
    .await?;
    Ok(Json(page))
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct InviteRequest {
    pub email: String,
    pub role: RoleName,
}

/// `POST members/invite {email, role}` (admin, step-up) → the pending
/// invite; the link goes by email (7 days, single use). Inviting again
/// replaces the earlier link.
async fn invite(
    Extension(t): Extension<Tenant>,
    Extension(account): Extension<Account>,
    Body(req): Body<InviteRequest>,
) -> Result<Json<InviteInfoRow>, ApiError> {
    require_admin(&t, &account)?;
    let email = users::normalise_email(&req.email).ok_or_else(|| ApiError::Invalid {
        problems: vec![contracts::Problem::new("email", "an email address")],
    })?;
    let role = Role::from(req.role);
    let a = account.clone();
    let slug = t.slug.clone();
    let (row, token) = blocking(move || {
        let id = tenant_id(&a, &slug)?;
        let now = contracts::now_ms();
        a.store.platform().with_write(|tx| {
            still_admin(tx, &a, &id, now)?;
            if let Some(user) = users::by_email(tx, &email)?
                && members::role_of(tx, UserId(user), &id)?.is_some()
            {
                return Err(ApiError::Rejected {
                    reason: "already_member".into(),
                    message: "That address is already a member.".into(),
                });
            }
            let actor = a.session.user;
            let (invite, token) =
                accounts::create_invite(tx, id.as_str(), &email, role.as_str(), Some(actor), now)?;
            accounts::log(
                tx,
                now,
                "invited",
                None,
                &actor.to_string(),
                Some(id.as_str()),
                &format!("{email} as {}", role.as_str()),
            )?;
            Ok((invite, token))
        })
    })
    .await?;
    let origin = &account.runtime.config.app_origin;
    account.runtime.send(Mail {
        to: row.email.clone(),
        subject: format!("You're invited to {} on keep-together", t.name),
        text: format!(
            "{} invited you to join {} on keep-together as {}.\n\nAccept here (the link works once, for 7 days):\n{origin}/invite#{token}\n\nIf you weren't expecting this, ignore this email.\n",
            account.session.email,
            t.name,
            row.role
        ),
    });
    Ok(Json(invite_row(row)))
}

/// `POST members/invites/{id}/revoke` (admin, step-up).
async fn revoke_invite(
    Extension(t): Extension<Tenant>,
    Extension(account): Extension<Account>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&t, &account)?;
    let a = account.clone();
    blocking(move || {
        let tenant = tenant_id(&a, &t.slug)?;
        let now = contracts::now_ms();
        a.store.platform().with_write(|tx| {
            still_admin(tx, &a, &tenant, now)?;
            if !accounts::revoke_invite(tx, tenant.as_str(), &id, now)? {
                return Err(ApiError::NotFound);
            }
            accounts::log(
                tx,
                now,
                "invite_revoked",
                None,
                &a.session.user.to_string(),
                Some(tenant.as_str()),
                &id,
            )?;
            Ok(())
        })
    })
    .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Inside the write transaction: the actor is still signed in and still
/// an admin here. The middleware's read may be stale (removed, demoted or
/// signed out by someone else while this request was on its way).
fn still_admin(
    tx: &rusqlite::Connection,
    a: &Account,
    tenant: &TenantId,
    now: i64,
) -> Result<(), ApiError> {
    sessions::by_id(tx, &a.session.id, now)?.ok_or(ApiError::Unauthenticated)?;
    if members::role_of(tx, UserId(a.session.user), tenant)? != Some(Role::Admin) {
        return Err(ApiError::Forbidden);
    }
    Ok(())
}

fn user_param(id: &str) -> Result<i64, ApiError> {
    id.parse().map_err(|_| ApiError::NotFound)
}

fn last_admin() -> ApiError {
    ApiError::Rejected {
        reason: "last_admin".into(),
        message: "A group needs at least one admin. Make someone else admin first.".into(),
    }
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct RoleRequest {
    pub role: RoleName,
}

/// `POST members/{id}/role {role}` (admin, step-up). The member's
/// sessions end (they sign in again with the new role); your own role
/// change rotates your session instead.
async fn set_role(
    Extension(t): Extension<Tenant>,
    Extension(account): Extension<Account>,
    Path(IdParam { id }): Path<IdParam>,
    headers: HeaderMap,
    Body(req): Body<RoleRequest>,
) -> Result<Response, ApiError> {
    require_admin(&t, &account)?;
    let target = user_param(&id)?;
    let role = Role::from(req.role);
    let a = account.clone();
    let rotated = blocking(move || {
        let tenant = tenant_id(&a, &t.slug)?;
        let now = contracts::now_ms();
        a.store.platform().with_write(|tx| {
            still_admin(tx, &a, &tenant, now)?;
            let current =
                members::role_of(tx, UserId(target), &tenant)?.ok_or(ApiError::NotFound)?;
            if current == Role::Admin
                && role != Role::Admin
                && members::admin_count(tx, &tenant)? <= 1
            {
                return Err(last_admin());
            }
            members::set_role(tx, UserId(target), &tenant, role)?;
            accounts::log(
                tx,
                now,
                "role_changed",
                Some(target),
                &a.session.user.to_string(),
                Some(tenant.as_str()),
                &format!("{} -> {}", current.as_str(), role.as_str()),
            )?;
            if target == a.session.user {
                Ok(Some(sessions::rotate(tx, &a.session)?))
            } else {
                sessions::revoke_user(tx, target)?;
                Ok(None)
            }
        })
    })
    .await?;
    let res = Json(serde_json::json!({ "ok": true })).into_response();
    match rotated {
        Some(token) => {
            account
                .runtime
                .revoked(Revoked::Session(account.session.id.clone()));
            with_session(res, &headers, &token, auth::Stage::Full)
        }
        None => {
            account.runtime.revoked(Revoked::User(target));
            Ok(res)
        }
    }
}

/// `POST members/{id}/remove` (admin, step-up): the membership ends and
/// every session of that user ends (revoke-all).
async fn remove(
    Extension(t): Extension<Tenant>,
    Extension(account): Extension<Account>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&t, &account)?;
    let target = user_param(&id)?;
    let a = account.clone();
    blocking(move || {
        let tenant = tenant_id(&a, &t.slug)?;
        let now = contracts::now_ms();
        a.store.platform().with_write(|tx| {
            still_admin(tx, &a, &tenant, now)?;
            let current =
                members::role_of(tx, UserId(target), &tenant)?.ok_or(ApiError::NotFound)?;
            if current == Role::Admin && members::admin_count(tx, &tenant)? <= 1 {
                return Err(last_admin());
            }
            members::remove_membership(tx, UserId(target), &tenant)?;
            sessions::revoke_user(tx, target)?;
            accounts::log(
                tx,
                now,
                "member_removed",
                Some(target),
                &a.session.user.to_string(),
                Some(tenant.as_str()),
                current.as_str(),
            )?;
            Ok(())
        })
    })
    .await?;
    account.runtime.revoked(Revoked::User(target));
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// `POST members/{id}/reset-2fa` (admin, step-up): the member's second
/// factor and recovery codes are cleared and their sessions end; their
/// next sign-in enrols again. Refused for someone who also belongs to
/// another organisation: one group's admin can't weaken an account other
/// groups rely on (the operator can, `keep auth reset-2fa`).
async fn reset_2fa(
    Extension(t): Extension<Tenant>,
    Extension(account): Extension<Account>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&t, &account)?;
    let target = user_param(&id)?;
    let a = account.clone();
    blocking(move || {
        let tenant = tenant_id(&a, &t.slug)?;
        let now = contracts::now_ms();
        a.store.platform().with_write(|tx| {
            still_admin(tx, &a, &tenant, now)?;
            members::role_of(tx, UserId(target), &tenant)?.ok_or(ApiError::NotFound)?;
            if users::membership_count(tx, target)? > 1 {
                return Err(ApiError::Rejected {
                    reason: "other_groups".into(),
                    message: "This person belongs to other groups too, so only the operator can reset their 2FA.".into(),
                });
            }
            accounts::clear_second_factor(tx, target, now)?;
            sessions::revoke_user(tx, target)?;
            accounts::log(tx, now, "second_factor_reset", Some(target), &a.session.user.to_string(), Some(tenant.as_str()), "")?;
            Ok(())
        })
    })
    .await?;
    account.runtime.revoked(Revoked::User(target));
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use store::{Store, StoreConfig};

    use super::*;
    use crate::auth::Runtime;

    /// Review F2: the middleware's read of the actor can be stale by the
    /// time a member mutation's transaction runs; the check inside it sees
    /// a demotion or a sign-out that committed in between.
    #[test]
    fn a_member_mutation_rechecks_the_actor_inside_its_transaction() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Arc::new(
            Store::open_with(
                StoreConfig {
                    dir: tmp.path().to_path_buf(),
                    org_migrations: crate::schema::org_migrations(),
                    readers: 1,
                    max_open: 4,
                },
                crate::schema::PLATFORM_SCHEMAS,
            )
            .unwrap(),
        );
        let t = store.create_tenant("alpha", "Alpha").unwrap();
        let p = store.platform();
        let ann = p.upsert_user("ann@alpha.org").unwrap();
        let bob = p.upsert_user("bob@alpha.org").unwrap();
        p.set_membership(ann, &t.id, Role::Admin).unwrap();
        p.set_membership(bob, &t.id, Role::Admin).unwrap();
        let now = contracts::now_ms();
        let token = p
            .with_write(|tx| sessions::create(tx, ann.0, auth::Stage::Full, now))
            .unwrap();
        let session = p
            .with_read(|c| sessions::get(c, &token, now))
            .unwrap()
            .unwrap();
        let a = Account {
            store: store.clone(),
            runtime: Arc::new(Runtime::default()),
            session,
        };
        let check = || p.with_write(|tx| still_admin(tx, &a, &t.id, now));
        assert!(check().is_ok());
        // Demoted by bob meanwhile.
        p.with_write(|tx| members::set_role(tx, ann, &t.id, Role::Staff))
            .unwrap();
        assert!(matches!(check(), Err(ApiError::Forbidden)));
        // Admin again, but signed out everywhere meanwhile.
        p.with_write(|tx| members::set_role(tx, ann, &t.id, Role::Admin))
            .unwrap();
        p.with_write(|tx| sessions::revoke_user(tx, ann.0)).unwrap();
        assert!(matches!(check(), Err(ApiError::Unauthenticated)));
    }
}
