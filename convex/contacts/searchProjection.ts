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
import { searchRow } from './search'

/**
 * Rebuild one contact's `contactSearch` row from its current state; writes
 * only if the row changed. Every read but the tag names runs at once: this
 * is on the save path.
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
  const tags = await Promise.all(tagRows.map((r) => db.get(r.tagId)))
  const row = searchRow(contact, {
    emails: emails.map((e) => e.address),
    phones: phones.map((p) => p.number),
    addresses,
    identifiers: idRows.map((r) => r.value),
    tagNames: tags.flatMap((t) => (t ? [t.name] : [])),
  })
  if (!existing) {
    await db.insert('contactSearch', { contactId, ...row })
  } else if (!sameRow(existing, row)) {
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
  await ctx.db.insert('contactSearch', { contactId: id, ...row })
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

/** One batch of a tag rename's re-index; schedules the next. */
export const reindexTag = internalTenantMutation({
  args: { tagId: v.id('tags'), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { tagId, cursor }) => {
    const page = await ctx.db
      .query('contactTags')
      .withIndex('by_tenant_tag', (q) => q.eq('tagId', tagId))
      .paginate({ numItems: REINDEX_TAG_BATCH, cursor })
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
