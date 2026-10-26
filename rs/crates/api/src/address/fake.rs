//! `KEEP_ADDRESS_LOOKUP=fake`: fixed addresses, no network. Tests, local
//! runs, the preview and QC's expectations.
//!
//! | postcode | answer |
//! |---|---|
//! | [`SEVERAL`] (`ID1 1QD`, also the QC postcode) | three addresses |
//! | [`ONE`] (`KT1 1AA`) | one address, with a line 2 |
//! | [`DOWN`] (`ZZ9 9ZZ`) | the provider is unavailable |
//! | anything else | not found |

use std::sync::atomic::{AtomicUsize, Ordering};

use futures_util::future::BoxFuture;

use super::{AddressLookup, LookupAddress, LookupError, Sent};

pub const SEVERAL: &str = "ID1 1QD";
pub const ONE: &str = "KT1 1AA";
pub const DOWN: &str = "ZZ9 9ZZ";

#[derive(Default)]
pub struct Fake {
    calls: AtomicUsize,
}

impl Fake {
    /// How many lookups reached this provider.
    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

fn address(line1: &str, line2: &str, town: &str, postcode: &str) -> LookupAddress {
    LookupAddress {
        line1: line1.into(),
        line2: line2.into(),
        line3: String::new(),
        town: town.into(),
        postcode: postcode.into(),
    }
}

/// The fixed answer for `postcode` (normalised).
pub fn answer(postcode: &str) -> Result<Vec<LookupAddress>, LookupError> {
    match postcode {
        SEVERAL => Ok(vec![
            address("1 Test Street", "", "Fakebury", SEVERAL),
            address("2 Test Street", "", "Fakebury", SEVERAL),
            address("Flat 3", "4 Test Street", "Fakebury", SEVERAL),
        ]),
        ONE => Ok(vec![address(
            "The Old Chapel",
            "Riverside Walk",
            "Kingston upon Thames",
            ONE,
        )]),
        DOWN => Err(LookupError::Unavailable("fake: unavailable".into())),
        _ => Err(LookupError::NotFound),
    }
}

impl AddressLookup for Fake {
    fn lookup<'a>(&'a self, postcode: &'a str) -> BoxFuture<'a, Result<Vec<LookupAddress>, Sent>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { answer(postcode).map_err(Sent::reached) })
    }
}
