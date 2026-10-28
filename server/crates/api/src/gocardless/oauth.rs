//! `GET /api/gocardless/callback?code&state` (or `?error&state`): where
//! GoCardless sends an admin back after "Connect with GoCardless"
//! (<https://docs.gocardless.com/docs/api-reference/oauth-reference>).
//!
//! The `state` must be one this server issued ([`super::new_state`]) in the
//! last 10 minutes, to this same session and user, and is spent on first
//! sight whatever happens; the user must still be the organisation's
//! admin. Then, one connect at a time: the code is traded for a token,
//! the GoCardless account reserved for this organisation in `platform.db`
//! (the mapping is what "connected" means), and the token sealed into its
//! file. An account another organisation here holds is refused, and the
//! new token (GoCardless disables the old one as it issues it) goes to
//! that holder instead. The browser always lands on the
//! group's settings with `?gocardless=<outcome>`: `connected`, `denied`
//! (the admin said no), `taken`, `failed`, `forbidden`, or, with no group
//! to name, on `/?gocardless=expired`.

use axum::Extension;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Redirect, Response};
use contracts::Source;
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use store::Role;

use super::{ConnectRefused, STATE_TTL_MS, record_connection, restore_connection, take_state};
use crate::timing::Timing;
use crate::{AppState, auth, blocking};

#[derive(Deserialize)]
pub struct Callback {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

fn land(slug: Option<&str>, outcome: &str) -> Response {
    match slug {
        Some(slug) => Redirect::to(&format!("/t/{slug}/settings?gocardless={outcome}")),
        None => Redirect::to(&format!("/?gocardless={outcome}")),
    }
    .into_response()
}

pub async fn callback(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    headers: HeaderMap,
    Query(q): Query<Callback>,
) -> Response {
    let Some(gc) = state.gocardless.clone() else {
        return crate::ApiError::NotFound.into_response();
    };
    let Ok(session) = auth::session(&state, &headers, &timing).await else {
        return land(None, "expired");
    };
    let Some(raw_state) = q.state else {
        return land(None, "expired");
    };
    let store = state.store.clone();
    let Ok(Some(row)) = blocking(move || take_state(&store, &raw_state)).await else {
        return land(None, "expired");
    };
    let now = contracts::now_ms();
    if row.session_id != session.id
        || row.user != session.user
        || now - row.created_at > STATE_TTL_MS
    {
        return land(None, "expired");
    }
    let (store, tenant, user) = (state.store.clone(), row.tenant.clone(), row.user);
    let member: Result<Option<(String, String)>, crate::ApiError> = blocking(move || {
        store.platform().with_read(|c| {
            c.query_row(
                "SELECT t.slug, m.role FROM memberships m JOIN tenants t ON t.id = m.tenant_id
                 WHERE m.user_id = ?1 AND t.id = ?2",
                params![user, tenant.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
        })
    })
    .await;
    let Ok(Some((slug, role))) = member else {
        return land(None, "expired");
    };
    if Role::parse(&role) != Some(Role::Admin) {
        return land(Some(&slug), "forbidden");
    }
    if q.error.is_some() {
        return land(Some(&slug), "denied");
    }
    let Some(code) = q.code.filter(|c| !c.is_empty()) else {
        return land(Some(&slug), "failed");
    };
    // One connect at a time on this server: the code exchange (which
    // disables the account's earlier token at GoCardless), who owns the
    // account, and where its token goes are one step, so the account's
    // holder always ends with its newest token and a refused group with
    // none.
    let _connecting = gc.connecting.lock().await;
    let token = match gc
        .api
        .exchange_code(gc.credentials(), &code, &gc.redirect_uri)
        .await
    {
        Ok(token) => token,
        Err(e) => {
            eprintln!("gocardless connect ({slug}): code exchange failed: {e}");
            return land(Some(&slug), "failed");
        }
    };
    // The account is reserved for this organisation (or found to be
    // another's) in one platform.db transaction, before any token moves.
    let (store, tenant) = (state.store.clone(), row.tenant.clone());
    let organisation = token.organisation_id.clone();
    let reserved =
        blocking(move || record_connection(&store, &tenant, &organisation, user, now)).await;
    let previous = match reserved {
        Ok(Ok(previous)) => previous,
        Ok(Err(ConnectRefused::Taken(holder))) => {
            // The exchange just disabled the holder's token: the new one
            // is the same account's, so it goes to the holder, who keeps
            // working. This group gets nothing.
            let (store, g) = (state.store.clone(), gc.clone());
            let access = token.access_token.clone();
            let h = holder.clone();
            let sealed = blocking(move || {
                let db = store.org(&h)?;
                contracts::transact(&db, None, |ctx| {
                    g.put_token(ctx, &access, Source::System)
                        .map_err(crate::ApiError::from)
                })
            })
            .await;
            match sealed {
                Ok(()) => eprintln!(
                    "gocardless connect: refused {slug} (the account is {holder}'s); \
                     {holder}'s token refreshed from the refused connect"
                ),
                Err(e) => crate::observe::error(&format!(
                    "gocardless connect: refused {slug}; refreshing {holder}'s token failed: {e:?}"
                )),
            }
            return land(Some(&slug), "taken");
        }
        Err(e) => {
            eprintln!("gocardless connect ({slug}): recording the connection: {e:?}");
            return land(Some(&slug), "failed");
        }
    };
    // Then the token into this organisation's file, as the admin; if that
    // fails the reservation is undone.
    let (store, tenant, g) = (state.store.clone(), row.tenant.clone(), gc.clone());
    let access = token.access_token.clone();
    let sealed = blocking(move || {
        let db = store.org(&tenant)?;
        contracts::transact(&db, Some(user), |ctx| {
            g.put_token(ctx, &access, Source::Ui)
                .map_err(crate::ApiError::from)
        })
    })
    .await;
    if let Err(e) = sealed {
        eprintln!("gocardless connect ({slug}): storing the token: {e:?}");
        let (store, tenant) = (state.store.clone(), row.tenant.clone());
        if let Err(e) = blocking(move || restore_connection(&store, &tenant, previous)).await {
            crate::observe::error(&format!(
                "gocardless connect ({slug}): undoing the reservation: {e:?}"
            ));
        }
        return land(Some(&slug), "failed");
    }
    land(Some(&slug), "connected")
}
