//! Child rows inside a root's contract payload (ADR 0014): they carry ids
//! and are reconciled by id. Removed ids are deleted, new ids created,
//! kept ids updated in place, except identity fields (an email's address,
//! a phone's number), which are immutable per id: change = remove + add.

use std::collections::{HashMap, HashSet};

use crate::{ContractError, Problem, new_id};

pub trait ChildRow {
    fn id(&self) -> &str;
    /// The value the row *is*, if it has one. Addresses have none.
    fn identity(&self) -> Option<&str> {
        None
    }
}

/// What changed between two states of a child list.
#[derive(Debug)]
pub struct Reconciled<'a, T> {
    pub added: Vec<&'a T>,
    /// Kept ids whose row differs; the `next` version.
    pub changed: Vec<&'a T>,
    pub removed: Vec<&'a T>,
}

impl<T> Reconciled<'_, T> {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.changed.is_empty() && self.removed.is_empty()
    }
}

/// Diff `before` → `next` by id. Duplicate ids in `next` are invalid; a
/// kept id whose identity changed is rejected.
pub fn reconcile<'a, T: ChildRow + PartialEq>(
    field: &str,
    before: &'a [T],
    next: &'a [T],
) -> Result<Reconciled<'a, T>, ContractError> {
    let mut seen = HashSet::new();
    let mut problems = Vec::new();
    for (i, row) in next.iter().enumerate() {
        if !is_client_id(row.id()) {
            problems.push(Problem::new(
                format!("{field}.{i}.id"),
                "32 lower-case hex characters",
            ));
        } else if !seen.insert(row.id()) {
            problems.push(Problem::new(format!("{field}.{i}.id"), "duplicate id"));
        }
    }
    if !problems.is_empty() {
        return Err(ContractError::Invalid(problems));
    }
    let old: HashMap<&str, &T> = before.iter().map(|r| (r.id(), r)).collect();
    let mut out = Reconciled {
        added: vec![],
        changed: vec![],
        removed: vec![],
    };
    for row in next {
        match old.get(row.id()) {
            None => out.added.push(row),
            Some(prev) if prev.identity() != row.identity() => {
                return Err(ContractError::rejected(
                    "identity_immutable",
                    format!("{field} {}: remove the row and add a new one", row.id()),
                ));
            }
            Some(prev) if *prev != row => out.changed.push(row),
            Some(_) => {}
        }
    }
    out.removed = before.iter().filter(|r| !seen.contains(r.id())).collect();
    Ok(out)
}

/// An id a client may choose (an entity's pre-generated id, a child
/// row's key): 32 lower-case hex characters, like [`new_id`].
pub fn is_client_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Give every row without an id a fresh one (in `prepare`, so the minted
/// ids are what the revision records and restore replays).
pub fn mint_ids<T>(rows: &mut [T], id: impl Fn(&mut T) -> &mut Option<String>) {
    for row in rows {
        let slot = id(row);
        if slot.as_deref().is_none_or(str::is_empty) {
            *slot = Some(new_id());
        }
    }
}
