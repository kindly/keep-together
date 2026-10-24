//! `KEEP_RESET_SEED=riverside`: staging is reset on every deploy. The
//! image's entrypoint (`scripts/ops/entrypoint.sh`) wipes the data dir
//! *before* Litestream starts, so Litestream never watches files vanish
//! under it; then the api seeds the empty store here.
//!
//! A placeholder until B3 ports the real `testSeed` riverside (100 donors,
//! notes, gifts, a user per role): one organisation `riverside` with an
//! admin (`riverside-admin@example.com`, the role users of QC's seed
//! follow) and a dozen contacts, written through the same contract
//! functions as the API. Refused when `KEEP_ENV=prod`.

use contacts::form::create;
use contacts::types::{CreateContact, Details, Kind};
use contracts::{Source, transact};
use store::{Role, Store};

pub const SLUG: &str = "riverside";
pub const ADMIN: &str = "riverside-admin@example.com";

const PEOPLE: [(&str, &str); 10] = [
    ("Ada", "Lovelace"),
    ("Charles", "Babbage"),
    ("Mary", "Somerville"),
    ("Michael", "Faraday"),
    ("Caroline", "Herschel"),
    ("Isambard", "Brunel"),
    ("Rosalind", "Franklin"),
    ("Alan", "Turing"),
    ("Dorothy", "Hodgkin"),
    ("Tim", "Berners-Lee"),
];
const ORGS: [&str; 2] = ["Riverside Allotment Society", "Mill Lane Community Café"];

/// Seed when `KEEP_RESET_SEED` asks for it and the store doesn't have the
/// org yet (a restart after the reset seeds nothing twice).
pub fn seed_from_env(store: &Store) -> Result<bool, String> {
    match std::env::var("KEEP_RESET_SEED").ok().as_deref() {
        None | Some("") => Ok(false),
        Some(SLUG) => {
            if std::env::var("KEEP_ENV").is_ok_and(|e| e == "prod") {
                return Err("KEEP_RESET_SEED is refused when KEEP_ENV=prod".into());
            }
            seed(store)
        }
        Some(other) => Err(format!("unknown KEEP_RESET_SEED {other:?}")),
    }
}

/// The riverside org; `false` if it was already there.
pub fn seed(store: &Store) -> Result<bool, String> {
    let p = store.platform();
    if p.tenant_by_slug(SLUG).map_err(|e| e.to_string())?.is_some() {
        return Ok(false);
    }
    let tenant = store
        .create_tenant(SLUG, "Riverside Community Trust (staging)")
        .map_err(|e| e.to_string())?;
    let admin = p.upsert_user(ADMIN).map_err(|e| e.to_string())?;
    p.set_membership(admin, &tenant.id, Role::Admin)
        .map_err(|e| e.to_string())?;
    let db = store.org(&tenant.id).map_err(|e| e.to_string())?;
    let details = PEOPLE
        .iter()
        .map(|(first, last)| details(Kind::Individual, first, last, ""))
        .chain(
            ORGS.iter()
                .map(|name| details(Kind::Organization, "", "", name)),
        );
    transact(&db, None, |ctx| {
        for d in details {
            create(
                ctx,
                CreateContact {
                    id: None,
                    details: d,
                },
                Source::Seed,
            )?;
        }
        Ok::<_, contracts::ContractError>(())
    })
    .map_err(|e| format!("{e:?}"))?;
    Ok(true)
}

fn details(kind: Kind, first: &str, last: &str, name: &str) -> Details {
    Details {
        client_key: None,
        kind,
        title: String::new(),
        first_name: first.into(),
        last_name: last.into(),
        nickname: String::new(),
        name: name.into(),
        birth_date: None,
        is_deceased: false,
        deceased_date: None,
    }
}

#[cfg(test)]
mod tests {
    use store::StoreConfig;

    use super::*;

    #[test]
    fn seeds_once_and_only_its_own_org() {
        let tmp = tempfile::tempdir().unwrap();
        let open = || {
            Store::open(StoreConfig {
                dir: tmp.path().into(),
                org_migrations: crate::schema::org_migrations(),
                readers: 1,
                max_open: StoreConfig::DEFAULT_MAX_OPEN,
            })
            .unwrap()
        };
        let store = open();
        let other = store.create_tenant("other", "Other").unwrap();
        assert!(seed(&store).unwrap());
        assert!(!seed(&open()).unwrap());

        let count = |id| {
            store
                .org(id)
                .unwrap()
                .read(|r| {
                    r.query_row("SELECT count(*) FROM contacts", [], |row| {
                        row.get::<_, i64>(0)
                    })
                })
                .unwrap()
        };
        let riverside = store.platform().tenant_by_slug(SLUG).unwrap().unwrap();
        assert_eq!(count(&riverside.id), 12);
        assert_eq!(count(&other.id), 0);
    }
}
