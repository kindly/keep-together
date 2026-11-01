//! `GET /healthz`: 200 when the server can serve, 503 when it can't. Fly's
//! health check and the 15-minute monitor call it. Besides the db, it
//! reports what the monitor judges: WAL backlog, backups, and the data
//! volume's free and total bytes, and which commit is running.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde_json::{Value, json};

use crate::{AppState, blocking};

pub async fn healthz(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
    let store = state.store.clone();
    let db_ok = blocking(move || store.each_org().map(|_| ())).await.is_ok();
    let mut body = json!({ "db": if db_ok { "ok" } else { "error" } });
    // Reported, never judged, like backups: the open org file with the
    // most WAL not yet checkpointed (`store::checkpoint`). Normally a few
    // hundred KB; `jobs::WalWatch` warns past `WAL_WARN_BYTES`.
    body["walBacklogBytes"] = json!(state.store.wal_backlog_worst());
    // Backups are reported, never judged here: a stale snapshot must not
    // take the only machine out of Fly's rotation. The 15-minute monitor
    // (`.github/workflows/health.yml`) judges these fields.
    body["backup"] = serde_json::to_value(crate::backup::health().await).unwrap_or_default();
    // Reported, never judged here either: a full disk is the monitor's to
    // raise (free under 20%, louder under 10%), and `ok` stays about
    // whether the server can serve. Counts only, never the path.
    let (free, total) = match crate::scans::limits::volume(state.store.dir()) {
        Ok((free, total)) => (json!(free), json!(total)),
        Err(_) => (Value::Null, Value::Null),
    };
    body["diskFreeBytes"] = free;
    body["diskTotalBytes"] = total;
    // Which commit this is, so a deploy (and QC on keep-qc) can tell the
    // new image is serving. `null` for a build without `KEEP_RELEASE`.
    body["commit"] = json!(state.commit.as_deref());
    let ok = db_ok;
    body["ok"] = json!(ok);
    let status = if ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, Json(body))
}

/// `KEEP_RELEASE` as `/healthz` reports it: a git commit, 7 to 64
/// lower-case hex characters. Anything else (unset, empty, a typo) is
/// `None`, reported as `null` rather than echoed.
pub fn commit(release: Option<&str>) -> Option<String> {
    let r = release?.trim();
    let hex = r
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    (hex && (7..=64).contains(&r.len())).then(|| r.to_owned())
}

#[cfg(test)]
mod tests {
    use super::commit;

    #[test]
    fn commit_takes_a_git_sha_and_nothing_else() {
        let sha = "7b18cb5a0c3f1e2d4b6a8c9e0f1a2b3c4d5e6f70";
        assert_eq!(commit(Some(sha)).as_deref(), Some(sha));
        assert_eq!(commit(Some("7b18cb5")).as_deref(), Some("7b18cb5"));
        assert_eq!(commit(Some(&format!(" {sha}\n"))).as_deref(), Some(sha));
        for bad in [
            "",
            "abc",
            "7B18CB5A",
            "main",
            "7b18cb5; rm -rf /",
            &"a".repeat(65),
        ] {
            assert_eq!(commit(Some(bad)), None, "{bad:?}");
        }
        assert_eq!(commit(None), None);
    }
}
