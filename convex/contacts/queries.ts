import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import { internalTenantQuery, tenantQuery } from '../lib/tenancy'
import type { ScopedDatabaseReader } from '../lib/tenancy'
import { normaliseEmail, normaliseTagName } from './rules'
import { contactWarnings } from './warnings'
import type { AlsoUsedBy } from './warnings'

function emailRows(db: ScopedDatabaseReader, contactId: Id<'contacts'>) {
  return db
    .query('contactEmails')
    .withIndex('by_tenant_contact', (q) => q.eq('contactId', contactId))
    .collect()
}

async function children(
  db: ScopedDatabaseReader,
  contactId: Id<'contacts'>,
  emailsRead: ReturnType<typeof emailRows>,
) {
  const [emails, phones, addresses] = await Promise.all([
    emailsRead,
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

/** A contact's tags with their names, alphabetical. */
async function tagsOf(db: ScopedDatabaseReader, contactId: Id<'contacts'>) {
  const rows = await db
    .query('contactTags')
    .withIndex('by_tenant_contact', (q) => q.eq('contactId', contactId))
    .collect()
  const out = await Promise.all(
    rows.map(async (r) => {
      const tag = await db.get(r.tagId)
      return {
        key: r.key,
        tagId: r.tagId,
        name: tag?.name ?? '?',
        isActive: tag?.isActive ?? false,
      }
    }),
  )
  return out.sort((a, b) =>
    normaliseTagName(a.name).localeCompare(normaliseTagName(b.name)),
  )
}

/** How many tags a tenant can hold before the picker list truncates. */
export const TAG_LIST_LIMIT = 500

/** The tenant's tags, alphabetical; archived ones only when asked (admin). */
export const tags = tenantQuery({
  args: { includeInactive: v.optional(v.boolean()) },
  handler: async (ctx, { includeInactive }) => {
    const rows = await ctx.db
      .query('tags')
      .withIndex('by_tenant_nameNormalized')
      .take(TAG_LIST_LIMIT)
    return includeInactive ? rows : rows.filter((t) => t.isActive)
  },
})

/** The most assignments one `byTag` page reads (one contact read each). */
export const BY_TAG_PAGE_LIMIT = 100

/**
 * Contacts carrying a tag, in the order they were tagged. A page holds the
 * page's assignments (at most BY_TAG_PAGE_LIMIT) minus archived contacts
 * (unless asked), so it can be shorter than `numItems`; `isDone` is what
 * ends the list.
 */
export const byTag = tenantQuery({
  args: {
    tagId: v.id('tags'),
    includeArchived: v.optional(v.boolean()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { tagId, includeArchived, paginationOpts }) => {
    const result = await ctx.db
      .query('contactTags')
      .withIndex('by_tenant_tag', (q) => q.eq('tagId', tagId))
      .paginate({
        ...paginationOpts,
        numItems: Math.min(paginationOpts.numItems, BY_TAG_PAGE_LIMIT),
      })
    const contacts = await Promise.all(
      result.page.map((r) => ctx.db.get(r.contactId)),
    )
    return {
      ...result,
      page: contacts
        .filter((c) => c !== null)
        .filter((c) => includeArchived || !c.archived)
        .map((c) => ({
          _id: c._id,
          kind: c.kind,
          displayName: c.displayName,
          sortName: c.sortName,
          archived: c.archived,
        })),
    }
  },
})

/** How many email rows one address lookup reads. */
export const EMAIL_LOOKUP_LIMIT = 50

/**
 * Contacts with an email row matching `address` (case- and
 * whitespace-insensitive), oldest row first. Reads at most
 * EMAIL_LOOKUP_LIMIT rows; `truncated` says more exist, so a caller that
 * needs "exactly one live match" must treat it as ambiguous.
 */
async function contactsWithEmail(
  db: ScopedDatabaseReader,
  address: string,
  /** A contact to leave out, never read (`get` skips its own row). */
  except?: Id<'contacts'>,
): Promise<{ contacts: Array<Doc<'contacts'>>; truncated: boolean }> {
  const normalised = normaliseEmail(address)
  if (!normalised) return { contacts: [], truncated: false }
  const rows = await db
    .query('contactEmails')
    .withIndex('by_tenant_addressNormalized', (q) =>
      q.eq('addressNormalized', normalised),
    )
    .take(EMAIL_LOOKUP_LIMIT + 1)
  const truncated = rows.length > EMAIL_LOOKUP_LIMIT
  const ids = [
    ...new Set(rows.slice(0, EMAIL_LOOKUP_LIMIT).map((r) => r.contactId)),
  ].filter((id) => id !== except)
  const contacts = await Promise.all(ids.map((id) => db.get(id)))
  return { contacts: contacts.filter((c) => c !== null), truncated }
}

/**
 * For imports and webhooks: the contacts using this email address, archived
 * ones included, capped as described on `contactsWithEmail`.
 */
export const findByEmail = internalTenantQuery({
  args: { address: v.string() },
  handler: async (ctx, { address }) => contactsWithEmail(ctx.db, address),
})

/** Searchable list (name, or an exact email address); archived hidden unless asked. Bounded at 100 rows. */
export const list = tenantQuery({
  args: {
    search: v.optional(v.string()),
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, { search, includeArchived }) => {
    const term = search?.trim()
    let rows: Array<Doc<'contacts'>>
    if (term) {
      const [byEmail, byName] = await Promise.all([
        contactsWithEmail(ctx.db, term).then((r) => r.contacts),
        ctx.db
          .query('contacts')
          .withSearchIndex('search_name', (q) => q.search('sortName', term))
          .take(100),
      ])
      const seen = new Set(byEmail.map((c) => c._id))
      rows = [...byEmail, ...byName.filter((c) => !seen.has(c._id))]
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

/**
 * The whole aggregate: root, children, counters and advisory warnings.
 * Every read that doesn't depend on another runs concurrently: this query
 * re-runs after every save of the contact, and its time is on the save's
 * critical path (the client sees the save once its queries are current).
 */
async function contactView(db: ScopedDatabaseReader, id: Id<'contacts'>) {
  const emails = emailRows(db, id)
  const [contact, kids, tagList, alsoUsedBy] = await Promise.all([
    db.get(id),
    children(db, id, emails),
    tagsOf(db, id),
    emails.then((rows) => sharedAddresses(db, id, rows)),
  ])
  if (!contact) return null
  return {
    contact,
    ...kids,
    tags: tagList,
    warnings: contactWarnings(kids, alsoUsedBy),
  }
}

/** Per email row, the other contacts using its address (S1 warning). */
async function sharedAddresses(
  db: ScopedDatabaseReader,
  id: Id<'contacts'>,
  emails: Array<Doc<'contactEmails'>>,
): Promise<AlsoUsedBy> {
  return Object.fromEntries(
    await Promise.all(
      emails.map(async (email) => {
        const { contacts, truncated } = await contactsWithEmail(
          db,
          email.address,
          id,
        )
        const others = contacts.map((c) => ({
          displayName: c.displayName,
          archived: c.archived,
        }))
        return [email.key, { contacts: others, truncated }] as const
      }),
    ),
  )
}

export const get = tenantQuery({
  args: { id: v.id('contacts') },
  handler: async (ctx, { id }) => contactView(ctx.db, id),
})

/**
 * The contact a new-contact form created, by the form's `clientKey`; null
 * until it exists. The form subscribes before it submits, so the new
 * contact arrives with the create mutation's own result and the contact
 * page renders without a second round trip.
 */
export const byClientKey = tenantQuery({
  args: { clientKey: v.string() },
  handler: async (ctx, { clientKey }) => {
    const contact = await ctx.db
      .query('contacts')
      .withIndex('by_tenant_clientKey', (q) => q.eq('clientKey', clientKey))
      .unique()
    return contact && contactView(ctx.db, contact._id)
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
    // Group names in one concurrent batch, not one read per moment.
    const groupIds = [
      ...new Set(revisions.flatMap((r) => (r.group ? [r.group] : []))),
    ]
    const groupNames = new Map(
      await Promise.all(
        groupIds.map(async (g) => [g, (await ctx.db.get(g))?.name] as const),
      ),
    )
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
      moments.push({
        revisionId: r._id,
        at: r._creationTime,
        actor: r.actor ?? null,
        source: r.source,
        groupName: r.group ? (groupNames.get(r.group) ?? null) : null,
        slices: [slice],
        restored: r.restoredFrom !== undefined,
      })
    }
    return moments
  },
})
