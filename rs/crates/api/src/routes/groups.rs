//! `/api/groups`: the signed-in user's groups (`convex/platform/tenants.ts`
//! `mine`, `opened`). Outside `/api/t/{slug}`: these answer about the
//! user across their groups, so each checks membership itself, and a slug
//! they aren't a member of answers 404.

use std::time::Instant;

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::{Extension, Json};
use platform::groups::{self, Opened};
use platform::preferences::{self, ListKind};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::timing::Timing;
use crate::{ApiError, AppState, RoleName, auth, blocking};

/// One of the caller's groups, with the Settings switches (and the
/// counters their saves need) and what they mean for this caller.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Group {
    pub slug: String,
    pub name: String,
    pub role: RoleName,
    /// When the caller last opened this group (ms); null if never
    /// recorded (or they belong to only one).
    #[ts(type = "number | null")]
    pub last_used_at: Option<i64>,
    pub staff_can_manage_identifier_types: bool,
    #[ts(type = "number | null")]
    pub identifier_types_version: Option<i64>,
    pub staff_can_manage_source_codes: bool,
    #[ts(type = "number | null")]
    pub source_codes_version: Option<i64>,
    pub staff_can_manage_fields: bool,
    #[ts(type = "number | null")]
    pub fields_version: Option<i64>,
    pub can_manage_identifier_types: bool,
    pub can_manage_source_codes: bool,
    pub can_manage_fields: bool,
}

/// `GET /api/groups`: every group the caller belongs to, by name.
pub async fn mine(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    headers: HeaderMap,
) -> Result<Json<Vec<Group>>, ApiError> {
    let session = auth::session(&state, &headers, &timing).await?;
    let store = state.store.clone();
    let start = Instant::now();
    let out = blocking(move || {
        let p = store.platform();
        let members = p.memberships(session.user)?;
        let last = p.with_read(|c| groups::last_used(c, session.user))?;
        let mut out = Vec::with_capacity(members.len());
        for m in members {
            // Each group's switches live in its own file. One that won't
            // open (set aside by a rollback, stamped wrong) is left out and
            // logged, so the user can still reach their other groups.
            let prefs = match store
                .org(&m.tenant.id)
                .map_err(ApiError::from)
                .and_then(|db| Ok(db.read(|r| preferences::read(r))?))
            {
                Ok(prefs) => prefs,
                Err(e) => {
                    eprintln!(
                        "groups: left out {} ({}): its file won't open: {e:?}",
                        m.tenant.slug, m.tenant.id
                    );
                    continue;
                }
            };
            let switch = |k| prefs.get(k);
            out.push(Group {
                last_used_at: last.get(&m.tenant.slug).copied().flatten(),
                staff_can_manage_identifier_types: switch(ListKind::IdentifierTypes)
                    .staff_can_manage,
                identifier_types_version: switch(ListKind::IdentifierTypes).version,
                staff_can_manage_source_codes: switch(ListKind::SourceCodes).staff_can_manage,
                source_codes_version: switch(ListKind::SourceCodes).version,
                staff_can_manage_fields: switch(ListKind::Fields).staff_can_manage,
                fields_version: switch(ListKind::Fields).version,
                can_manage_identifier_types: prefs.may_manage(m.role, ListKind::IdentifierTypes),
                can_manage_source_codes: prefs.may_manage(m.role, ListKind::SourceCodes),
                can_manage_fields: prefs.may_manage(m.role, ListKind::Fields),
                slug: m.tenant.slug,
                name: m.tenant.name,
                role: m.role.into(),
            });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.slug.cmp(&b.slug)));
        Ok::<_, ApiError>(out)
    })
    .await;
    timing.add_platform(start.elapsed());
    out.map(Json)
}

#[derive(Deserialize)]
pub struct SlugParam {
    slug: String,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OpenedResult {
    /// The new mark (ms), or null when nothing was recorded.
    #[ts(type = "number | null")]
    pub last_used_at: Option<i64>,
}

/// `POST /api/groups/{slug}/opened`: the caller opened this group. Any
/// member, viewers too: it changes no group data. Not a member: 404.
pub async fn opened(
    State(state): State<AppState>,
    Extension(timing): Extension<Timing>,
    Path(SlugParam { slug }): Path<SlugParam>,
    headers: HeaderMap,
) -> Result<Json<OpenedResult>, ApiError> {
    let session = auth::session(&state, &headers, &timing).await?;
    let store = state.store.clone();
    let start = Instant::now();
    let out = blocking(move || {
        store.platform().with_write(|tx| {
            groups::opened(tx, session.user, &slug, contracts::now_ms()).map_err(ApiError::from)
        })
    })
    .await;
    timing.add_platform(start.elapsed());
    match out? {
        Opened::NotMember => Err(ApiError::NotFound),
        Opened::Unchanged => Ok(Json(OpenedResult { last_used_at: None })),
        Opened::Marked(at) => Ok(Json(OpenedResult {
            last_used_at: Some(at),
        })),
    }
}
