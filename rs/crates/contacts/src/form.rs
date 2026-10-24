//! Commands on a contact: create, the form save (several slices in one
//! transaction), archive, restore. Each runs inside the caller's
//! transaction (`Ctx`); the API and the seed call the same functions.

use contracts::{
    Contract, ContractError, Ctx, Exec, Executed, Source, canonical, command_group, execute,
    restore, restore_entity_to,
};
use rusqlite::OptionalExtension;

use crate::REGISTRY;
use crate::identifiers::{IDENTIFIERS, identifier_problems, load_identifiers};
use crate::queries::counters;
use crate::slices::{
    ADDRESSES, ARCHIVE, DETAILS, FIELD_VALUES, METHODS, field_refusals, load_addresses,
    load_details, load_field_values, load_methods,
};
use crate::types::{
    Archive, Counters, CreateContact, Created, Expected, FormProblem, RestoreRequest, Restored,
    SaveForm, SaveFormResult, SaveSource,
};

/// Create a contact from its details. A `clientKey` or pre-generated `id`
/// seen before is `Duplicate { id }` (the command already ran).
pub fn create(ctx: &Ctx, req: CreateContact, source: Source) -> Result<Created, ContractError> {
    create_in(ctx, req, source, None)
}

/// [`create`], in `group` when given (a create with an acquisition code).
pub(crate) fn create_in(
    ctx: &Ctx,
    req: CreateContact,
    source: Source,
    group: Option<&contracts::CommandGroup>,
) -> Result<Created, ContractError> {
    let mut opts = match &req.id {
        Some(id) => Exec::create_with_id(id, source),
        None => Exec::create(source),
    };
    if let Some(g) = group {
        opts = opts.in_group(g);
    }
    let Executed { id, .. } = execute(ctx, &DETAILS, req.details, opts)?;
    let number =
        ctx.tx
            .read()
            .query_row("SELECT number FROM contacts WHERE id = ?1", [&id], |r| {
                r.get(0)
            })?;
    Ok(Created { id, number })
}

/// Runs one queued slice, in the save's group if it has one; returns the
/// slice's new counter.
type Run<'a> =
    Box<dyn FnOnce(&Ctx, Option<&contracts::CommandGroup>) -> Result<i64, ContractError> + 'a>;

/// One slice the form submitted, after prepare and the diff.
struct Change<'a> {
    name: &'static str,
    run: Run<'a>,
}

/// A form save in progress: what it reports and what it will run.
struct Form<'a> {
    id: &'a str,
    source: Source,
    out: SaveFormResult,
    changes: Vec<Change<'a>>,
}

impl<'a> Form<'a> {
    /// Prepare `submitted`, diff it against the slice's state now
    /// (`current`, at `counter`), and queue it if it changed and isn't
    /// stale. Invalid → `problems`, stale → `stale` + `current`; neither
    /// stops the other slices.
    fn consider<C>(
        &mut self,
        contract: &'static C,
        name: &'static str,
        submitted: Option<Expected<C::Payload>>,
        current: serde_json::Value,
        counter: i64,
    ) -> Result<Option<C::Payload>, ContractError>
    where
        C: Contract,
        C::Payload: Clone + 'a,
    {
        let Some(Expected { expected, slice }) = submitted else {
            return Ok(None);
        };
        let prepared = match contract.prepare(slice) {
            Ok(p) => p,
            Err(ContractError::Invalid(problems)) => {
                self.out
                    .problems
                    .insert(name.into(), problems.into_iter().map(Into::into).collect());
                return Ok(None);
            }
            Err(e) => return Err(e),
        };
        let mut value = serde_json::to_value(&prepared)?;
        if let Some(map) = value.as_object_mut() {
            // Create-only; never part of a save's diff.
            map.remove("clientKey");
        }
        if canonical(&value) == canonical(&current) {
            return Ok(None);
        }
        if expected != counter {
            self.out.stale.insert(name.into(), counter);
            self.out.current.insert(name.into(), current);
            return Ok(None);
        }
        let (id, source, payload) = (self.id, self.source, prepared.clone());
        self.changes.push(Change {
            name,
            run: Box::new(move |ctx, group| {
                let mut opts = Exec::update(id, Some(expected), source);
                if let Some(g) = group {
                    opts = opts.in_group(g);
                }
                Ok(execute(ctx, contract, payload, opts)?.counter)
            }),
        });
        Ok(Some(prepared))
    }
}

/// The contact form's save: every slice provided is diffed against the
/// stored state and only changed ones execute (a no-op save writes
/// nothing). Invalid or stale slices are reported and skipped; the rest
/// save, under one command group when there are several. A field value
/// refused mid-edit (an option archived) is reported on its field.
pub fn save_form(ctx: &Ctx, id: &str, form: SaveForm) -> Result<SaveFormResult, ContractError> {
    let tx = ctx.tx.read();
    let Some(now) = counters(tx, id)? else {
        return Err(ContractError::NotFound);
    };
    let mut f = Form {
        id,
        source: match form.source.unwrap_or_default() {
            SaveSource::Ui => Source::Ui,
            SaveSource::Autosave => Source::Autosave,
        },
        out: SaveFormResult::default(),
        changes: Vec::new(),
    };
    f.consider(
        &DETAILS,
        "details",
        form.details,
        serde_json::to_value(load_details(tx, id)?)?,
        now.details,
    )?;
    f.consider(
        &METHODS,
        "methods",
        form.methods,
        serde_json::to_value(load_methods(tx, id)?)?,
        now.methods,
    )?;
    f.consider(
        &ADDRESSES,
        "addresses",
        form.addresses,
        serde_json::to_value(load_addresses(tx, id)?)?,
        now.addresses,
    )?;
    let fields = f.consider(
        &FIELD_VALUES,
        "fields",
        form.fields,
        serde_json::json!({ "values": load_field_values(tx, id)? }),
        now.fields,
    )?;
    let identifiers = f.consider(
        &IDENTIFIERS,
        "identifiers",
        form.identifiers,
        serde_json::to_value(load_identifiers(tx, id)?)?,
        now.identifiers,
    )?;
    // A clash or a type archived mid-edit is the contract's refusal too,
    // but caught here it stays on its row: the other slices still save.
    if let Some(identifiers) = identifiers {
        let refused = identifier_problems(tx, id, &identifiers.identifiers)?;
        if !refused.is_empty() {
            f.out.problems.insert("identifiers".into(), refused);
            f.changes.retain(|c| c.name != "identifiers");
        }
    }
    if let Some(fields) = fields {
        let refused = field_refusals(tx, id, &fields.values)?;
        if !refused.is_empty() {
            f.out.problems.insert(
                "fields".into(),
                refused
                    .into_iter()
                    .map(|r| FormProblem {
                        field: "fields".into(),
                        message: r.message,
                        key: Some(r.field_id),
                        contact_id: None,
                    })
                    .collect(),
            );
            f.changes.retain(|c| c.name != "fields");
        }
    }

    let Form {
        mut out, changes, ..
    } = f;
    let group = if changes.len() > 1 {
        Some(command_group(ctx, "contact form save")?)
    } else {
        None
    };
    let mut counters = now;
    for change in changes {
        let counter = (change.run)(ctx, group.as_ref())?;
        set_counter(&mut counters, change.name, counter);
        out.saved.push(change.name.into());
    }
    out.counters = counters;
    Ok(out)
}

fn set_counter(c: &mut Counters, name: &str, value: i64) {
    match name {
        "details" => c.details = value,
        "methods" => c.methods = value,
        "addresses" => c.addresses = value,
        "archive" => c.archive = value,
        "fields" => c.fields = value,
        "identifiers" => c.identifiers = value,
        "acquisition" => c.acquisition = value,
        _ => {}
    }
}

/// Archive or unarchive (never delete: rule 3).
pub fn set_archived(
    ctx: &Ctx,
    id: &str,
    expected: i64,
    archived: bool,
) -> Result<Executed, ContractError> {
    execute(
        ctx,
        &ARCHIVE,
        Archive { archived },
        Exec::update(id, Some(expected), Source::Ui),
    )
}

/// Restore one of this contact's revisions, or the whole contact (archive
/// excluded) to its state at `at`, as new commands.
pub fn restore_contact(
    ctx: &Ctx,
    id: &str,
    req: RestoreRequest,
) -> Result<Restored, ContractError> {
    match req {
        RestoreRequest::Revision { revision_id } => {
            let owner: Option<(String, String)> = ctx
                .tx
                .read()
                .query_row(
                    "SELECT entity, entity_id FROM revisions WHERE id = ?1",
                    [revision_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if owner != Some(("contacts".into(), id.to_owned())) {
                return Err(ContractError::NotFound);
            }
            let contract: String = ctx.tx.read().query_row(
                "SELECT contract FROM revisions WHERE id = ?1",
                [revision_id],
                |r| r.get(0),
            )?;
            restore(ctx, &REGISTRY, revision_id, None)?;
            Ok(Restored {
                restored: vec![contract],
            })
        }
        RestoreRequest::At { at } => {
            if counters(ctx.tx.read(), id)?.is_none() {
                return Err(ContractError::NotFound);
            }
            let restored =
                restore_entity_to(ctx, &REGISTRY, "contacts", id, at, &[ARCHIVE_NAME], None)?;
            Ok(Restored { restored })
        }
    }
}

const ARCHIVE_NAME: &str = <crate::slices::ContactArchive as Contract>::NAME;
