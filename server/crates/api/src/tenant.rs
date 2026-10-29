//! `/api/t/{slug}/…`: session → membership in `platform.db` → the one
//! org file this request may touch.
//!
//! Tenant routes are a stateless `Router`: a handler can't extract the
//! `AppState` (so can't reach the `Store`), only the [`Tenant`] this
//! middleware put in the request, which holds a single `OrgDb`.

use std::sync::Arc;
use std::time::Instant;

use axum::extract::{OriginalUri, Request, State};
use axum::http::Method;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use contracts::Ctx;
use serde::Serialize;
use store::{OrgDb, OrgRead, Role, Store, TenantId, UserId};
use ts_rs::TS;

use crate::error::ApiError;
use crate::timing::Timing;
use crate::{AppState, RoleName, auth, blocking};

/// The organisation a request is scoped to, and who is asking.
#[derive(Clone)]
pub struct Tenant {
    db: Arc<OrgDb>,
    pub slug: String,
    pub name: String,
    pub role: Role,
    /// The platform user id: revisions' `actor`.
    pub user: i64,
    /// When this session last proved password + second factor.
    authenticated_at: i64,
    /// `KEEP_AUTH_POLICY=relaxed`: no step-up.
    no_step_up: bool,
    timing: Timing,
    /// For [`Tenant::run_job`]'s `platform.db` marker only: handlers never
    /// see the store.
    tenant_id: TenantId,
    /// For [`Tenant::write`]'s re-check and `run_job`'s marker (handlers
    /// never see it).
    store: Arc<Store>,
    /// The session's stored hash, for [`Tenant::write`]'s re-check.
    session_id: String,
    /// `KEEP_ADDRESS_LOOKUP`, for [`Tenant::lookup_address`].
    address: Option<Arc<crate::address::Lookup>>,
    /// `KEEP_GOCARDLESS`, for [`Tenant::gocardless`] and the connection.
    gocardless: Option<Arc<crate::gocardless::GoCardless>>,
    /// Scan uploads' cap and disk reserve.
    scan_limits: Arc<crate::scans::limits::ScanLimits>,
}

impl Tenant {
    /// Read one consistent snapshot of this organisation's file.
    pub async fn read<T, F>(&self, f: F) -> Result<T, ApiError>
    where
        T: Send + 'static,
        F: FnOnce(&OrgRead) -> Result<T, ApiError> + Send + 'static,
    {
        let db = self.db.clone();
        let timing = self.timing.clone();
        blocking(move || {
            let start = Instant::now();
            let out = db.read(f);
            timing.add_db(start.elapsed());
            out
        })
        .await
    }

    /// Run commands in one `BEGIN IMMEDIATE` transaction on this
    /// organisation's file, as this user. Needs `staff` or above.
    ///
    /// The session and the role are checked again first, on `platform.db`:
    /// the middleware's check ran before the body arrived, which a client
    /// can delay at will, and a sign-out, removal or demotion in between
    /// must stop the write (S1 codex C5). What remains is the moment
    /// between this check and the org file's transaction (two files).
    pub async fn write<T, F>(&self, f: F) -> Result<T, ApiError>
    where
        T: Send + 'static,
        F: FnOnce(&Ctx) -> Result<T, ApiError> + Send + 'static,
    {
        if self.role < Role::Staff {
            return Err(ApiError::Forbidden);
        }
        let db = self.db.clone();
        let timing = self.timing.clone();
        let user = self.user;
        let check = self.recheck();
        blocking(move || {
            let start = Instant::now();
            check()?;
            timing.add_platform(start.elapsed());
            let start = Instant::now();
            let out = contracts::transact(&db, Some(user), f);
            timing.add_db(start.elapsed());
            out
        })
        .await
    }
}

impl Tenant {
    /// A check, run on a blocking thread, that this session is still live
    /// and its user still staff or above here, on `platform.db` (S1 codex
    /// C5): the middleware's check can be stale by the time a write runs.
    fn recheck(&self) -> impl FnOnce() -> Result<(), ApiError> + Send + 'static + use<> {
        let (store, session) = (self.store.clone(), self.session_id.clone());
        let (user, slug) = (self.user, self.slug.clone());
        move || {
            let now = contracts::now_ms();
            let live = store
                .platform()
                .with_read(|c| ::auth::sessions::by_id(c, &session, now))?
                .is_some_and(|s| s.user == user && s.stage == ::auth::Stage::Full);
            if !live {
                return Err(ApiError::Unauthenticated);
            }
            match store.platform().member(UserId(user), &slug)? {
                Some(m) if m.role >= Role::Staff => Ok(()),
                _ => Err(ApiError::Forbidden),
            }
        }
    }

    /// Admin-only routes: role `admin`, and a sign-in (or step-up) within
    /// the last hour (ADR 0020), else `403 step_up_required`.
    pub fn require_admin(&self) -> Result<(), ApiError> {
        if self.role < Role::Admin {
            return Err(ApiError::Forbidden);
        }
        self.require_step_up()
    }

    /// Irreversible commands (retiring or deleting a field), whoever may
    /// run them: a sign-in (or step-up) within the last hour, else `403
    /// step_up_required`. Always passes under `KEEP_AUTH_POLICY=relaxed`.
    pub fn require_step_up(&self) -> Result<(), ApiError> {
        if !self.no_step_up && contracts::now_ms() - self.authenticated_at >= ::auth::STEP_UP_MS {
            return Err(ApiError::StepUpRequired);
        }
        Ok(())
    }

    /// Mark `job`'s work on `key` pending in `platform.db`, before the
    /// work's first commit (write-ahead), so a server stopping anywhere
    /// after it leaves the work to the job. Idempotent.
    pub async fn mark_job(&self, job: &'static str, key: String) -> Result<(), ApiError> {
        let (store, id) = (self.store.clone(), self.tenant_id.clone());
        blocking(move || crate::jobs::mark_pending(&store, &id, job, &key)).await
    }

    /// Run `step` again and again, each run its own transaction as this
    /// user, until it answers `true`: in the background, after this
    /// returns. `job`/`key` are marked pending in `platform.db` first (a
    /// no-op after [`Tenant::mark_job`]) and cleared at the end, so a server stopping part way leaves the work
    /// to the job of that name ([`crate::jobs::each_pending_org`]). A
    /// failure is logged and sent to Sentry, and leaves the marker.
    ///
    /// Steps run back to back: the org writer is released fairly
    /// (`store::OrgDb::write_raw`), so a request's write waiting for it
    /// runs between two steps rather than after the whole job.
    pub async fn run_job<F>(&self, job: &'static str, key: String, step: F) -> Result<(), ApiError>
    where
        F: Fn(&Ctx) -> Result<bool, ApiError> + Send + 'static,
    {
        // As in `write`: the session and role still hold when it starts.
        blocking(self.recheck()).await?;
        let (store, id) = (self.store.clone(), self.tenant_id.clone());
        {
            let (store, id, key) = (store.clone(), id.clone(), key.clone());
            blocking(move || crate::jobs::mark_pending(&store, &id, job, &key)).await?;
        }
        let db = self.db.clone();
        let user = self.user;
        tokio::task::spawn_blocking(move || {
            let done = loop {
                match contracts::transact(&db, Some(user), &step) {
                    Ok(true) => break Ok(()),
                    Ok(false) => continue,
                    Err(e) => break Err(e),
                }
            };
            let done = done.and_then(|()| {
                crate::jobs::clear_pending(&store, &id, job, &key).map_err(ApiError::from)
            });
            if let Err(e) = done {
                crate::observe::error(&format!("{job} {id} {key}: {e:?}"));
            }
        });
        Ok(())
    }

    /// The addresses at `postcode`, for the contact form (staff and
    /// above): counted against this organisation's month in `platform.db`
    /// ([`crate::address`]). Off: `404`. Not a postcode: `422`, before
    /// anything is counted or sent. Nothing is stored or logged.
    pub async fn lookup_address(
        &self,
        postcode: &str,
    ) -> Result<Vec<crate::address::LookupAddress>, ApiError> {
        use crate::address::{LookupError, normalise};
        if self.role < Role::Staff {
            return Err(ApiError::Forbidden);
        }
        let Some(lookup) = self.address.clone() else {
            return Err(ApiError::NotFound);
        };
        let Some(postcode) = normalise(postcode) else {
            return Err(ApiError::Invalid {
                problems: vec![contracts::Problem::new(
                    "postcode",
                    "Enter a UK postcode, like SW1A 1AA.",
                )],
            });
        };
        let out = lookup
            .lookup(self.store.clone(), self.tenant_id.clone(), &postcode)
            .await;
        match out {
            Ok(found) => Ok(found),
            Err(LookupError::NotFound) => Err(ApiError::NotFound),
            Err(LookupError::CapReached) => Err(ApiError::LookupCap),
            Err(LookupError::Unavailable(detail)) => {
                // `detail` never holds the key, a postcode or an address.
                eprintln!("address lookup unavailable ({}): {detail}", self.slug);
                Err(ApiError::LookupUnavailable)
            }
        }
    }

    /// GoCardless, when it is on here (`KEEP_GOCARDLESS`); off: `404`.
    /// The organisation's token is read from its own file
    /// ([`crate::gocardless::GoCardless::token`]).
    pub fn gocardless(&self) -> Result<Arc<crate::gocardless::GoCardless>, ApiError> {
        self.gocardless.clone().ok_or(ApiError::NotFound)
    }

    /// Whether GoCardless is on, and this organisation's connection
    /// (`platform.db`).
    pub async fn gocardless_status(&self) -> Result<crate::gocardless::GoCardlessStatus, ApiError> {
        use crate::gocardless::{GoCardlessStatus, Mode, connection};
        let Some(gc) = self.gocardless.clone() else {
            return Ok(GoCardlessStatus::new(Mode::Off, None));
        };
        let (store, id) = (self.store.clone(), self.tenant_id.clone());
        let (connected, failed) = blocking(move || {
            Ok::<_, ApiError>((
                connection(&store, &id)?,
                crate::gocardless::process::failed_count(&store, &id)?,
            ))
        })
        .await?;
        Ok(GoCardlessStatus {
            failed_events: failed,
            ..GoCardlessStatus::new(gc.mode, connected)
        })
    }

    /// Whether this organisation owns a GoCardless account's mapping in
    /// `platform.db`: what "connected" means (a token alone doesn't).
    pub async fn gocardless_owned(&self) -> Result<bool, ApiError> {
        let (store, id) = (self.store.clone(), self.tenant_id.clone());
        Ok(blocking(move || crate::gocardless::connection(&store, &id))
            .await?
            .is_some())
    }

    /// Put this organisation's parked GoCardless events back in the queue
    /// (admin) and start a run.
    pub async fn gocardless_retry_failed(
        &self,
    ) -> Result<crate::gocardless::GoCardlessStatus, ApiError> {
        self.require_admin()?;
        let gc = self.gocardless()?;
        let (store, id) = (self.store.clone(), self.tenant_id.clone());
        blocking(move || crate::gocardless::process::requeue_failed(&store, &id)).await?;
        crate::gocardless::webhook::spawn_processing(self.store.clone(), gc);
        self.gocardless_status().await
    }

    /// Start "Connect with GoCardless" (admin within the step-up hour):
    /// a single-use `state` bound to this session, user and organisation,
    /// and the URL to send the browser to.
    pub async fn gocardless_connect(&self) -> Result<crate::gocardless::ConnectStart, ApiError> {
        self.require_admin()?;
        let gc = self.gocardless()?;
        blocking(self.recheck()).await?;
        let (store, id) = (self.store.clone(), self.tenant_id.clone());
        let (user, session) = (self.user, self.session_id.clone());
        let state = blocking(move || {
            crate::gocardless::new_state(&store, &id, user, &session, contracts::now_ms())
        })
        .await?;
        Ok(crate::gocardless::ConnectStart {
            url: gc.authorize_url(&state),
        })
    }

    /// Disconnect (admin within the step-up hour): revoke the token at
    /// GoCardless, forget it here, and stop routing the account's
    /// webhooks. Regular gifts stay, shown as not connected. GoCardless
    /// unreachable: `503`, nothing changed.
    pub async fn gocardless_disconnect(
        &self,
    ) -> Result<crate::gocardless::GoCardlessStatus, ApiError> {
        use crate::gocardless::{GoCardlessStatus, forget_connection};
        self.require_admin()?;
        let gc = self.gocardless()?;
        // One connect or disconnect at a time: a connect's token can't
        // land in this file after it was emptied here, nor a reservation
        // vanish under a connect.
        let _connecting = gc.connecting.lock().await;
        let g = gc.clone();
        let token = self.read(move |r| g.token(r)).await?;
        if let Some(token) = token {
            match gc.api.revoke(gc.credentials(), &token).await {
                Ok(()) => {}
                // GoCardless failing, unreachable or rate-limiting (429):
                // the token may still be live. Nothing changes here.
                Err(e) if e.retryable() => {
                    eprintln!("gocardless disconnect ({}): revoke: {e}", self.slug);
                    return Err(ApiError::GocardlessUnavailable);
                }
                // Revoked already (an admin removed the app in GoCardless's
                // dashboard): nothing left to revoke.
                Err(
                    e @ (crate::gocardless::CallError::Unauthorized
                    | crate::gocardless::CallError::Refused { .. }),
                ) => eprintln!(
                    "gocardless disconnect ({}): GoCardless no longer knows the token ({e})",
                    self.slug
                ),
                Err(e) => {
                    eprintln!("gocardless disconnect ({}): revoke: {e}", self.slug);
                    return Err(ApiError::GocardlessUnavailable);
                }
            }
            let g = gc.clone();
            self.write(move |ctx| Ok(g.put_token(ctx, "", "", contracts::Source::Ui)?))
                .await?;
        }
        let (store, id) = (self.store.clone(), self.tenant_id.clone());
        blocking(move || forget_connection(&store, &id)).await?;
        Ok(GoCardlessStatus::new(gc.mode, None))
    }

    // ── declaration scans (`crate::scans`) ─────────────────────────────────

    /// Start a phone pairing for this session (staff or admin, a sign-in
    /// or step-up within the hour). The token is in the answer only.
    pub async fn start_scan_pairing(
        &self,
        purpose: crate::scans::Purpose,
    ) -> Result<(crate::scans::Pairing, String), ApiError> {
        if self.role < Role::Staff {
            return Err(ApiError::Forbidden);
        }
        self.require_step_up()?;
        blocking(self.recheck()).await?;
        let (store, id) = (self.store.clone(), self.tenant_id.clone());
        let (user, session) = (self.user, self.session_id.clone());
        blocking(move || {
            crate::scans::start(&store, &id, user, &session, purpose, contracts::now_ms())
        })
        .await
    }

    /// One of this organisation's pairings (any staff member's), or
    /// `404`: another organisation's id reads as unknown.
    pub async fn scan_pairing(&self, id: String) -> Result<crate::scans::Pairing, ApiError> {
        let (store, tenant) = (self.store.clone(), self.tenant_id.clone());
        blocking(move || {
            crate::scans::by_id(&store, &id)?
                .filter(|p| p.tenant_id == tenant.as_str())
                .ok_or(ApiError::NotFound)
        })
        .await
    }

    /// End one of this organisation's pairings (the laptop's "Done").
    pub async fn end_scan_pairing(&self, id: String) -> Result<crate::scans::Pairing, ApiError> {
        if self.role < Role::Staff {
            return Err(ApiError::Forbidden);
        }
        let pairing = self.scan_pairing(id).await?;
        let store = self.store.clone();
        blocking(move || {
            crate::scans::end(&store, &pairing.id, "ended", contracts::now_ms())?;
            crate::scans::by_id(&store, &pairing.id)?.ok_or(ApiError::NotFound)
        })
        .await
    }

    /// A signed-in phone's upload (`via: direct`, staff or admin): the
    /// image re-encoded into this organisation's files db, then the
    /// scan's contract as this user.
    pub async fn upload_scan_page(
        &self,
        target: crate::scans::Target,
        raw: axum::body::Bytes,
        slot: Option<crate::scans::limits::Slot>,
    ) -> Result<crate::scans::Uploaded, ApiError> {
        if self.role < Role::Staff {
            return Err(ApiError::Forbidden);
        }
        let (db, limits) = (self.db.clone(), self.scan_limits.clone());
        let (user, timing, check) = (self.user, self.timing.clone(), self.recheck());
        blocking(move || {
            // Held until the work ends, whether or not anyone still waits.
            let _slot = slot;
            check()?;
            let start = Instant::now();
            let page = crate::scans::store_page(&db, &raw, &limits)?;
            let scan_id = crate::scans::upload(&db, user, None, target, page)?;
            let pages = crate::scans::page_count(&db, &scan_id)?;
            timing.add_db(start.elapsed());
            Ok::<_, ApiError>(crate::scans::Uploaded {
                scan_id,
                pages,
                uploads_left: None,
            })
        })
        .await
    }

    /// A page's image from this organisation's files db, if its page row
    /// names it and its images haven't gone. Staff and admins only.
    pub async fn scan_page_image(
        &self,
        scan_id: String,
        page_no: i64,
    ) -> Result<Option<store::files::Blob>, ApiError> {
        if self.role < Role::Staff {
            return Err(ApiError::Forbidden);
        }
        let db = self.db.clone();
        blocking(move || {
            let sha = db.read(|r| giftaid::scans::page_blob(r, &scan_id, page_no))?;
            let Some(sha) = sha else {
                return Ok(None);
            };
            match db.files_if_any()? {
                Some(files) => Ok::<_, ApiError>(files.get(&sha)?),
                None => Ok(None),
            }
        })
        .await
    }

    /// Bytes this organisation's files db holds (Settings), and its cap.
    pub async fn files_usage(&self) -> Result<(i64, i64), ApiError> {
        let db = self.db.clone();
        let used = blocking(move || match db.files_if_any()? {
            Some(files) => Ok::<_, ApiError>(files.usage()?),
            None => Ok(0),
        })
        .await?;
        Ok((used, self.scan_limits.cap_bytes))
    }

    /// After a scan's images were recorded as gone (committed): the blobs
    /// no page names any more. Blobs put within the last hour stay (a
    /// write in flight); the daily sweep takes them.
    pub async fn sweep_scan_blobs(&self) -> Result<usize, ApiError> {
        let db = self.db.clone();
        blocking(move || {
            crate::scans::sweep_blobs(&db, contracts::now_ms() - crate::scans::PUT_GRACE_MS)
        })
        .await
    }

    /// This organisation's committed changes as SSE, resuming after
    /// `Last-Event-ID` if given (see [`crate::events`]).
    pub async fn events(
        &self,
        last_event_id: Option<&str>,
    ) -> Result<
        impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>
        + Send
        + 'static
        + use<>,
        ApiError,
    > {
        crate::events::stream(self.db.clone(), last_event_id).await
    }
}

/// The `{slug}` in `/api/t/{slug}/…`.
fn slug(uri: &OriginalUri) -> Option<&str> {
    let rest = uri.path().strip_prefix("/api/t/")?;
    let slug = rest.split('/').next()?;
    (!slug.is_empty()).then_some(slug)
}

pub(crate) async fn middleware(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    uri: OriginalUri,
    mut req: Request,
    next: Next,
) -> Response {
    let headers = req.headers().clone();
    // Writes need staff or above, whatever the route: a viewer's command
    // is refused here, before its body is read or its ids looked up, so no
    // write route can forget (the roles meta-test in `tests/roles.rs`).
    let reads = matches!(*req.method(), Method::GET | Method::HEAD);
    let resolved = async {
        let req = &mut req;
        let session = auth::session(&state, &headers, &timing).await?;
        let slug = slug(&uri).ok_or(ApiError::NotFound)?.to_owned();
        let store = state.store.clone();
        let start = Instant::now();
        let found = blocking(move || {
            // Unknown slug and someone else's organisation read the same.
            let Some(member) = store
                .platform()
                .member(store::UserId(session.user), &slug)?
            else {
                return Err(ApiError::Forbidden);
            };
            let db = store.org(&member.tenant.id)?;
            Ok((member, db))
        })
        .await;
        timing.add_platform(start.elapsed());
        let (member, db) = found?;
        if !reads && member.role < Role::Staff {
            return Err(ApiError::Forbidden);
        }
        req.extensions_mut()
            .insert(auth::Account::new(&state, &session));
        Ok::<_, ApiError>(Tenant {
            db,
            slug: member.tenant.slug,
            name: member.tenant.name,
            role: member.role,
            user: session.user,
            authenticated_at: session.authenticated_at.unwrap_or(0),
            no_step_up: state.auth.policy.is_relaxed(),
            timing: timing.clone(),
            tenant_id: member.tenant.id.clone(),
            store: state.store.clone(),
            session_id: session.id.clone(),
            address: state.address.clone(),
            gocardless: state.gocardless.clone(),
            scan_limits: state.scans.clone(),
        })
    }
    .await;
    match resolved {
        Ok(tenant) => {
            req.extensions_mut().insert(tenant);
            next.run(req).await
        }
        Err(err) => err.into_response(),
    }
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct TenantInfo {
    pub slug: String,
    pub name: String,
    pub role: RoleName,
}

/// `GET /api/t/{slug}`
pub async fn info(Extension(tenant): Extension<Tenant>) -> Json<TenantInfo> {
    Json(TenantInfo {
        slug: tenant.slug,
        name: tenant.name,
        role: tenant.role.into(),
    })
}

#[cfg(test)]
mod tests {
    use store::StoreConfig;

    use super::*;

    /// S1 codex C5: `write` checks the session and the role on
    /// `platform.db` itself, so a sign-out or a demotion after the
    /// middleware's check (e.g. while the handler ran) stops the write.
    #[tokio::test]
    async fn a_write_rechecks_the_session_and_role() {
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
        let cat = p.upsert_user("cat@alpha.org").unwrap();
        p.set_membership(cat, &t.id, Role::Staff).unwrap();
        let now = contracts::now_ms();
        let token = p
            .with_write(|tx| ::auth::sessions::create(tx, cat.0, ::auth::Stage::Full, now))
            .unwrap();
        let tenant = Tenant {
            tenant_id: t.id.clone(),
            db: store.org(&t.id).unwrap(),
            slug: "alpha".into(),
            name: "Alpha".into(),
            role: Role::Staff,
            user: cat.0,
            authenticated_at: now,
            no_step_up: false,
            timing: Timing::default(),
            store: store.clone(),
            session_id: ::auth::secret::hash(&token),
            address: None,
            gocardless: None,
            scan_limits: Arc::default(),
        };
        let write = || tenant.write(|_ctx| Ok(()));
        assert!(write().await.is_ok());
        p.set_membership(cat, &t.id, Role::Viewer).unwrap();
        assert!(matches!(write().await, Err(ApiError::Forbidden)));
        p.set_membership(cat, &t.id, Role::Staff).unwrap();
        p.with_write(|tx| ::auth::sessions::revoke_user(tx, cat.0))
            .unwrap();
        assert!(matches!(write().await, Err(ApiError::Unauthenticated)));
    }
}
