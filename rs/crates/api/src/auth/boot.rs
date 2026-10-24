//! Auth's settings from the environment, and what a deployed environment
//! (`KEEP_ENV=prod|staging`) refuses to boot without (S1 review H1, M2,
//! L3). A refusal is the message the boot stops with.
//!
//! | var | |
//! |---|---|
//! | `KEEP_APP_ORIGIN` | the SPA's origin; required (https) when deployed |
//! | `KEEP_CLIENT_IP_HEADER` | the proxy's client-address header (`Fly-Client-IP`); required when deployed, or every client shares the proxy's rate-limit bucket. Its value counts only when it is one IP address |
//! | `KEEP_SETTINGS_KEY`, `KEEP_AUTH_PEPPER` | 32 bytes, base64 ([`auth::keys`]); required when deployed, else the published dev keys |
//! | `KEEP_MAIL=log` | prints codes and links: only with `KEEP_ENV=dev`, or `KEEP_ENV` unset on a loopback bind |
//! | `KEEP_DEV_AUTH=1` | refused when deployed |

use std::net::IpAddr;

use auth::Keys;
use comms::mail::Mailer;

use super::{Config, Runtime, dev_auth_refused};

/// The auth runtime the environment describes, reading variables through
/// `var`, for a server bound to `bind`. `Err` names what to fix.
pub fn runtime(var: impl Fn(&str) -> Option<String>, bind: IpAddr) -> Result<Runtime, String> {
    let keep_env = var("KEEP_ENV");
    let deployed = dev_auth_refused(keep_env.as_deref());
    if deployed && var("KEEP_DEV_AUTH").as_deref() == Some("1") {
        return Err("KEEP_DEV_AUTH=1 is refused with KEEP_ENV=prod|staging".into());
    }

    let mailer = Mailer::from_vars(&var).map_err(|e| format!("mail settings: {e}"))?;
    let log_allowed =
        keep_env.as_deref() == Some("dev") || (keep_env.is_none() && bind.is_loopback());
    if mailer.is_log() && !log_allowed {
        return Err(
            "KEEP_MAIL=log writes sign-in codes and links to the log: it needs KEEP_ENV=dev \
             (or KEEP_ENV unset on a loopback bind). Set KEEP_MAIL=smtp"
                .into(),
        );
    }

    let mut config = Config::default();
    match var("KEEP_APP_ORIGIN") {
        Some(origin) => {
            let origin = origin.trim_end_matches('/').to_owned();
            if deployed && !origin.starts_with("https://") {
                return Err(format!(
                    "KEEP_APP_ORIGIN={origin:?} must be https with KEEP_ENV=prod|staging"
                ));
            }
            config.app_origin = origin;
        }
        None if deployed => {
            return Err(
                "KEEP_APP_ORIGIN is required with KEEP_ENV=prod|staging (links in emails)".into(),
            );
        }
        None => {}
    }
    match var("KEEP_CLIENT_IP_HEADER") {
        Some(name) => {
            config.client_ip_header = Some(
                name.parse()
                    .map_err(|_| format!("KEEP_CLIENT_IP_HEADER={name:?} is not a header name"))?,
            );
        }
        None if deployed => {
            return Err(
                "KEEP_CLIENT_IP_HEADER is required with KEEP_ENV=prod|staging \
                 (Fly-Client-IP on Fly): without it every client shares the proxy's \
                 rate-limit bucket"
                    .into(),
            );
        }
        None => {}
    }

    let keys = match (var("KEEP_SETTINGS_KEY"), var("KEEP_AUTH_PEPPER")) {
        (Some(key), Some(pepper)) => Keys::parse(&key, &pepper).map_err(|e| e.to_string())?,
        (None, None) if !deployed => Keys::dev(),
        _ => {
            return Err(
                "KEEP_SETTINGS_KEY and KEEP_AUTH_PEPPER are both required with \
                 KEEP_ENV=prod|staging (and never one without the other)"
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

    /// L3: the log mailer only for dev.
    #[test]
    fn the_log_mailer_is_for_dev_only() {
        assert!(
            boot(&[], LOOPBACK).is_ok(),
            "local dev: KEEP_ENV unset, loopback"
        );
        assert!(boot(&[("KEEP_ENV", "dev")], ANY).is_ok());
        assert!(
            boot(&[], ANY).is_err(),
            "KEEP_ENV unset on a reachable bind (a deployed machine missing it)"
        );
        assert!(boot(&[("KEEP_ENV", "test")], LOOPBACK).is_err());
        let mut st = staging();
        st[1].1 = "log".into();
        assert!(boot_owned(&st, ANY).is_err());
    }

    /// Local dev runs with the published dev keys; half a pair is refused.
    #[test]
    fn keys_come_in_pairs() {
        assert!(boot(&[], LOOPBACK).is_ok());
        let key = Keys::generate();
        assert!(boot(&[("KEEP_SETTINGS_KEY", key.as_str())], LOOPBACK).is_err());
    }
}
