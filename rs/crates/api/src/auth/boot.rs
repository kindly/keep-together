//! Auth's settings from the environment, and what a deployed environment
//! (`KEEP_ENV=prod|staging`, or a non-loopback bind unless `KEEP_ENV=dev`)
//! refuses to boot without (S1 review H1, M2, L3, re-review R1). Any other
//! `KEEP_ENV` value is refused. A refusal is the message the boot stops
//! with.
//!
//! | var | |
//! |---|---|
//! | `KEEP_APP_ORIGIN` | the SPA's origin; required (https) when deployed |
//! | `KEEP_CLIENT_IP_HEADER` | the proxy's client-address header (`Fly-Client-IP`); required when deployed, or every client shares the proxy's rate-limit bucket. Its value counts only when it is one IP address; `X-Forwarded-For` and `Forwarded` (lists a client can prepend to) are refused |
//! | `KEEP_SETTINGS_KEY`, `KEEP_AUTH_PEPPER` | 32 bytes, base64 ([`auth::keys`]); required when deployed, and on any non-loopback bind; else the published dev keys |
//! | `KEEP_MAIL=log` | prints codes and links: only for dev (`KEEP_ENV=dev`, or unset) on a loopback bind. `KEEP_MAIL=off`: no mail, and the api refuses what needs it (refused in prod). `KEEP_MAIL_ONLY_TO`: mail only those recipients, anyone else as if off (staging; refused in prod) |
//! | `KEEP_DEV_AUTH=1` | refused when deployed |

use std::net::IpAddr;

use auth::Keys;
use comms::mail::Mailer;

use super::{Config, Runtime, dev_auth_refused};

/// The auth runtime the environment describes, reading variables through
/// `var`, for a server bound to `bind`. `Err` names what to fix.
pub fn runtime(var: impl Fn(&str) -> Option<String>, bind: IpAddr) -> Result<Runtime, String> {
    let keep_env = var("KEEP_ENV");
    if !matches!(keep_env.as_deref(), None | Some("dev" | "staging" | "prod")) {
        return Err(format!(
            "KEEP_ENV={:?}: expected dev, staging or prod",
            keep_env.unwrap_or_default()
        ));
    }
    // Deployed: staging or prod, or any reachable bind not explicitly dev,
    // so a machine missing KEEP_ENV gets every deployed rule (re-review R1).
    let deployed = dev_auth_refused(keep_env.as_deref())
        || (!bind.is_loopback() && keep_env.as_deref() != Some("dev"));
    if deployed && var("KEEP_DEV_AUTH").as_deref() == Some("1") {
        return Err(
            "KEEP_DEV_AUTH=1 is refused when deployed (KEEP_ENV=prod|staging, or a reachable bind)"
                .into(),
        );
    }

    let mailer = Mailer::from_vars(&var).map_err(|e| format!("mail settings: {e}"))?;
    if mailer.is_off() && keep_env.as_deref() == Some("prod") {
        return Err("KEEP_MAIL=off is refused with KEEP_ENV=prod: resets, notices and invites need mail. Set KEEP_MAIL=smtp".into());
    }
    if mailer.is_restricted() && keep_env.as_deref() == Some("prod") {
        return Err(
            "KEEP_MAIL_ONLY_TO is refused with KEEP_ENV=prod: production mails everyone. Unset it"
                .into(),
        );
    }
    // Dev is KEEP_ENV=dev, or unset (a local `cargo run`); a deployed
    // machine also binds a reachable address.
    let dev = matches!(keep_env.as_deref(), None | Some("dev"));
    if mailer.is_log() && !(dev && bind.is_loopback()) {
        return Err(
            "KEEP_MAIL=log writes sign-in codes and links to the log: only for dev \
             (KEEP_ENV=dev or unset) on a loopback bind. Set KEEP_MAIL=smtp, or off"
                .into(),
        );
    }

    let mut config = Config::default();
    match var("KEEP_APP_ORIGIN") {
        Some(origin) => {
            let origin = origin.trim_end_matches('/').to_owned();
            if deployed && !origin.starts_with("https://") {
                return Err(format!(
                    "KEEP_APP_ORIGIN={origin:?} must be https when deployed"
                ));
            }
            config.app_origin = origin;
        }
        None if deployed => {
            return Err("KEEP_APP_ORIGIN is required when deployed (links in emails)".into());
        }
        None => {}
    }
    match var("KEEP_CLIENT_IP_HEADER") {
        Some(name) => {
            let header: axum::http::HeaderName = name
                .parse()
                .map_err(|_| format!("KEEP_CLIENT_IP_HEADER={name:?} is not a header name"))?;
            if matches!(header.as_str(), "x-forwarded-for" | "forwarded") {
                return Err(format!(
                    "KEEP_CLIENT_IP_HEADER={name:?} is a list a client can prepend to: name \
                     the proxy's single-address header (Fly-Client-IP)"
                ));
            }
            config.client_ip_header = Some(header);
        }
        None if deployed => {
            return Err("KEEP_CLIENT_IP_HEADER is required when deployed \
                 (Fly-Client-IP on Fly): without it every client shares the proxy's \
                 rate-limit bucket"
                .into());
        }
        None => {}
    }

    let keys = match (var("KEEP_SETTINGS_KEY"), var("KEEP_AUTH_PEPPER")) {
        (Some(key), Some(pepper)) => Keys::parse(&key, &pepper).map_err(|e| e.to_string())?,
        // The published dev keys: never on a reachable bind.
        (None, None) if !deployed && bind.is_loopback() => Keys::dev(),
        _ => {
            return Err(
                "KEEP_SETTINGS_KEY and KEEP_AUTH_PEPPER are both required when deployed \
                 (KEEP_ENV=prod|staging, or a reachable bind) and never one without the other"
                    .into(),
            );
        }
    };
    Ok(Runtime::new(config, mailer).with_keys(keys))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    const LOOPBACK: IpAddr = IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);
    const ANY: IpAddr = IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED);

    fn boot(vars: &[(&str, &str)], bind: IpAddr) -> Result<Runtime, String> {
        let map: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        runtime(|k| map.get(k).cloned(), bind)
    }

    fn staging() -> Vec<(&'static str, String)> {
        vec![
            ("KEEP_ENV", "staging".into()),
            ("KEEP_MAIL", "smtp".into()),
            (
                "KEEP_APP_ORIGIN",
                "https://staging.keep-together.org.uk".into(),
            ),
            ("KEEP_CLIENT_IP_HEADER", "Fly-Client-IP".into()),
            ("KEEP_SETTINGS_KEY", Keys::generate()),
            ("KEEP_AUTH_PEPPER", Keys::generate()),
        ]
    }

    fn without(vars: &[(&'static str, String)], name: &str) -> Vec<(&'static str, String)> {
        vars.iter().filter(|(k, _)| *k != name).cloned().collect()
    }

    fn boot_owned(vars: &[(&'static str, String)], bind: IpAddr) -> Result<Runtime, String> {
        let borrowed: Vec<(&str, &str)> = vars.iter().map(|(k, v)| (*k, v.as_str())).collect();
        boot(&borrowed, bind)
    }

    /// H1: staging as configured in fly.staging.toml (plus its secrets)
    /// boots, and refuses without any one of the settings.
    #[test]
    fn a_deployed_environment_needs_every_auth_setting() {
        let ok = boot_owned(&staging(), ANY).expect("staging boots");
        assert_eq!(
            ok.config.client_ip_header.as_ref().map(|h| h.as_str()),
            Some("fly-client-ip")
        );
        for name in [
            "KEEP_APP_ORIGIN",
            "KEEP_CLIENT_IP_HEADER",
            "KEEP_SETTINGS_KEY",
            "KEEP_AUTH_PEPPER",
            "KEEP_MAIL",
        ] {
            let err = boot_owned(&without(&staging(), name), ANY)
                .err()
                .unwrap_or_else(|| panic!("boots without {name}"));
            let named = if name == "KEEP_MAIL" {
                "KEEP_MAIL=log"
            } else {
                name
            };
            assert!(err.contains(named), "{name}: {err}");
        }
        let mut prod = staging();
        prod[0].1 = "prod".into();
        assert!(boot_owned(&prod, ANY).is_ok());
        assert!(boot_owned(&without(&prod, "KEEP_CLIENT_IP_HEADER"), ANY).is_err());

        let mut http = staging();
        http[2].1 = "http://staging.keep-together.org.uk".into();
        assert!(boot_owned(&http, ANY).err().unwrap().contains("https"));
        let mut dev_auth = staging();
        dev_auth.push(("KEEP_DEV_AUTH", "1".into()));
        assert!(boot_owned(&dev_auth, ANY).is_err());
        let mut bad_key = staging();
        bad_key[4].1 = "short".into();
        assert!(boot_owned(&bad_key, ANY).is_err());
    }

    /// H1: `fly.staging.toml`'s own `[env]`, plus the secrets
    /// `scripts/fly/staging.sh` sets, boots; without the secrets it
    /// doesn't.
    #[test]
    fn fly_staging_toml_boots_with_its_secrets() {
        let toml = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fly.staging.toml"),
        )
        .unwrap();
        let mut vars: Vec<(&'static str, String)> = vec![];
        let mut in_env = false;
        for line in toml.lines().map(str::trim) {
            if line.starts_with('[') {
                in_env = line == "[env]";
            } else if in_env && let Some((k, v)) = line.split_once(" = ") {
                let k: &'static str = Box::leak(k.trim().to_owned().into_boxed_str());
                vars.push((k, v.trim().trim_matches('"').to_owned()));
            }
        }
        for k in [
            "KEEP_ENV",
            "KEEP_APP_ORIGIN",
            "KEEP_CLIENT_IP_HEADER",
            "KEEP_MAIL",
        ] {
            assert!(
                vars.iter().any(|(n, _)| *n == k),
                "fly.staging.toml lacks {k}"
            );
        }
        assert!(boot_owned(&vars, ANY).is_err(), "no keys yet");
        vars.push(("KEEP_SETTINGS_KEY", Keys::generate()));
        vars.push(("KEEP_AUTH_PEPPER", Keys::generate()));
        let rt = boot_owned(&vars, ANY).expect("boots");
        assert_eq!(rt.config.app_origin, "https://staging.keep-together.org.uk");
    }

    /// L3: the log mailer only for dev.
    #[test]
    fn the_log_mailer_is_for_dev_only() {
        assert!(
            boot(&[], LOOPBACK).is_ok(),
            "local dev: KEEP_ENV unset, loopback"
        );
        assert!(boot(&[("KEEP_ENV", "dev")], LOOPBACK).is_ok());
        assert!(boot(&[("KEEP_ENV", "dev")], ANY).is_err(), "reachable");
        assert!(
            boot(&[], ANY).is_err(),
            "KEEP_ENV unset on a reachable bind (a deployed machine missing it)"
        );
        assert!(boot(&[("KEEP_ENV", "test")], LOOPBACK).is_err());
        let mut st = staging();
        st[1].1 = "log".into();
        assert!(boot_owned(&st, ANY).is_err());
        // C8: staging runs with no mail at all until SES is set up.
        st[1].1 = "off".into();
        assert!(boot_owned(&st, ANY).is_ok_and(|rt| rt.mailer.is_off()));
    }

    /// C9: a list header is refused by name.
    #[test]
    fn a_forwarded_for_header_is_refused() {
        for name in ["X-Forwarded-For", "forwarded"] {
            let mut st = staging();
            st[3].1 = name.into();
            let err = boot_owned(&st, ANY).err().unwrap();
            assert!(err.contains("Fly-Client-IP"), "{name}: {err}");
        }
    }

    /// R1: a reachable bind is deployed unless KEEP_ENV=dev says so, an
    /// unknown KEEP_ENV is refused, and the dev keys never leave loopback.
    #[test]
    fn a_reachable_bind_is_deployed_unless_dev() {
        let mut st = staging();
        st.remove(0);
        let err = boot_owned(&without(&st, "KEEP_CLIENT_IP_HEADER"), ANY)
            .err()
            .unwrap();
        assert!(err.contains("KEEP_CLIENT_IP_HEADER"), "{err}");
        let err = boot_owned(&without(&st, "KEEP_SETTINGS_KEY"), ANY)
            .err()
            .unwrap();
        assert!(err.contains("KEEP_SETTINGS_KEY"), "{err}");
        assert!(boot_owned(&st, ANY).is_ok(), "unset KEEP_ENV, all set");
        for bad in ["production", "Prod", "test"] {
            let mut v = staging();
            v[0].1 = bad.into();
            assert!(
                boot_owned(&v, ANY).err().unwrap().contains("KEEP_ENV"),
                "{bad}"
            );
        }
        // Dev in a container: no deployed rules, but no dev keys either.
        let dev = [("KEEP_ENV", "dev"), ("KEEP_MAIL", "smtp")];
        assert!(boot(&dev, ANY).err().unwrap().contains("KEEP_SETTINGS_KEY"));
        let (k, p) = (Keys::generate(), Keys::generate());
        let mut keyed = dev.to_vec();
        keyed.push(("KEEP_SETTINGS_KEY", &k));
        keyed.push(("KEEP_AUTH_PEPPER", &p));
        assert!(boot(&keyed, ANY).is_ok());
    }

    /// R2: no mail is for staging, never prod.
    #[test]
    fn mail_off_is_refused_in_prod() {
        let mut prod = staging();
        prod[0].1 = "prod".into();
        prod[1].1 = "off".into();
        assert!(
            boot_owned(&prod, ANY)
                .err()
                .unwrap()
                .contains("KEEP_MAIL=off")
        );
    }

    /// Only staging mails a short list; prod mails everyone.
    #[test]
    fn mail_only_to_is_refused_in_prod() {
        let mut st = staging();
        st.push(("KEEP_MAIL_ONLY_TO", "@example.org".into()));
        assert!(boot_owned(&st, ANY).is_ok_and(|rt| rt.mailer.is_restricted()));
        let mut prod = st.clone();
        prod[0].1 = "prod".into();
        assert!(
            boot_owned(&prod, ANY)
                .err()
                .unwrap()
                .contains("KEEP_MAIL_ONLY_TO")
        );
        // A malformed list stops any boot.
        let mut bad = st;
        bad.last_mut().unwrap().1 = "@example.org,".into();
        assert!(
            boot_owned(&bad, ANY)
                .err()
                .unwrap()
                .contains("KEEP_MAIL_ONLY_TO")
        );
    }

    /// Local dev runs with the published dev keys; half a pair is refused.
    #[test]
    fn keys_come_in_pairs() {
        assert!(boot(&[], LOOPBACK).is_ok());
        let key = Keys::generate();
        assert!(boot(&[("KEEP_SETTINGS_KEY", key.as_str())], LOOPBACK).is_err());
    }
}
