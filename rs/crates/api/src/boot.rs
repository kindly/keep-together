//! `GET /api/t/{slug}/boot`: everything a cold load needs in one request,
//! to seed the SPA's query cache.

use axum::{Extension, Json};
use contacts::fields::definitions;
use contacts::queries::{self, ListQuery};
use contacts::types::{ContactPage, FieldDefinition};
use serde::Serialize;
use ts_rs::TS;

use crate::auth::{Account, Me};
use crate::events::head_seq;
use crate::tenant::TenantInfo;
use crate::timing::Timing;
use crate::{ApiError, Tenant};

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Boot {
    /// As `GET /api/me`.
    pub me: Me,
    /// As `GET /api/t/{slug}`.
    pub org: TenantInfo,
    /// As `GET fields`.
    pub fields: Vec<FieldDefinition>,
    /// As `GET contacts` with no parameters.
    pub first_page: ContactPage,
    /// The newest revision id in the snapshot `fields` and `firstPage`
    /// were read from: open `/events?after=<seq>` so no change committed
    /// since is missed.
    #[ts(type = "number")]
    pub seq: i64,
}

pub async fn boot(
    Extension(tenant): Extension<Tenant>,
    Extension(account): Extension<Account>,
    Extension(timing): Extension<Timing>,
) -> Result<Json<Boot>, ApiError> {
    let (me, (fields, first_page, seq)) = tokio::try_join!(
        account.me(&timing),
        tenant.read(|r| {
            Ok((
                definitions(r)?,
                queries::list(r, &ListQuery::default())?,
                head_seq(r)?,
            ))
        })
    )?;
    Ok(Json(Boot {
        me,
        org: TenantInfo {
            slug: tenant.slug.clone(),
            name: tenant.name.clone(),
            role: tenant.role.into(),
        },
        fields,
        first_page,
        seq,
    }))
}
