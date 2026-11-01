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
//!
//! One exception, never on live (so never in prod: the boot refuses
//! `sandbox` and `fake` there): a `state` of `cli-` and 32 hex is
//! `scripts/fly/gocardless-qc-token.sh`'s, which mints the QC sandbox
//! account's token from a terminal (plan gocardless-sandbox-qc.sv, G1).
//! This server never issued it, so nothing is exchanged or connected:
//! the callback answers a plain page showing `code=…&state=…` for the
//! human to paste back, uncached and never logged. The script checks the
//! state and exchanges the code itself.

use axum::Extension;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{Html, IntoResponse, Redirect, Response};
use contracts::Source;
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use store::Role;

use super::{
    ConnectRefused, STATE_TTL_MS, record_connection, requeue_set_aside, restore_connection,
    take_state,
};
use crate::timing::Timing;
use crate::{AppState, auth, blocking};

#[derive(Deserialize)]
pub struct Callback {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

/// `scripts/fly/gocardless-qc-token.sh`'s state: `cli-` and 32 lower-case
/// hex. Only on the sandbox (and the fake), never live.
fn is_cli_state(mode: super::Mode, state: Option<&str>) -> bool {
    matches!(mode, super::Mode::Sandbox | super::Mode::Fake)
        && state.and_then(|s| s.strip_prefix("cli-")).is_some_and(|h| {
            h.len() == 32 && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        })
}

/// GoCardless's codes and error words: a narrow alphabet, so the page
/// never carries markup and the pasted line parses as a query.
fn plain(v: &Option<String>) -> Option<&str> {
    v.as_deref().filter(|v| {
        !v.is_empty()
            && v.len() <= 512
            && v.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~'))
    })
}

/// The token script's page: what to paste back, or `None` when `q` isn't
/// the script's (the usual callback runs).
fn cli_page(mode: super::Mode, q: &Callback) -> Option<Response> {
    if !is_cli_state(mode, q.state.as_deref()) {
        return None;
    }
    let state = q.state.as_deref().unwrap_or_default();
    let line = match (plain(&q.error), plain(&q.code)) {
        (Some(error), _) => format!("error={error}&state={state}"),
        (None, Some(code)) => format!("code={code}&state={state}"),
        (None, None) => format!("state={state}"),
    };
    let body = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <title>Paste this into the terminal</title></head><body>\
         <h1>Paste this into the terminal</h1>\
         <p>gocardless-qc-token.sh is waiting for this line. Nothing has been \
         connected here.</p>\
         <pre style=\"font-size:1.2em;user-select:all\">{line}</pre></body></html>"
    );
    let mut res = Html(body).into_response();
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'"),
    );
    h.insert("x-robots-tag", HeaderValue::from_static("noindex"));
    Some(res)
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
    if let Some(page) = cli_page(gc.mode, &q) {
        return page;
    }
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
    // No processing run may see the organisation between its reservation
    // and its token (it would read "connected, no token"), nor its
    // set-aside events before they can run: reserve, seal and requeue
    // happen with runs held off.
    let _processing = gc.processing.lock().await;
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
            let account = token.organisation_id.clone();
            let h = holder.clone();
            let sealed = blocking(move || {
                let db = store.org(&h)?;
                contracts::transact(&db, None, |ctx| {
                    g.put_token(ctx, &access, &account, Source::System)
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
    // fails the reservation is undone. The token it replaces, if it was
    // another account's, is kept to revoke.
    let (store, tenant, g) = (state.store.clone(), row.tenant.clone(), gc.clone());
    let access = token.access_token.clone();
    let account = token.organisation_id.clone();
    let sealed = blocking(move || {
        let db = store.org(&tenant)?;
        let old = db.read(|r| g.token(r))?;
        contracts::transact(&db, Some(user), |ctx| {
            g.put_token(ctx, &access, &account, Source::Ui)
                .map_err(crate::ApiError::from)
        })?;
        Ok::<_, crate::ApiError>(old)
    })
    .await;
    if let Err(e) = &sealed {
        eprintln!("gocardless connect ({slug}): storing the token: {e:?}");
        let (store, tenant) = (state.store.clone(), row.tenant.clone());
        if let Err(e) = blocking(move || restore_connection(&store, &tenant, previous)).await {
            crate::observe::error(&format!(
                "gocardless connect ({slug}): undoing the reservation: {e:?}"
            ));
        }
        return land(Some(&slug), "failed");
    }
    // A switch to another account: the old account's token is revoked,
    // not left live at GoCardless.
    if let (Ok(Some(old)), Some(previous)) = (&sealed, &previous)
        && previous.organisation_id != token.organisation_id
        && let Err(e) = gc.api.revoke(gc.credentials(), old).await
    {
        crate::observe::warning(&format!(
            "gocardless connect ({slug}): revoking the previous account's token: {e}"
        ));
    }
    // Only now, with the token in place, do the events kept while it
    // wasn't connected go back in the queue; then a run handles them.
    let (store, tenant) = (state.store.clone(), row.tenant.clone());
    let organisation = token.organisation_id.clone();
    let requeued = blocking(move || {
        store.platform().with_write(|tx| {
            Ok::<_, store::StoreError>(requeue_set_aside(tx, &tenant, &organisation)?)
        })
    })
    .await;
    if let Err(e) = requeued {
        crate::observe::error(&format!(
            "gocardless connect ({slug}): requeueing the events kept while disconnected: {e:?}"
        ));
    }
    drop(_processing);
    super::webhook::spawn_processing(state.store.clone(), gc.clone());
    land(Some(&slug), "connected")
}
