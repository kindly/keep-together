//! The QC suite's seeded world on the Rust backend (the counterpart of
//! Convex's `platform/qcSeed`): per run and Playwright worker, two
//! organisations and four users (admin A, admin B, A's staff and viewer),
//! three distinctively named contacts each, and A's "Volunteer status"
//! field (Active / Lapsed / Prospect, every kind, on no contact). Source
//! codes (A2): the starter categories, a Street detail named for the side
//! and run (`Alpha<run>`, `Bravo<run>`) and Event's `Gala`, each with
//! versions 001 and 002; Charles carries Street-<side>-001 and the Trust
//! -002, and the Gala codes are free for the flows to set. Users
//! sign in with the dev login, so there are no passwords.
//!
//! Refused (403) unless both `KEEP_DEV_AUTH=1` and `KEEP_QC_SEED=1`.
//! Re-running with the same run and worker returns the same world.

use axum::Json;
use axum::extract::State;
use contacts::acquisition::{ACQUISITION, Acquisition};
use contacts::fields::{FIELD, FIELD_OPTION};
use contacts::form::{create, save_form};
use contacts::queries::{ListQuery, list};
use contacts::types::{
    ChannelLabel, CreateContact, Details, EmailRow, Expected, FieldOptionPayload, FieldPayload,
    Kind, Methods, SaveForm,
};
use contracts::{ContractError, Exec, Source, command_group, execute, transact};
use serde::{Deserialize, Serialize};
use sources::{SeedDetail, SeedVersion, seed_details};
use store::{OrgDb, Role};
use ts_rs::TS;

use crate::{ApiError, AppState, Body, RoleName, blocking};

pub const QC_FIELD: &str = "Volunteer status";
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
#[ts(export)]
pub struct QcUser {
    pub email: String,
    pub role: RoleName,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QcTenant {
    pub slug: String,
    /// In creation order: Ada, Charles, the Trust.
    pub contact_ids: Vec<String>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct QcField {
    pub label: String,
    pub options: Vec<String>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct QcWorld {
    /// a, b, then A's staff and viewer.
    pub users: Vec<QcUser>,
    pub tenants: Vec<QcTenant>,
    pub field: QcField,
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

fn side(
    db: &OrgDb,
    label: &str,
    run_id: &str,
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
        sources::seed_new_org(ctx)?;
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

/// `POST /api/dev/qc-seed {runId, worker}`
pub async fn fixture(
    State(state): State<AppState>,
    Body(req): Body<QcSeedRequest>,
) -> Result<Json<QcWorld>, ApiError> {
    enabled(&state)?;
    let store = state.store.clone();
    blocking(move || {
        let p = store.platform();
        let base = format!("r{}w{}", req.run_id, req.worker);
        let accounts = [
            ("a", Role::Admin),
            ("b", Role::Admin),
            ("a-staff", Role::Staff),
            ("a-viewer", Role::Viewer),
        ];
        let mut users = vec![];
        for (suffix, role) in accounts {
            let email = format!("qc-{base}-{suffix}@example.com");
            users.push((p.upsert_user(&email)?, email, role));
        }
        let mut tenants = vec![];
        for (i, (suffix, label)) in [("a", "Alpha"), ("b", "Bravo")].into_iter().enumerate() {
            let slug = format!("{base}-{suffix}");
            let (tenant, fresh) = match p.tenant_by_slug(&slug)? {
                Some(t) => (t, false),
                None => (
                    store.create_tenant(&slug, &format!("{label} {base} qc group"))?,
                    true,
                ),
            };
            p.set_membership(users[i].0, &tenant.id, Role::Admin)?;
            if suffix == "a" {
                for (user, _, role) in &users[2..] {
                    p.set_membership(*user, &tenant.id, *role)?;
                }
            }
            let db = store.org(&tenant.id)?;
            let contact_ids = if fresh {
                side(&db, label, &req.run_id, &slug, suffix == "a")?
            } else {
                contact_ids(&db)?
            };
            tenants.push(QcTenant { slug, contact_ids });
        }
        Ok::<_, ApiError>(QcWorld {
            users: users
                .into_iter()
                .map(|(_, email, role)| QcUser {
                    email,
                    role: role.into(),
                })
                .collect(),
            tenants,
            field: QcField {
                label: QC_FIELD.into(),
                options: QC_OPTIONS.iter().map(|s| (*s).into()).collect(),
            },
        })
    })
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

/// `POST /api/dev/qc-crowd {slug, lastName, count}`: `count` individuals
/// named `n0001 <lastName>` … through the details contract, 100 to a
/// transaction (as Convex's `crowd`). Returns the count.
pub async fn crowd(
    State(state): State<AppState>,
    Body(req): Body<QcCrowdRequest>,
) -> Result<Json<u32>, ApiError> {
    enabled(&state)?;
    if req.count > CROWD_MAX {
        return Err(ApiError::Invalid {
            problems: vec![contracts::Problem::new(
                "count",
                format!("at most {CROWD_MAX}"),
            )],
        });
    }
    let store = state.store.clone();
    blocking(move || {
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
        Ok::<_, ApiError>(req.count)
    })
    .await
    .map(Json)
}
