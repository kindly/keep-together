//! The QC suite's seeded world on the Rust backend (the counterpart of
//! Convex's `platform/qcSeed`): per run and Playwright worker, two
//! organisations and four users (admin A, admin B, A's staff and viewer),
//! three distinctively named contacts each, and A's "Volunteer status"
//! field (Active / Lapsed / Prospect, every kind, on no contact). Source
//! codes (A2): the starter categories, a Street detail named for the side
//! and run (`Alpha<run>`, `Bravo<run>`) and Event's `Gala`, each with
//! versions 001 and 002; Charles carries Street-<side>-001 and the Trust
//! -002, and the Gala codes are free for the flows to set. Gifts and Gift
//! Aid (B2): the Trust gave once under its code (A £12.34, B £56.78), and
//! Ada holds one paper declaration (future gifts, made 2025-01-01). Every
//! crate's reference data is there too (`schema::seed_new_org`: the UK
//! relationship types, the starter categories). An organisation and its
//! world are made in one go: a failure leaves no half-made group.
//!
//! Refused (403) unless both `KEEP_DEV_AUTH=1` and `KEEP_QC_SEED=1`.
//! Re-running with the same run and worker returns the same world (new
//! passwords and TOTP secrets each time).
//!
//! Every QC organisation's slug starts `qc-` and every QC user's email is
//! on [`QC_DOMAIN`] (`.invalid`, so no real person has one). The users get
//! a password and a TOTP secret, new on every seed, in the response body
//! only.
//!
//! **The token surface, `/api/qc/*`** (the nightly QC run on staging,
//! where dev auth is refused): `seed`, `crowd`, `hold` (as the dev routes)
//! and `session` (a full session for a QC user, so each test needn't
//! spend a TOTP code: a code is good once per 30 s step). Rules
//! ([`QcAccess`], [`QcCaller`]):
//! - only when `KEEP_QC_TOKEN` is set *and* `KEEP_ENV=staging`; a token
//!   with `KEEP_ENV=prod` stops the boot, and anywhere else it is ignored.
//!   Off, every `/api/qc/*` answers 404, as does a wrong or missing token;
//! - the token (≥ 64 characters) comes in the `x-keep-qc-token` header,
//!   never the URL; it is compared as SHA-256 digests in constant time
//!   (so its length doesn't time either), and never logged or echoed;
//! - per client address: at most [`QC_CALLS`] calls a minute, and after
//!   [`QC_FAILURES`] wrong tokens in 10 minutes every call is 429 before
//!   the token is looked at;
//! - `qc-` slugs are reserved ([`is_qc_slug`]): nothing else makes one;
//! - it reaches only `qc-` organisations and users whose every membership
//!   is in one: `crowd`/`hold` 404 on any other slug, `seed` refuses (403)
//!   a QC address that someone made a member of a real group, `session`
//!   404s for any other user; at most [`QC_TENANT_CAP`] `qc-` groups;
//! - the CSRF guard and the timing layer apply as to every `/api` route.

use axum::Json;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{FromRequestParts, State};
use axum::http::HeaderMap;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use contacts::acquisition::{ACQUISITION, Acquisition};
use contacts::fields::{FIELD, FIELD_OPTION};
use contacts::form::{create, save_form};
use contacts::identifiers::{
    IDENTIFIER_TYPE, IDENTIFIERS, IdentifierRow, IdentifierTypePayload, Identifiers,
};
use contacts::queries::{ListQuery, list};
use contacts::types::{
    ChannelLabel, CreateContact, Details, EmailRow, Expected, FieldOptionPayload, FieldPayload,
    Kind, Methods, SaveForm,
};
use contracts::{ContractError, Exec, Source, command_group, execute, transact};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sources::{SeedDetail, SeedVersion, seed_details};
use store::{OrgDb, Role, Store, UserId};
use ts_rs::TS;

use crate::auth::ClientIp;
use crate::{ApiError, AppState, Body, RoleName, blocking};

pub const QC_FIELD: &str = "Volunteer status";
/// A's Ada holds `shared` under it; in B the same name holds `shared`,
/// `bOnly` and `bReuse` on Ada, Charles and the Trust, then is archived:
/// B has no active type, A's search proves B's values don't leak, and A
/// can add `bReuse` without a clash.
pub const QC_IDENTIFIER_TYPE: &str = "Membership number";

/// The seeded identifier values: one token each with no name in it (the
/// name search never matches them), none a prefix of another.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QcIdentifiers {
    pub shared: String,
    pub b_only: String,
    pub b_reuse: String,
}

fn qc_identifiers(base: &str) -> QcIdentifiers {
    QcIdentifiers {
        shared: format!("ID{base}"),
        b_only: format!("IDB{base}"),
        b_reuse: format!("IDR{base}"),
    }
}
pub const QC_OPTIONS: [&str; 3] = ["Active", "Lapsed", "Prospect"];
/// Event's detail on both sides; its codes are on no contact.
pub const QC_EVENT_DETAIL: &str = "Gala";

fn enabled(state: &AppState) -> Result<(), ApiError> {
    let qc = std::env::var("KEEP_QC_SEED").is_ok_and(|v| v == "1");
    if state.dev_auth && qc {
        Ok(())
    } else {
        Err(ApiError::Forbidden)
    }
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QcSeedRequest {
    pub run_id: String,
    pub worker: u32,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QcUser {
    pub email: String,
    pub role: RoleName,
    /// Signs in for real (A4): this password, then a code from this TOTP
    /// secret (base32). Both new on every seed.
    pub password: String,
    pub totp_secret: String,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QcTenant {
    pub slug: String,
    /// In creation order: Ada, Charles, the Trust.
    pub contact_ids: Vec<String>,
    /// The Trust's gift.
    pub gift_ids: Vec<String>,
    /// Ada's declaration.
    pub declaration_ids: Vec<String>,
}

/// The Trust's seeded gift, pence, per side (A, B).
pub const QC_GIFT_PENCE: [i64; 2] = [1234, 5678];

#[derive(Serialize, TS)]
#[ts(export)]
pub struct QcField {
    pub label: String,
    pub options: Vec<String>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QcWorld {
    /// a, b, then A's staff and viewer.
    pub users: Vec<QcUser>,
    pub tenants: Vec<QcTenant>,
    pub field: QcField,
    pub identifier_type: String,
    pub identifiers: QcIdentifiers,
    /// The api runs `KEEP_MAIL=off` (staging until SES): what needs email
    /// is refused (`mail_off`), so the flows that send some check that
    /// refusal instead, and the run says so.
    pub mail_off: bool,
}

fn person(kind: Kind, first: &str, last: &str, name: &str) -> Details {
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

fn contact_ids(db: &OrgDb) -> Result<Vec<String>, ContractError> {
    let mut rows = db
        .read(|r| {
            list(
                r,
                &ListQuery {
                    include_archived: Some(true),
                    ..Default::default()
                },
            )
        })?
        .rows;
    rows.sort_by_key(|r| r.number);
    Ok(rows.into_iter().map(|r| r.id).collect())
}

/// The Trust's gifts and Ada's declarations, as seeded.
fn seeded_giving(
    db: &OrgDb,
    contacts: &[String],
) -> Result<(Vec<String>, Vec<String>), ContractError> {
    let (Some(ada), Some(trust)) = (contacts.first(), contacts.get(2)) else {
        return Ok((vec![], vec![]));
    };
    Ok(db.read(|r| {
        let ids = |sql: &str, contact: &str| {
            r.prepare(sql)?
                .query_map([contact], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()
        };
        Ok::<_, rusqlite::Error>((
            ids(
                "SELECT id FROM gifts WHERE contact_id = ?1 ORDER BY rowid",
                trust,
            )?,
            ids(
                "SELECT id FROM gift_aid_declarations WHERE contact_id = ?1 ORDER BY rowid",
                ada,
            )?,
        ))
    })?)
}

fn side(
    db: &OrgDb,
    label: &str,
    run_id: &str,
    base: &str,
    slug: &str,
    with_field: bool,
) -> Result<Vec<String>, ContractError> {
    transact(db, None, |ctx| {
        let group = command_group(ctx, "qc seed")?;
        let name = format!("{label}-{run_id}");
        let mut ids = vec![];
        for d in [
            person(Kind::Individual, "Ada", &name, ""),
            person(Kind::Individual, "Charles", &name, ""),
            person(Kind::Organization, "", "", &format!("{name} Trust")),
        ] {
            let local: String = if d.first_name.is_empty() {
                &d.name
            } else {
                &d.first_name
            }
            .to_lowercase()
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .collect();
            let id = create(
                ctx,
                CreateContact {
                    id: None,
                    details: d,
                },
                Source::Seed,
            )?
            .id;
            save_form(
                ctx,
                &id,
                SaveForm {
                    methods: Some(Expected {
                        expected: 0,
                        slice: Methods {
                            emails: vec![EmailRow {
                                key: None,
                                label: ChannelLabel::Home,
                                address: format!("{local}-{slug}@example.com"),
                                is_primary: true,
                            }],
                            phones: vec![],
                        },
                    }),
                    ..Default::default()
                },
            )?;
            ids.push(id);
        }
        let ids_held = qc_identifiers(base);
        let type_id = execute(
            ctx,
            &IDENTIFIER_TYPE,
            IdentifierTypePayload {
                name: QC_IDENTIFIER_TYPE.into(),
                is_active: true,
            },
            Exec::create(Source::Seed).in_group(&group),
        )?
        .id;
        let held = if with_field {
            vec![(&ids[0], &ids_held.shared)]
        } else {
            vec![
                (&ids[0], &ids_held.shared),
                (&ids[1], &ids_held.b_only),
                (&ids[2], &ids_held.b_reuse),
            ]
        };
        for (contact, value) in held {
            execute(
                ctx,
                &IDENTIFIERS,
                Identifiers {
                    identifiers: vec![IdentifierRow {
                        key: None,
                        type_id: type_id.clone(),
                        value: value.clone(),
                    }],
                },
                Exec::update(contact, Some(0), Source::Seed).in_group(&group),
            )?;
        }
        if !with_field {
            execute(
                ctx,
                &IDENTIFIER_TYPE,
                IdentifierTypePayload {
                    name: QC_IDENTIFIER_TYPE.into(),
                    is_active: false,
                },
                Exec::update(&type_id, Some(0), Source::Seed).in_group(&group),
            )?;
        }
        crate::schema::seed_new_org(ctx)?;
        let versions = || {
            ["001", "002"]
                .map(|name| SeedVersion {
                    name: name.into(),
                    ..Default::default()
                })
                .to_vec()
        };
        let street_detail = format!("{label}{run_id}");
        seed_details(
            ctx,
            &[
                SeedDetail {
                    category: "Street".into(),
                    name: street_detail.clone(),
                    versions: versions(),
                    ..Default::default()
                },
                SeedDetail {
                    category: "Event".into(),
                    name: QC_EVENT_DETAIL.into(),
                    versions: versions(),
                    ..Default::default()
                },
            ],
            Some(&group),
        )?;
        // Charles on Street-<side>-001, the Trust on -002.
        for (contact, version) in [(&ids[1], "001"), (&ids[2], "002")] {
            let code: String = ctx.tx.read().query_row(
                "SELECT v.id FROM source_codes v
                 JOIN source_codes d ON d.id = v.parent_id
                 JOIN source_codes c ON c.id = d.parent_id
                 WHERE c.name = 'Street' AND d.name = ?1 AND v.name = ?2",
                [&street_detail, version],
                |r| r.get(0),
            )?;
            execute(
                ctx,
                &ACQUISITION,
                Acquisition {
                    code_id: Some(code),
                },
                Exec::update(contact, Some(0), Source::Seed).in_group(&group),
            )?;
        }
        // The Trust's gift under its own code, and Ada's declaration.
        let trust_code: String = ctx.tx.read().query_row(
            "SELECT v.id FROM source_codes v
             JOIN source_codes d ON d.id = v.parent_id
             JOIN source_codes c ON c.id = d.parent_id
             WHERE c.name = 'Street' AND d.name = ?1 AND v.name = '002'",
            [&street_detail],
            |r| r.get(0),
        )?;
        let pence = QC_GIFT_PENCE[usize::from(!with_field)];
        giving::create_gift(
            ctx,
            giving::GiftPayload {
                contact_id: ids[2].clone(),
                received_on: "2025-06-01".into(),
                amount: pence,
                method: giving::types::Method::Cash,
                reference: None,
                allocations: vec![giving::types::AllocationRow {
                    key: None,
                    source_code_id: trust_code,
                    amount: pence,
                }],
                client_key: None,
            },
            Source::Seed,
            Some(&group),
        )?;
        giftaid::make_declaration(
            ctx,
            giftaid::DeclarationPayload {
                contact_id: ids[0].clone(),
                scope: giftaid::Scope::Future,
                gift_id: None,
                made_on: "2025-01-01".into(),
                method: giftaid::Method::PaperForm,
                wording_version: giftaid::HMRC_MODEL_WORDING_VERSION.into(),
                first_name: "Ada".into(),
                last_name: name.clone(),
                address_line1: "1 High Street".into(),
                postcode: "SW1A 1AA".into(),
            },
            Source::Seed,
            Some(&group),
        )?;
        if with_field {
            let field = execute(
                ctx,
                &FIELD,
                FieldPayload {
                    label: QC_FIELD.into(),
                    applies_to: Kind::ALL.to_vec(),
                    is_active: true,
                },
                Exec::create(Source::Seed).in_group(&group),
            )?;
            for (position, label) in QC_OPTIONS.iter().enumerate() {
                execute(
                    ctx,
                    &FIELD_OPTION,
                    FieldOptionPayload {
                        field_id: field.id.clone(),
                        label: (*label).into(),
                        position: position as u32,
                        is_active: true,
                    },
                    Exec::create(Source::Seed).in_group(&group),
                )?;
            }
        }
        Ok(ids)
    })
}

/// QC users' addresses: reserved (RFC 2606), so no real one matches.
pub const QC_DOMAIN: &str = "qc.keep-together.invalid";
/// Every QC organisation's slug starts with this.
pub const QC_SLUG_PREFIX: &str = "qc-";
/// The most `qc-` organisations a store holds (staging wipes on deploy).
pub const QC_TENANT_CAP: i64 = 1000;
/// The token's header.
pub const QC_TOKEN_HEADER: &str = "x-keep-qc-token";
/// Calls a minute per client address on `/api/qc/*`.
pub const QC_CALLS: u32 = 600;
/// Wrong tokens per client address in 10 minutes before every call is 429.
pub const QC_FAILURES: u32 = 10;
/// The shortest token accepted (256 bits as hex).
pub const QC_TOKEN_MIN: usize = 64;

/// `r<run>w<worker>`: the run id is the harness's base-36 stamp; anything
/// else is refused, so it can't shape a slug or an address.
fn base(req: &QcSeedRequest) -> Result<String, ApiError> {
    let ok = (1..=16).contains(&req.run_id.len())
        && req
            .run_id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && req.worker < 1000;
    if !ok {
        return Err(ApiError::Invalid {
            problems: vec![contracts::Problem::new(
                "runId",
                "1–16 lower-case letters or digits, worker under 1000",
            )],
        });
    }
    Ok(format!("r{}w{}", req.run_id, req.worker))
}

/// Whether `slug` is in the reserved `qc-` space: only [`seed_world`]
/// makes such groups; `keep tenant create` and `/api/dev/tenants` refuse
/// them, so the token never reaches a real group.
pub fn is_qc_slug(slug: &str) -> bool {
    slug.starts_with(QC_SLUG_PREFIX)
}

/// Whether every membership `user` holds is in a `qc-` organisation.
fn only_qc_memberships(conn: &Connection, user: UserId) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT NOT EXISTS (SELECT 1 FROM memberships m JOIN tenants t ON t.id = m.tenant_id
                            WHERE m.user_id = ?1 AND t.slug NOT LIKE 'qc-%')",
        [user.0],
        |r| r.get(0),
    )
}

/// The QC world for one run and worker (both surfaces).
fn seed_world(
    store: &Store,
    keys: &::auth::Keys,
    req: QcSeedRequest,
    mail_off: bool,
) -> Result<QcWorld, ApiError> {
    let p = store.platform();
    let base = base(&req)?;
    let accounts = [
        ("a", Role::Admin),
        ("b", Role::Admin),
        ("a-staff", Role::Staff),
        ("a-viewer", Role::Viewer),
    ];
    let mut users = vec![];
    let mut credentials = vec![];
    for (suffix, role) in accounts {
        let email = format!("qc-{base}-{suffix}@{QC_DOMAIN}");
        let password = ::auth::secret::token();
        let secret = ::auth::totp::new_secret();
        let now = contracts::now_ms();
        let user = p.with_write(|tx| {
            let user = store::Platform::upsert_user_in(tx, &email)?;
            // A QC address someone added to a real group: leave it be.
            if !only_qc_memberships(tx, user)? {
                return Err(ApiError::Forbidden);
            }
            ::auth::accounts::set_password(tx, user.0, &password, now)
                .map_err(ApiError::internal)?;
            ::auth::accounts::set_second_factor(
                tx,
                keys,
                user.0,
                ::auth::SecondFactor::Totp,
                Some((secret.as_str(), 0)),
                now,
            )?;
            Ok::<_, ApiError>(user)
        })?;
        credentials.push((password, secret));
        users.push((user, email, role));
    }
    let mut tenants = vec![];
    for (i, (suffix, label)) in [("a", "Alpha"), ("b", "Bravo")].into_iter().enumerate() {
        let slug = format!("{QC_SLUG_PREFIX}{base}-{suffix}");
        let (tenant, made) = match p.tenant_by_slug(&slug)? {
            Some(t) => (t, None),
            None => {
                let qc_groups: i64 = p.with_read(|c| {
                    c.query_row(
                        "SELECT count(*) FROM tenants WHERE slug LIKE 'qc-%'",
                        [],
                        |r| r.get(0),
                    )
                })?;
                if qc_groups >= QC_TENANT_CAP {
                    return Err(ApiError::Rejected {
                        reason: "qc_tenant_cap".into(),
                        message: format!("at most {QC_TENANT_CAP} qc- groups"),
                    });
                }
                // The org and its world commit together, or neither does.
                let mut made = None;
                let tenant = store.create_tenant_with(
                    &slug,
                    &format!("{label} {base} qc group"),
                    |_, _, db| {
                        made = Some(side(db, label, &req.run_id, &base, &slug, suffix == "a")?);
                        Ok::<_, ApiError>(())
                    },
                )?;
                (tenant, made)
            }
        };
        p.set_membership(users[i].0, &tenant.id, Role::Admin)?;
        if suffix == "a" {
            for (user, _, role) in &users[2..] {
                p.set_membership(*user, &tenant.id, *role)?;
            }
        }
        let db = store.org(&tenant.id)?;
        let contact_ids = match made {
            Some(ids) => ids,
            None => contact_ids(&db)?,
        };
        let (gift_ids, declaration_ids) = seeded_giving(&db, &contact_ids)?;
        tenants.push(QcTenant {
            slug,
            contact_ids,
            gift_ids,
            declaration_ids,
        });
    }
    Ok(QcWorld {
        users: users
            .into_iter()
            .zip(credentials)
            .map(|((_, email, role), (password, totp_secret))| QcUser {
                email,
                role: role.into(),
                password,
                totp_secret,
            })
            .collect(),
        tenants,
        field: QcField {
            label: QC_FIELD.into(),
            options: QC_OPTIONS.iter().map(|s| (*s).into()).collect(),
        },
        identifier_type: QC_IDENTIFIER_TYPE.into(),
        identifiers: qc_identifiers(&base),
        mail_off,
    })
}

/// `POST /api/dev/qc-seed {runId, worker}`
pub async fn fixture(
    State(state): State<AppState>,
    Body(req): Body<QcSeedRequest>,
) -> Result<Json<QcWorld>, ApiError> {
    enabled(&state)?;
    let store = state.store.clone();
    let keys = state.auth.keys.clone();
    let mail_off = state.auth.mailer.is_off();
    blocking(move || seed_world(&store, &keys, req, mail_off))
        .await
        .map(Json)
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QcCrowdRequest {
    pub slug: String,
    pub last_name: String,
    pub count: u32,
}

/// The most contacts one `qc-crowd` call makes (L1).
pub const CROWD_MAX: u32 = 10_000;

/// `count` individuals named `n0001 <lastName>` … through the details
/// contract, 100 to a transaction (as Convex's `crowd`).
fn crowd_in(store: &Store, req: QcCrowdRequest) -> Result<u32, ApiError> {
    if req.count > CROWD_MAX {
        return Err(ApiError::Invalid {
            problems: vec![contracts::Problem::new(
                "count",
                format!("at most {CROWD_MAX}"),
            )],
        });
    }
    let tenant = store
        .platform()
        .tenant_by_slug(&req.slug)?
        .ok_or(ApiError::NotFound)?;
    let db = store.org(&tenant.id)?;
    for from in (0..req.count).step_by(100) {
        transact(&db, None, |ctx| {
            let group = command_group(ctx, "qc crowd")?;
            for i in from..(from + 100).min(req.count) {
                let d = person(
                    Kind::Individual,
                    &format!("n{:04}", i + 1),
                    &req.last_name,
                    "",
                );
                execute(
                    ctx,
                    &contacts::DETAILS,
                    d,
                    Exec::create(Source::Seed).in_group(&group),
                )?;
            }
            Ok::<_, ContractError>(())
        })?;
    }
    Ok(req.count)
}

/// `POST /api/dev/qc-crowd {slug, lastName, count}`: the paged list's
/// crowd. Returns the count.
pub async fn crowd(
    State(state): State<AppState>,
    Body(req): Body<QcCrowdRequest>,
) -> Result<Json<u32>, ApiError> {
    enabled(&state)?;
    let store = state.store.clone();
    blocking(move || crowd_in(&store, req)).await.map(Json)
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct QcHoldRequest {
    pub slug: String,
    pub address: String,
}

/// Hold an address as a hard bounce would (Convex `qcSeed:hold`), as the
/// system, like the provider's webhook. Whether it changed.
fn hold_in(store: &Store, req: QcHoldRequest) -> Result<bool, ApiError> {
    let tenant = store
        .platform()
        .tenant_by_slug(&req.slug)?
        .ok_or(ApiError::NotFound)?;
    let db = store.org(&tenant.id)?;
    let (changed, _) = transact(&db, None, |ctx| {
        comms::suppress_address(ctx, &req.address, Some("qc".into()), None)
    })?;
    Ok(changed)
}

/// `POST /api/dev/qc-hold {slug, address}`, for the email-hold flows.
pub async fn hold(
    State(state): State<AppState>,
    Body(req): Body<QcHoldRequest>,
) -> Result<Json<bool>, ApiError> {
    enabled(&state)?;
    let store = state.store.clone();
    blocking(move || hold_in(&store, req)).await.map(Json)
}

// ── the token surface ──────────────────────────────────────────────────────

/// Calls in the current window per client address.
struct Window {
    started: Instant,
    count: u32,
}

/// Fixed windows per key: `allow` counts a call, `over` only looks.
struct Windows {
    span: Duration,
    max: u32,
    map: Mutex<HashMap<String, Window>>,
}

impl Windows {
    fn new(span: Duration, max: u32) -> Self {
        Self {
            span,
            max,
            map: Mutex::new(HashMap::new()),
        }
    }

    fn with<T>(&self, key: &str, f: impl FnOnce(&mut Window, u32) -> T) -> T {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if map.len() > 10_000 {
            map.retain(|_, w| now.duration_since(w.started) < self.span);
        }
        let w = map.entry(key.to_owned()).or_insert(Window {
            started: now,
            count: 0,
        });
        if now.duration_since(w.started) >= self.span {
            *w = Window {
                started: now,
                count: 0,
            };
        }
        f(w, self.max)
    }

    /// Count one; false if that went over the limit.
    fn allow(&self, key: &str) -> bool {
        self.with(key, |w, max| {
            w.count = w.count.saturating_add(1);
            w.count <= max
        })
    }

    fn over(&self, key: &str) -> bool {
        self.with(key, |w, max| w.count >= max)
    }
}

/// `KEEP_QC_TOKEN`, as its SHA-256 (hex), and its rate limits. Never
/// printed: `Debug` shows nothing of it.
pub struct QcAccess {
    digest: String,
    calls: Windows,
    failures: Windows,
}

impl std::fmt::Debug for QcAccess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("QcAccess(..)")
    }
}

impl QcAccess {
    /// A token of at least [`QC_TOKEN_MIN`] printable ASCII characters.
    /// The error never quotes it.
    pub fn new(token: &str) -> Result<Self, String> {
        if token.len() < QC_TOKEN_MIN || !token.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(format!(
                "KEEP_QC_TOKEN must be at least {QC_TOKEN_MIN} printable characters (e.g. 32 random bytes as hex)"
            ));
        }
        Ok(Self {
            digest: ::auth::secret::hash(token),
            calls: Windows::new(Duration::from_secs(60), QC_CALLS),
            failures: Windows::new(Duration::from_secs(600), QC_FAILURES),
        })
    }

    /// From `KEEP_ENV` and `KEEP_QC_TOKEN`: on only with `staging` and a
    /// token; a token with `prod` is an error (the boot stops); with any
    /// other `KEEP_ENV` it stays off (the caller warns).
    pub fn from_env(keep_env: Option<&str>, token: Option<&str>) -> Result<Option<Self>, String> {
        let Some(token) = token.filter(|t| !t.is_empty()) else {
            return Ok(None);
        };
        match keep_env {
            Some("prod") => Err("KEEP_QC_TOKEN is refused with KEEP_ENV=prod".into()),
            Some("staging") => Self::new(token).map(Some),
            _ => Ok(None),
        }
    }

    /// The header's token is this one: SHA-256 digests compared in
    /// constant time, so neither content nor length times.
    fn matches(&self, given: &str) -> bool {
        !given.is_empty() && ::auth::secret::same(&::auth::secret::hash(given), &self.digest)
    }
}

/// A caller of `/api/qc/*` that passed the gate (module docs). Rejects
/// with 404 when the surface is off or the token is wrong or missing,
/// 429 over a limit.
pub struct QcCaller;

impl FromRequestParts<AppState> for QcCaller {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let Some(qc) = state.qc.clone() else {
            return Err(ApiError::NotFound);
        };
        let ClientIp(ip) = ClientIp::from_request_parts(parts, state).await?;
        if qc.failures.over(&ip) || !qc.calls.allow(&ip) {
            return Err(ApiError::RateLimited);
        }
        let given = parts
            .headers
            .get(QC_TOKEN_HEADER)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if qc.matches(given) {
            Ok(QcCaller)
        } else {
            qc.failures.allow(&ip);
            Err(ApiError::NotFound)
        }
    }
}

/// `POST /api/qc/seed {runId, worker}`: [`fixture`]'s world.
pub async fn qc_fixture(
    _: QcCaller,
    State(state): State<AppState>,
    Body(req): Body<QcSeedRequest>,
) -> Result<Json<QcWorld>, ApiError> {
    let store = state.store.clone();
    let keys = state.auth.keys.clone();
    let mail_off = state.auth.mailer.is_off();
    blocking(move || seed_world(&store, &keys, req, mail_off))
        .await
        .map(Json)
}

/// `POST /api/qc/crowd`: [`crowd`], in a `qc-` group only.
pub async fn qc_crowd(
    _: QcCaller,
    State(state): State<AppState>,
    Body(req): Body<QcCrowdRequest>,
) -> Result<Json<u32>, ApiError> {
    if !is_qc_slug(&req.slug) {
        return Err(ApiError::NotFound);
    }
    let store = state.store.clone();
    blocking(move || crowd_in(&store, req)).await.map(Json)
}

/// `POST /api/qc/hold`: [`hold`], in a `qc-` group only.
pub async fn qc_hold(
    _: QcCaller,
    State(state): State<AppState>,
    Body(req): Body<QcHoldRequest>,
) -> Result<Json<bool>, ApiError> {
    if !is_qc_slug(&req.slug) {
        return Err(ApiError::NotFound);
    }
    let store = state.store.clone();
    blocking(move || hold_in(&store, req)).await.map(Json)
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct QcSessionRequest {
    pub email: String,
}

/// `POST /api/qc/session {email}`: a full session cookie for a QC user
/// (an address on [`QC_DOMAIN`], a member of `qc-` groups only and of at
/// least one); anyone else is 404. An ordinary session, not a dev one.
pub async fn qc_session(
    _: QcCaller,
    State(state): State<AppState>,
    headers: HeaderMap,
    Body(req): Body<QcSessionRequest>,
) -> Result<Response, ApiError> {
    let email = crate::auth::users::normalise_email(&req.email).ok_or(ApiError::NotFound)?;
    if !email.ends_with(&format!("@{QC_DOMAIN}")) {
        return Err(ApiError::NotFound);
    }
    let store = state.store.clone();
    let token = blocking(move || {
        store.platform().with_write(|tx| {
            let Some(user) = crate::auth::users::by_email(tx, &email)? else {
                return Err(ApiError::NotFound);
            };
            let groups: i64 = tx.query_row(
                "SELECT count(*) FROM memberships WHERE user_id = ?1",
                [user],
                |r| r.get(0),
            )?;
            if groups == 0 || !only_qc_memberships(tx, UserId(user))? {
                return Err(ApiError::NotFound);
            }
            Ok(::auth::sessions::create(
                tx,
                user,
                ::auth::Stage::Full,
                contracts::now_ms(),
            )?)
        })
    })
    .await?;
    crate::auth::with_session(
        Json(serde_json::json!({ "ok": true })).into_response(),
        &headers,
        &token,
        ::auth::Stage::Full,
    )
}
