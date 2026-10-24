//! Security notices to the account's own address (S1 review M3, ASVS
//! 2.5.5 and 2.2.3): a change to the password, the second factor or the
//! recovery codes, a 2FA reset, and a locked second factor. Transactional
//! (`comms::mail`): never held back by marketing suppression (rule 5).
//! Each says what happened and what to do if it wasn't you.

use comms::mail::Mail;

use crate::SecondFactor;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Notice {
    PasswordChanged,
    PasswordReset,
    /// A second factor was set up or changed.
    FactorSet(SecondFactor),
    RecoveryCodesRenewed,
    /// An admin of the group (or the operator) reset the second factor.
    FactorReset,
    /// Too many wrong codes: the second factor is locked for an hour.
    Locked,
}

/// The mail for `notice`, to `to`. `app_origin` is the SPA's origin.
pub fn mail(to: &str, notice: Notice, app_origin: &str) -> Mail {
    let reset = format!("{app_origin}/reset");
    let not_you = format!(
        "If this wasn't you, someone else may be able to sign in as you: reset your password now at {reset} and tell your group's admin."
    );
    let (subject, body) = match notice {
        Notice::PasswordChanged => (
            "Your keep-together password was changed",
            format!(
                "The password for this address was just changed, and every other session was signed out.\n\n{not_you}"
            ),
        ),
        Notice::PasswordReset => (
            "Your keep-together password was reset",
            format!(
                "The password for this address was just reset by email link, and every session was signed out.\n\n{not_you}"
            ),
        ),
        Notice::FactorSet(f) => (
            "Your keep-together second factor was set up",
            format!(
                "Your account's second factor is now {}, with new recovery codes (the old ones no longer work).\n\n{not_you}",
                match f {
                    SecondFactor::Totp => "an authenticator app",
                    SecondFactor::Email => "a code emailed to this address",
                }
            ),
        ),
        Notice::RecoveryCodesRenewed => (
            "New keep-together recovery codes",
            format!(
                "New recovery codes were made for your account; the old ones no longer work.\n\n{not_you}"
            ),
        ),
        Notice::FactorReset => (
            "Your keep-together second factor was reset",
            format!(
                "Your account's second factor and recovery codes were removed, and every session was signed out. Next time you sign in you'll set up a new one; a code will be emailed here to confirm it's you.\n\nIf you didn't ask for this, reply to your group's admin straight away, and reset your password at {reset}."
            ),
        ),
        Notice::Locked => (
            "Too many wrong keep-together codes",
            format!(
                "Someone entered too many wrong sign-in codes for your account, after giving its password. Signing in is paused for an hour.\n\nIf this wasn't you, your password is known to someone else: reset it now at {reset}."
            ),
        ),
    };
    Mail {
        to: to.into(),
        subject: subject.into(),
        text: format!("{body}\n"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_notice_says_what_to_do_and_carries_no_code() {
        for n in [
            Notice::PasswordChanged,
            Notice::PasswordReset,
            Notice::FactorSet(SecondFactor::Totp),
            Notice::FactorSet(SecondFactor::Email),
            Notice::RecoveryCodesRenewed,
            Notice::FactorReset,
            Notice::Locked,
        ] {
            let m = mail("ann@alpha.org", n, "https://app.test");
            assert!(m.text.contains("https://app.test/reset"), "{n:?}");
            assert!(!m.subject.contains("code:"), "{n:?}");
        }
    }
}
