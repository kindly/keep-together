//! `keep dev seed-riverside`: the binary end to end (the world itself is
//! `seed`'s tests).

use std::process::Command;

fn keep(data: &std::path::Path, keep_env: Option<&str>) -> std::process::Output {
    keep_with(data, keep_env, &[])
}

fn keep_with(
    data: &std::path::Path,
    keep_env: Option<&str>,
    vars: &[(&str, String)],
) -> std::process::Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_keep"));
    cmd.arg("--data").arg(data).args(["dev", "seed-riverside"]);
    cmd.env_remove("KEEP_ENV")
        .env_remove("KEEP_SETTINGS_KEY")
        .env_remove("KEEP_AUTH_PEPPER");
    for (k, v) in vars {
        cmd.env(k, v);
    }
    for role in ["ADMIN", "STAFF", "VIEWER"] {
        for what in ["PASSWORD", "TOTP"] {
            cmd.env_remove(format!("KEEP_RIVERSIDE_{role}_{what}"));
        }
    }
    if let Some(e) = keep_env {
        cmd.env("KEEP_ENV", e);
    }
    cmd.output().unwrap()
}

#[test]
fn refused_unless_keep_env_is_dev_or_staging_then_prints_the_sign_ins() {
    let tmp = tempfile::tempdir().unwrap();
    for env in [None, Some("prod")] {
        let out = keep(tmp.path(), env);
        assert!(!out.status.success());
        assert!(String::from_utf8_lossy(&out.stderr).contains("KEEP_ENV"));
    }
    // Staging needs the api's keys (no dev keys there)...
    let out = keep(tmp.path(), Some("staging"));
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("KEEP_SETTINGS_KEY"));
    // ...and every credential from env.
    let keys = [
        ("KEEP_SETTINGS_KEY", auth::Keys::generate()),
        ("KEEP_AUTH_PEPPER", auth::Keys::generate()),
    ];
    let out = keep_with(tmp.path(), Some("staging"), &keys);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("KEEP_RIVERSIDE_ADMIN_PASSWORD"));

    let out = keep(tmp.path(), Some("dev"));
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.starts_with("created riverside"), "{text}");
    assert!(text.contains("100 donors created"), "{text}");
    for email in ["admin@", "staff@", "viewer@"] {
        let line = text.lines().find(|l| l.contains(email)).unwrap();
        assert!(
            line.contains("password ") && line.contains("totp "),
            "{line}"
        );
    }
    let again = keep(tmp.path(), Some("dev"));
    let text = String::from_utf8_lossy(&again.stdout);
    assert!(text.starts_with("updated riverside"), "{text}");
    assert!(text.contains(": 0 donors created"));
    // Review L2: a re-run keeps the sign-ins it printed the first time.
    assert_eq!(
        text.matches("password (unchanged)  totp (unchanged)")
            .count(),
        3,
        "{text}"
    );
}
