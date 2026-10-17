/**
 * Contact contracts (ADR 0014). Four partitioned slices on the Contact
 * root, plus RelationshipType and Relationship as their own aggregates.
 * Apply functions are pure state application — restore re-runs them.
 */
import type { Id } from '../_generated/dataModel'
import type { ContractCtx } from '../lib/contracts'
import { defineContract, registry, rejected } from '../lib/contracts'
import {
  computedNames,
  prepareAddresses,
  prepareDetails,
  prepareMethods,
  prepareRelationship,
  prepareRelationshipType,
} from './rules'
import {
  addressesFields,
  archiveFields,
  detailsFields,
  methodsFields,
  relationshipFields,
  relationshipTypeFields,
} from './validators'

export const details = defineContract({
  name: 'contacts.details',
  entity: 'contacts',
  version: 1,
  counter: 'detailsVersion',
  fields: detailsFields,
  prepare: prepareDetails,
  apply: async (ctx, p, root) => {
    const names = computedNames(p)
    if (p.externalIdentifier) {
      const clash = await ctx.db
        .query('contacts')
        .withIndex('by_tenant_external', (q) =>
          q.eq('externalIdentifier', p.externalIdentifier),
        )
        .first()
      if (clash && clash._id !== root?._id) {
        throw rejected(
          'duplicate_external_identifier',
          `External identifier ${p.externalIdentifier} is already used`,
        )
      }
    }
    const fields = {
      title: p.title,
      firstName: p.firstName,
      lastName: p.lastName,
      nickname: p.nickname,
      name: p.name,
      birthDate: p.birthDate,
      isDeceased: p.isDeceased,
      deceasedDate: p.deceasedDate,
      externalIdentifier: p.externalIdentifier,
      ...names,
    }
    if (root === null) {
      if (p.clientKey) {
        const existing = await ctx.db
          .query('contacts')
          .withIndex('by_tenant_clientKey', (q) =>
            q.eq('clientKey', p.clientKey),
          )
          .unique()
        if (existing) {
          // The command was already executed (double submit / retried import).
          throw rejected('duplicate', existing._id)
        }
      }
      return ctx.db.insert('contacts', {
        ...fields,
        clientKey: p.clientKey,
        kind: p.kind,
        archived: false,
        detailsVersion: 0,
        methodsVersion: 0,
        addressesVersion: 0,
        archiveVersion: 0,
      })
    }
    if (root.kind !== p.kind) {
      // CiviCRM allows changing kind; that is a bug farm, not a feature.
      throw rejected(
        'kind_change',
        `Contact is ${root.kind}; kind cannot change`,
      )
    }
    await ctx.db.patch('contacts', root._id, fields)
    return root._id
  },
})

// ── child-row reconciliation ───────────────────────────────────────────────

type ChildTable = 'contactEmails' | 'contactPhones' | 'contactAddresses'
type Row = { key?: string } & Record<string, unknown>

/**
 * Reconcile a child table against the payload by `key`: removed keys are
 * deleted, new keys created, kept keys updated in place — except identity
 * fields (the value the row *is*, e.g. an email address), which are
 * immutable per key because state may hang off them. System-owned fields
 * (email `onHold`) live on the row and simply survive a patch.
 */
async function reconcile(
  ctx: ContractCtx,
  table: ChildTable,
  contactId: Id<'contacts'>,
  rows: Array<Row>,
  identityFields: Array<string>,
) {
  const existing = await ctx.db
    .query(table)
    .withIndex('by_tenant_contact', (q) => q.eq('contactId', contactId))
    .collect()
  const byKey = new Map(existing.map((d) => [d.key, d]))
  const payloadKeys = new Set(rows.map((r) => r.key as string))

  for (const doc of existing) {
    if (!payloadKeys.has(doc.key)) await ctx.db.delete(table, doc._id)
  }
  for (const row of rows) {
    const key = row.key as string
    const current = byKey.get(key)
    if (!current) {
      const elsewhere = await ctx.db
        .query(table)
        .withIndex('by_tenant_key', (q) => q.eq('key', key))
        .first()
      if (elsewhere) {
        throw rejected(
          'child_ownership',
          `${table} row ${key} belongs to another contact`,
        )
      }
      await ctx.db.insert(table, {
        ...(row as object),
        key,
        contactId,
        ...(table === 'contactEmails' ? { onHold: false } : {}),
      } as never)
      continue
    }
    const doc = current as unknown as Record<string, unknown>
    const frozen = identityFields.filter((f) => doc[f] !== row[f])
    if (frozen.length) {
      throw rejected(
        'immutable_child',
        `${frozen.join(', ')} can't be edited — remove the entry and add a new one`,
      )
    }
    const changes: Record<string, unknown> = {}
    for (const [field, value] of Object.entries(row)) {
      if (field === 'key' || identityFields.includes(field)) continue
      if (doc[field] !== value) changes[field] = value
    }
    if (Object.keys(changes).length) {
      await ctx.db.patch(table, current._id, changes as never)
    }
  }
}

export const methods = defineContract({
  name: 'contacts.methods',
  entity: 'contacts',
  version: 1,
  counter: 'methodsVersion',
  fields: methodsFields,
  prepare: prepareMethods,
  apply: async (ctx, p, root) => {
    if (!root)
      throw rejected('no_root', 'contacts.methods targets an existing contact')
    await reconcile(ctx, 'contactEmails', root._id, p.emails, ['address'])
    await reconcile(ctx, 'contactPhones', root._id, p.phones, ['number'])
    return root._id
  },
})

export const addresses = defineContract({
  name: 'contacts.addresses',
  entity: 'contacts',
  version: 1,
  counter: 'addressesVersion',
  fields: addressesFields,
  prepare: prepareAddresses,
  apply: async (ctx, p, root) => {
    if (!root)
      throw rejected(
        'no_root',
        'contacts.addresses targets an existing contact',
      )
    // No identity field: the key is the identity, every field is correctable.
    await reconcile(ctx, 'contactAddresses', root._id, p.addresses, [])
    return root._id
  },
})

export const archive = defineContract({
  name: 'contacts.archive',
  entity: 'contacts',
  version: 1,
  counter: 'archiveVersion',
  fields: archiveFields,
  apply: async (ctx, p, root) => {
    if (!root)
      throw rejected('no_root', 'contacts.archive targets an existing contact')
    await ctx.db.patch('contacts', root._id, { archived: p.archived })
    return root._id
  },
})

export const relationshipType = defineContract({
  name: 'contacts.relationshipType',
  entity: 'relationshipTypes',
  version: 1,
  counter: 'saveVersion',
  fields: relationshipTypeFields,
  prepare: prepareRelationshipType,
  apply: async (ctx, p, root) => {
    if (!root)
      return ctx.db.insert('relationshipTypes', { ...p, saveVersion: 0 })
    await ctx.db.patch('relationshipTypes', root._id, p)
    return root._id
  },
})

export const relationship = defineContract({
  name: 'contacts.relationship',
  entity: 'relationships',
  version: 1,
  counter: 'saveVersion',
  fields: relationshipFields,
  prepare: prepareRelationship,
  apply: async (ctx, p, root) => {
    const [a, b, type] = await Promise.all([
      ctx.db.get(p.contactA),
      ctx.db.get(p.contactB),
      ctx.db.get(p.typeId),
    ])
    if (!a || !b) throw rejected('unknown_contact', 'Both contacts must exist')
    if (!type || !type.isActive) {
      throw rejected(
        'unknown_type',
        'Relationship type must exist and be active',
      )
    }
    if (type.kindA && a.kind !== type.kindA) {
      throw rejected(
        'kind_mismatch',
        `${type.labelAB}: contact A must be ${type.kindA}`,
      )
    }
    if (type.kindB && b.kind !== type.kindB) {
      throw rejected(
        'kind_mismatch',
        `${type.labelAB}: contact B must be ${type.kindB}`,
      )
    }
    if (!root) return ctx.db.insert('relationships', { ...p, saveVersion: 0 })
    await ctx.db.patch('relationships', root._id, p)
    return root._id
  },
})

/** Everything restore needs to know about this module. */
export const contactContracts = registry(
  details,
  methods,
  addresses,
  archive,
  relationshipType,
  relationship,
)

/** Slices of the Contact form, in the order the form shows them. */
export const contactSlices = { details, methods, addresses } as const
