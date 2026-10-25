//! The mail transport: SMTP via `lettre` (SES London's SMTP endpoint in
//! production, Mailpit at `localhost:1025` in dev), the log, or memory
//! (tests). Transactional only: what goes through here never consults
//! marketing suppression (rule 5).
//!
//! Env (`Mailer::from_env`):
//!
//! | var | |
//! |---|---|
//! | `KEEP_MAIL` | `log` (default: print each message to stderr), `smtp`, `off` (no mail at all: the api refuses what needs it) |
//! | `KEEP_SMTP_URL` | `smtp://localhost:1025` (Mailpit, default), `smtp://USER:PASS@email-smtp.eu-west-2.amazonaws.com:587?tls=required` (SES) |
//! | `KEEP_MAIL_FROM` | `keep-together <no-reply@auth.keep-together.org.uk>` |
//! | `KEEP_MAIL_ONLY_TO` | unset (everyone); else `a@example.org,@example.com`: full addresses or `@domain`, exact and case-insensitive (no wildcards, no subdomains). Mail to anyone else is mail off for them (staging; refused in prod) |

use std::sync::{Arc, Mutex};

use lettre::message::Mailbox;
use lettre::message::header::ContentType;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

pub const DEFAULT_FROM: &str = "keep-together <no-reply@auth.keep-together.org.uk>";
pub const DEFAULT_SMTP_URL: &str = "smtp://localhost:1025";

/// One plain-text message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mail {
    pub to: String,
    pub subject: String,
    pub text: String,
}

/// What a memory transport has sent, for tests.
pub type Outbox = Arc<Mutex<Vec<Mail>>>;

#[derive(Clone)]
enum Transport {
    Off,
    Log,
    Memory(Outbox),
    Smtp(AsyncSmtpTransport<Tokio1Executor>),
}

#[derive(Clone)]
pub struct Mailer {
    from: Mailbox,
    transport: Transport,
    /// `KEEP_MAIL_ONLY_TO`, lower-cased: who may be mailed (`None`: anyone).
    only_to: Option<Vec<String>>,
}

#[derive(Debug, thiserror::Error)]
pub enum MailError {
    #[error("address {0:?}: {1}")]
    Address(String, String),
    #[error("message: {0}")]
    Message(String),
    #[error("smtp: {0}")]
    Smtp(String),
    #[error("mail is off for this recipient (KEEP_MAIL=off, or not in KEEP_MAIL_ONLY_TO)")]
    Off,
    #[error("KEEP_MAIL_ONLY_TO entry {0:?}: {1}")]
    OnlyTo(String, String),
}

impl Mailer {
    /// Messages go to stderr: dev, and staging until SES is set up.
    pub fn log() -> Self {
        Self {
            from: DEFAULT_FROM.parse().expect("default from"),
            transport: Transport::Log,
            only_to: None,
        }
    }

    /// Messages are kept in the returned outbox (tests).
    pub fn memory() -> (Self, Outbox) {
        let outbox = Outbox::default();
        (
            Self {
                from: DEFAULT_FROM.parse().expect("default from"),
                transport: Transport::Memory(outbox.clone()),
                only_to: None,
            },
            outbox,
        )
    }

    /// SMTP to `url` (lettre's connection URL), sending as `from`.
    pub fn smtp(url: &str, from: &str) -> Result<Self, MailError> {
        let transport = AsyncSmtpTransport::<Tokio1Executor>::from_url(url)
            .map_err(|e| MailError::Smtp(e.to_string()))?
            .build();
        Ok(Self {
            from: from.parse().map_err(|e: lettre::address::AddressError| {
                MailError::Address(from.into(), e.to_string())
            })?,
            transport: Transport::Smtp(transport),
            only_to: None,
        })
    }

    /// From `KEEP_MAIL`, `KEEP_SMTP_URL`, `KEEP_MAIL_FROM`,
    /// `KEEP_MAIL_ONLY_TO` (module docs).
    pub fn from_env() -> Result<Self, MailError> {
        Self::from_vars(|name| std::env::var(name).ok())
    }

    /// As [`Mailer::from_env`], reading variables through `var`.
    pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> Result<Self, MailError> {
        let from = var("KEEP_MAIL_FROM").unwrap_or_else(|| DEFAULT_FROM.into());
        let mailer = match var("KEEP_MAIL").as_deref() {
            Some("smtp") => {
                let url = var("KEEP_SMTP_URL").unwrap_or_else(|| DEFAULT_SMTP_URL.into());
                Self::smtp(&url, &from)
            }
            Some("off") => Ok(Self {
                from: DEFAULT_FROM.parse().expect("default from"),
                transport: Transport::Off,
                only_to: None,
            }),
            Some("log") | None => Ok(Self {
                from: from.parse().map_err(|e: lettre::address::AddressError| {
                    MailError::Address(from.clone(), e.to_string())
                })?,
                transport: Transport::Log,
                only_to: None,
            }),
            Some(other) => Err(MailError::Smtp(format!(
                "KEEP_MAIL={other:?}: expected log, smtp or off"
            ))),
        }?;
        match var("KEEP_MAIL_ONLY_TO") {
            Some(list) => mailer.only_to(&list),
            None => Ok(mailer),
        }
    }

    /// Mail only the recipients in `list` (`KEEP_MAIL_ONLY_TO`: full
    /// addresses or `@domain`, comma-separated); anyone else is as if mail
    /// were off. An empty or malformed entry is an error.
    pub fn only_to(mut self, list: &str) -> Result<Self, MailError> {
        let entries = list
            .split(',')
            .map(|entry| {
                let entry = entry.trim();
                let bad = |why: &str| Err(MailError::OnlyTo(entry.into(), why.into()));
                if entry.is_empty() {
                    return bad("empty");
                }
                if entry.chars().any(char::is_whitespace) || entry.contains(['*', '<', '>']) {
                    return bad("expected a full address or @domain, no wildcards");
                }
                match entry.split_once('@') {
                    Some((_, domain)) if domain.is_empty() || domain.contains('@') => {
                        bad("expected a full address or @domain")
                    }
                    Some(_) => Ok(entry.to_lowercase()),
                    None => bad("expected a full address or @domain"),
                }
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.only_to = Some(entries);
        Ok(self)
    }

    /// Whether `KEEP_MAIL_ONLY_TO` limits who is mailed (refused in
    /// production).
    pub fn is_restricted(&self) -> bool {
        self.only_to.is_some()
    }

    /// Whether this mailer only logs (refused in production).
    pub fn is_log(&self) -> bool {
        matches!(self.transport, Transport::Log)
    }

    /// Whether there is no mail at all (`KEEP_MAIL=off`).
    pub fn is_off(&self) -> bool {
        matches!(self.transport, Transport::Off)
    }

    /// Whether `to` gets no mail: mail is off, or `KEEP_MAIL_ONLY_TO`
    /// doesn't list it (the address, or `@` its domain; case-insensitive).
    /// Depends only on `to`, never on who has an account.
    pub fn is_off_for(&self, to: &str) -> bool {
        if self.is_off() {
            return true;
        }
        let Some(only_to) = &self.only_to else {
            return false;
        };
        let to = to.trim().to_lowercase();
        let Some((_, domain)) = to.rsplit_once('@') else {
            return true;
        };
        !only_to
            .iter()
            .any(|entry| *entry == to || entry.strip_prefix('@') == Some(domain))
    }

    pub async fn send(&self, mail: Mail) -> Result<(), MailError> {
        if self.is_off_for(&mail.to) {
            return Err(MailError::Off);
        }
        match &self.transport {
            Transport::Off => Err(MailError::Off),
            Transport::Log => {
                eprintln!(
                    "mail (KEEP_MAIL=log) to {}: {}\n{}\n",
                    mail.to, mail.subject, mail.text
                );
                Ok(())
            }
            Transport::Memory(outbox) => {
                outbox.lock().unwrap_or_else(|e| e.into_inner()).push(mail);
                Ok(())
            }
            Transport::Smtp(smtp) => {
                let to: Mailbox = mail
                    .to
                    .parse()
                    .map_err(|e: lettre::address::AddressError| {
                        MailError::Address(mail.to.clone(), e.to_string())
                    })?;
                let message = Message::builder()
                    .from(self.from.clone())
                    .to(to)
                    .subject(mail.subject)
                    .header(ContentType::TEXT_PLAIN)
                    .body(mail.text)
                    .map_err(|e| MailError::Message(e.to_string()))?;
                smtp.send(message)
                    .await
                    .map(|_| ())
                    .map_err(|e| MailError::Smtp(e.to_string()))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn memory_keeps_what_was_sent() {
        let (m, outbox) = Mailer::memory();
        m.send(Mail {
            to: "a@example.org".into(),
            subject: "s".into(),
            text: "t".into(),
        })
        .await
        .unwrap();
        assert_eq!(outbox.lock().unwrap().len(), 1);
        assert!(!m.is_log());
        assert!(Mailer::log().is_log());
    }

    fn vars(mail: &str, only_to: &str) -> Result<Mailer, MailError> {
        Mailer::from_vars(|k| match k {
            "KEEP_MAIL" => Some(mail.into()),
            "KEEP_MAIL_ONLY_TO" => Some(only_to.into()),
            _ => None,
        })
    }

    #[test]
    fn only_to_parses_addresses_and_domains() {
        let m = vars("log", " a@Example.org , @Keep.test").unwrap();
        assert!(m.is_restricted());
        assert!(!Mailer::log().is_restricted());
        for bad in [
            "",
            "a@example.org,",
            ",@x.test",
            "a@example.org,,b@example.org",
            "example.org",
            "@",
            "a@",
            "a@b@c",
            "*@example.org",
            "@*.example.org",
            "a b@example.org",
            "A <a@example.org>",
        ] {
            assert!(
                matches!(vars("log", bad), Err(MailError::OnlyTo(..))),
                "{bad:?} should be refused"
            );
        }
    }

    #[test]
    fn only_to_matches_exactly_and_ignores_case() {
        let m = vars("log", "a@example.org,@keep.test").unwrap();
        assert!(!m.is_off());
        for allowed in [
            "a@example.org",
            "A@EXAMPLE.ORG",
            " a@example.org ",
            "x@keep.test",
            "Y@Keep.Test",
        ] {
            assert!(!m.is_off_for(allowed), "{allowed:?}");
        }
        for refused in [
            "b@example.org",
            "a@example.org.evil",
            "aa@example.org",
            "x@sub.keep.test",
            "x@keep.test.evil",
            "x@notkeep.test",
            "keep.test",
            "",
        ] {
            assert!(m.is_off_for(refused), "{refused:?}");
        }
        // Without the list, everyone; with mail off, no one.
        assert!(!Mailer::log().is_off_for("b@example.org"));
        assert!(
            vars("off", "a@example.org")
                .unwrap()
                .is_off_for("a@example.org")
        );
    }

    #[tokio::test]
    async fn a_recipient_not_listed_is_never_sent_to() {
        let (m, outbox) = Mailer::memory();
        let m = m.only_to("@keep.test").unwrap();
        let mail = |to: &str| Mail {
            to: to.into(),
            subject: "s".into(),
            text: "t".into(),
        };
        assert!(matches!(
            m.send(mail("a@qc.invalid")).await,
            Err(MailError::Off)
        ));
        m.send(mail("a@keep.test")).await.unwrap();
        let sent = outbox.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].to, "a@keep.test");
    }

    #[test]
    fn smtp_urls_parse() {
        assert!(Mailer::smtp(DEFAULT_SMTP_URL, DEFAULT_FROM).is_ok());
        assert!(
            Mailer::smtp(
                "smtp://user:pass@email-smtp.eu-west-2.amazonaws.com:587?tls=required",
                DEFAULT_FROM
            )
            .is_ok()
        );
        assert!(Mailer::smtp("nonsense", DEFAULT_FROM).is_err());
    }
}
