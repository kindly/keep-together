//! `keep`, the operator CLI. Subcommands live here as functions so tests
//! call them directly; `main.rs` only parses arguments.

pub mod auth;
pub mod dev;
pub mod giftaid;
pub mod sql;
pub mod tenant;
