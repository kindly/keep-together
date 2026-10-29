//! `keep giving-consistency`: ADR 0025's provider-payment check, through
//! the read-only opener.

use cli::giving::consistency;

#[test]
fn a_provider_gift_without_its_payment_is_reported_and_nothing_written() {
    let tmp = tempfile::tempdir().unwrap();
    let alpha = cli::tenant::create(tmp.path(), "alpha", "Alpha", "ann@alpha.org").unwrap();
    cli::tenant::create(tmp.path(), "beta", "Beta", "bob@beta.org").unwrap();
    assert_eq!(
        consistency(tmp.path(), "alpha").unwrap(),
        Vec::<String>::new()
    );
    let store = cli::tenant::open(tmp.path()).unwrap();
    store
        .org(&alpha.tenant.id)
        .unwrap()
        .write_raw(|tx| {
            tx.conn().execute_batch(
                "PRAGMA defer_foreign_keys = ON;
                 INSERT INTO direct_debit_payments (id, payment_id, amount, charge_date, status)
                 VALUES ('00000000000000000000000000000001', 'PM1', 500, '2026-10-01',
                     'confirmed');
                 INSERT INTO gifts (id, contact_id, received_on, amount, method, reference,
                     status, entered_at, provider, provider_payment_id)
                 VALUES ('00000000000000000000000000000002', 'nobody', '2026-10-01', 500,
                     'direct_debit', 'PM2', 'completed', 1, 'gocardless', 'PM2');
                 PRAGMA defer_foreign_keys = OFF;",
            )
        })
        .ok();
    let problems = consistency(tmp.path(), "alpha").unwrap();
    // PM1 is unmatched (no donor, no gift): listed for staff, not a fault.
    assert_eq!(
        problems,
        ["gift 00000000000000000000000000000002: payment PM2 isn't on record"]
    );
    assert!(consistency(tmp.path(), "beta").unwrap().is_empty());
    assert!(consistency(tmp.path(), "gamma").is_err());
}
