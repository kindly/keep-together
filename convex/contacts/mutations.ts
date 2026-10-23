import { v, ConvexError } from 'convex/values'
import type { PropertyValidators } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import {
  canonical,
  commandGroup,
  executeContract,
  invalid,
  rejected,
  restore,
  restoreEntityTo,
} from '../lib/contracts'
import type { CommandGroup, Problem } from '../lib/contracts'
import type { FieldRestoreNote } from './contracts'
import { tenantPreferences } from '../lib/lists'
import { tenantMutation } from '../lib/tenancy'
import type { ScopedDatabaseReader } from '../lib/tenancy'
import { describe } from '../sources/code'
import {
  acquisition,
  addresses,
  archive,
  checkFieldValues,
  contactContracts,
  planFieldRestore,
  details,
  fieldValues,
  identifierClashes,
  identifierType,
  identifiers,
  methods,
} from './contracts'
import {
  BULK_FIELD_LIMIT,
  IDENTIFIER_TYPE_LIMIT,
  normaliseListName,
} from './rules'
import {
  acquisitionFields,
  addressesFields,
  archiveFields,
  detailsFields,
  identifierTypeFields,
  identifiersFields,
  methodsFields,
} from './validators'
import type { Payloads } from './validators'
import { fieldValuesOf, fieldsBySlot } from './fieldDefs'
import { fieldValueVerdict, fieldValuesFields } from './fieldTypes'
import type { FieldValue } from './fieldTypes'
import { sortValues, withValue } from './fieldValues'
import { slotFieldName } from '../lib/fieldSlots'
import { RETIRED_CONTRACTS, isRetired } from './retired'
import type { FieldSlot } from '../lib/fieldSlots'

/**
 * Create a contact, with its acquisition code when the new-contact form
 * picked one: then both slices run as one action named after the code, so
 * history keeps the code as it read then (as `setAcquisition` does).
 */
export const create = tenantMutation({
  args: {
    ...detailsFields,
    acquisitionCodeId: v.optional(v.id('sourceCodes')),
  },
  handler: async (ctx, { acquisitionCodeId, ...payload }) => {
    // An unknown code is refused by the contract, rolling back the group
    // and the contact with it.
    const code = acquisitionCodeId
      ? await describe(ctx.db, acquisitionCodeId)
      : null
    const group = acquisitionCodeId
      ? await commandGroup(
          ctx,
          code ? `new contact, acquisition code ${code.code}` : 'new contact',
        )
      : undefined
    const { id } = await executeContract(ctx, details, payload, {
      source: 'ui',
      group,
    })
    if (acquisitionCodeId) {
      await executeContract(
        ctx,
        acquisition,
        { codeId: acquisitionCodeId },
        { entityId: id, expected: 0, source: 'ui', group },
      )
    }
    return id
  },
})

export const saveDetails = tenantMutation({
  args: { id: v.id('contacts'), expected: v.number(), ...detailsFields },
  handler: async (ctx, { id, expected, ...payload }) =>
    executeContract(ctx, details, payload, {
      entityId: id,
      expected,
      source: 'ui',
    }),
})

export const saveMethods = tenantMutation({
  args: { id: v.id('contacts'), expected: v.number(), ...methodsFields },
  handler: async (ctx, { id, expected, ...payload }) =>
    executeContract(ctx, methods, payload, {
      entityId: id,
      expected,
      source: 'ui',
    }),
})

export const saveAddresses = tenantMutation({
  args: { id: v.id('contacts'), expected: v.number(), ...addressesFields },
  handler: async (ctx, { id, expected, ...payload }) =>
    executeContract(ctx, addresses, payload, {
      entityId: id,
      expected,
      source: 'ui',
    }),
})

export const setArchived = tenantMutation({
  args: { id: v.id('contacts'), expected: v.number(), ...archiveFields },
  handler: async (ctx, { id, expected, ...payload }) =>
    executeContract(ctx, archive, payload, {
      entityId: id,
      expected,
      source: 'ui',
    }),
})

/**
 * Set or clear the contact's acquisition code. A change runs as an action
 * named after the code, so history keeps the code as it read then, even
 * after a part is renamed; re-sending the current code is a no-op.
 */
export const setAcquisition = tenantMutation({
  args: { id: v.id('contacts'), expected: v.number(), ...acquisitionFields },
  handler: async (ctx, { id, expected, codeId }) => {
    const contact = await ctx.db.get(id)
    if (!contact) throw new ConvexError({ kind: 'not_found' as const })
    if ((contact.acquisitionCodeId ?? null) === codeId) {
      return { id, counter: contact.acquisitionVersion }
    }
    // A stale `expected` or a refused code throws in the contract, which
    // rolls the group back with it.
    const code = codeId && (await describe(ctx.db, codeId))
    const group = await commandGroup(
      ctx,
      code ? `acquisition code ${code.code}` : 'acquisition code cleared',
    )
    return executeContract(
      ctx,
      acquisition,
      { codeId },
      { entityId: id, expected, source: 'ui', group },
    )
  },
})

/**
 * An identifier type save's reads, all at once: the list-manager switch,
 * the row, the name clash and, for a new type, the cap. The contract then
 * finds them cached (the save-path prefetch, by `saveForm`).
 */
async function prefetchTypeSave(
  db: ScopedDatabaseReader,
  id: Id<'identifierTypes'> | undefined,
  name: string,
) {
  const nameNormalized = normaliseListName(name)
  await Promise.all([
    tenantPreferences(db),
    id ? db.get(id) : null,
    db
      .query('identifierTypes')
      .withIndex('by_tenant_nameNormalized', (q) =>
        q.eq('nameNormalized', nameNormalized),
      )
      .first(),
    id
      ? null
      : db
          .query('identifierTypes')
          .withIndex('by_tenant_nameNormalized')
          .take(IDENTIFIER_TYPE_LIMIT),
  ])
}

/**
 * Create an identifier type (no `id`) or rename / archive / reactivate one.
 * Admins, and staff when the tenant lets them manage identifier types (the
 * contract is `managesList: 'identifierTypes'`; lib/lists): types are managed on the settings page; the
 * contact form's picker only selects (external-ids plan, g2q3). Never
 * deleted.
 */
export const saveIdentifierType = tenantMutation({
  args: {
    id: v.optional(v.id('identifierTypes')),
    expected: v.optional(v.number()),
    ...identifierTypeFields,
  },
  handler: async (ctx, { id, expected, ...payload }) => {
    if (id !== undefined && expected === undefined) {
      throw invalid([
        { field: 'expected', message: 'An update needs the version it edits' },
      ])
    }
    await prefetchTypeSave(ctx.db, id, payload.name)
    return executeContract(ctx, identifierType, payload, {
      entityId: id,
      expected,
      source: 'ui',
    })
  },
})

// ── dropdown field values ──────────────────────────────────────────────────

/**
 * What a change of the contact's field values reads as in history: each
 * field changed, by its label and its new option's, as they read now
 * (so history keeps them after a rename). E.g. "Region: North, Type
 * cleared".
 */
async function describeFieldChange(
  db: ScopedDatabaseReader,
  before: Array<FieldValue>,
  after: Array<FieldValue>,
  bySlot: Map<FieldSlot, Doc<'contactFields'>>,
): Promise<string> {
  const was = new Map(before.map((x) => [x.fieldId as string, x.optionId]))
  const now = new Map(after.map((x) => [x.fieldId as string, x.optionId]))
  const labels = new Map([...bySlot.values()].map((f) => [f._id, f.label]))
  const changes = await Promise.all(
    [...new Set([...was.keys(), ...now.keys()])]
      .filter((fieldId) => was.get(fieldId) !== now.get(fieldId))
      .map(async (fieldId) => {
        const label =
          labels.get(fieldId as Id<'contactFields'>) ??
          (await db.get(fieldId as Id<'contactFields'>))?.label ??
          '?'
        const optionId = now.get(fieldId)
        if (!optionId) return `${label} cleared`
        return `${label}: ${(await db.get(optionId))?.label ?? '?'}`
      }),
  )
  return changes.join(', ')
}

/**
 * Set one field to one option (or clear it, `optionId: null`) on a batch
 * of contacts, as one command group: one `contacts.fields` revision per
 * contact that changes, none for contacts already in that state. To set,
 * contacts of a kind the field doesn't apply to are skipped and counted;
 * a clear clears every holder, whatever its kind. The whole
 * batch is refused if any contact is unknown, the field is retired, or a
 * contact would be refused the option (`fieldValueVerdict`: it is another
 * field's, or archived, or its field is).
 */
export const bulkSetField = tenantMutation({
  args: {
    contactIds: v.array(v.id('contacts')),
    fieldId: v.id('contactFields'),
    optionId: v.union(v.id('contactFieldOptions'), v.null()),
  },
  handler: async (ctx, { contactIds, fieldId, optionId }) => {
    const ids = [...new Set(contactIds)]
    if (ids.length > BULK_FIELD_LIMIT) {
      throw invalid([
        {
          field: 'contactIds',
          message: `At most ${BULK_FIELD_LIMIT} contacts per batch`,
        },
      ])
    }
    // Every read at once: the batch's contacts and the projection rows
    // the contracts will rebuild are then cached (see saveForm).
    const [field, option, bySlot, contacts] = await Promise.all([
      ctx.db.get(fieldId),
      optionId ? ctx.db.get(optionId) : null,
      fieldsBySlot(ctx.db),
      Promise.all(ids.map((id) => ctx.db.get(id))),
      Promise.all(
        ids.map((id) =>
          ctx.db
            .query('contactSearch')
            .withIndex('by_tenant_contact', (q) => q.eq('contactId', id))
            .unique(),
        ),
      ),
    ])
    // Another tenant's ids read as null through the scoped db.
    if (!field) throw rejected('unknown_field', 'That field does not exist')
    if (field.slot === undefined) {
      throw rejected('retired_field', `${field.label} has been retired`)
    }
    const slot = slotFieldName(field.slot as FieldSlot)
    let skipped = 0
    const plans: Array<{
      id: Id<'contacts'>
      expected: number
      values: Array<FieldValue>
    }> = []
    for (const contact of contacts) {
      if (!contact) throw rejected('unknown_contact', 'Contact must exist')
      const current = contact[slot]
      if ((current ?? null) === optionId) continue
      // Only setting is kind-checked: a clear reaches every holder, even
      // one the field no longer applies to.
      if (optionId && !field.appliesTo.includes(contact.kind)) {
        skipped++
        continue
      }
      if (optionId) {
        // The contract's own rule, checked up front so a refusal names
        // the batch, not one contact in it.
        const verdict = fieldValueVerdict(
          field,
          option,
          contact.kind,
          current,
          'save',
        )
        // In save mode every refusal is a reason (never a skip).
        if (!verdict.ok && verdict.skip === null) {
          throw rejected(verdict.reason, verdict.message)
        }
      }
      plans.push({
        id: contact._id,
        expected: contact.fieldsVersion,
        values: withValue(fieldValuesOf(contact, bySlot), fieldId, optionId),
      })
    }
    if (plans.length === 0) return { changed: 0, skipped, group: null }
    const group = await commandGroup(
      ctx,
      option ? `set ${field.label} to ${option.label}` : `clear ${field.label}`,
    )
    for (const plan of plans) {
      await executeContract(
        ctx,
        fieldValues,
        { values: plan.values },
        { entityId: plan.id, expected: plan.expected, source: 'ui', group },
      )
    }
    return { changed: plans.length, skipped, group: group.id }
  },
})

// ── the form save (an action over the content slices) ─────────────────────

const slice = <TFields extends PropertyValidators>(fields: TFields) =>
  v.optional(v.object({ expected: v.number(), ...fields }))

type Slice = 'details' | 'methods' | 'addresses' | 'identifiers' | 'fields'

async function contactIdentifierRows(
  db: ScopedDatabaseReader,
  contactId: Id<'contacts'>,
) {
  return db
    .query('contactIdentifiers')
    .withIndex('by_tenant_contact', (q) => q.eq('contactId', contactId))
    .collect()
}

/**
 * The current state of each slice, in payload shape, for change detection.
 * Reads the root and its children concurrently; null if no such contact.
 */
export async function currentPayloads(
  db: ScopedDatabaseReader,
  id: Id<'contacts'>,
): Promise<{
  contact: Doc<'contacts'>
  /** The tenant's live fields, which name the contact's slot values. */
  bySlot: Map<FieldSlot, Doc<'contactFields'>>
  current: {
    details: Payloads['details']
    methods: Payloads['methods']
    addresses: Payloads['addresses']
    identifiers: Payloads['identifiers']
    fields: Payloads['fields']
  }
} | null> {
  const [contact, emails, phones, addrs, idRows, bySlot] = await Promise.all([
    db.get(id),
    db
      .query('contactEmails')
      .withIndex('by_tenant_contact', (q) => q.eq('contactId', id))
      .collect(),
    db
      .query('contactPhones')
      .withIndex('by_tenant_contact', (q) => q.eq('contactId', id))
      .collect(),
    db
      .query('contactAddresses')
      .withIndex('by_tenant_contact', (q) => q.eq('contactId', id))
      .collect(),
    contactIdentifierRows(db, id),
    fieldsBySlot(db),
  ])
  if (!contact) return null
  const current = {
    details: {
      kind: contact.kind,
      title: contact.title,
      firstName: contact.firstName,
      lastName: contact.lastName,
      nickname: contact.nickname,
      name: contact.name,
      birthDate: contact.birthDate,
      isDeceased: contact.isDeceased,
      deceasedDate: contact.deceasedDate,
    },
    methods: {
      emails: emails.map((e) => ({
        key: e.key,
        label: e.label,
        address: e.address,
        isPrimary: e.isPrimary,
      })),
      phones: phones.map((p) => ({
        key: p.key,
        label: p.label,
        number: p.number,
        isPrimary: p.isPrimary,
      })),
    },
    addresses: {
      addresses: addrs.map((a) => ({
        key: a.key,
        label: a.label,
        line1: a.line1,
        line2: a.line2,
        line3: a.line3,
        town: a.town,
        postcode: a.postcode,
        country: a.country,
        isPrimary: a.isPrimary,
      })),
    },
    identifiers: {
      identifiers: idRows.map((r) => ({
        key: r.key,
        typeId: r.typeId,
        value: r.value,
      })),
    },
    fields: { values: sortValues(fieldValuesOf(contact, bySlot)) },
  }
  return { contact, bySlot, current }
}

// ── save-path prefetch ─────────────────────────────────────────────────────
//
// A contract re-reads what it needs inside its own transaction, and the
// search projection rebuilds from fresh reads after the writes: that is
// what keeps them correct, so they stay as they are. But each sequential
// level of *fresh* reads costs a deployment ~2.5 ms, while a repeat of a
// read the transaction already made costs ~0.1 ms. So `saveForm` makes
// those reads early and at once, and discards the results: the contracts
// and the projection then find them cached, and a save is two read levels
// after auth instead of five or six. Nothing here decides anything; a read
// left out (or one too many) only costs time.

/**
 * First level, beside `currentPayloads`: the projection's row, and the
 * submitted field values' field and option documents.
 */
async function prefetchSearchRow(
  db: ScopedDatabaseReader,
  contactId: Id<'contacts'>,
  submittedFields: Array<FieldValue> | undefined,
) {
  await Promise.all([
    db
      .query('contactSearch')
      .withIndex('by_tenant_contact', (q) => q.eq('contactId', contactId))
      .unique(),
    // What `resolveFieldValue` reads for each value.
    ...(submittedFields ?? []).flatMap((r) => [
      db.get(r.fieldId),
      db.get(r.optionId),
    ]),
  ])
}

/**
 * Second level, once the current rows are known: what `reconcile` will
 * look up for the changed slices (only keys new to the contact for
 * identifiers, which pass it their rows; every key for the others).
 */
async function prefetchChanged(
  db: ScopedDatabaseReader,
  found: NonNullable<Awaited<ReturnType<typeof currentPayloads>>>,
  changed: Array<{ name: Slice; prepared: unknown }>,
) {
  const { current } = found
  const reads: Array<Promise<unknown>> = []
  const lookup = (table: Parameters<typeof db.query>[0], key?: string) => {
    if (key === undefined) return
    reads.push(
      db
        .query(table as 'contactIdentifiers')
        .withIndex('by_tenant_key', (q) => q.eq('key', key))
        .first(),
    )
  }
  const newKeys = (
    rows: Array<{ key?: string }>,
    kept: Array<{ key?: string }>,
  ) => {
    const have = new Set(kept.map((r) => r.key))
    return rows.filter((r) => !have.has(r.key))
  }
  for (const { name, prepared } of changed) {
    if (name === 'methods') {
      const p = prepared as Payloads['methods']
      for (const r of p.emails) lookup('contactEmails', r.key)
      for (const r of p.phones) lookup('contactPhones', r.key)
    } else if (name === 'addresses') {
      const p = prepared as Payloads['addresses']
      for (const r of p.addresses) lookup('contactAddresses', r.key)
    } else if (name === 'identifiers') {
      const p = prepared as Payloads['identifiers']
      for (const r of newKeys(p.identifiers, current.identifiers.identifiers))
        lookup('contactIdentifiers', r.key)
    }
  }
  await Promise.all(reads)
}

/**
 * Single endpoint behind autosave and the Save button. Every provided slice
 * is diffed against current state and only the changed ones execute: a
 * no-op save creates no command, no counter bump, no revision. Slices that
 * fail blocking validation or are stale are reported and skipped; the rest
 * still save (partial saves are correct behaviour). Multi-slice saves share
 * one command group. An identifier another contact already holds is
 * reported the same way, per row, naming that contact.
 */
export const saveForm = tenantMutation({
  args: {
    id: v.id('contacts'),
    source: v.optional(v.union(v.literal('ui'), v.literal('autosave'))),
    details: slice(detailsFields),
    methods: slice(methodsFields),
    addresses: slice(addressesFields),
    identifiers: slice(identifiersFields),
    fields: slice(fieldValuesFields),
  },
  handler: async (ctx, args) => {
    const [found] = await Promise.all([
      currentPayloads(ctx.db, args.id),
      prefetchSearchRow(ctx.db, args.id, args.fields?.values),
    ])
    if (!found) throw new ConvexError({ kind: 'not_found' as const })
    const { contact, bySlot, current } = found
    const source = args.source ?? 'ui'

    const problems: Partial<
      Record<
        Slice,
        Array<Problem & { key?: string; contactId?: Id<'contacts'> }>
      >
    > = {}
    const stale: Partial<Record<Slice, number>> = {}
    const changed: Array<{
      name: Slice
      prepared: unknown
      run: (group?: CommandGroup) => Promise<{ counter: number }>
    }> = []

    const consider = <TSlice extends Slice>(
      name: TSlice,
      contract: (typeof contactContracts)[string],
      submitted: ({ expected: number } & Record<string, unknown>) | undefined,
      counter: number,
    ) => {
      if (!submitted) return
      const { expected, ...payload } = submitted
      if (name === 'details') {
        delete (payload as { clientKey?: string }).clientKey
      }
      let prepared: unknown
      try {
        prepared = contract.prepare ? contract.prepare(payload) : payload
      } catch (e) {
        if (
          e instanceof ConvexError &&
          (e.data as { kind?: string }).kind === 'invalid'
        ) {
          problems[name] = (e.data as { problems: Array<Problem> }).problems
          return
        }
        throw e
      }
      if (canonical(prepared) === canonical(current[name])) return
      if (expected !== counter) {
        stale[name] = counter
        return
      }
      changed.push({
        name,
        prepared,
        run: (group) =>
          executeContract(ctx, contract, prepared as never, {
            entityId: args.id,
            expected,
            source,
            group,
          }),
      })
    }

    consider('details', details, args.details, contact.detailsVersion)
    consider('methods', methods, args.methods, contact.methodsVersion)
    consider('addresses', addresses, args.addresses, contact.addressesVersion)
    consider(
      'identifiers',
      identifiers,
      args.identifiers,
      contact.identifiersVersion,
    )
    consider('fields', fieldValues, args.fields, contact.fieldsVersion)

    // Not awaited yet: its reads go out alongside the identifier check's.
    const prefetched = prefetchChanged(ctx.db, found, changed)

    // A clash or a type archived mid-edit is the contract's refusal too,
    // but caught here it stays on its row: the other slices still save.
    const ids = changed.findIndex((c) => c.name === 'identifiers')
    if (ids !== -1) {
      const kept = new Set(current.identifiers.identifiers.map((r) => r.key))
      const added = (
        changed[ids].prepared as Payloads['identifiers']
      ).identifiers.filter((r) => !kept.has(r.key))
      const [types, clashes] = await Promise.all([
        Promise.all(added.map((r) => ctx.db.get(r.typeId))),
        identifierClashes(ctx.db, args.id, added),
      ])
      const refused = [
        ...added
          .filter((_, i) => !types[i]?.isActive)
          .map((r) => ({
            field: 'identifiers',
            message: 'That type has been archived: choose another',
            key: r.key!,
          })),
        ...clashes.map((c) => ({
          field: 'identifiers',
          message: `${c.value} is already used by ${c.displayName}`,
          key: c.key,
          contactId: c.contactId,
        })),
      ]
      if (refused.length) {
        problems.identifiers = refused
        changed.splice(ids, 1)
      }
    }

    // The same for a field value refused mid-edit (an option archived, a
    // field retired): reported on its field, the other slices still save.
    const at = changed.findIndex((c) => c.name === 'fields')
    let fieldChange: string | null = null
    if (at !== -1) {
      const next = (changed[at].prepared as Payloads['fields']).values
      const { refused } = await checkFieldValues(ctx.db, contact, next, false)
      if (refused.length) {
        problems.fields = refused.map((r) => ({
          field: 'fields',
          message: r.message,
          key: r.fieldId,
        }))
        changed.splice(at, 1)
      } else {
        fieldChange = await describeFieldChange(
          ctx.db,
          current.fields.values,
          next,
          bySlot,
        )
      }
    }

    await prefetched
    // A field change always runs in a group named after it, so history
    // keeps the labels as they read then (as `setAcquisition` does).
    const groupName =
      fieldChange === null
        ? 'contact form save'
        : changed.length > 1
          ? `contact form save, ${fieldChange}`
          : fieldChange
    const group =
      changed.length > 1 || fieldChange !== null
        ? await commandGroup(ctx, groupName)
        : undefined
    // The counters after the save, from what ran (no re-read of the root).
    const counters = {
      details: contact.detailsVersion,
      methods: contact.methodsVersion,
      addresses: contact.addressesVersion,
      archive: contact.archiveVersion,
      identifiers: contact.identifiersVersion,
      fields: contact.fieldsVersion,
    }
    for (const c of changed) counters[c.name] = (await c.run(group)).counter

    return {
      saved: changed.map((c) => c.name),
      problems,
      stale,
      counters,
    }
  },
})

// ── history ────────────────────────────────────────────────────────────────

/**
 * What restoring a `contacts.fields` revision left as it was, and why
 * (`planFieldRestore`). Read after the restore, against the contact as it
 * wrote it: a value it set is now held, so passes; one it left alone is
 * still not, and a newer field still holds its value.
 */
async function fieldRestoreNotes(
  db: ScopedDatabaseReader,
  restored: Doc<'revisions'>,
): Promise<Array<FieldRestoreNote>> {
  const contact = await db.get(restored.entityId as Id<'contacts'>)
  if (!contact) return []
  const values = (restored.payload as Payloads['fields']).values
  return (await planFieldRestore(db, contact, values, restored._creationTime))
    .notes
}

/**
 * Restore one stored revision as a new command. `skippedFields`: the
 * fields it left as they were (`FieldRestoreNote`: `retired`,
 * `wrong_kind`, or `added_after` "kept: added after this version"), by
 * label. A revision of a retired contract (tags) is history only: refused
 * (`retired_contract`), nothing written.
 */
export const restoreRevision = tenantMutation({
  args: { revisionId: v.id('revisions') },
  handler: async (ctx, { revisionId }) => {
    const revision = await ctx.db.get(revisionId)
    if (revision && isRetired(revision.contract)) {
      throw rejected(
        'retired_contract',
        'Tags have been removed: this change stays in history but can’t be restored',
      )
    }
    const result = await restore(ctx, contactContracts, revisionId)
    const skippedFields =
      revision?.contract === fieldValues.name
        ? await fieldRestoreNotes(ctx.db, revision)
        : []
    return { ...result, skippedFields }
  },
})

/**
 * Restore the whole Contact to the moment `at` — the latest state of every
 * content slice at that time (archive excluded; it has its own toggle; so
 * are retired contracts, whose revisions are history only).
 * `skippedFields` as `restoreRevision`'s.
 */
export const restoreTo = tenantMutation({
  args: { id: v.id('contacts'), at: v.number() },
  handler: async (ctx, { id, at }) => {
    const result = await restoreEntityTo(
      ctx,
      contactContracts,
      'contacts',
      id,
      at,
      {
        exclude: ['contacts.archive', ...Object.keys(RETIRED_CONTRACTS)],
        label: `restore to ${new Date(at).toISOString()}`,
      },
    )
    // The fields revision this restore just wrote names the revision it
    // restored.
    const written = result.restored.includes(fieldValues.name)
      ? await ctx.db
          .query('revisions')
          .withIndex('by_tenant_entity_contract', (q) =>
            q
              .eq('entity', 'contacts')
              .eq('entityId', id)
              .eq('contract', fieldValues.name),
          )
          .order('desc')
          .first()
      : null
    const restored =
      written?.restoredFrom && (await ctx.db.get(written.restoredFrom))
    const skippedFields = restored
      ? await fieldRestoreNotes(ctx.db, restored)
      : []
    return { ...result, skippedFields }
  },
})
