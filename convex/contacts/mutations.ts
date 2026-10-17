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
import type { ContractCtx, Problem } from '../lib/contracts'
import { tenantMutation } from '../lib/tenancy'
import type { ScopedDatabaseReader } from '../lib/tenancy'
import {
  addresses,
  archive,
  contactContracts,
  details,
  methods,
  tag,
  tags,
} from './contracts'
import {
  addressesFields,
  archiveFields,
  detailsFields,
  methodsFields,
  tagFields,
  tagsFields,
} from './validators'
import type { Payloads } from './validators'

export const create = tenantMutation({
  args: detailsFields,
  handler: async (ctx, args) => {
    const { id } = await executeContract(ctx, details, args, { source: 'ui' })
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

/** Create a tag (no `id`) or rename / archive / reactivate one. */
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
    return executeContract(ctx, tag, payload, {
      entityId: id,
      expected,
      source: 'ui',
    })
  },
})

/** The most contacts one `bulkTag` call changes; larger selections are batched by the caller. */
export const BULK_TAG_LIMIT = 100

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
  return { changed: plans.length, group }
}

// ── the form save (an action over the content slices) ─────────────────────

const slice = <TFields extends PropertyValidators>(fields: TFields) =>
  v.optional(v.object({ expected: v.number(), ...fields }))

type Slice = 'details' | 'methods' | 'addresses' | 'tags'

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
  }
} | null> {
  const [contact, emails, phones, addrs, tagRows] = await Promise.all([
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
      externalIdentifier: contact.externalIdentifier,
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
  }
  return { contact, current }
}

/**
 * Single endpoint behind autosave and the Save button. Every provided slice
 * is diffed against current state and only the changed ones execute: a
 * no-op save creates no command, no counter bump, no revision. Slices that
 * fail blocking validation or are stale are reported and skipped; the rest
 * still save (partial saves are correct behaviour). Multi-slice saves share
 * one command group.
 */
export const saveForm = tenantMutation({
  args: {
    id: v.id('contacts'),
    source: v.optional(v.union(v.literal('ui'), v.literal('autosave'))),
    details: slice(detailsFields),
    methods: slice(methodsFields),
    addresses: slice(addressesFields),
    tags: slice(tagsFields),
  },
  handler: async (ctx, args) => {
    const found = await currentPayloads(ctx.db, args.id)
    if (!found) throw new ConvexError({ kind: 'not_found' as const })
    const { contact, current } = found
    const source = args.source ?? 'ui'

    const problems: Partial<Record<Slice, Array<Problem>>> = {}
    const stale: Partial<Record<Slice, number>> = {}
    const changed: Array<{
      name: Slice
      run: (group?: Id<'commandGroups'>) => Promise<{ counter: number }>
    }> = []

    const consider = <TSlice extends Slice>(
      name: TSlice,
      contract: (typeof contactContracts)[string],
      submitted: ({ expected: number } & Record<string, unknown>) | undefined,
      counter: number,
    ) => {
      if (!submitted) return
      const { expected, ...payload } = submitted
      if (name === 'details')
        delete (payload as { clientKey?: string }).clientKey
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
