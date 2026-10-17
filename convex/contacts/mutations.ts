import { v, ConvexError } from 'convex/values'
import type { PropertyValidators } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import {
  canonical,
  commandGroup,
  executeContract,
  restore,
  restoreEntityTo,
} from '../lib/contracts'
import type { Problem } from '../lib/contracts'
import { tenantMutation } from '../lib/tenancy'
import type { ScopedDatabaseReader } from '../lib/tenancy'
import {
  addresses,
  archive,
  contactContracts,
  details,
  methods,
} from './contracts'
import {
  addressesFields,
  archiveFields,
  detailsFields,
  methodsFields,
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

// ── the form save (an action over the three content slices) ──────────────

const slice = <TFields extends PropertyValidators>(fields: TFields) =>
  v.optional(v.object({ expected: v.number(), ...fields }))

type Slice = 'details' | 'methods' | 'addresses'

/** The current state of each slice, in payload shape, for change detection. */
export async function currentPayloads(
  db: ScopedDatabaseReader,
  contact: Doc<'contacts'>,
): Promise<{
  details: Payloads['details']
  methods: Payloads['methods']
  addresses: Payloads['addresses']
}> {
  const [emails, phones, addrs] = await Promise.all([
    db
      .query('contactEmails')
      .withIndex('by_tenant_contact', (q) => q.eq('contactId', contact._id))
      .collect(),
    db
      .query('contactPhones')
      .withIndex('by_tenant_contact', (q) => q.eq('contactId', contact._id))
      .collect(),
    db
      .query('contactAddresses')
      .withIndex('by_tenant_contact', (q) => q.eq('contactId', contact._id))
      .collect(),
  ])
  return {
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
  }
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
  },
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.id)
    if (!contact) throw new ConvexError({ kind: 'not_found' as const })
    const current = await currentPayloads(ctx.db, contact)
    const source = args.source ?? 'ui'

    const problems: Partial<Record<Slice, Array<Problem>>> = {}
    const stale: Partial<Record<Slice, number>> = {}
    const changed: Array<{
      name: Slice
      run: (group?: Id<'commandGroups'>) => Promise<unknown>
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

    const group =
      changed.length > 1
        ? await commandGroup(ctx, 'contact form save')
        : undefined
    for (const c of changed) await c.run(group)

    const after = (await ctx.db.get(args.id))!
    return {
      saved: changed.map((c) => c.name),
      problems,
      stale,
      counters: {
        details: after.detailsVersion,
        methods: after.methodsVersion,
        addresses: after.addressesVersion,
        archive: after.archiveVersion,
      },
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
