//! `keep giving-consistency`: ADR 0025's provider-payment check, through
//! the read-only opener.

use cli::giving::consistency;

#[test]
fn provider_gifts_without_their_payment_are_reported_and_nothing_written() {
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
                 INSERT INTO gifts (id, contact_id, received_on, amount, method, reference,
                     status, entered_at, provider)
                 VALUES ('00000000000000000000000000000003', 'nobody', '2026-09-01', 500,
                     'direct_debit', 'PM9', 'completed', 1, 'gocardless');
                 PRAGMA defer_foreign_keys = OFF;",
            )
        })
        .ok();
    let problems = consistency(tmp.path(), "alpha").unwrap();
    // PM1 is unmatched (no donor, no gift): listed for staff, not a fault.
    // A provider gift with no payment id that counts (review L2): the
    // same money twice.
    assert_eq!(
        problems,
        [
            "gift 00000000000000000000000000000002: payment PM2 isn't on record",
            "gift 00000000000000000000000000000003: a provider gift with no payment id is \
             completed, not void"
        ]
    );
    assert!(consistency(tmp.path(), "beta").unwrap().is_empty());
    assert!(consistency(tmp.path(), "gamma").is_err());
}

#[test]
fn stripe_gifts_and_payments_that_disagree_are_reported_too() {
    let tmp = tempfile::tempdir().unwrap();
    let alpha = cli::tenant::create(tmp.path(), "alpha", "Alpha", "ann@alpha.org").unwrap();
    cli::tenant::create(tmp.path(), "beta", "Beta", "bob@beta.org").unwrap();
    let store = cli::tenant::open(tmp.path()).unwrap();
    store
        .org(&alpha.tenant.id)
        .unwrap()
        .write_raw(|tx| {
            tx.conn().execute_batch(
                "PRAGMA defer_foreign_keys = ON;
                 INSERT INTO gifts (id, contact_id, received_on, amount, method, reference,
                     status, entered_at, provider, provider_payment_id)
                 VALUES ('00000000000000000000000000000002', 'nobody', '2026-11-18', 500,
                     'card', 'pi_1', 'completed', 1, 'stripe', 'pi_1'),
                        ('00000000000000000000000000000004', 'nobody', '2026-11-18', 700,
                     'card', 'pi_2', 'completed', 1, 'stripe', 'pi_2');
                 INSERT INTO stripe_payments (id, payment_id, amount, currency, status, paid_on,
                     refunded_amount, contact_id, gift_id)
                 VALUES ('00000000000000000000000000000005', 'pi_2', 700, 'gbp', 'succeeded',
                     '2026-11-18', 700, 'nobody', '00000000000000000000000000000004'),
                        ('00000000000000000000000000000006', 'pi_3', 900, 'gbp', 'succeeded',
                     '2026-11-18', 0, NULL, NULL),
                        ('00000000000000000000000000000007', 'pi_4', 900, 'gbp', 'failed',
                     NULL, 0, NULL, NULL);
                 PRAGMA defer_foreign_keys = OFF;",
            )
        })
        .ok();
    // pi_4 never succeeded: nobody's to match, not a fault.
    assert_eq!(
        consistency(tmp.path(), "alpha").unwrap(),
        [
            "payment pi_2: gift is completed, payment says refunded",
            "payment pi_3: succeeded, with no gift and in nobody's queue",
            "gift 00000000000000000000000000000002: payment pi_1 isn't on record as its payment",
        ]
    );
    assert!(consistency(tmp.path(), "beta").unwrap().is_empty());
}
