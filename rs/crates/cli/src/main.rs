//! `keep`: the operator CLI. Data dir from `--data <dir>` or
//! `KEEP_DATA_DIR` (default `data`).
//!
//! ```text
//! keep sql <slug> "<select…>" [--json]
//! keep tenant create --slug <slug> --name <name> --admin-email <email>
//! keep auth reset-2fa <email> [--reason <text>]
//! ```

use std::path::PathBuf;
use std::process::ExitCode;

use cli::sql::{self, Format};

const USAGE: &str = "usage:
  keep [--data <dir>] sql <slug> \"<select…>\" [--json]
  keep [--data <dir>] tenant create --slug <slug> --name <name> --admin-email <email>
  keep [--data <dir>] auth reset-2fa <email> [--reason <text>]";

fn fail(msg: impl std::fmt::Display) -> ExitCode {
    eprintln!("{msg}");
    ExitCode::from(1)
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
                Ok(t) => {
                    println!("created {} ({}), admin {email}", t.slug, t.id);
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
                Ok(true) => {
                    eprintln!(
                        "2FA reset for {email} (logged); their sessions ended, next sign-in enrols again"
                    );
                    ExitCode::SUCCESS
                }
                Ok(false) => fail(format!("no user {email}")),
                Err(e) => fail(e),
            }
        }
        _ => fail(USAGE),
    }
}
