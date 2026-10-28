//! `/healthz`'s Litestream part, read from a fake control socket that
//! answers the way Litestream 0.5's `GET /list` does.

use std::path::PathBuf;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixListener;

/// Serve `body` (status line `status`) to every connection on `path`.
fn fake_litestream(path: PathBuf, status: &'static str, body: String) {
    let listener = UnixListener::bind(&path).unwrap();
    tokio::spawn(async move {
        loop {
            let (mut conn, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let n = conn.read(&mut buf).await.unwrap();
            assert!(String::from_utf8_lossy(&buf[..n]).starts_with("GET /list HTTP/1.0\r\n"));
            let res = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            conn.write_all(res.as_bytes()).await.unwrap();
        }
    });
}

#[tokio::test]
async fn lag_comes_from_the_control_socket_and_a_dead_socket_is_an_error() {
    let tmp = tempfile::tempdir().unwrap();
    let socket = tmp.path().join("litestream.sock");
    // One global per test binary, so both cases share it: first a live
    // socket, then the same path gone.
    api::backup::init_health(tmp.path(), false, Some(socket.clone()));

    let now = time::OffsetDateTime::now_utc();
    let synced = (now - time::Duration::seconds(3))
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();
    let body = format!(
        r#"{{"databases":[{{"path":"/data/platform.db","status":"replicating","last_sync_at":"{synced}"}},
            {{"path":"/data/orgs/a.db","status":"replicating","last_sync_at":"{synced}"}}]}}"#
    );
    fake_litestream(socket.clone(), "200 OK", body);
    let h = api::backup::health().await;
    assert_eq!(h.snapshots, "off");
    assert_eq!(h.litestream, "ok");
    assert_eq!(h.litestream_databases, 2);
    let lag = h.litestream_lag_seconds.unwrap();
    assert!((3..6).contains(&lag), "{lag}");

    std::fs::remove_file(&socket).unwrap();
    let h = api::backup::health().await;
    assert_eq!(h.litestream, "error");
    // Public: a status word, never the error text (paths, buckets).
    let body = serde_json::to_string(&h).unwrap();
    assert!(
        !body.contains("connect") && !body.contains("litestream.sock"),
        "{body}"
    );
}
