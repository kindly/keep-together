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
import type { CommandGroup, ContractCtx, Problem } from '../lib/contracts'
import { tenantPreferences } from '../lib/lists'
import { tenantMutation } from '../lib/tenancy'
import type { ScopedDatabaseReader } from '../lib/tenancy'
import { describe } from '../sources/code'
import {
  acquisition,
  addresses,
  archive,
  contactContracts,
  details,
  identifierClashes,
  identifierType,
  identifiers,
  methods,
  tag,
  tags,
} from './contracts'
import {
  BULK_TAG_LIMIT,
  IDENTIFIER_TYPE_LIMIT,
  normaliseTagName,
} from './rules'
import {
  acquisitionFields,
  addressesFields,
  archiveFields,
  detailsFields,
  identifierTypeFields,
  identifiersFields,
  methodsFields,
  tagFields,
  tagsFields,
} from './validators'
import type { Payloads } from './validators'

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

// ── tags ───────────────────────────────────────────────────────────────────

export const saveTags = tenantMutation({
  args: { id: v.id('contacts'), expected: v.number(), ...tagsFields },
  handler: async (ctx, { id, expected, ...payload }) => {
    const contact = await ctx.db.get(id)
    if (!contact) throw new ConvexError({ kind: 'not_found' as const })
    return executeContract(ctx, tags, payload, {
      entityId: id,
      expected,
      source: 'ui',
    })
  },
})

/**
 * A tag or identifier type save's reads, all at once: the list-manager
 * switch, the row, the name clash and, for a new type, the cap. The
 * contract then finds them cached (the save-path prefetch, by `saveForm`).
 */
async function prefetchListSave(
  db: ScopedDatabaseReader,
  table: 'tags' | 'identifierTypes',
  id: Id<'tags'> | Id<'identifierTypes'> | undefined,
  name: string,
) {
  const nameNormalized = normaliseTagName(name)
  await Promise.all([
    tenantPreferences(db),
    id ? db.get(id) : null,
    db
      .query(table)
      .withIndex('by_tenant_nameNormalized', (q) =>
        q.eq('nameNormalized', nameNormalized),
      )
      .first(),
    table === 'identifierTypes' && !id
      ? db
          .query(table)
          .withIndex('by_tenant_nameNormalized')
          .take(IDENTIFIER_TYPE_LIMIT)
      : null,
  ])
}

/**
 * Create a tag (no `id`) or rename / archive / reactivate one. Admins, and
 * staff when the tenant lets them manage tags (the contract is
 * `managesList: 'tags'`; lib/lists).
 */
export const saveTag = tenantMutation({
  args: {
    id: v.optional(v.id('tags')),
    expected: v.optional(v.number()),
    ...tagFields,
  },
  handler: async (ctx, { id, expected, ...payload }) => {
    if (id !== undefined && expected === undefined) {
      // Without it two admins renaming one tag silently overwrite each other.
      throw invalid([
        { field: 'expected', message: 'An update needs the version it edits' },
      ])
    }
    await prefetchListSave(ctx.db, 'tags', id, payload.name)
    return executeContract(ctx, tag, payload, {
      entityId: id,
      expected,
      source: 'ui',
    })
  },
})

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
    await prefetchListSave(ctx.db, 'identifierTypes', id, payload.name)
    return executeContract(ctx, identifierType, payload, {
      entityId: id,
      expected,
      source: 'ui',
    })
  },
})

async function contactTagRows(
  db: ScopedDatabaseReader,
  contactId: Id<'contacts'>,
) {
  return db
    .query('contactTags')
    .withIndex('by_tenant_contact', (q) => q.eq('contactId', contactId))
    .collect()
}

/**
 * Add or remove one tag on a batch of contacts, as one command group: one
 * `contacts.tags` revision per contact that changes, none for contacts
 * already in the wanted state. The whole batch is refused if any contact
 * is unknown or not yet migrated, or if an inactive tag is being added.
 */
export const bulkTag = tenantMutation({
  args: {
    contactIds: v.array(v.id('contacts')),
    tagId: v.id('tags'),
    op: v.union(v.literal('add'), v.literal('remove')),
  },
  handler: async (ctx, { contactIds, tagId, op }) =>
    applyBulkTag(ctx, [...new Set(contactIds)], tagId, op),
})

async function applyBulkTag(
  ctx: ContractCtx,
  contactIds: Array<Id<'contacts'>>,
  tagId: Id<'tags'>,
  op: 'add' | 'remove',
) {
  if (contactIds.length > BULK_TAG_LIMIT) {
    throw invalid([
      {
        field: 'contactIds',
        message: `At most ${BULK_TAG_LIMIT} contacts per batch`,
      },
    ])
  }
  const t = await ctx.db.get(tagId)
  if (!t) throw rejected('unknown_tag', 'Tag must exist')
  if (op === 'add' && !t.isActive) {
    throw rejected('unknown_tag', 'Tag must exist and be active')
  }
  const plans: Array<{
    id: Id<'contacts'>
    expected: number
    rows: Array<{ key: string; tagId: Id<'tags'> }>
  }> = []
  for (const id of contactIds) {
    const contact = await ctx.db.get(id)
    if (!contact) throw rejected('unknown_contact', 'Contact must exist')
    const expected = contact.tagsVersion
    const rows = (await contactTagRows(ctx.db, id)).map((r) => ({
      key: r.key,
      tagId: r.tagId,
    }))
    const has = rows.some((r) => r.tagId === tagId)
    if (op === 'add' && !has) {
      plans.push({
        id,
        expected,
        rows: [...rows, { key: crypto.randomUUID(), tagId }],
      })
    } else if (op === 'remove' && has) {
      plans.push({ id, expected, rows: rows.filter((r) => r.tagId !== tagId) })
    }
  }
  if (plans.length === 0) return { changed: 0, group: null }
  const group = await commandGroup(
    ctx,
    `${op === 'add' ? 'add' : 'remove'} tag ${t.name}`,
  )
  for (const plan of plans) {
    await executeContract(
      ctx,
      tags,
      { tags: plan.rows },
      { entityId: plan.id, expected: plan.expected, source: 'ui', group },
    )
  }
  return { changed: plans.length, group: group.id }
}

// ── the form save (an action over the content slices) ─────────────────────

const slice = <TFields extends PropertyValidators>(fields: TFields) =>
  v.optional(v.object({ expected: v.number(), ...fields }))

type Slice = 'details' | 'methods' | 'addresses' | 'tags' | 'identifiers'

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
  current: {
    details: Payloads['details']
    methods: Payloads['methods']
    addresses: Payloads['addresses']
    tags: Payloads['tags']
    identifiers: Payloads['identifiers']
  }
} | null> {
  const [contact, emails, phones, addrs, tagRows, idRows] = await Promise.all([
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
    contactTagRows(db, id),
    contactIdentifierRows(db, id),
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
    tags: { tags: tagRows.map((r) => ({ key: r.key, tagId: r.tagId })) },
    identifiers: {
      identifiers: idRows.map((r) => ({
        key: r.key,
        typeId: r.typeId,
        value: r.value,
      })),
    },
  }
  return { contact, current }
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
 * submitted tags' documents (the tags contract checks the new ones and
 * copies their names; which are new isn't known yet).
 */
async function prefetchSearchRow(
  db: ScopedDatabaseReader,
  contactId: Id<'contacts'>,
  submittedTags: Array<{ tagId: Id<'tags'> }> | undefined,
) {
  await Promise.all([
    db
      .query('contactSearch')
      .withIndex('by_tenant_contact', (q) => q.eq('contactId', contactId))
      .unique(),
    ...(submittedTags ?? []).map((r) => db.get(r.tagId)),
  ])
}

/**
 * Second level, once the current rows are known: what `reconcile` will
 * look up for the changed slices (only keys new to the contact for tags
 * and identifiers, which pass it their rows; every key for the others).
 * The projection names tags from the `contactTags` rows, so it reads no
 * tag documents.
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
        .query(table as 'contactTags')
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
    } else if (name === 'tags') {
      const p = prepared as Payloads['tags']
      for (const r of newKeys(p.tags, current.tags.tags))
        lookup('contactTags', r.key)
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
    tags: slice(tagsFields),
    identifiers: slice(identifiersFields),
  },
  handler: async (ctx, args) => {
    const [found] = await Promise.all([
      currentPayloads(ctx.db, args.id),
      prefetchSearchRow(ctx.db, args.id, args.tags?.tags),
    ])
    if (!found) throw new ConvexError({ kind: 'not_found' as const })
    const { contact, current } = found
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
    consider('tags', tags, args.tags, contact.tagsVersion)
    consider(
      'identifiers',
      identifiers,
      args.identifiers,
      contact.identifiersVersion,
    )

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

    await prefetched
    const group =
      changed.length > 1
        ? await commandGroup(ctx, 'contact form save')
        : undefined
    // The counters after the save, from what ran (no re-read of the root).
    const counters = {
      details: contact.detailsVersion,
      methods: contact.methodsVersion,
      addresses: contact.addressesVersion,
      archive: contact.archiveVersion,
      tags: contact.tagsVersion,
      identifiers: contact.identifiersVersion,
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

/** Restore one stored revision as a new command. */
export const restoreRevision = tenantMutation({
  args: { revisionId: v.id('revisions') },
  handler: async (ctx, { revisionId }) =>
    restore(ctx, contactContracts, revisionId),
})

/**
 * Restore the whole Contact to the moment `at` — the latest state of every
 * content slice at that time (archive excluded; it has its own toggle).
 */
export const restoreTo = tenantMutation({
  args: { id: v.id('contacts'), at: v.number() },
  handler: async (ctx, { id, at }) =>
    restoreEntityTo(ctx, contactContracts, 'contacts', id, at, {
      exclude: ['contacts.archive'],
      label: `restore to ${new Date(at).toISOString()}`,
    }),
})
