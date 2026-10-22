/**
 * The `contactSearch` projection (search plan, Q1): one derived row per
 * contact, rebuilt from the contact's current state. Not a domain
 * aggregate (no contract, no revisions): `projectContactSearch` runs as the
 * `project` hook of every contract that touches a searchable slice, inside
 * that contract's transaction, and it and the backfill are the only
 * writers of the table.
 */
import { v } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import { internal } from '../_generated/api'
import type { ContractCtx } from '../lib/contracts'
import { internalTenantMutation } from '../lib/tenancy'
import type { ScopedDatabaseReader } from '../lib/tenancy'
import { describe } from '../sources/code'
import { searchRow } from './search'
import { sameSlots, slotValues } from './fieldValues'

type AcquisitionIds = Pick<
  Doc<'contactSearch'>,
  'acquisitionCodeId' | 'acquisitionDetailId' | 'acquisitionCategoryId'
>

/**
 * The contact's acquisition code with its detail and category, for the
 * list's filters. A code's parents never change (a version stays under its
 * detail, a detail under its category), so the ids the row already holds
 * for the same code are reused without a read.
 */
async function acquisitionIds(
  db: ScopedDatabaseReader,
  codeId: Id<'sourceCodes'> | undefined,
  existing: Doc<'contactSearch'> | null,
): Promise<AcquisitionIds> {
  if (!codeId) {
    return {
      acquisitionCodeId: undefined,
      acquisitionDetailId: undefined,
      acquisitionCategoryId: undefined,
    }
  }
  if (
    existing?.acquisitionCodeId === codeId &&
    existing.acquisitionDetailId &&
    existing.acquisitionCategoryId
  ) {
    return {
      acquisitionCodeId: codeId,
      acquisitionDetailId: existing.acquisitionDetailId,
      acquisitionCategoryId: existing.acquisitionCategoryId,
    }
  }
  const code = await describe(db, codeId)
  return {
    acquisitionCodeId: codeId,
    acquisitionDetailId: code?.detailId,
    acquisitionCategoryId: code?.categoryId,
  }
}

function sameIds(existing: Doc<'contactSearch'>, ids: AcquisitionIds) {
  return (
    existing.acquisitionCodeId === ids.acquisitionCodeId &&
    existing.acquisitionDetailId === ids.acquisitionDetailId &&
    existing.acquisitionCategoryId === ids.acquisitionCategoryId
  )
}

/**
 * Rebuild one contact's `contactSearch` row from its current state; writes
 * only if the row changed. Every read runs at once (tags are named by the
 * copy on their `contactTags` rows): this is on the save path.
 */
export async function projectContactSearch(
  ctx: Pick<ContractCtx, 'db'>,
  contactId: Id<'contacts'>,
): Promise<void> {
  const db = ctx.db
  const [contact, emails, phones, addresses, tagRows, idRows, existing] =
    await Promise.all([
      db.get(contactId),
      db
        .query('contactEmails')
        .withIndex('by_tenant_contact', (q) => q.eq('contactId', contactId))
        .collect(),
      db
        .query('contactPhones')
        .withIndex('by_tenant_contact', (q) => q.eq('contactId', contactId))
        .collect(),
      db
        .query('contactAddresses')
        .withIndex('by_tenant_contact', (q) => q.eq('contactId', contactId))
        .collect(),
      db
        .query('contactTags')
        .withIndex('by_tenant_contact', (q) => q.eq('contactId', contactId))
        .collect(),
      db
        .query('contactIdentifiers')
        .withIndex('by_tenant_contact', (q) => q.eq('contactId', contactId))
        .collect(),
      db
        .query('contactSearch')
        .withIndex('by_tenant_contact', (q) => q.eq('contactId', contactId))
        .unique(),
    ])
  if (!contact) return
  const ids = await acquisitionIds(db, contact.acquisitionCodeId, existing)
  const row = {
    ...searchRow(contact, {
      emails: emails.map((e) => e.address),
      phones: phones.map((p) => p.number),
      addresses,
      identifiers: idRows.map((r) => r.value),
      tagNames: tagRows.map((r) => r.name),
    }),
    ...ids,
    ...slotValues(contact),
  }
  if (!existing) {
    await db.insert('contactSearch', { contactId, ...row })
  } else if (
    !sameRow(existing, row) ||
    !sameIds(existing, ids) ||
    !sameSlots(existing, contact)
  ) {
    await db.patch('contactSearch', existing._id, row)
  }
}

function sameRow(
  existing: Doc<'contactSearch'>,
  row: ReturnType<typeof searchRow>,
): boolean {
  return (
    existing.text === row.text &&
    existing.archived === row.archived &&
    existing.kind === row.kind &&
    existing.sortName === row.sortName &&
    existing.phones.join(' ') === row.phones.join(' ')
  )
}

/**
 * The `project` hook of the contact contracts. A contact the command
 * created (no `before`) has no child rows and no search row yet, so only
 * the new root is read: create is on the user's path, and each read
 * skipped is time saved.
 */
export async function projectContact(
  ctx: ContractCtx,
  id: Id<'contacts'>,
  before: Doc<'contacts'> | null,
): Promise<void> {
  if (before) return projectContactSearch(ctx, id)
  const contact = await ctx.db.get(id)
  if (!contact) return
  const row = searchRow(contact, {
    emails: [],
    phones: [],
    addresses: [],
    identifiers: [],
    tagNames: [],
  })
  await ctx.db.insert('contactSearch', {
    contactId: id,
    ...row,
    ...slotValues(contact),
  })
}

/**
 * The `project` hook of `contacts.acquisition`: only the row's acquisition
 * ids can have changed, so it reads the root and the row, not the
 * children. A contact with no row yet gets a full build.
 */
export async function projectAcquisition(
  ctx: ContractCtx,
  id: Id<'contacts'>,
): Promise<void> {
  const [contact, existing] = await Promise.all([
    ctx.db.get(id),
    ctx.db
      .query('contactSearch')
      .withIndex('by_tenant_contact', (q) => q.eq('contactId', id))
      .unique(),
  ])
  if (!contact) return
  if (!existing) return projectContactSearch(ctx, id)
  const ids = await acquisitionIds(ctx.db, contact.acquisitionCodeId, existing)
  if (!sameIds(existing, ids)) {
    await ctx.db.patch('contactSearch', existing._id, ids)
  }
}

/**
 * The `project` hook of `contacts.fields`: only the row's slot values can
 * have changed (option labels are not in the search text, g1q11), so it
 * reads the root and the row, not the children. A contact with no row yet
 * gets a full build.
 */
export async function projectFields(
  ctx: ContractCtx,
  id: Id<'contacts'>,
): Promise<void> {
  const [contact, existing] = await Promise.all([
    ctx.db.get(id),
    ctx.db
      .query('contactSearch')
      .withIndex('by_tenant_contact', (q) => q.eq('contactId', id))
      .unique(),
  ])
  if (!contact) return
  if (!existing) return projectContactSearch(ctx, id)
  if (!sameSlots(existing, contact)) {
    await ctx.db.patch('contactSearch', existing._id, slotValues(contact))
  }
}

/** How many contacts one `reindexTag` batch rebuilds. */
export const REINDEX_TAG_BATCH = 100

/**
 * The `project` hook of `contacts.tag`: a rename changes the search text of
 * every contact carrying the tag, so it re-indexes them in scheduled
 * batches (a tag can be on more contacts than one transaction can touch).
 * Archiving or reactivating changes nothing searchable.
 */
export async function projectTag(
  ctx: ContractCtx,
  id: Id<'tags'>,
  before: Doc<'tags'> | null,
): Promise<void> {
  if (!before) return
  const after = await ctx.db.get(id)
  if (!after || after.name === before.name) return
  if (!ctx.scheduler) {
    throw new Error('contacts.tag: a rename needs a scheduler to re-index')
  }
  await ctx.scheduler.runAfter(
    0,
    internal.contacts.searchProjection.reindexTag,
    {
      tagId: id,
      cursor: null,
    },
  )
}

/**
 * One batch of a tag rename's re-index; schedules the next. Each batch
 * copies the tag's current name onto its `contactTags` rows, then rebuilds
 * those contacts' search rows from them. Reading the name per batch (not
 * passing it along) means a second rename mid-run still ends on the latest.
 */
export const reindexTag = internalTenantMutation({
  args: { tagId: v.id('tags'), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { tagId, cursor }) => {
    const [tag, page] = await Promise.all([
      ctx.db.get(tagId),
      ctx.db
        .query('contactTags')
        .withIndex('by_tenant_tag', (q) => q.eq('tagId', tagId))
        .paginate({ numItems: REINDEX_TAG_BATCH, cursor }),
    ])
    if (tag) {
      await Promise.all(
        page.page
          .filter((r) => r.name !== tag.name)
          .map((r) => ctx.db.patch('contactTags', r._id, { name: tag.name })),
      )
    }
    await Promise.all(
      page.page.map((r) => projectContactSearch(ctx, r.contactId)),
    )
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.contacts.searchProjection.reindexTag,
        { tagId, cursor: page.continueCursor },
      )
    }
  },
})
