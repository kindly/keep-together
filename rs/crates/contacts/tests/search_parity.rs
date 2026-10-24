//! Search parity with Convex (rust spike step 3): a sample of
//! `convex/contacts/searchList.test.ts` and `search.test.ts` ported case
//! for case, run end to end through `search`. Where a
//! Convex test asserts an order, so does this; where it asserts a set, the
//! set is compared sorted.

use std::sync::Arc;

use contacts::form::{create, set_archived};
use contacts::number::format_number;
use contacts::queries::{SearchQuery, search};
use contacts::types::*;
use contacts::{ADDRESSES, METHODS};
use contracts::{ContractError, Ctx, Exec, Source, execute};
use store::{M, Migrations, OrgDb, Store, StoreConfig};

struct World {
    _tmp: tempfile::TempDir,
    a: Arc<OrgDb>,
    b: Arc<OrgDb>,
}

fn world() -> World {
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

fn w<T>(db: &OrgDb, f: impl FnOnce(&Ctx) -> Result<T, ContractError>) -> T {
    contracts::transact(db, Some(1), f).unwrap()
}

/// What `contact()` in searchList.test.ts takes.
#[derive(Default)]
struct C<'a> {
    first: &'a str,
    last: &'a str,
    org: &'a str,
    kind: Option<Kind>,
    email: &'a str,
    phone: &'a str,
    line1: &'a str,
    town: &'a str,
    postcode: &'a str,
}

/// A contact with the given searchable children, as searchList.test.ts's
/// `contact()`: create, then methods, then addresses. Returns (id, number).
fn contact(db: &OrgDb, c: C) -> (String, i64) {
    let kind = c.kind.unwrap_or(if c.org.is_empty() {
        Kind::Individual
    } else {
        Kind::Organization
    });
    let created = w(db, |ctx| {
        create(
            ctx,
            CreateContact {
                id: None,
                details: Details {
                    client_key: None,
                    kind,
                    title: String::new(),
                    first_name: c.first.into(),
                    last_name: c.last.into(),
                    nickname: String::new(),
                    name: c.org.into(),
                    birth_date: None,
                    is_deceased: false,
                    deceased_date: None,
                },
            },
            Source::Test,
        )
    });
    if !c.email.is_empty() || !c.phone.is_empty() {
        let emails = (!c.email.is_empty())
            .then(|| EmailRow {
                key: None,
                label: ChannelLabel::Home,
                address: c.email.into(),
                is_primary: true,
            })
            .into_iter()
            .collect();
        let phones = (!c.phone.is_empty())
            .then(|| PhoneRow {
                key: None,
                label: ChannelLabel::Home,
                number: c.phone.into(),
                is_primary: true,
            })
            .into_iter()
            .collect();
        w(db, |ctx| {
            execute(
                ctx,
                &METHODS,
                Methods { emails, phones },
                Exec::update(&created.id, Some(0), Source::Test),
            )
        });
    }
    if !c.postcode.is_empty() || !c.line1.is_empty() || !c.town.is_empty() {
        w(db, |ctx| {
            execute(
                ctx,
                &ADDRESSES,
                Addresses {
                    addresses: vec![AddressRow {
                        key: None,
                        label: ChannelLabel::Home,
                        line1: c.line1.into(),
                        line2: String::new(),
                        line3: String::new(),
                        town: c.town.into(),
                        postcode: c.postcode.into(),
                        country: "GB".into(),
                        is_primary: true,
                    }],
                },
                Exec::update(&created.id, Some(0), Source::Test),
            )
        });
    }
    (created.id, created.number)
}

/// `list()`: the search.
fn list(db: &OrgDb, q: SearchQuery) -> SearchResult {
    db.read(|c| search(c, &q)).unwrap()
}

fn q(text: &str) -> SearchQuery {
    SearchQuery {
        q: text.into(),
        ..Default::default()
    }
}

fn ids(db: &OrgDb, text: &str) -> Vec<String> {
    list(db, q(text)).rows.into_iter().map(|r| r.id).collect()
}

fn ids_with(db: &OrgDb, query: SearchQuery) -> Vec<String> {
    list(db, query).rows.into_iter().map(|r| r.id).collect()
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

// ── searchList.test.ts: what one search box finds ─────────────────────────

#[test]
fn a_phone_in_any_common_format_and_by_its_last_six_digits() {
    let f = world();
    let (priya, _) = contact(
        &f.a,
        C {
            first: "Priya",
            last: "Okonjo",
            phone: "07700 900123",
            ..Default::default()
        },
    );
    contact(
        &f.a,
        C {
            first: "Tomas",
            last: "Lindqvist",
            phone: "01452 300400",
            ..Default::default()
        },
    );
    for typed in [
        "07700 900123",
        "07700900123",
        "+44 7700 900123",
        "+44 (0)7700 900-123",
        "900123",
        "07700 9",
    ] {
        assert_eq!(ids(&f.a, typed), std::slice::from_ref(&priya), "{typed}");
    }
}

#[test]
fn an_exact_phone_ranks_before_a_longer_number_it_prefixes() {
    let f = world();
    let (longer, _) = contact(
        &f.a,
        C {
            last: "Achebe",
            phone: "077009001234",
            ..Default::default()
        },
    );
    let (exact, _) = contact(
        &f.a,
        C {
            last: "Mensah",
            phone: "07700 900123",
            ..Default::default()
        },
    );
    assert_eq!(ids(&f.a, "07700900123"), [exact, longer]);
}

#[test]
fn a_postcode_with_or_without_its_space() {
    let f = world();
    let (id, _) = contact(
        &f.a,
        C {
            last: "Haddad",
            postcode: "GL5 1AB",
            ..Default::default()
        },
    );
    let (other, _) = contact(
        &f.a,
        C {
            last: "Ferreira",
            postcode: "GL6 0AA",
            ..Default::default()
        },
    );
    assert_eq!(ids(&f.a, "gl51ab"), std::slice::from_ref(&id));
    assert_eq!(ids(&f.a, "GL5 1AB"), std::slice::from_ref(&id));
    assert_eq!(sorted(ids(&f.a, "GL")), sorted(vec![id, other]));
}

#[test]
fn part_of_an_email_the_domain_the_local_part_a_prefix() {
    let f = world();
    let (id, _) = contact(
        &f.a,
        C {
            last: "Osei",
            email: "kwame.osei@riverside.example",
            ..Default::default()
        },
    );
    contact(
        &f.a,
        C {
            last: "Other",
            email: "someone@elsewhere.example",
            ..Default::default()
        },
    );
    assert_eq!(ids(&f.a, "riverside"), std::slice::from_ref(&id));
    assert_eq!(ids(&f.a, "kwame"), std::slice::from_ref(&id));
    assert_eq!(ids(&f.a, "kwame.osei@river"), [id]);
}

#[test]
fn an_organisation_by_its_name_street_and_town() {
    let f = world();
    let (hall, _) = contact(
        &f.a,
        C {
            org: "Oakfield Bakery",
            line1: "3 Weavers Row",
            town: "Nailsworth",
            ..Default::default()
        },
    );
    assert_eq!(ids(&f.a, "oakfield bak"), std::slice::from_ref(&hall));
    assert_eq!(ids(&f.a, "weavers row"), std::slice::from_ref(&hall));
    assert_eq!(ids(&f.a, "nailsworth"), [hall]);
}

#[test]
fn every_word_must_match_accents_fold_both_ways() {
    let f = world();
    let (zoe, _) = contact(
        &f.a,
        C {
            first: "Zoë",
            last: "Ndiaye",
            town: "Stroud",
            ..Default::default()
        },
    );
    contact(
        &f.a,
        C {
            first: "Zoe",
            last: "Baptiste",
            ..Default::default()
        },
    );
    assert_eq!(ids(&f.a, "zoe stroud"), std::slice::from_ref(&zoe));
    assert_eq!(ids(&f.a, "Zoë Ndiaye"), [zoe]);
    assert_eq!(ids(&f.a, "ZOE").len(), 2);
    assert!(ids(&f.a, "zoe london").is_empty());
    // search.test.ts matchesAll: every word but the last is whole.
    assert!(ids(&f.a, "nd stroud").is_empty());
    assert_eq!(ids(&f.a, "ndiaye stro").len(), 1);
}

#[test]
fn a_hyphenated_apostrophe_or_multi_word_name_however_typed_own_tenant_only() {
    let f = world();
    let (sj, _) = contact(
        &f.a,
        C {
            first: "Ann",
            last: "Smith-Jones",
            ..Default::default()
        },
    );
    let (ob, _) = contact(
        &f.a,
        C {
            first: "Ann",
            last: "O’Brien",
            ..Default::default()
        },
    );
    let (dc, _) = contact(
        &f.a,
        C {
            first: "Zoe",
            last: "de la Cruz",
            ..Default::default()
        },
    );
    contact(
        &f.b,
        C {
            first: "Bea",
            last: "Smith-Jones",
            ..Default::default()
        },
    );
    for typed in ["smith-jones", "smith jones", "smithjones", "smithj"] {
        assert_eq!(ids(&f.a, typed), std::slice::from_ref(&sj), "{typed}");
    }
    for typed in ["o'brien", "o’brien", "obrien", "o brien", "obr"] {
        assert_eq!(ids(&f.a, typed), std::slice::from_ref(&ob), "{typed}");
    }
    for typed in ["de la cruz", "delacruz", "zoe delac"] {
        assert_eq!(ids(&f.a, typed), std::slice::from_ref(&dc), "{typed}");
    }
    assert!(ids(&f.a, "smithjonas").is_empty());
    let in_b = ids(&f.b, "smithjones");
    assert_eq!(in_b.len(), 1);
    assert!(!in_b.contains(&sj));
}

// ── search.test.ts: searchText forms, end to end ──────────────────────────

#[test]
fn joined_forms_of_longer_names_and_the_sort_name_not_joined() {
    let f = world();
    let (vdb, _) = contact(
        &f.a,
        C {
            first: "Piet",
            last: "van der Berg",
            ..Default::default()
        },
    );
    let (mj, _) = contact(
        &f.a,
        C {
            last: "Mary-Jane O'Neil-Ward",
            ..Default::default()
        },
    );
    assert_eq!(ids(&f.a, "vanderberg"), std::slice::from_ref(&vdb));
    for typed in ["maryjane", "oneilward", "maryjaneoneilward"] {
        assert_eq!(ids(&f.a, typed), std::slice::from_ref(&mj), "{typed}");
    }
    // "Berg, Piet" is never one word.
    assert!(ids(&f.a, "bergpiet").is_empty());
    assert!(ids(&f.a, "vanderbergpiet").is_empty());
}

#[test]
fn emails_split_at_at_and_dot_phones_abroad_compact_postcodes() {
    let f = world();
    let (zoe, _) = contact(
        &f.a,
        C {
            first: "Zoë",
            last: "Ndiaye",
            email: " Zoe.N@Example.co.uk ",
            phone: "+1 212 555 0100",
            postcode: "SW1A1AA",
            ..Default::default()
        },
    );
    // matchesAll(text, ['zoe', 'n', 'example']): the local part's pieces.
    assert_eq!(ids(&f.a, "zoe n example"), std::slice::from_ref(&zoe));
    assert_eq!(ids(&f.a, "Zoë  N@Example"), std::slice::from_ref(&zoe));
    assert_eq!(ids(&f.a, "example co uk"), std::slice::from_ref(&zoe));
    // normalisePhone('+1 212 555 0100') = '12125550100', and its last six.
    assert_eq!(ids(&f.a, "12125550100"), std::slice::from_ref(&zoe));
    assert_eq!(ids(&f.a, "550100"), std::slice::from_ref(&zoe));
    // A postcode typed without its space gets the spaced form too.
    for typed in ["sw1a1aa", "sw1a 1aa", "SW1A", "1aa"] {
        assert_eq!(ids(&f.a, typed), std::slice::from_ref(&zoe), "{typed}");
    }
}

#[test]
fn nothing_searchable_and_at_most_sixteen_terms() {
    let f = world();
    let (zoe, _) = contact(
        &f.a,
        C {
            first: "Zoe",
            last: "Ndiaye",
            ..Default::default()
        },
    );
    // parseSearch('@@') has no terms: nothing found, no error.
    assert!(ids(&f.a, "@@").is_empty());
    // parseSearch keeps 16 terms: a 17th that matches nothing is dropped.
    let mut many: Vec<String> = std::iter::repeat_n("zoe".to_string(), 16).collect();
    many.push("nomatchxyz".into());
    assert_eq!(ids(&f.a, &many.join(" ")), [zoe]);
}

// ── searchList.test.ts: contact numbers ───────────────────────────────────

#[test]
fn no_prefix_matching_on_the_written_number() {
    let f = world();
    let (target, n) = contact(
        &f.a,
        C {
            last: "Mensah",
            ..Default::default()
        },
    );
    let written = format_number(n);
    for typed in [&written[..4], &written[..3]] {
        let found = list(&f.a, q(typed));
        assert!(found.rows.is_empty(), "{typed}");
        assert_eq!(found.number_match, None, "{typed}");
    }
    let found = list(&f.a, q(&written));
    assert_eq!(found.number_match.as_deref(), Some(target.as_str()));
}

#[test]
fn the_number_match_respects_the_filters_archived_and_kind() {
    let f = world();
    let (target, n) = contact(
        &f.a,
        C {
            org: "Ludlow Hall",
            ..Default::default()
        },
    );
    let written = format_number(n);
    assert!(
        ids_with(
            &f.a,
            SearchQuery {
                kind: Some(Kind::Individual),
                ..q(&written)
            }
        )
        .is_empty()
    );
    w(&f.a, |ctx| set_archived(ctx, &target, 0, true));
    let hidden = list(&f.a, q(&written));
    assert!(hidden.rows.is_empty());
    assert_eq!(hidden.number_match, None);
    assert_eq!(
        ids_with(
            &f.a,
            SearchQuery {
                include_archived: Some(true),
                ..q(&written)
            }
        ),
        [target]
    );
}

// ── searchList.test.ts: filters ───────────────────────────────────────────

#[test]
fn kind_with_a_search_archived_hidden_unless_asked() {
    let f = world();
    contact(
        &f.a,
        C {
            first: "Ruth",
            last: "Oakfield",
            ..Default::default()
        },
    );
    let (org, _) = contact(
        &f.a,
        C {
            org: "Oakfield Trust",
            ..Default::default()
        },
    );
    let (home, _) = contact(
        &f.a,
        C {
            org: "The Oakfield Household",
            kind: Some(Kind::Household),
            ..Default::default()
        },
    );
    let kind = |k: Kind, text: &str| {
        ids_with(
            &f.a,
            SearchQuery {
                kind: Some(k),
                ..q(text)
            },
        )
    };
    assert_eq!(
        kind(Kind::Organization, "oakfield"),
        std::slice::from_ref(&org)
    );
    assert_eq!(kind(Kind::Household, "oakfield"), [home]);
    w(&f.a, |ctx| set_archived(ctx, &org, 0, true));
    assert!(ids(&f.a, "oakfield trust").is_empty());
    assert_eq!(
        ids_with(
            &f.a,
            SearchQuery {
                include_archived: Some(true),
                ..q("oakfield trust")
            }
        ),
        [org]
    );
}

#[test]
fn an_exact_email_match_respects_the_kind_filter() {
    let f = world();
    let (org, _) = contact(
        &f.a,
        C {
            org: "Ludlow Hall",
            email: "hello@ludlow.example",
            ..Default::default()
        },
    );
    let kind = |k: Kind| {
        ids_with(
            &f.a,
            SearchQuery {
                kind: Some(k),
                ..q("hello@ludlow.example")
            },
        )
    };
    assert!(kind(Kind::Individual).is_empty());
    assert_eq!(kind(Kind::Organization), [org]);
}

#[test]
fn b_never_finds_a_by_name_email_or_postcode_and_a_shared_phone_stays_apart() {
    let f = world();
    let (in_a, _) = contact(
        &f.a,
        C {
            first: "Priya",
            last: "Okonjo",
            email: "priya@okonjo.example",
            phone: "07700 900123",
            postcode: "GL5 1AB",
            ..Default::default()
        },
    );
    let (in_b, _) = contact(
        &f.b,
        C {
            first: "Kofi",
            last: "Boateng",
            phone: "07700 900123",
            ..Default::default()
        },
    );
    for typed in ["okonjo", "priya@okonjo.example", "okonjo.example", "gl51ab"] {
        assert!(ids(&f.b, typed).is_empty(), "{typed}");
    }
    assert_eq!(ids(&f.b, "07700900123"), std::slice::from_ref(&in_b));
    assert_eq!(ids(&f.a, "07700900123"), [in_a]);
    assert!(!ids(&f.a, "07700900123").contains(&in_b));
}
