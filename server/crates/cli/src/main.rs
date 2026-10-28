//! `keep`: the operator CLI. Data dir from `--data <dir>` or
//! `KEEP_DATA_DIR` (default `data`).
//!
//! ```text
//! keep sql <slug> "<select…>" [--json]
//! keep tenant create --slug <slug> --name <name> --admin-email <email>
//! keep auth reset-2fa <email> [--reason <text>]
//! keep auth invite <slug> <email> [--role admin|staff|viewer]
//! keep dev seed-demo [--slug <slug>] [--admin-email <email>]
//! keep dev seed-riverside
//! keep giftaid-xml <slug> <claim-id>
//! keep giftaid-xml --hmrc-sample
//! ```

use std::path::PathBuf;
use std::process::ExitCode;

use cli::sql::{self, Format};

const USAGE: &str = "usage:
  keep [--data <dir>] sql <slug> \"<select…>\" [--json]
  keep [--data <dir>] tenant create --slug <slug> --name <name> --admin-email <email>
  keep [--data <dir>] auth reset-2fa <email> [--reason <text>]
  keep [--data <dir>] auth invite <slug> <email> [--role admin|staff|viewer]
  keep [--data <dir>] dev seed-demo [--slug <slug>] [--admin-email <email>]
  keep [--data <dir>] dev seed-riverside   (KEEP_ENV=dev|staging)
  keep [--data <dir>] giftaid-xml <slug> <claim-id>   (the claim's XML on stdout, IRmark on stderr)
  keep giftaid-xml --hmrc-sample                      (HMRC's sample data: their GAValidSample.xml)";

fn fail(msg: impl std::fmt::Display) -> ExitCode {
    eprintln!("{msg}");
    ExitCode::from(1)
}

/// Send the admin's invite as the api would (`KEEP_MAIL`), or, with the
/// log mailer, print it for the operator to pass on.
fn send_invite(mail: comms::mail::Mail) -> Result<(), String> {
    send(mail, "invite")
}

/// Send `mail` (`KEEP_MAIL`), or print it with the log mailer.
fn send(mail: comms::mail::Mail, what: &str) -> Result<(), String> {
    let mailer = comms::mail::Mailer::from_env().map_err(|e| e.to_string())?;
    // Mail off for this address (KEEP_MAIL=off, or not in
    // KEEP_MAIL_ONLY_TO): the operator's own terminal.
    if mailer.is_log() || mailer.is_off_for(&mail.to) {
        println!(
            "{what} for {} (KEEP_MAIL=log/off or not in KEEP_MAIL_ONLY_TO, not sent):\n{}",
            mail.to, mail.text
        );
        return Ok(());
    }
    let to = mail.to.clone();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?
        .block_on(mailer.send(mail))
        .map_err(|e| e.to_string())?;
    println!("{what} emailed to {to}");
    Ok(())
}

/// A claim's XML to stdout (no newline added: the IRmark covers the
/// bytes as they are), its IRmark to stderr.
fn print_xml(made: Result<(String, giftaid::irmark::Irmark), String>) -> ExitCode {
    match made {
        Ok((xml, mark)) => {
            print!("{xml}");
            eprintln!("IRmark {} ({})", mark.base64, mark.base32);
            ExitCode::SUCCESS
        }
        Err(e) => fail(e),
    }
}

/// The value after `--flag`, removed from `args`.
fn take(args: &mut Vec<String>, flag: &str) -> Option<String> {
    let i = args.iter().position(|a| a == flag)?;
    args.remove(i);
    (i < args.len()).then(|| args.remove(i))
}

fn main() -> ExitCode {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let data = take(&mut args, "--data")
        .or_else(|| std::env::var("KEEP_DATA_DIR").ok())
        .map_or_else(|| PathBuf::from("data"), PathBuf::from);
    let json = match args.iter().position(|a| a == "--json") {
        Some(i) => {
            args.remove(i);
            true
        }
        None => false,
    };
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["sql", slug, query] => {
            let format = if json { Format::Json } else { Format::Csv };
            match sql::open(&data, slug).and_then(|c| sql::run(&c, query, format)) {
                Ok(out) => {
                    print!("{out}");
                    ExitCode::SUCCESS
                }
                Err(e) => fail(e),
            }
        }
        ["tenant", "create", ..] => {
            let mut rest = args[2..].to_vec();
            let (Some(slug), Some(name), Some(email)) = (
                take(&mut rest, "--slug"),
                take(&mut rest, "--name"),
                take(&mut rest, "--admin-email"),
            ) else {
                return fail(USAGE);
            };
            match cli::tenant::create(&data, &slug, &name, &email) {
                Ok(c) => {
                    println!("created {} ({}), admin {email}", c.tenant.slug, c.tenant.id);
                    match send_invite(c.invite) {
                        Ok(()) => ExitCode::SUCCESS,
                        // The organisation and the admin's membership exist;
                        // `keep auth invite <slug> <email> --role admin`
                        // sends a new link.
                        Err(e) => fail(format!("the invite wasn't sent: {e}")),
                    }
                }
                Err(e) => fail(e),
            }
        }
        ["dev", "seed-demo", ..] => {
            let mut rest = args[2..].to_vec();
            let slug = take(&mut rest, "--slug").unwrap_or_else(|| "demo".into());
            let email = take(&mut rest, "--admin-email");
            if !rest.is_empty() {
                return fail(USAGE);
            }
            let made = cli::tenant::open(&data)
                .map_err(cli::tenant::CreateError::from)
                .and_then(|store| cli::dev::seed_demo(&store, &slug, email.as_deref()));
            match made {
                Ok(d) => {
                    let t = &d.created.tenant;
                    println!(
                        "created {} ({}) with {} contacts",
                        t.slug,
                        t.id,
                        d.contact_ids.len()
                    );
                    println!("{}", d.created.invite.text);
                    ExitCode::SUCCESS
                }
                Err(e) => fail(e),
            }
        }
        ["giftaid-xml", "--hmrc-sample"] => print_xml(cli::giftaid::sample_xml()),
        ["giftaid-xml", slug, claim] => print_xml(cli::giftaid::claim_xml(&data, slug, claim)),
        ["dev", "seed-riverside"] => {
            let seeded = cli::tenant::open(&data)
                .map_err(|e| e.to_string())
                .and_then(|store| cli::dev::seed_riverside(&store).map_err(|e| e.to_string()));
            match seeded {
                Ok((s, credentials)) => {
                    let t = &s.tenant;
                    println!(
                        "{} {} ({}): {} donors created",
                        if s.created { "created" } else { "updated" },
                        t.slug,
                        t.id,
                        s.donors_created
                    );
                    for c in credentials {
                        println!(
                            "  {:<6} {}  password {}  totp {}",
                            c.role.as_str(),
                            c.email,
                            api::reset::shown(&c.password, c.password_origin),
                            api::reset::shown(&c.totp_secret, c.totp_origin)
                        );
                    }
                    ExitCode::SUCCESS
                }
                Err(e) => fail(e),
            }
        }
        ["auth", "reset-2fa", ..] => {
            let mut rest = args[2..].to_vec();
            let reason = take(&mut rest, "--reason").unwrap_or_default();
            let [email] = rest.as_slice() else {
                return fail(USAGE);
            };
            match cli::auth::reset_2fa(&data, email, &reason) {
                Ok(Some(notice)) => {
                    eprintln!(
                        "2FA reset for {email} (logged); their sessions ended, next sign-in enrols again (with an emailed code)"
                    );
                    if comms::mail::Mailer::from_env().is_ok_and(|m| m.is_off_for(email)) {
                        eprintln!(
                            "warning: mail is off for {email} (KEEP_MAIL=off, or not in KEEP_MAIL_ONLY_TO): re-enrolling needs an emailed code, so {email} can't sign in again until mail is on (docs/ops.md)"
                        );
                    }
                    match send(notice, "notice") {
                        Ok(()) => ExitCode::SUCCESS,
                        Err(e) => fail(format!(
                            "the reset is done, but the notice wasn't sent: {e}"
                        )),
                    }
                }
                Ok(None) => fail(format!("no user {email}")),
                Err(e) => fail(e),
            }
        }
        ["auth", "invite", ..] => {
            let mut rest = args[2..].to_vec();
            let role = take(&mut rest, "--role").unwrap_or_else(|| "staff".into());
            let [slug, email] = rest.as_slice() else {
                return fail(USAGE);
            };
            match cli::auth::invite(&data, slug, email, &role) {
                Ok(mail) => match send_invite(mail) {
                    Ok(()) => ExitCode::SUCCESS,
                    Err(e) => fail(format!("the invite wasn't sent: {e}")),
                },
                Err(e) => fail(e),
            }
        }
        _ => fail(USAGE),
    }
}
