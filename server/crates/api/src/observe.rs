//! Error reporting to Sentry (EU region), on when `SENTRY_DSN` is set.
//! Panics and [`error`] calls are sent; request bodies, cookies, headers,
//! query strings, users and anything shaped like an email address never
//! are. `KEEP_ENV` names the environment.

use std::sync::Arc;

use sentry::protocol::Event;

/// Keep the guard alive for the life of the process (it flushes on drop).
pub fn init_sentry() -> Option<sentry::ClientInitGuard> {
    let dsn = std::env::var("SENTRY_DSN").ok().filter(|v| !v.is_empty())?;
    let mut options = sentry::ClientOptions::default();
    options.release = sentry::release_name!();
    options.environment = std::env::var("KEEP_ENV").ok().map(Into::into);
    options.send_default_pii = false;
    options.before_send = Some(Arc::new(|event| Some(scrub(event))));
    let guard = sentry::init((dsn, options));
    guard.is_enabled().then_some(guard)
}

/// Log an error and send it to Sentry (a no-op there when it's off).
pub fn error(message: &str) {
    eprintln!("error: {message}");
    sentry::capture_message(message, sentry::Level::Error);
}

/// Log a warning and send it to Sentry.
pub fn warning(message: &str) {
    eprintln!("warning: {message}");
    sentry::capture_message(message, sentry::Level::Warning);
}

fn scrub(mut event: Event<'static>) -> Event<'static> {
    event.user = None;
    if let Some(req) = event.request.as_mut() {
        req.data = None;
        req.cookies = None;
        req.headers.clear();
        req.query_string = None;
        req.env.clear();
        // A phone pairing's token is in its path (`/api/scan/{token}`).
        if let Some(url) = req.url.as_mut() {
            let path = redact_scan_tokens(url.path());
            url.set_path(&path);
        }
    }
    let redact = |m: &str| redact_scan_tokens(&redact_emails(m));
    event.message = event.message.map(|m| redact(&m));
    for exception in event.exception.values.iter_mut() {
        exception.value = exception.value.as_deref().map(redact);
    }
    for crumb in event.breadcrumbs.values.iter_mut() {
        crumb.message = crumb.message.as_deref().map(redact);
        crumb.data.clear();
    }
    event.extra.clear();
    event
}

/// Every whitespace-separated word with an `@` between two characters
/// becomes `[email]`.
fn redact_emails(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String| {
        let at = word.find('@');
        if at.is_some_and(|i| i > 0 && i + 1 < word.len()) {
            out.push_str("[email]");
        } else {
            out.push_str(word);
        }
        word.clear();
    };
    for c in text.chars() {
        if c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | ',' | '(' | ')') {
            flush(&mut word, &mut out);
            out.push(c);
        } else {
            word.push(c);
        }
    }
    flush(&mut word, &mut out);
    out
}

/// Every `/api/scan/<token>` becomes `/api/scan/[token]`, and any other
/// 64-hex run (a token's shape) `[token]`.
pub fn redact_scan_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut String| {
        if run.len() == 64 {
            out.push_str("[token]");
        } else {
            out.push_str(run);
        }
        run.clear();
    };
    for c in text.chars() {
        if c.is_ascii_hexdigit() {
            run.push(c);
        } else {
            flush(&mut run, &mut out);
            out.push(c);
        }
    }
    flush(&mut run, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use sentry::protocol::{Exception, Request, User};

    use super::*;

    #[test]
    fn scan_tokens_are_redacted() {
        let token = "ab".repeat(32);
        assert_eq!(
            redact_scan_tokens(&format!("GET /api/scan/{token}/scans x")),
            "GET /api/scan/[token]/scans x"
        );
        // A 32-hex id is no token.
        let id = "0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0";
        assert_eq!(redact_scan_tokens(id), id);
    }

    #[test]
    fn emails_are_redacted() {
        assert_eq!(
            redact_emails("no user \"ada@example.com\" (b@x.org), @handle a@"),
            "no user \"[email]\" ([email]), @handle a@"
        );
    }

    #[test]
    fn events_lose_users_bodies_and_cookies() {
        let event = Event {
            user: Some(User {
                email: Some("ada@example.com".into()),
                ..Default::default()
            }),
            request: Some(Request {
                data: Some(r#"{"email":"ada@example.com"}"#.into()),
                cookies: Some("kt_session=secret".into()),
                query_string: Some("q=ada".into()),
                headers: [("cookie".to_owned(), "kt_session=secret".to_owned())].into(),
                ..Default::default()
            }),
            message: Some("save failed for ada@example.com".into()),
            exception: vec![Exception {
                value: Some("duplicate b@example.org".into()),
                ..Default::default()
            }]
            .into(),
            ..Default::default()
        };
        let out = scrub(event);
        assert!(out.user.is_none());
        let req = out.request.unwrap();
        assert!(req.data.is_none() && req.cookies.is_none() && req.query_string.is_none());
        assert!(req.headers.is_empty());
        assert_eq!(out.message.as_deref(), Some("save failed for [email]"));
        assert_eq!(
            out.exception.values[0].value.as_deref(),
            Some("duplicate [email]")
        );
    }
}
