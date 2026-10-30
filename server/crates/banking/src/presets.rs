//! CSV layouts of the banks small groups use. None has been checked
//! against a real export yet (plan `bank-transfers.sv`, g3q1): NatWest's
//! is written from its official Bankline spec, Barclays' and Lloyds' from
//! third-party write-ups, and each says `verified: false` until a group's
//! anonymised file confirms it. Column mapping covers every other bank.

use serde::Serialize;
use ts_rs::TS;

use crate::csv::{AmountColumns, Column, ColumnMapping, HeaderRow};

/// Banks with a preset planned, waiting for a real anonymised export to
/// write it from (g2q7, g3q1). Until one arrives, staff map the columns
/// by hand. Add the preset to [`presets`] from the sample, with the
/// sample under `tests/fixtures/`, and take the bank off this list.
pub const AWAITING_SAMPLES: &[&str] = &["CAF Bank", "Unity Trust", "Co-op Business"];

/// A bank's CSV layout.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankPreset")]
pub struct Preset {
    /// Stable: saved on an account, never reused for another layout.
    pub id: &'static str,
    pub bank: &'static str,
    /// Which of the bank's exports, as its screens name it.
    pub export: &'static str,
    /// Checked against a real file from a group.
    pub verified: bool,
    /// Where the layout comes from.
    pub source: &'static str,
    pub mapping: ColumnMapping,
}

/// Every preset, in the order the import page lists them.
pub fn presets() -> Vec<Preset> {
    let name = Column::name;
    let narrative = |first: u16| (first..first + 5).map(Column::Index).collect();
    vec![
        Preset {
            id: "natwest-bankline-statement",
            bank: "NatWest / RBS (Bankline)",
            export: "Account statement (Acc_Stmt_….csv)",
            verified: false,
            source: "NatWest, Export file layout guide: Bankline CSV format, January 2025",
            // Fields 1–18: sort code, account number, alias, short name,
            // currency, account type, BIC, bank, branch, date (10),
            // narrative lines 1–5 (11–15), type, debit value, credit value.
            mapping: ColumnMapping {
                header: HeaderRow::Skip { rows: 1 },
                date: Column::Index(9),
                amount: AmountColumns::PaidInOut {
                    paid_in: Column::Index(17),
                    paid_out: Column::Index(16),
                },
                payer: None,
                reference: None,
                narrative: narrative(10),
                bank_id: None,
                currency: Some(Column::Index(4)),
            },
        },
        Preset {
            id: "natwest-bankline-search",
            bank: "NatWest / RBS (Bankline)",
            export: "Transaction search results (Trans_….csv)",
            verified: false,
            source: "NatWest, Export file layout guide: Bankline CSV format, January 2025",
            // Fields 1–15: sort code, account number, alias, short name,
            // currency, posting date (6), narrative lines 1–5 (7–11),
            // type, transaction reference (13), value date, signed amount.
            mapping: ColumnMapping {
                header: HeaderRow::Skip { rows: 1 },
                date: Column::Index(5),
                amount: AmountColumns::Signed {
                    column: Column::Index(14),
                },
                payer: None,
                reference: None,
                narrative: narrative(6),
                bank_id: Some(Column::Index(12)),
                currency: Some(Column::Index(4)),
            },
        },
        Preset {
            id: "barclays",
            bank: "Barclays",
            export: "CSV",
            verified: false,
            source: "third-party write-up (beancount.io, Barclays CSV)",
            // Number, Date, Account, Amount, Subcategory, Memo; the memo's
            // fields are tab-padded, which reading collapses.
            mapping: ColumnMapping {
                header: HeaderRow::Find,
                date: name("Date"),
                amount: AmountColumns::Signed {
                    column: name("Amount"),
                },
                payer: None,
                reference: None,
                narrative: vec![name("Memo")],
                bank_id: None,
                currency: None,
            },
        },
        Preset {
            id: "lloyds",
            bank: "Lloyds",
            export: "CSV",
            verified: false,
            source: "third-party write-up (github.com/ggirtsou/lloyds), personal accounts",
            // Transaction Date, Transaction Type, Sort Code, Account
            // Number, Transaction Description, Debit Amount, Credit
            // Amount, Balance (and a trailing comma).
            mapping: ColumnMapping {
                header: HeaderRow::Find,
                date: name("Transaction Date"),
                amount: AmountColumns::PaidInOut {
                    paid_in: name("Credit Amount"),
                    paid_out: name("Debit Amount"),
                },
                payer: None,
                reference: None,
                narrative: vec![name("Transaction Description")],
                bank_id: None,
                currency: None,
            },
        },
    ]
}

/// The preset with this id.
pub fn preset(id: &str) -> Option<Preset> {
    presets().into_iter().find(|p| p.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_are_valid_unique_and_unverified() {
        let all = presets();
        for p in &all {
            assert!(p.mapping.check().is_ok(), "{}", p.id);
            assert!(!p.verified, "{} needs a real file to be verified", p.id);
            assert_eq!(all.iter().filter(|q| q.id == p.id).count(), 1);
            assert!(!AWAITING_SAMPLES.contains(&p.bank));
        }
        assert!(preset("lloyds").is_some());
        assert!(preset("caf").is_none());
    }
}
