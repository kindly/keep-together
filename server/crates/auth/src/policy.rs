//! `KEEP_AUTH_POLICY`: how much a sign-in asks for, per deployment (never
//! per organisation). ADR 0020's amendment of 2026-10-25.
//!
//! - `strict` (the default): a second factor is required, admin actions
//!   need a sign-in or step-up within the hour, new passwords follow
//!   [`password::problem`].
//! - `relaxed`, for the tailnet preview and local runs reached over the
//!   network: a password alone signs in (a user who has enrolled a second
//!   factor is still asked for it), no step-up, and any non-empty
//!   password up to [`password::MAX_LEN`] is accepted. Hashing, rate
//!   limits, sessions, invites and roles are as strict. `KEEP_ENV=prod`
//!   refuses it (`api::auth::boot`).

use serde::Serialize;

use crate::password;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Policy {
    #[default]
    Strict,
    Relaxed,
}

impl Policy {
    /// `KEEP_AUTH_POLICY`'s value: unset or `strict`, or `relaxed`.
    /// Anything else is refused, naming the variable.
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        match value {
            None | Some("strict") => Ok(Policy::Strict),
            Some("relaxed") => Ok(Policy::Relaxed),
            Some(other) => Err(format!(
                "KEEP_AUTH_POLICY={other:?}: expected strict or relaxed"
            )),
        }
    }

    pub fn is_relaxed(self) -> bool {
        self == Policy::Relaxed
    }

    /// For a response: `None` under strict (the field is left out, so a
    /// strict answer is as it was before relaxed existed).
    pub fn shown(self) -> Option<Policy> {
        self.is_relaxed().then_some(self)
    }

    /// Why a new password is refused under this policy.
    pub fn password_problem(self, password: &str) -> Option<&'static str> {
        match self {
            Policy::Strict => password::problem(password),
            Policy::Relaxed if password.is_empty() => Some("Enter a password."),
            Policy::Relaxed if password.chars().count() > password::MAX_LEN => {
                Some("Password must be at most 128 characters.")
            }
            Policy::Relaxed => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_two_tiers_only() {
        assert_eq!(Policy::parse(None), Ok(Policy::Strict));
        assert_eq!(Policy::parse(Some("strict")), Ok(Policy::Strict));
        assert_eq!(Policy::parse(Some("relaxed")), Ok(Policy::Relaxed));
        for bad in ["", "demo", "Relaxed", "off"] {
            assert!(
                Policy::parse(Some(bad))
                    .unwrap_err()
                    .contains("KEEP_AUTH_POLICY")
            );
        }
    }

    #[test]
    fn relaxed_takes_any_non_empty_password() {
        assert!(Policy::Strict.password_problem("riverside").is_some());
        assert_eq!(Policy::Relaxed.password_problem("riverside"), None);
        assert_eq!(Policy::Relaxed.password_problem("x"), None);
        assert!(Policy::Relaxed.password_problem("").is_some());
        assert!(Policy::Relaxed.password_problem(&"a".repeat(129)).is_some());
    }
}
