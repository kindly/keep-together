//! Advisory validation (ADR 0015) for a saved declaration: storable but
//! not yet enough for HMRC. Never blocks a save; a later claim step
//! decides which declarations count (`convex/giftaid/warnings.ts`).

use crate::rules::HMRC_MODEL_WORDING_VERSION;
use crate::types::{DeclarationPayload, Method, Warning};

fn warning(anchor: &str, label: &str, message: &str) -> Warning {
    Warning {
        anchor: anchor.into(),
        label: label.into(),
        message: message.into(),
    }
}

pub fn declaration_warnings(d: &DeclarationPayload) -> Vec<Warning> {
    let mut out = Vec::new();
    // 3.6.2: the donor's name (full name recommended).
    if d.first_name.is_empty() || d.last_name.is_empty() {
        out.push(warning(
            if d.first_name.is_empty() {
                "firstName"
            } else {
                "lastName"
            },
            "Name",
            "HMRC needs the donor’s first and last name",
        ));
    }
    // 3.6.2: a UK home address is enough as house number or name + postcode.
    if d.address_line1.is_empty() || d.postcode.is_empty() {
        out.push(warning(
            if d.address_line1.is_empty() { "addressLine1" } else { "postcode" },
            "Home address",
            "No house number or name and postcode: gifts can’t be claimed until the declaration has both",
        ));
    }
    // 3.10.1: an oral declaration takes effect once the donor is sent a
    // written record of it; typing it into a database isn't enough.
    if d.method == Method::Oral {
        out.push(warning(
            "method",
            "Made orally",
            "Not effective until the donor has been sent a written record of it",
        ));
    }
    // Staff ticked with no form in hand: honest, but nothing yet shows the
    // donor made it. A claim leaves these out until evidence is recorded.
    if d.method == Method::StaffTickedNoEvidence {
        out.push(warning(
            "method",
            "No evidence yet",
            "Gifts won’t be claimed until there is evidence the donor made this declaration",
        ));
    }
    // 3.6.2: the donor must have been given HMRC's tax explanation; an
    // older wording may still be valid but is worth a look.
    if d.wording_version != HMRC_MODEL_WORDING_VERSION {
        out.push(warning(
            "wordingVersion",
            "Wording",
            "Not HMRC’s current model declaration wording",
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Scope;

    fn full() -> DeclarationPayload {
        DeclarationPayload {
            contact_id: "c".into(),
            scope: Scope::Future,
            gift_id: None,
            made_on: "2026-03-03".into(),
            method: Method::PaperForm,
            wording_version: HMRC_MODEL_WORDING_VERSION.into(),
            first_name: "Jo".into(),
            last_name: "Bloggs".into(),
            address_line1: "12".into(),
            postcode: "SW1A 1AA".into(),
        }
    }

    fn anchors(d: DeclarationPayload) -> Vec<String> {
        declaration_warnings(&d)
            .into_iter()
            .map(|w| w.anchor)
            .collect()
    }

    #[test]
    fn none_for_a_complete_written_declaration() {
        assert!(declaration_warnings(&full()).is_empty());
    }

    #[test]
    fn missing_address_missing_name_oral() {
        let no_postcode = DeclarationPayload {
            postcode: String::new(),
            ..full()
        };
        assert_eq!(anchors(no_postcode), ["postcode"]);
        let no_address = DeclarationPayload {
            address_line1: String::new(),
            postcode: String::new(),
            ..full()
        };
        assert_eq!(anchors(no_address), ["addressLine1"]);
        let no_last = DeclarationPayload {
            last_name: String::new(),
            ..full()
        };
        assert_eq!(anchors(no_last), ["lastName"]);
        let oral = DeclarationPayload {
            method: Method::Oral,
            ..full()
        };
        assert_eq!(anchors(oral), ["method"]);
    }

    #[test]
    fn staff_ticked_with_no_evidence_and_an_old_wording() {
        let ticked = DeclarationPayload {
            method: Method::StaffTickedNoEvidence,
            ..full()
        };
        let labels: Vec<String> = declaration_warnings(&ticked)
            .into_iter()
            .map(|w| w.label)
            .collect();
        assert_eq!(labels, ["No evidence yet"]);
        let old = DeclarationPayload {
            wording_version: "hmrc-2012".into(),
            ..full()
        };
        assert_eq!(anchors(old), ["wordingVersion"]);
    }
}
