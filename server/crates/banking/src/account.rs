//! `banking.account`: a bank account the group names (admins set them
//! up, plan g1q9), with the layout its CSV statements are read with
//! (a preset, or columns mapped by hand and saved here) and the source
//! code a gift made from one of its lines falls back to (g2q6).

use contracts::{Command, Contract, ContractError, OrgTx, WriteTx};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::csv::ColumnMapping;
use crate::presets::preset;
use crate::text::clean;

pub const TABLE: &str = "bank_accounts";
pub const NAME_MAX: usize = 100;
/// Bank accounts an organisation may hold, inactive ones included.
pub const ACCOUNT_LIMIT: i64 = 50;

/// How this account's CSV statements are read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, rename = "BankCsvLayout")]
pub enum CsvLayout {
    /// A preset by id (`presets`), so a corrected preset reaches it.
    Preset { id: String },
    /// Columns mapped by hand.
    Mapping { mapping: ColumnMapping },
}

impl CsvLayout {
    /// The mapping to read with, `None` for a preset that no longer exists.
    pub fn mapping(&self) -> Option<ColumnMapping> {
        match self {
            CsvLayout::Preset { id } => preset(id).map(|p| p.mapping),
            CsvLayout::Mapping { mapping } => Some(mapping.clone()),
        }
    }
}

/// The `banking.account` slice.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankAccountPayload")]
pub struct AccountPayload {
    /// "CAF current", "Unity deposit".
    pub name: String,
    /// Six digits or empty; dashes and spaces are dropped.
    #[serde(default)]
    pub sort_code: String,
    /// The account number's last four digits, or empty: never the whole
    /// number.
    #[serde(default)]
    pub account_last4: String,
    /// A source code version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub default_source_code_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub csv_layout: Option<CsvLayout>,
    pub active: bool,
}

/// The slice as stored, with who created it and when (the system's).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankAccount")]
pub struct Account {
    #[serde(flatten)]
    pub payload: AccountPayload,
    #[ts(type = "number | null")]
    pub created_by: Option<i64>,
    #[ts(type = "number")]
    pub created_at: i64,
}

pub struct AccountContract;
pub static ACCOUNT: AccountContract = AccountContract;

fn digits_or_empty(field: &str, value: &str, len: usize) -> Result<String, ContractError> {
    let digits: String = value
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect();
    if digits.is_empty() || (digits.len() == len && digits.bytes().all(|b| b.is_ascii_digit())) {
        Ok(digits)
    } else {
        Err(ContractError::invalid(
            field,
            format!("{len} digits, or leave it empty"),
        ))
    }
}

fn prepare_account(mut p: AccountPayload) -> Result<AccountPayload, ContractError> {
    p.name = clean(&p.name);
    if p.name.is_empty() {
        return Err(ContractError::invalid("name", "Name the account"));
    }
    if p.name.chars().count() > NAME_MAX {
        return Err(ContractError::invalid(
            "name",
            format!("At most {NAME_MAX} characters"),
        ));
    }
    p.sort_code = digits_or_empty("sortCode", &p.sort_code, 6)?;
    p.account_last4 = digits_or_empty("accountLast4", &p.account_last4, 4)?;
    p.default_source_code_id = p.default_source_code_id.filter(|id| !id.is_empty());
    match &p.csv_layout {
        Some(CsvLayout::Preset { id }) if preset(id).is_none() => {
            return Err(ContractError::invalid(
                "csvLayout",
                format!("No preset {id}"),
            ));
        }
        Some(CsvLayout::Mapping { mapping }) => {
            mapping
                .check()
                .map_err(|m| ContractError::invalid("csvLayout", m))?;
        }
        _ => {}
    }
    Ok(p)
}

/// One account, `None` if there is none with that id.
pub fn account(conn: &Connection, id: &str) -> Result<Option<Account>, ContractError> {
    let row = conn
        .prepare_cached(
            "SELECT name, sort_code, account_last4, default_source_code_id, csv_mapping, active,
                    created_by, created_at
             FROM bank_accounts WHERE id = ?1",
        )?
        .query_row([id], |r| {
            Ok((
                AccountPayload {
                    name: r.get(0)?,
                    sort_code: r.get(1)?,
                    account_last4: r.get(2)?,
                    default_source_code_id: r.get(3)?,
                    csv_layout: None,
                    active: r.get(5)?,
                },
                r.get::<_, Option<String>>(4)?,
                r.get(6)?,
                r.get(7)?,
            ))
        })
        .optional()?;
    let Some((mut payload, layout, created_by, created_at)) = row else {
        return Ok(None);
    };
    payload.csv_layout = layout.map(|l| serde_json::from_str(&l)).transpose()?;
    Ok(Some(Account {
        payload,
        created_by,
        created_at,
    }))
}

impl Contract for AccountContract {
    const NAME: &'static str = "banking.account";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "version";
    type Payload = AccountPayload;
    type State = Account;

    fn prepare(&self, p: AccountPayload) -> Result<AccountPayload, ContractError> {
        prepare_account(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<Account, ContractError> {
        account(tx.read(), id)?.ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&Account>,
        p: &AccountPayload,
        command: &Command,
    ) -> Result<Account, ContractError> {
        Ok(Account {
            payload: p.clone(),
            created_by: current.map_or(command.actor, |c| c.created_by),
            created_at: current.map_or(command.at, |c| c.created_at),
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&Account>,
        next: &Account,
    ) -> Result<(), ContractError> {
        let p = &next.payload;
        if let Some(code) = &p.default_source_code_id
            && sources::describe(tx, code)?.is_none()
        {
            return Err(ContractError::invalid(
                "defaultSourceCodeId",
                "Pick a source code version",
            ));
        }
        let clash: Option<String> = tx
            .prepare_cached(
                "SELECT name FROM bank_accounts WHERE lower(name) = lower(?1) AND id != ?2",
            )?
            .query_row(params![p.name, id], |r| r.get(0))
            .optional()?;
        if let Some(name) = clash {
            return Err(ContractError::rejected(
                "duplicate_account_name",
                format!("There is already an account called {name}"),
            ));
        }
        let layout = p
            .csv_layout
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        if before.is_some() {
            // Who created it, and when, are never this slice's to change.
            tx.prepare_cached(
                "UPDATE bank_accounts SET name = ?2, sort_code = ?3, account_last4 = ?4,
                     default_source_code_id = ?5, csv_mapping = ?6, active = ?7
                 WHERE id = ?1",
            )?
            .execute(params![
                id,
                p.name,
                p.sort_code,
                p.account_last4,
                p.default_source_code_id,
                layout,
                p.active
            ])?;
            return Ok(());
        }
        let held: i64 = tx.query_row("SELECT count(*) FROM bank_accounts", [], |r| r.get(0))?;
        if held >= ACCOUNT_LIMIT {
            return Err(ContractError::rejected(
                "bank_account_limit",
                format!("An organisation can have at most {ACCOUNT_LIMIT} bank accounts"),
            ));
        }
        tx.prepare_cached(
            "INSERT INTO bank_accounts (id, name, sort_code, account_last4,
                 default_source_code_id, csv_mapping, active, created_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?
        .execute(params![
            id,
            p.name,
            p.sort_code,
            p.account_last4,
            p.default_source_code_id,
            layout,
            p.active,
            next.created_by,
            next.created_at
        ])?;
        Ok(())
    }
}

/// An account in a list, with its counter for the next save.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankAccountRow")]
pub struct AccountRow {
    pub id: String,
    #[ts(type = "number")]
    pub version: i64,
    #[serde(flatten)]
    pub account: Account,
    /// The default source code as it shows (`defaultSourceCodeId`'s).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub default_source_code: Option<sources::CodeDescription>,
}

/// One account as a list shows it, `None` if there is none.
pub fn account_row(conn: &Connection, id: &str) -> Result<Option<AccountRow>, ContractError> {
    let Some(account) = account(conn, id)? else {
        return Ok(None);
    };
    let version = conn.query_row(
        "SELECT version FROM bank_accounts WHERE id = ?1",
        [id],
        |r| r.get(0),
    )?;
    let default_source_code = match &account.payload.default_source_code_id {
        Some(code) => sources::describe(conn, code)?,
        None => None,
    };
    Ok(Some(AccountRow {
        id: id.to_owned(),
        version,
        account,
        default_source_code,
    }))
}

/// Every account, in the order they were added.
pub fn accounts(conn: &Connection) -> Result<Vec<AccountRow>, ContractError> {
    let ids: Vec<String> = conn
        .prepare_cached("SELECT id FROM bank_accounts ORDER BY seq LIMIT ?1")?
        .query_map([ACCOUNT_LIMIT], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    ids.iter()
        .map(|id| account_row(conn, id)?.ok_or(ContractError::NotFound))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> AccountPayload {
        AccountPayload {
            name: "  CAF   current ".into(),
            sort_code: "40-52-40".into(),
            account_last4: " 1234".into(),
            default_source_code_id: Some(String::new()),
            csv_layout: Some(CsvLayout::Preset {
                id: "lloyds".into(),
            }),
            active: true,
        }
    }

    #[test]
    fn prepare_cleans_and_checks() {
        let p = prepare_account(payload()).unwrap();
        assert_eq!(
            (
                p.name.as_str(),
                p.sort_code.as_str(),
                p.account_last4.as_str()
            ),
            ("CAF current", "405240", "1234")
        );
        assert_eq!(p.default_source_code_id, None);
        let bad = |f: fn(&mut AccountPayload)| {
            let mut p = payload();
            f(&mut p);
            prepare_account(p).is_err()
        };
        assert!(bad(|p| p.name = " ".into()));
        assert!(bad(|p| p.name = "x".repeat(NAME_MAX + 1)));
        assert!(bad(|p| p.sort_code = "40524".into()));
        assert!(bad(|p| p.account_last4 = "12345678".into()));
        assert!(bad(
            |p| p.csv_layout = Some(CsvLayout::Preset { id: "caf".into() })
        ));
        assert!(!bad(|p| {
            p.sort_code = String::new();
            p.account_last4 = String::new();
            p.csv_layout = None;
        }));
    }
}
