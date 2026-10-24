//! Two organisations on real org files, and the helpers A1's tests share.
#![allow(dead_code)]

use std::sync::Arc;

use contacts::METHODS;
use contacts::form::{create, save_form};
use contacts::identifiers::{IDENTIFIER_TYPE, IdentifierRow, IdentifierTypePayload, Identifiers};
use contacts::queries::{SearchQuery, get, history, search};
use contacts::types::*;
use contracts::{ContractError, Ctx, Exec, Source, execute};
use store::{M, Migrations, OrgDb, Store, StoreConfig};

pub struct World {
    _tmp: tempfile::TempDir,
    pub a: Arc<OrgDb>,
    pub b: Arc<OrgDb>,
}

pub fn world() -> World {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(StoreConfig {
        dir: tmp.path().to_path_buf(),
        org_migrations: Migrations::new(vec![
            M::up(contracts::MIGRATION),
            M::up(contacts::MIGRATION),
            M::up(contacts::DROP_TRIGRAM),
            M::up(contacts::MIGRATION_IDENTIFIERS_NOTES),
            // A2: `get` reads the contact's acquisition code.
            M::up(sources::MIGRATION),
            M::up(contacts::acquisition::MIGRATION),
        ]),
        readers: 2,
        max_open: StoreConfig::DEFAULT_MAX_OPEN,
    })
    .unwrap();
    let a = store.create_tenant("alpha", "Alpha").unwrap();
    let b = store.create_tenant("beta", "Beta").unwrap();
    World {
        a: store.org(&a.id).unwrap(),
        b: store.org(&b.id).unwrap(),
        _tmp: tmp,
    }
}

/// A write as user 1.
pub fn w<T>(
    db: &OrgDb,
    f: impl FnOnce(&Ctx) -> Result<T, ContractError>,
) -> Result<T, ContractError> {
    as_user(db, 1, f)
}

pub fn as_user<T>(
    db: &OrgDb,
    user: i64,
    f: impl FnOnce(&Ctx) -> Result<T, ContractError>,
) -> Result<T, ContractError> {
    contracts::transact(db, Some(user), f)
}

pub fn r<T>(db: &OrgDb, f: impl FnOnce(&rusqlite::Connection) -> Result<T, ContractError>) -> T {
    db.read(|c| f(c)).unwrap()
}

pub fn person(first: &str, last: &str) -> Details {
    Details {
        client_key: None,
        kind: Kind::Individual,
        title: String::new(),
        first_name: first.into(),
        last_name: last.into(),
        nickname: String::new(),
        name: String::new(),
        birth_date: None,
        is_deceased: false,
        deceased_date: None,
    }
}

pub fn org(name: &str) -> Details {
    Details {
        kind: Kind::Organization,
        first_name: String::new(),
        last_name: String::new(),
        name: name.into(),
        ..person("", "")
    }
}

pub fn add(db: &OrgDb, d: Details) -> String {
    w(db, |ctx| {
        create(
            ctx,
            CreateContact {
                id: None,
                details: d,
            },
            Source::Test,
        )
    })
    .unwrap()
    .id
}

pub fn email(address: &str) -> EmailRow {
    EmailRow {
        key: None,
        label: ChannelLabel::Home,
        address: address.into(),
        is_primary: false,
    }
}

pub fn set_emails(db: &OrgDb, id: &str, addresses: &[&str]) {
    let expected = view(db, id).counters.methods;
    w(db, |ctx| {
        execute(
            ctx,
            &METHODS,
            Methods {
                emails: addresses.iter().map(|a| email(a)).collect(),
                phones: vec![],
            },
            Exec::update(id, Some(expected), Source::Test),
        )
    })
    .unwrap();
}

pub fn view(db: &OrgDb, id: &str) -> ContactView {
    r(db, |c| get(c, id)).unwrap()
}

pub fn revisions(db: &OrgDb, id: &str) -> Vec<contracts::Revision> {
    r(db, |c| history(c, id, None, 50)).revisions
}

pub fn find(db: &OrgDb, q: &str) -> Vec<String> {
    r(db, |c| {
        search(
            c,
            &SearchQuery {
                q: q.into(),
                ..Default::default()
            },
        )
    })
    .rows
    .into_iter()
    .map(|r| r.display_name)
    .collect()
}

pub fn exp<T>(expected: i64, slice: T) -> Option<Expected<T>> {
    Some(Expected { expected, slice })
}

/// A new identifier type, active.
pub fn id_type(db: &OrgDb, name: &str) -> String {
    w(db, |ctx| {
        execute(
            ctx,
            &IDENTIFIER_TYPE,
            IdentifierTypePayload {
                name: name.into(),
                is_active: true,
            },
            Exec::create(Source::Test),
        )
    })
    .unwrap()
    .id
}

pub fn ident(type_id: &str, value: &str) -> IdentifierRow {
    IdentifierRow {
        key: None,
        type_id: type_id.into(),
        value: value.into(),
    }
}

/// The form save of the identifiers slice alone.
pub fn save_identifiers(
    db: &OrgDb,
    id: &str,
    expected: i64,
    rows: Vec<IdentifierRow>,
) -> SaveFormResult {
    w(db, |ctx| {
        save_form(
            ctx,
            id,
            SaveForm {
                identifiers: exp(expected, Identifiers { identifiers: rows }),
                ..Default::default()
            },
        )
    })
    .unwrap()
}
