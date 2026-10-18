import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import { internalTenantQuery, tenantQuery } from '../lib/tenancy'
import type { ScopedDatabaseReader } from '../lib/tenancy'
import {
  IDENTIFIER_TYPE_LIMIT,
  normaliseEmail,
  normaliseIdentifier,
  normaliseTagName,
} from './rules'
import { contactKind } from '../schema'
import { matchesAll, parseSearch } from './search'
import type { AlsoUsedBy } from './warnings'
import { groupsToRead, toMoments } from './history'

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

/**
 * A contact's identifiers with their type names, by type name then value.
 * A row of an archived type says so (`typeActive: false`).
 */
async function identifiersOf(
  db: ScopedDatabaseReader,
  contactId: Id<'contacts'>,
) {
  const rows = await db
    .query('contactIdentifiers')
    .withIndex('by_tenant_contact', (q) => q.eq('contactId', contactId))
    .collect()
  // Rows share a few types: read each type once, not once per row (every
  // save re-runs this, and a read costs the same however small).
  const typeIds = [...new Set(rows.map((r) => r.typeId))]
  const types = new Map(
    (await Promise.all(typeIds.map((id) => db.get(id)))).map((t, i) => [
      typeIds[i],
      t,
    ]),
  )
  const out = rows.map((r) => {
    const type = types.get(r.typeId)
    return {
      key: r.key,
      typeId: r.typeId,
      value: r.value,
      typeName: type?.name ?? '?',
      typeActive: type?.isActive ?? false,
    }
  })
  return out.sort(
    (a, b) =>
      normaliseTagName(a.typeName).localeCompare(
        normaliseTagName(b.typeName),
      ) || a.value.localeCompare(b.value),
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

/**
 * The tenant's identifier types, alphabetical; archived ones only when
 * asked (the settings page). Any member may read. Never truncated: the
 * contract caps a tenant at IDENTIFIER_TYPE_LIMIT.
 */
export const listIdentifierTypes = tenantQuery({
  args: { includeInactive: v.optional(v.boolean()) },
  handler: async (ctx, { includeInactive }) => {
    const rows = await ctx.db
      .query('identifierTypes')
      .withIndex('by_tenant_nameNormalized')
      .take(IDENTIFIER_TYPE_LIMIT)
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

/**
 * For imports: the contact holding this identifier (archived included), or
 * null. Matching is trimmed and case-insensitive; an archived type's rows
 * are still found. At most one contact holds a (type, value) pair.
 */
export const findByIdentifier = internalTenantQuery({
  args: { typeId: v.id('identifierTypes'), value: v.string() },
  handler: async (ctx, { typeId, value }) => {
    const valueNormalized = normaliseIdentifier(value)
    if (!valueNormalized) return null
    const row = await ctx.db
      .query('contactIdentifiers')
      .withIndex('by_tenant_valueNormalized_type', (q) =>
        q.eq('valueNormalized', valueNormalized).eq('typeId', typeId),
      )
      .first()
    return row && ctx.db.get(row.contactId)
  },
})

/** How many identifier rows one list search reads (any type, one value). */
export const IDENTIFIER_LOOKUP_LIMIT = 50

/** Contacts holding an identifier equal to `value`, of any type. */
async function contactsWithIdentifier(
  db: ScopedDatabaseReader,
  value: string,
): Promise<Array<Doc<'contacts'>>> {
  const valueNormalized = normaliseIdentifier(value)
  if (!valueNormalized) return []
  const rows = await db
    .query('contactIdentifiers')
    .withIndex('by_tenant_valueNormalized_type', (q) =>
      q.eq('valueNormalized', valueNormalized),
    )
    .take(IDENTIFIER_LOOKUP_LIMIT)
  const ids = [...new Set(rows.map((r) => r.contactId))]
  const contacts = await Promise.all(ids.map((id) => db.get(id)))
  return contacts.filter((c) => c !== null)
}

/** The most rows `list` returns. */
export const LIST_LIMIT = 100
/** The most assignments a tag-filtered `list` reads (then sorted by name). */
export const LIST_TAG_SCAN = 200
/**
 * The most `contactSearch` hits one search reads. Convex ranks rows that
 * match any term; those missing a term are dropped after, so it reads
 * more than it returns.
 */
export const LIST_SEARCH_SCAN = 2 * LIST_LIMIT

/**
 * Searchable list, optionally only the contacts carrying one tag and of
 * one kind; archived hidden unless asked. Bounded at LIST_LIMIT rows. Each
 * row carries its tag ids (names come from `tags`).
 *
 * A search finds a contact by anything in its `contactSearch` text (names,
 * emails and their parts, phones, postcodes, street, town, identifiers,
 * tags): every word must match, the last as a prefix. Exact matches come
 * first: an email address, then an identifier, then a phone number
 * (normalised), then the rest in Convex's relevance order.
 *
 * Without a search, a tag filter reads the tag's first LIST_TAG_SCAN
 * assignments; larger tags page through `byTag`. `truncated` says more
 * contacts may match than `rows` holds (a cap or scan limit was hit), so
 * the UI can say it shows only some of them. `tooBroad` says the search
 * read LIST_SEARCH_SCAN hits and none held every word: a full match may
 * rank beyond them, so the UI asks for another word instead of saying
 * nothing matches.
 */
export const list = tenantQuery({
  args: {
    search: v.optional(v.string()),
    includeArchived: v.optional(v.boolean()),
    tagId: v.optional(v.id('tags')),
    kind: v.optional(contactKind),
  },
  handler: async (ctx, { search, includeArchived, tagId, kind }) => {
    const term = search?.trim()
    let rows: Array<Doc<'contacts'>>
    // A read that hit its cap: more contacts may match than it saw.
    let scanFull = false
    // The scan was all partial matches: a full match may lie beyond it.
    let tooBroad = false
    if (term) {
      const { terms, phone } = parseSearch(term)
      const [byEmail, byIdentifier, hits] = await Promise.all([
        contactsWithEmail(ctx.db, term).then((r) => r.contacts),
        contactsWithIdentifier(ctx.db, term),
        terms.length
          ? ctx.db
              .query('contactSearch')
              .withSearchIndex('search_text', (q) => {
                const s = q.search('text', terms.join(' '))
                const live = includeArchived ? s : s.eq('archived', false)
                return kind ? live.eq('kind', kind) : live
              })
              .take(LIST_SEARCH_SCAN)
          : Promise.resolve([]),
      ])
      scanFull = hits.length === LIST_SEARCH_SCAN
      const matched = hits.filter((h) => matchesAll(h.text, terms))
      tooBroad = scanFull && matched.length === 0
      const byPhone = phone
        ? matched.filter((h) => h.phones.includes(phone))
        : []
      // Exact matches first, each contact once; then read only as many
      // full-text hits as can still be shown (all of them under a tag
      // filter, which drops hits after).
      const seen = new Set<Id<'contacts'>>()
      const once = (id: Id<'contacts'>) =>
        !seen.has(id) && Boolean(seen.add(id))
      const exact = [...byEmail, ...byIdentifier].filter(
        (c) =>
          (!kind || c.kind === kind) &&
          (includeArchived || !c.archived) &&
          once(c._id),
      )
      const rest = [...byPhone, ...matched].map((h) => h.contactId).filter(once)
      const wanted = tagId ? rest : rest.slice(0, LIST_LIMIT + 1 - exact.length)
      const found = await Promise.all(wanted.map((id) => ctx.db.get(id)))
      rows = [...exact, ...found.filter((c) => c !== null)]
    } else if (tagId) {
      const assigned = await ctx.db
        .query('contactTags')
        .withIndex('by_tenant_tag', (q) => q.eq('tagId', tagId))
        .take(LIST_TAG_SCAN)
      scanFull = assigned.length === LIST_TAG_SCAN
      const contacts = await Promise.all(
        assigned.map((r) => ctx.db.get(r.contactId)),
      )
      rows = contacts
        .filter((c) => c !== null)
        .filter((c) => !kind || c.kind === kind)
        .sort((a, b) => a.sortName.localeCompare(b.sortName))
    } else {
      rows = await (
        kind
          ? ctx.db
              .query('contacts')
              .withIndex('by_tenant_kind_sort', (q) => q.eq('kind', kind))
          : ctx.db.query('contacts').withIndex('by_tenant_sort')
      ).take(2 * LIST_LIMIT)
      scanFull = rows.length === 2 * LIST_LIMIT
    }
    const visible = includeArchived ? rows : rows.filter((c) => !c.archived)
    // A search with a tag filter checks the tag per hit, so it shapes every
    // hit before cutting to the limit; otherwise only the rows it returns.
    const searchingTag = Boolean(term && tagId)
    const shaped = await Promise.all(
      (searchingTag ? visible : visible.slice(0, LIST_LIMIT)).map(async (c) => {
        const [email, tagRows] = await Promise.all([
          ctx.db
            .query('contactEmails')
            .withIndex('by_tenant_contact', (q) => q.eq('contactId', c._id))
            .first(),
          ctx.db
            .query('contactTags')
            .withIndex('by_tenant_contact', (q) => q.eq('contactId', c._id))
            .collect(),
        ])
        return {
          _id: c._id,
          kind: c.kind,
          displayName: c.displayName,
          sortName: c.sortName,
          archived: c.archived,
          email: email?.address ?? null,
          tagIds: tagRows.map((r) => r.tagId),
        }
      }),
    )
    const matching = searchingTag
      ? shaped.filter((r) => r.tagIds.includes(tagId!))
      : shaped
    return {
      rows: matching.slice(0, LIST_LIMIT),
      tooBroad,
      truncated:
        scanFull ||
        (searchingTag ? matching.length : visible.length) > LIST_LIMIT,
    }
  },
})

/**
 * The whole aggregate: root, children and counters. Every read that doesn't
 * depend on another runs concurrently: this query re-runs after every save
 * of the contact, and its time is on the save's critical path (the client
 * sees the save once its queries are current). Advisory warnings are
 * `contactWarnings(view, sharedAddresses)`, computed by the caller, so the
 * shared-address lookup (two more read levels) stays off that path.
 */
async function contactView(db: ScopedDatabaseReader, id: Id<'contacts'>) {
  const emails = emailRows(db, id)
  const [contact, kids, tagList, identifierList] = await Promise.all([
    db.get(id),
    children(db, id, emails),
    tagsOf(db, id),
    identifiersOf(db, id),
  ])
  if (!contact) return null
  return {
    contact,
    ...kids,
    tags: tagList,
    identifiers: identifierList,
  }
}

/**
 * The most addresses one `sharedAddresses` call looks up. The methods
 * contract has no per-contact cap, so rows past this come back `unchecked`
 * and the form says so rather than implying nobody shares them.
 */
export const SHARED_ADDRESS_LIMIT = 20

/**
 * Per email row (by key), the other contacts in the tenant using its
 * address: the "also used by" warning's input (S1). Takes the contact's
 * saved addresses as args rather than reading its rows, so a save that
 * adds an address doesn't re-run it inside the save's wait; the caller
 * re-subscribes with the new list one round trip later. Advisory only
 * (ADR 0015), so arriving late is fine.
 */
export const sharedAddresses = tenantQuery({
  args: {
    id: v.id('contacts'),
    emails: v.array(v.object({ key: v.string(), address: v.string() })),
  },
  handler: async (ctx, { id, emails }): Promise<AlsoUsedBy> =>
    Object.fromEntries(
      await Promise.all(
        emails.map(async (email, i) => {
          if (i >= SHARED_ADDRESS_LIMIT) {
            const unchecked = {
              contacts: [],
              truncated: false,
              unchecked: true,
            }
            return [email.key, unchecked] as const
          }
          const { contacts, truncated } = await contactsWithEmail(
            ctx.db,
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
    ),
})

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

/** Revisions one `history` page reads at most (newest first). */
export const HISTORY_PAGE_LIMIT = 10

/**
 * History as *moments*: revisions from one action (sharing a command group)
 * collapse into a single entry listing the slices it touched. Newest first,
 * one page of HISTORY_PAGE_LIMIT revisions when subscribed, so its cost on
 * open doesn't depend on how long the history is. While a subscription
 * lives, Convex keeps the page's end where it was, so the newest page grows
 * by one read per revision saved meanwhile (that's what keeps older pages
 * contiguous); a fresh subscription starts at HISTORY_PAGE_LIMIT again.
 * A group can straddle a page boundary: the client joins adjacent moments
 * with the same `key` (`joinMoments`).
 */
export const history = tenantQuery({
  args: { id: v.id('contacts'), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { id, paginationOpts }) => {
    const result = await ctx.db
      .query('revisions')
      .withIndex('by_tenant_entity', (q) =>
        q.eq('entity', 'contacts').eq('entityId', id),
      )
      .order('desc')
      .paginate({
        ...paginationOpts,
        numItems: Math.min(paginationOpts.numItems, HISTORY_PAGE_LIMIT),
      })
    const revisions = result.page
    const groupNames = new Map(
      await Promise.all(
        groupsToRead(revisions).map(
          async (g) => [g, (await ctx.db.get(g))?.name] as const,
        ),
      ),
    )
    const moments = toMoments(revisions, groupNames)
    return { ...result, page: moments }
  },
})
