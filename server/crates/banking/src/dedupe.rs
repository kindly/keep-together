//! Which lines of a file are new for an account. Most UK CSVs carry no
//! transaction id, so a line is known by its content: posted date,
//! amount, payer, reference and narrative ([`content_key`]; the account
//! scopes it). When a file holds a key *n* times and the account already
//! holds it *m* times, *n − m* are new, so two identical £10 standing
//! orders on one day both survive, and importing that file again adds
//! nothing. A bank id, when the format has one, is used as well: a line
//! whose id the account already holds is a duplicate whatever its content
//! (banks reword narratives between exports).

use std::collections::{HashMap, HashSet};

use sha2::{Digest, Sha256};

use crate::CreditLine;

/// A line's content key: SHA-256 (hex) of its date, amount, payer,
/// reference and narrative, whitespace collapsed and upper-cased so a
/// re-export that only changes case or padding matches.
pub fn content_key(line: &CreditLine) -> String {
    let norm = |v: &str| crate::text::clean(v).to_uppercase();
    let canonical = [
        line.posted_on.clone(),
        line.amount.to_string(),
        norm(line.payer.as_deref().unwrap_or("")),
        norm(line.reference.as_deref().unwrap_or("")),
        norm(&line.narrative),
    ]
    .join("\u{1f}");
    Sha256::digest(canonical.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// What an account already holds: for each content key, its lines' bank
/// ids. Loaded for the keys and ids a file has.
#[derive(Clone, Debug, Default)]
pub struct Held {
    by_key: HashMap<String, Vec<Option<String>>>,
    ids: HashSet<String>,
}

impl Held {
    pub fn new() -> Self {
        Self::default()
    }

    /// One stored line.
    pub fn add(&mut self, key: &str, bank_id: Option<&str>) {
        self.by_key
            .entry(key.to_owned())
            .or_default()
            .push(bank_id.map(str::to_owned));
        self.ids.extend(bank_id.map(str::to_owned));
    }

    fn count(&self, key: &str) -> usize {
        self.by_key.get(key).map_or(0, Vec::len)
    }
}

/// A new line with its key and occurrence: the *k*th line the account
/// holds with that key (1-based), so (account, key, occurrence) is unique.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Keyed {
    pub line: CreditLine,
    pub key: String,
    pub occurrence: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Deduped {
    /// In file order.
    pub new: Vec<Keyed>,
    pub duplicates: usize,
}

/// Splits a file's credits into new lines and duplicates of `held`.
pub fn dedupe(lines: Vec<CreditLine>, held: &Held) -> Deduped {
    let file_ids: HashSet<&str> = lines.iter().filter_map(|l| l.bank_id.as_deref()).collect();
    let keyed: Vec<(CreditLine, String)> = lines
        .iter()
        .map(|l| (l.clone(), content_key(l)))
        .collect();

    // Per key, the held lines this file's ids don't account for (no id,
    // or one the bank has since reissued): that many of the file's lines
    // with the key are already held.
    let mut to_drop: HashMap<&str, usize> = HashMap::new();
    for (_, key) in &keyed {
        to_drop.entry(key).or_insert_with(|| {
            held.by_key.get(key.as_str()).map_or(0, |ids| {
                ids.iter()
                    .filter(|id| !id.as_deref().is_some_and(|id| file_ids.contains(id)))
                    .count()
            })
        });
    }

    let mut out = Deduped::default();
    let mut next: HashMap<&str, u32> = HashMap::new();
    let mut new_ids: HashSet<String> = HashSet::new();
    for (line, key) in &keyed {
        if line.bank_id.as_ref().is_some_and(|id| held.ids.contains(id)) {
            out.duplicates += 1;
            continue;
        }
        let drop = to_drop.get_mut(key.as_str()).expect("counted above");
        if *drop > 0 {
            *drop -= 1;
            out.duplicates += 1;
            continue;
        }
        let n = next
            .entry(key)
            .or_insert_with(|| held.count(key) as u32);
        *n += 1;
        let mut line = line.clone();
        // An id the bank repeats within one file identifies neither line;
        // the first keeps it (an account holds an id once).
        if line.bank_id.as_ref().is_some_and(|id| !new_ids.insert(id.clone())) {
            line.bank_id = None;
        }
        out.new.push(Keyed {
            line,
            key: key.clone(),
            occurrence: *n,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(day: u32, amount: i64, payer: &str) -> CreditLine {
        CreditLine {
            line: 0,
            posted_on: format!("2026-11-{day:02}"),
            amount,
            payer: Some(payer.to_owned()),
            reference: None,
            narrative: format!("{payer} SO"),
            bank_id: None,
        }
    }

    fn with_id(mut l: CreditLine, id: &str) -> CreditLine {
        l.bank_id = Some(id.to_owned());
        l
    }

    /// Dedupes `file` and stores its new lines into `held`, as an import
    /// would.
    fn import(held: &mut Held, file: Vec<CreditLine>) -> Deduped {
        let d = dedupe(file, held);
        for k in &d.new {
            held.add(&k.key, k.line.bank_id.as_deref());
        }
        d
    }

    #[test]
    fn the_key_ignores_case_and_padding_but_not_content() {
        let a = line(3, 1000, "J SMITH");
        let mut b = a.clone();
        b.narrative = "  j smith   so ".into();
        assert_eq!(content_key(&a), content_key(&b));
        b.line = 99;
        assert_eq!(content_key(&a), content_key(&b));
        for other in [line(4, 1000, "J SMITH"), line(3, 1001, "J SMITH"), line(3, 1000, "A JONES")] {
            assert_ne!(content_key(&a), content_key(&other));
        }
    }

    #[test]
    fn reimporting_the_same_file_adds_nothing() {
        let file = vec![line(1, 1000, "J SMITH"), line(2, 500, "A JONES")];
        let mut held = Held::new();
        let first = import(&mut held, file.clone());
        assert_eq!((first.new.len(), first.duplicates), (2, 0));
        let again = dedupe(file, &held);
        assert_eq!((again.new.len(), again.duplicates), (0, 2));
    }

    #[test]
    fn an_overlapping_file_adds_only_the_new_days() {
        let days = |from, to| (from..=to).map(|d| line(d, 1000, "J SMITH")).collect::<Vec<_>>();
        let mut held = Held::new();
        import(&mut held, days(1, 10));
        let overlap = dedupe(days(5, 15), &held);
        let new_days: Vec<&str> = overlap.new.iter().map(|k| &k.line.posted_on[8..]).collect();
        assert_eq!(new_days, ["11", "12", "13", "14", "15"]);
        assert_eq!(overlap.duplicates, 6);
    }

    #[test]
    fn identical_lines_in_one_file_are_both_kept_and_stay_two() {
        let file = vec![line(3, 1000, "J SMITH"), line(3, 1000, "J SMITH")];
        let mut held = Held::new();
        let first = import(&mut held, file.clone());
        let occurrences: Vec<u32> = first.new.iter().map(|k| k.occurrence).collect();
        assert_eq!(occurrences, [1, 2]);
        assert_eq!(dedupe(file.clone(), &held).new.len(), 0);
        // A later export showing a third payment that day adds just it.
        let mut three = file;
        three.push(line(3, 1000, "J SMITH"));
        let later = dedupe(three, &held);
        assert_eq!(later.new.len(), 1);
        assert_eq!(later.new[0].occurrence, 3);
    }

    #[test]
    fn a_held_bank_id_is_a_duplicate_whatever_the_content() {
        let mut held = Held::new();
        import(&mut held, vec![with_id(line(3, 1000, "J SMITH"), "F1")]);
        let mut reworded = with_id(line(3, 1000, "J SMITH"), "F1");
        reworded.narrative = "J SMITH FP 100016".into();
        let d = dedupe(vec![reworded.clone()], &held);
        assert_eq!((d.new.len(), d.duplicates), (0, 1));
        // A new id with that same content is a second payment.
        let d = dedupe(vec![reworded, with_id(line(3, 1000, "J SMITH"), "F2")], &held);
        assert_eq!((d.new.len(), d.duplicates), (1, 1));
        assert_eq!(d.new[0].line.bank_id.as_deref(), Some("F2"));
    }

    #[test]
    fn an_id_repeated_within_a_file_is_kept_once() {
        let file = vec![with_id(line(3, 1000, "J SMITH"), "A"), with_id(line(4, 500, "A JONES"), "A")];
        let d = dedupe(file, &Held::new());
        let ids: Vec<Option<&str>> = d.new.iter().map(|k| k.line.bank_id.as_deref()).collect();
        assert_eq!(ids, [Some("A"), None]);
    }

    #[test]
    fn reissued_bank_ids_fall_back_to_content() {
        let mut held = Held::new();
        let file = vec![with_id(line(3, 1000, "J SMITH"), "A"), with_id(line(3, 1000, "J SMITH"), "B")];
        import(&mut held, file);
        // The same two payments, downloaded again with fresh ids.
        let file = vec![with_id(line(3, 1000, "J SMITH"), "C"), with_id(line(3, 1000, "J SMITH"), "D")];
        let d = dedupe(file, &held);
        assert_eq!((d.new.len(), d.duplicates), (0, 2));
    }
}
