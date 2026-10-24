//! `GET /healthz`: 200 when the server can serve, 503 when it can't. Fly's
//! health check and the 15-minute monitor call it.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde_json::{Value, json};

use crate::{AppState, blocking};

pub async fn healthz(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
    let store = state.store.clone();
    let db_ok = blocking(move || store.each_org().map(|_| ())).await.is_ok();
    let mut body = json!({ "db": if db_ok { "ok" } else { "error" } });
    // Backups are reported, never judged here: a stale snapshot must not
    // take the only machine out of Fly's rotation. The 15-minute monitor
    // (`.github/workflows/health.yml`) judges these fields.
    body["backup"] = serde_json::to_value(crate::backup::health().await).unwrap_or_default();
    let ok = db_ok;
    body["ok"] = json!(ok);
    let status = if ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, Json(body))
}
