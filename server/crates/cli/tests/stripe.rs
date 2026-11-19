//! `keep stripe requeue`: an organisation's parked Stripe events go back
//! in the queue; nobody else's do, and nothing that wasn't parked.

fn outcomes(store: &store::Store) -> Vec<(String, Option<String>, i64)> {
    store
        .platform()
        .with_read(|c| {
            Ok::<_, store::StoreError>(
                c.prepare("SELECT id, outcome, attempts FROM stripe_events ORDER BY id")?
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                    .collect::<rusqlite::Result<_>>()?,
            )
        })
        .unwrap()
}

#[test]
fn parked_events_of_one_organisation_go_back_in_the_queue() {
    let tmp = tempfile::tempdir().unwrap();
    let alpha = cli::tenant::create(tmp.path(), "alpha", "Alpha", "ann@alpha.org").unwrap();
    let beta = cli::tenant::create(tmp.path(), "beta", "Beta", "bob@beta.org").unwrap();
    let store = cli::tenant::open(tmp.path()).unwrap();
    store
        .platform()
        .with_write(|tx| {
            for (id, tenant, outcome) in [
                ("evt_a_failed", &alpha.tenant.id, "failed"),
                ("evt_a_done", &alpha.tenant.id, "done"),
                ("evt_a_kept", &alpha.tenant.id, "not_connected"),
                ("evt_b_failed", &beta.tenant.id, "failed"),
            ] {
                tx.execute(
                    "INSERT INTO stripe_events (id, account_id, tenant_id, type, created, body,
                         received_at, processed_at, outcome, attempts, last_error)
                     VALUES (?1, 'acct_1', ?2, 'account.updated', 0, '{}', 0, 1, ?3, 50, 'x')",
                    rusqlite::params![id, tenant.as_str(), outcome],
                )?;
            }
            Ok::<_, store::StoreError>(())
        })
        .unwrap();
    drop(store);

    assert_eq!(cli::stripe::requeue(tmp.path(), "alpha").unwrap(), 1);
    let store = cli::tenant::open(tmp.path()).unwrap();
    assert_eq!(
        outcomes(&store),
        [
            ("evt_a_done".to_owned(), Some("done".to_owned()), 50),
            ("evt_a_failed".to_owned(), None, 0),
            (
                "evt_a_kept".to_owned(),
                Some("not_connected".to_owned()),
                50
            ),
            ("evt_b_failed".to_owned(), Some("failed".to_owned()), 50),
        ]
    );
    drop(store);
    // Nothing left to requeue; an unknown organisation is an error.
    assert_eq!(cli::stripe::requeue(tmp.path(), "alpha").unwrap(), 0);
    assert!(cli::stripe::requeue(tmp.path(), "gamma").is_err());
}
