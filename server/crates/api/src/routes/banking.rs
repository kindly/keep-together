//! `/api/t/{slug}/bank/…`: bank accounts and statement imports (plan
//! `bank-transfers.sv`, ADR 0027). Statement lines show every payer into
//! the account, donors or not, so viewers get `403` on every route here
//! (g1q9). Setting an account up is admin only (`Tenant::require_admin`);
//! staff and admins import and read.
//!
//! An upload's body is the statement file itself (at most 5 MB: `413
//! too_large` past it); which account, the file's name and how to read it
//! ride in the query. A file that can't be read is `422 file_rows`, by
//! line, and nothing from it is stored. Imports are never optimistic: the
//! answer is what was committed.

use axum::body::Bytes;
use axum::extract::DefaultBodyLimit;
use axum::extract::Path;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use banking::account::account as one_account;
use banking::import::ImportLine;
use banking::{
    AccountPayload, AccountRow, CsvLayout, FileLayout, ImportRequest, ImportRow, Imported,
    PeekRow, Preset, Preview,
};
use contracts::{Executed, Problem, Source, command_group};
use serde::{Deserialize, Serialize};
use store::Role;
use ts_rs::TS;

use super::Params;
use crate::{ApiError, Body, IdParam, Tenant};

pub fn router() -> Router {
    Router::new()
        .route("/bank/presets", get(presets))
        .route("/bank/accounts", get(accounts).post(create))
        .route("/bank/accounts/{id}", get(one))
        .route("/bank/accounts/{id}/save", post(save))
        .route("/bank/accounts/{id}/imports", get(imports))
        .route("/bank/imports", post(import))
        .route("/bank/imports/preview", post(preview))
        .route("/bank/imports/{id}", get(import_detail))
        .route("/bank/peek", post(peek))
        // `body::buffer` has already capped a statement at its 5 MB; the
        // extractor's own 2 MB default would cut it short.
        .layer(DefaultBodyLimit::max(banking::import::FILE_BYTES_MAX))
}

fn require_staff(t: &Tenant) -> Result<(), ApiError> {
    if t.role < Role::Staff {
        return Err(ApiError::Forbidden);
    }
    Ok(())
}

/// `GET bank/presets`.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankPresets")]
pub struct Presets {
    pub presets: Vec<Preset>,
    /// Banks whose preset waits for a real export; map their columns.
    pub awaiting_samples: Vec<String>,
}

async fn presets(Extension(t): Extension<Tenant>) -> Result<Json<Presets>, ApiError> {
    require_staff(&t)?;
    Ok(Json(Presets {
        presets: banking::presets(),
        awaiting_samples: banking::AWAITING_SAMPLES.iter().map(|b| b.to_string()).collect(),
    }))
}

/// `GET bank/accounts`: every account, in the order they were added.
async fn accounts(Extension(t): Extension<Tenant>) -> Result<Json<Vec<AccountRow>>, ApiError> {
    require_staff(&t)?;
    t.read(|r| Ok(banking::accounts(r)?)).await.map(Json)
}

fn row(conn: &rusqlite::Connection, id: &str) -> Result<AccountRow, ApiError> {
    banking::account_row(conn, id)?.ok_or(ApiError::NotFound)
}

/// `GET bank/accounts/{id}`
async fn one(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<AccountRow>, ApiError> {
    require_staff(&t)?;
    t.read(move |r| row(r, &id)).await.map(Json)
}

/// `POST bank/accounts {name, sortCode, accountLast4,
/// defaultSourceCodeId?, csvLayout?, active}` (admin) → the account.
/// `422 rejected`: `duplicate_account_name`, `bank_account_limit`.
async fn create(
    Extension(t): Extension<Tenant>,
    Body(p): Body<AccountPayload>,
) -> Result<Json<AccountRow>, ApiError> {
    t.require_admin()?;
    t.write(move |ctx| {
        let id = banking::create_account(ctx, p, Source::Ui)?.id;
        row(ctx.tx.read(), &id)
    })
    .await
    .map(Json)
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "SaveBankAccount")]
pub struct SaveAccount {
    #[ts(type = "number")]
    pub expected: i64,
    #[serde(flatten)]
    pub account: AccountPayload,
}

/// `POST bank/accounts/{id}/save {expected, …}` (admin): `expected` is
/// the account's `version`. `409 stale`.
async fn save(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(s): Body<SaveAccount>,
) -> Result<Json<Executed>, ApiError> {
    t.require_admin()?;
    t.write(move |ctx| {
        Ok(banking::save_account(
            ctx,
            &id,
            s.expected,
            s.account,
            Source::Ui,
        )?)
    })
    .await
    .map(Json)
}

/// `GET bank/accounts/{id}/imports`: newest first (at most 100).
async fn imports(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<Vec<ImportRow>>, ApiError> {
    require_staff(&t)?;
    t.read(move |r| {
        one_account(r, &id)?.ok_or(ApiError::NotFound)?;
        Ok(banking::imports(r, &id)?)
    })
    .await
    .map(Json)
}

/// The query of an upload. `layout` is a JSON [`FileLayout`]; absent,
/// the account's saved CSV layout.
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankImportQuery")]
pub struct ImportQuery {
    pub account_id: String,
    pub file_name: String,
    #[serde(default)]
    #[ts(optional)]
    pub layout: Option<String>,
    /// Keep `layout` (a CSV one) as the account's, in the same
    /// transaction. Staff may only when the account has none yet; an
    /// admin may replace it.
    #[serde(default)]
    #[ts(optional)]
    pub save_layout: Option<bool>,
}

impl ImportQuery {
    fn request(&self) -> Result<ImportRequest, ApiError> {
        let layout = self
            .layout
            .as_deref()
            .filter(|l| !l.is_empty())
            .map(serde_json::from_str::<FileLayout>)
            .transpose()
            .map_err(|e| ApiError::Invalid {
                problems: vec![Problem::new("layout", e.to_string())],
            })?;
        Ok(ImportRequest {
            account_id: self.account_id.clone(),
            file_name: self.file_name.clone(),
            layout,
        })
    }
}

/// `POST bank/imports/preview?accountId&fileName&layout` (body: the
/// file): what importing it would add, written nowhere.
async fn preview(
    Extension(t): Extension<Tenant>,
    Params(q): Params<ImportQuery>,
    body: Bytes,
) -> Result<Json<Preview>, ApiError> {
    require_staff(&t)?;
    let request = q.request()?;
    t.read(move |r| Ok(banking::plan_import(r, request, &body)?.preview()))
        .await
        .map(Json)
}

/// `POST bank/imports?accountId&fileName&layout&saveLayout` (body: the
/// file) → "41 new, 12 already imported". `422 file_rows`, `413
/// too_large`, `422 rejected`: `account_inactive`.
async fn import(
    Extension(t): Extension<Tenant>,
    Params(q): Params<ImportQuery>,
    body: Bytes,
) -> Result<Json<Imported>, ApiError> {
    require_staff(&t)?;
    let request = q.request()?;
    let save_layout = q.save_layout.unwrap_or(false);
    let admin = t.role >= Role::Admin;
    t.write(move |ctx| {
        let layout = match &request.layout {
            Some(FileLayout::Preset { id }) => Some(CsvLayout::Preset { id: id.clone() }),
            Some(FileLayout::Mapping { mapping }) => Some(CsvLayout::Mapping {
                mapping: mapping.clone(),
            }),
            _ => None,
        };
        let Some(layout) = layout.filter(|_| save_layout) else {
            return Ok(banking::import_file(ctx, request, &body, Source::Ui, None)?);
        };
        let account_id = request.account_id.clone();
        let current = one_account(ctx.tx.read(), &account_id)?.ok_or(ApiError::NotFound)?;
        if current.payload.csv_layout.is_some() && !admin {
            return Err(ApiError::Forbidden);
        }
        let version: i64 = ctx.tx.read().query_row(
            "SELECT version FROM bank_accounts WHERE id = ?1",
            [&account_id],
            |r| r.get(0),
        )?;
        let group = command_group(ctx, "import statement and keep its layout")?;
        let imported = banking::import_file(ctx, request, &body, Source::Ui, Some(&group))?;
        contracts::execute(
            ctx,
            &banking::ACCOUNT,
            AccountPayload {
                csv_layout: Some(layout),
                ..current.payload
            },
            contracts::Exec::update(&account_id, Some(version), Source::Ui).in_group(&group),
        )?;
        Ok(imported)
    })
    .await
    .map(Json)
}

/// `GET bank/imports/{id}`: one import and its lines.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankImportDetail")]
pub struct ImportDetail {
    pub account_id: String,
    pub import: ImportRow,
    pub lines: Vec<ImportLine>,
}

async fn import_detail(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<ImportDetail>, ApiError> {
    require_staff(&t)?;
    t.read(move |r| {
        let (account_id, import) = banking::import_of(r, &id)?.ok_or(ApiError::NotFound)?;
        Ok(ImportDetail {
            account_id,
            import,
            lines: banking::import_lines(r, &id)?,
        })
    })
    .await
    .map(Json)
}

/// `POST bank/peek` (body: a CSV file): its first rows as text, for
/// mapping its columns. Reads nothing from the organisation.
async fn peek(
    Extension(t): Extension<Tenant>,
    body: Bytes,
) -> Result<Json<Vec<PeekRow>>, ApiError> {
    require_staff(&t)?;
    banking::peek_csv(&body)
        .map(Json)
        .map_err(|e| ApiError::FileRows { rows: vec![e] })
}
