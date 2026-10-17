import { v } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import { tenantQuery } from '../lib/tenancy'
import type { ScopedDatabaseReader } from '../lib/tenancy'
import { contactWarnings } from './warnings'

async function children(db: ScopedDatabaseReader, contactId: Id<'contacts'>) {
  const [emails, phones, addresses] = await Promise.all([
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
  ])
  const primaryFirst = <
    TRow extends { isPrimary: boolean; _creationTime: number },
  >(
    rows: Array<TRow>,
  ) =>
    [...rows].sort(
      (a, b) =>
        Number(b.isPrimary) - Number(a.isPrimary) ||
        a._creationTime - b._creationTime,
    )
  return {
    emails: primaryFirst(emails),
    phones: primaryFirst(phones),
    addresses: primaryFirst(addresses),
  }
}

/** Searchable list; archived hidden unless asked. Bounded at 100 rows. */
export const list = tenantQuery({
  args: {
    search: v.optional(v.string()),
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, { search, includeArchived }) => {
    const term = search?.trim()
    let rows: Array<Doc<'contacts'>>
    if (term) {
      rows = await ctx.db
        .query('contacts')
        .withSearchIndex('search_name', (q) => q.search('sortName', term))
        .take(100)
    } else {
      rows = await ctx.db
        .query('contacts')
        .withIndex('by_tenant_sort')
        .take(200)
    }
    const visible = includeArchived ? rows : rows.filter((c) => !c.archived)
    return Promise.all(
      visible.slice(0, 100).map(async (c) => {
        const email = await ctx.db
          .query('contactEmails')
          .withIndex('by_tenant_contact', (q) => q.eq('contactId', c._id))
          .first()
        return {
          _id: c._id,
          kind: c.kind,
          displayName: c.displayName,
          sortName: c.sortName,
          archived: c.archived,
          email: email?.address ?? null,
        }
      }),
    )
  },
})

/** The whole aggregate: root, children, counters and advisory warnings. */
export const get = tenantQuery({
  args: { id: v.id('contacts') },
  handler: async (ctx, { id }) => {
    const contact = await ctx.db.get(id)
    if (!contact) return null
    const kids = await children(ctx.db, id)
    return { contact, ...kids, warnings: contactWarnings(kids) }
  },
})

/**
 * History as *moments*: revisions from one action (sharing a command group)
 * collapse into a single entry listing the slices it touched. Newest first.
 */
export const history = tenantQuery({
  args: { id: v.id('contacts') },
  handler: async (ctx, { id }) => {
    const revisions = await ctx.db
      .query('revisions')
      .withIndex('by_tenant_entity', (q) =>
        q.eq('entity', 'contacts').eq('entityId', id),
      )
      .order('desc')
      .take(100)
    const moments: Array<{
      revisionId: Id<'revisions'>
      at: number
      actor: Id<'users'> | null
      source: Doc<'revisions'>['source']
      groupName: string | null
      slices: Array<string>
      restored: boolean
    }> = []
    const index = new Map<string, number>()
    for (const r of revisions) {
      const key = r.group ?? r._id
      const slice = r.contract.replace(/^contacts\./, '')
      const at = index.get(key)
      if (at !== undefined) {
        const m = moments[at]
        if (!m.slices.includes(slice)) m.slices.push(slice)
        continue
      }
      index.set(key, moments.length)
      const group = r.group ? await ctx.db.get(r.group) : null
      moments.push({
        revisionId: r._id,
        at: r._creationTime,
        actor: r.actor ?? null,
        source: r.source,
        groupName: group?.name ?? null,
        slices: [slice],
        restored: r.restoredFrom !== undefined,
      })
    }
    return moments
  },
})
