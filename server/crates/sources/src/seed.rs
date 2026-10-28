//! The starter categories, and demo details for the test and QC worlds
//! (Convex `sources/seed.ts`). Everything goes through the contract,
//! source `seed`, so a seeded part has its revisions like any other.

use contracts::{CommandGroup, ContractError, Ctx, Exec, Source, command_group, execute};
use rusqlite::OptionalExtension;

use crate::rules::{FIRST_VERSION_NAME, SEED_CATEGORIES, normalise_name};
use crate::{CODE, SourceCodePayload, create_part};

/// A new organisation's source codes: the seven categories, unless it
/// already has any source code (so a rerun is a no-op, and a deleted seed
/// never comes back). Returns how many it created.
pub fn seed_new_org(ctx: &Ctx) -> Result<usize, ContractError> {
    let any: bool =
        ctx.tx
            .read()
            .query_row("SELECT EXISTS (SELECT 1 FROM source_codes)", [], |r| {
                r.get(0)
            })?;
    if any {
        return Ok(0);
    }
    let group = command_group(ctx, "seed source codes")?;
    for name in SEED_CATEGORIES {
        create_part(
            ctx,
            SourceCodePayload {
                parent_id: None,
                name: name.into(),
                description: None,
                start_date: None,
                end_date: None,
                is_active: true,
            },
            Source::Seed,
            Some(&group),
        )?;
    }
    Ok(SEED_CATEGORIES.len())
}

/// A version to seed under a [`SeedDetail`].
#[derive(Clone, Debug, Default)]
pub struct SeedVersion {
    pub name: String,
    pub description: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

/// A detail to seed under an existing category, with its versions.
#[derive(Clone, Debug, Default)]
pub struct SeedDetail {
    pub category: String,
    pub name: String,
    pub description: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    /// The first is the auto-created `001`, renamed if named otherwise.
    pub versions: Vec<SeedVersion>,
    pub archived: bool,
}

fn by_name(ctx: &Ctx, parent: Option<&str>, name: &str) -> rusqlite::Result<Option<String>> {
    ctx.tx
        .read()
        .query_row(
            "SELECT id FROM source_codes WHERE parent_id IS ?1 AND name_normalized = ?2",
            rusqlite::params![parent, normalise_name(name)],
            |r| r.get(0),
        )
        .optional()
}

/// Seed `details` through the contract, source `seed`. A detail whose
/// category is missing, or that already exists, is skipped, so a rerun
/// changes nothing. Returns how many were created.
pub fn seed_details(
    ctx: &Ctx,
    details: &[SeedDetail],
    group: Option<&CommandGroup>,
) -> Result<usize, ContractError> {
    let mut created = 0;
    let mut own = None;
    for d in details {
        let Some(category) = by_name(ctx, None, &d.category)? else {
            continue;
        };
        if by_name(ctx, Some(&category), &d.name)?.is_some() {
            continue;
        }
        let g = match group {
            Some(g) => g,
            None => {
                if own.is_none() {
                    own = Some(command_group(ctx, "seed source codes")?);
                }
                own.as_ref().expect("just set")
            }
        };
        let made = create_part(
            ctx,
            SourceCodePayload {
                parent_id: Some(category),
                name: d.name.clone(),
                description: d.description.clone(),
                start_date: d.start_date.clone(),
                end_date: d.end_date.clone(),
                is_active: !d.archived,
            },
            Source::Seed,
            Some(g),
        )?;
        let version = |v: &SeedVersion, parent_id: Option<String>| SourceCodePayload {
            parent_id,
            name: v.name.clone(),
            description: v.description.clone(),
            start_date: v.start_date.clone(),
            end_date: v.end_date.clone(),
            is_active: true,
        };
        if let (Some(first), Some(version_id)) = (d.versions.first(), &made.version_id) {
            let renamed = first.name != FIRST_VERSION_NAME
                || first.description.is_some()
                || first.start_date.is_some()
                || first.end_date.is_some();
            if renamed {
                execute(
                    ctx,
                    &CODE,
                    version(first, None),
                    Exec::update(version_id, Some(0), Source::Seed).in_group(g),
                )?;
            }
        }
        for v in d.versions.iter().skip(1) {
            execute(
                ctx,
                &CODE,
                version(v, Some(made.id.clone())),
                Exec::create(Source::Seed).in_group(g),
            )?;
        }
        created += 1;
    }
    Ok(created)
}
