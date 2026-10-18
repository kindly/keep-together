/**
 * Contact contracts (ADR 0014). Six partitioned slices on the Contact
 * root, plus Tag, IdentifierType, RelationshipType, Relationship and
 * ContactNote (two slices) as their own aggregates.
 * Apply functions are pure state application — restore re-runs them.
 */
import { v } from 'convex/values'
import { validate } from 'convex-helpers/validators'
import type { Id } from '../_generated/dataModel'
import type { ContractCtx } from '../lib/contracts'
import { defineContract, registry, rejected } from '../lib/contracts'
import type { ScopedDatabaseReader } from '../lib/tenancy'
import {
  IDENTIFIER_TYPE_LIMIT,
  computedNames,
  normaliseEmail,
  normaliseIdentifier,
  normaliseTagName,
  prepareAddresses,
  prepareDetails,
  prepareIdentifierType,
  prepareIdentifiers,
  prepareMethods,
  prepareNote,
  prepareRelationship,
  prepareRelationshipType,
  prepareTag,
  prepareTags,
} from './rules'
import {
  addressesFields,
  archiveFields,
  detailsFields,
  identifierTypeFields,
  identifiersFields,
  methodsFields,
  noteCreateFields,
  noteFields,
  noteFlagsFields,
  relationshipFields,
  relationshipTypeFields,
  tagFields,
  tagsFields,
} from './validators'

/**
 * v2 (external identifiers X1): `externalIdentifier` left the payload for
 * the `contacts.identifiers` slice. A v1 revision restores through the
 * upcaster and leaves the contact's identifiers (and any not yet
 * backfilled `externalIdentifier`) as they are.
 */
export const details = defineContract({
  name: 'contacts.details',
  entity: 'contacts',
  version: 2,
  counter: 'detailsVersion',
  fields: detailsFields,
  prepare: prepareDetails,
  upcasters: {
    1: (payload) => {
      const { externalIdentifier: _, ...rest } = payload as {
        externalIdentifier?: string
      }
      return rest
    },
  },
  apply: async (ctx, p, root) => {
    const names = computedNames(p)
    const fields = {
      title: p.title,
      firstName: p.firstName,
      lastName: p.lastName,
      nickname: p.nickname,
      name: p.name,
      birthDate: p.birthDate,
      isDeceased: p.isDeceased,
      deceasedDate: p.deceasedDate,
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
        tagsVersion: 0,
        identifiersVersion: 0,
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

type ChildTable =
  | 'contactEmails'
  | 'contactPhones'
  | 'contactAddresses'
  | 'contactTags'
  | 'contactIdentifiers'
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
  // The ownership lookups go with the read of the current rows, not after
  // it: one read level instead of two. A key found on a row of this
  // contact is simply kept.
  const [existing, byKeyAnywhere] = await Promise.all([
    ctx.db
      .query(table)
      .withIndex('by_tenant_contact', (q) => q.eq('contactId', contactId))
      .collect(),
    Promise.all(
      rows.map((row) =>
        ctx.db
          .query(table)
          .withIndex('by_tenant_key', (q) => q.eq('key', row.key as string))
          .first(),
      ),
    ),
  ])
  const byKey = new Map(existing.map((d) => [d.key, d]))
  const payloadKeys = new Set(rows.map((r) => r.key as string))

  // Every check before any write, and the reads and writes each as one
  // concurrent batch: a save's latency is the depth of its awaits.
  const updates: Array<{
    id: Id<ChildTable>
    changes: Record<string, unknown>
  }> = []
  const added: Array<Row> = []
  for (const row of rows) {
    const current = byKey.get(row.key as string)
    if (!current) {
      added.push(row)
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
    if (Object.keys(changes).length) updates.push({ id: current._id, changes })
  }
  const owned = byKeyAnywhere.findIndex(
    (d) => d !== null && d.contactId !== contactId,
  )
  if (owned !== -1) {
    throw rejected(
      'child_ownership',
      `${table} row ${rows[owned].key as string} belongs to another contact`,
    )
  }

  await Promise.all([
    ...existing
      .filter((doc) => !payloadKeys.has(doc.key))
      .map((doc) => ctx.db.delete(table, doc._id)),
    ...added.map((row) =>
      ctx.db.insert(table, {
        ...(row as object),
        key: row.key,
        contactId,
        ...(table === 'contactEmails'
          ? {
              onHold: false,
              // Derived from the identity field, so it never changes per key.
              addressNormalized: normaliseEmail(row.address as string),
            }
          : {}),
        ...(table === 'contactIdentifiers'
          ? { valueNormalized: normaliseIdentifier(row.value as string) }
          : {}),
      } as never),
    ),
    ...updates.map(({ id, changes }) =>
      ctx.db.patch(table, id, changes as never),
    ),
  ])
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
    await Promise.all([
      reconcile(ctx, 'contactEmails', root._id, p.emails, ['address']),
      reconcile(ctx, 'contactPhones', root._id, p.phones, ['number']),
    ])
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

/**
 * The contact's tag assignments. Only active tags can be newly added; a
 * kept row keeps its tag even after the tag is archived, and a restore
 * may re-add one (the assignment is history, so restores never fail on
 * tags; the tag stays archived and out of pickers).
 */
export const tags = defineContract({
  name: 'contacts.tags',
  entity: 'contacts',
  version: 1,
  counter: 'tagsVersion',
  fields: tagsFields,
  prepare: prepareTags,
  apply: async (ctx, p, root, command) => {
    if (!root)
      throw rejected('no_root', 'contacts.tags targets an existing contact')
    const existing = await ctx.db
      .query('contactTags')
      .withIndex('by_tenant_contact', (q) => q.eq('contactId', root._id))
      .collect()
    const kept = new Set(existing.map((r) => r.key))
    for (const row of p.tags) {
      if (kept.has(row.key!)) continue
      // Another tenant's id reads as null through the scoped db.
      const tag = await ctx.db.get(row.tagId)
      if (!tag || (!tag.isActive && command.source !== 'restore')) {
        throw rejected('unknown_tag', 'Tag must exist and be active')
      }
    }
    await reconcile(ctx, 'contactTags', root._id, p.tags, ['tagId'])
    return root._id
  },
})

/** A tag definition. Renaming keeps every assignment (they hold the id). */
export const tag = defineContract({
  name: 'contacts.tag',
  entity: 'tags',
  version: 1,
  counter: 'saveVersion',
  fields: tagFields,
  prepare: prepareTag,
  apply: async (ctx, p, root) => {
    const nameNormalized = normaliseTagName(p.name)
    const clash = await ctx.db
      .query('tags')
      .withIndex('by_tenant_nameNormalized', (q) =>
        q.eq('nameNormalized', nameNormalized),
      )
      .first()
    if (clash && clash._id !== root?._id) {
      throw rejected('duplicate_tag_name', `A tag called ${clash.name} exists`)
    }
    const fields = { name: p.name, nameNormalized, isActive: p.isActive }
    if (!root) return ctx.db.insert('tags', { ...fields, saveVersion: 0 })
    await ctx.db.patch('tags', root._id, fields)
    return root._id
  },
})

/** Another contact holding one of these (type, value) pairs. */
export type IdentifierClash = {
  key: string
  value: string
  contactId: Id<'contacts'>
  displayName: string
}

/**
 * For each row, the other contact (if any) already holding its (type,
 * value) pair in this tenant. Shared by the contract (which refuses) and
 * the form save (which reports it on the row and saves the other slices).
 */
export async function identifierClashes(
  db: ScopedDatabaseReader,
  contactId: Id<'contacts'>,
  rows: Array<{ key?: string; typeId: Id<'identifierTypes'>; value: string }>,
): Promise<Array<IdentifierClash>> {
  const found = await Promise.all(
    rows.map(async (row) => {
      const held = await db
        .query('contactIdentifiers')
        .withIndex('by_tenant_valueNormalized_type', (q) =>
          q
            .eq('valueNormalized', normaliseIdentifier(row.value))
            .eq('typeId', row.typeId),
        )
        .first()
      if (!held || held.contactId === contactId) return null
      const other = await db.get(held.contactId)
      return {
        key: row.key!,
        value: row.value,
        contactId: held.contactId,
        displayName: other?.displayName ?? '?',
      }
    }),
  )
  return found.filter((c) => c !== null)
}

/**
 * The contact's external identifiers. A (type, value) pair belongs to at
 * most one contact. Only active types can be newly added; a kept row keeps
 * an archived type, and a restore may re-add one (same rule as tags).
 * Called only on contacts that have `identifiersVersion` (all of them after
 * the X2 backfill): `executeContract` throws on a missing counter.
 */
export const identifiers = defineContract({
  name: 'contacts.identifiers',
  entity: 'contacts',
  version: 1,
  counter: 'identifiersVersion',
  fields: identifiersFields,
  prepare: prepareIdentifiers,
  apply: async (ctx, p, root, command) => {
    if (!root)
      throw rejected(
        'no_root',
        'contacts.identifiers targets an existing contact',
      )
    const existing = await ctx.db
      .query('contactIdentifiers')
      .withIndex('by_tenant_contact', (q) => q.eq('contactId', root._id))
      .collect()
    const kept = new Set(existing.map((r) => r.key))
    const added = p.identifiers.filter((r) => !kept.has(r.key!))
    const [types, clashes] = await Promise.all([
      // Another tenant's id reads as null through the scoped db.
      Promise.all(added.map((r) => ctx.db.get(r.typeId))),
      identifierClashes(ctx.db, root._id, added),
    ])
    if (
      types.some((t) => !t || (!t.isActive && command.source !== 'restore'))
    ) {
      throw rejected(
        'unknown_identifier_type',
        'Identifier type must exist and be active',
      )
    }
    if (clashes.length) {
      const { value, displayName } = clashes[0]
      throw rejected(
        'duplicate_identifier',
        `${value} is already used by ${displayName}`,
      )
    }
    await reconcile(ctx, 'contactIdentifiers', root._id, p.identifiers, [
      'typeId',
      'value',
    ])
    return root._id
  },
})

/**
 * An identifier type. Renaming keeps every row (they hold the id). A
 * tenant holds at most IDENTIFIER_TYPE_LIMIT, archived ones included.
 */
export const identifierType = defineContract({
  name: 'contacts.identifierType',
  entity: 'identifierTypes',
  version: 1,
  counter: 'saveVersion',
  fields: identifierTypeFields,
  prepare: prepareIdentifierType,
  apply: async (ctx, p, root) => {
    const nameNormalized = normaliseTagName(p.name)
    const clash = await ctx.db
      .query('identifierTypes')
      .withIndex('by_tenant_nameNormalized', (q) =>
        q.eq('nameNormalized', nameNormalized),
      )
      .first()
    if (clash && clash._id !== root?._id) {
      throw rejected(
        'duplicate_identifier_type_name',
        `An identifier type called ${clash.name} exists`,
      )
    }
    const fields = { name: p.name, nameNormalized, isActive: p.isActive }
    if (!root) {
      const held = await ctx.db
        .query('identifierTypes')
        .withIndex('by_tenant_nameNormalized')
        .take(IDENTIFIER_TYPE_LIMIT)
      if (held.length >= IDENTIFIER_TYPE_LIMIT) {
        throw rejected(
          'identifier_type_limit',
          `A group can have at most ${IDENTIFIER_TYPE_LIMIT} identifier types, archived ones included`,
        )
      }
      return ctx.db.insert('identifierTypes', { ...fields, saveVersion: 0 })
    }
    await ctx.db.patch('identifierTypes', root._id, fields)
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

/**
 * The note's text. `contactId` is a create-only argument, not payload, so
 * any revision restores onto the note wherever it lives now.
 */
export const note = defineContract({
  name: 'contacts.note',
  entity: 'contactNotes',
  version: 1,
  counter: 'bodyVersion',
  fields: noteFields,
  prepare: prepareNote,
  apply: async (ctx, p, root, command) => {
    const edited = {
      editedBy: command.actor ?? undefined,
      editedAt: command.at,
    }
    if (!root) {
      validate(v.object(noteCreateFields), command.createWith, { throw: true })
      const { contactId } = command.createWith as { contactId: Id<'contacts'> }
      // Another tenant's id reads as null through the scoped db.
      const contact = await ctx.db.get(contactId)
      if (!contact) throw rejected('unknown_contact', 'Contact must exist')
      return ctx.db.insert('contactNotes', {
        contactId,
        body: p.body,
        pinned: false,
        archived: false,
        createdBy: command.actor ?? undefined,
        ...edited,
        bodyVersion: 0,
        flagsVersion: 0,
      })
    }
    if (root.archived) {
      throw rejected('archived', 'Restore the note before editing it')
    }
    await ctx.db.patch('contactNotes', root._id, { body: p.body, ...edited })
    return root._id
  },
})

/** Pin and archive: not edits, so they leave body and editedBy/At alone. */
export const noteFlags = defineContract({
  name: 'contacts.noteFlags',
  entity: 'contactNotes',
  version: 1,
  counter: 'flagsVersion',
  fields: noteFlagsFields,
  apply: async (ctx, p, root) => {
    if (!root)
      throw rejected('no_root', 'contacts.noteFlags targets an existing note')
    // Archive and unarchive are always allowed; nothing else changes on an
    // archived note.
    if (root.archived && p.archived && root.pinned !== p.pinned) {
      throw rejected('archived', 'Restore the note before pinning it')
    }
    await ctx.db.patch('contactNotes', root._id, {
      pinned: p.pinned,
      archived: p.archived,
    })
    return root._id
  },
})

/** Everything restore needs to know about this module. */
export const contactContracts = registry(
  details,
  methods,
  addresses,
  archive,
  tags,
  tag,
  identifiers,
  identifierType,
  relationshipType,
  relationship,
  note,
  noteFlags,
)

/** Slices of the Contact form, in the order the form shows them. */
export const contactSlices = {
  details,
  methods,
  addresses,
  tags,
  identifiers,
} as const
