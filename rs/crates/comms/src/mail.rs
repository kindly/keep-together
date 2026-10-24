//! The mail transport: SMTP via `lettre` (SES London's SMTP endpoint in
//! production, Mailpit at `localhost:1025` in dev), the log, or memory
//! (tests). Transactional only: what goes through here never consults
//! marketing suppression (rule 5).
//!
//! Env (`Mailer::from_env`):
//!
//! | var | |
//! |---|---|
//! | `KEEP_MAIL` | `log` (default: print each message to stderr), `smtp` |
//! | `KEEP_SMTP_URL` | `smtp://localhost:1025` (Mailpit, default), `smtp://USER:PASS@email-smtp.eu-west-2.amazonaws.com:587?tls=required` (SES) |
//! | `KEEP_MAIL_FROM` | `keep-together <no-reply@auth.keep-together.org.uk>` |

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
    Log,
    Memory(Outbox),
    Smtp(AsyncSmtpTransport<Tokio1Executor>),
}

#[derive(Clone)]
pub struct Mailer {
    from: Mailbox,
    transport: Transport,
}

#[derive(Debug, thiserror::Error)]
pub enum MailError {
    #[error("address {0:?}: {1}")]
    Address(String, String),
    #[error("message: {0}")]
    Message(String),
    #[error("smtp: {0}")]
    Smtp(String),
}

impl Mailer {
    /// Messages go to stderr: dev, and staging until SES is set up.
    pub fn log() -> Self {
        Self {
            from: DEFAULT_FROM.parse().expect("default from"),
            transport: Transport::Log,
        }
    }

    /// Messages are kept in the returned outbox (tests).
    pub fn memory() -> (Self, Outbox) {
        let outbox = Outbox::default();
        (
            Self {
                from: DEFAULT_FROM.parse().expect("default from"),
                transport: Transport::Memory(outbox.clone()),
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
        })
    }

    /// From `KEEP_MAIL`, `KEEP_SMTP_URL`, `KEEP_MAIL_FROM` (module docs).
    pub fn from_env() -> Result<Self, MailError> {
        Self::from_vars(|name| std::env::var(name).ok())
    }

    /// As [`Mailer::from_env`], reading variables through `var`.
    pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> Result<Self, MailError> {
        let from = var("KEEP_MAIL_FROM").unwrap_or_else(|| DEFAULT_FROM.into());
        match var("KEEP_MAIL").as_deref() {
            Some("smtp") => {
                let url = var("KEEP_SMTP_URL").unwrap_or_else(|| DEFAULT_SMTP_URL.into());
                Self::smtp(&url, &from)
            }
            Some("log") | None => Ok(Self {
                from: from.parse().map_err(|e: lettre::address::AddressError| {
                    MailError::Address(from.clone(), e.to_string())
                })?,
                transport: Transport::Log,
            }),
            Some(other) => Err(MailError::Smtp(format!(
                "KEEP_MAIL={other:?}: expected log or smtp"
            ))),
        }
    }

    /// Whether this mailer only logs (refused in production).
    pub fn is_log(&self) -> bool {
        matches!(self.transport, Transport::Log)
    }

    pub async fn send(&self, mail: Mail) -> Result<(), MailError> {
        match &self.transport {
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
