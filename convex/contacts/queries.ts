import { paginationOptsValidator } from 'convex/server'
import type { PaginationResult } from 'convex/server'
import { v } from 'convex/values'
import type { Infer } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import { internalTenantQuery, tenantQuery } from '../lib/tenancy'
import type { ScopedDatabaseReader } from '../lib/tenancy'
import {
  IDENTIFIER_TYPE_LIMIT,
  normaliseEmail,
  normaliseIdentifier,
  normaliseTagName,
} from './rules'
import { contactKind } from '../lib/appSchema'
import { matchesAll, parseSearch } from './search'
import type { AlsoUsedBy } from './warnings'
import { groupsToRead, toMoments } from './history'
import { describe } from '../sources/code'
import { nameIdentifiers } from './view'
import type { IdentifierRow } from './view'

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

/**
 * A contact's tags with their names, alphabetical. The name is the copy on
 * the `contactTags` row, so no tag is read. Whether a tag is archived is
 * not here: the form takes it from the tenant's tag list (`tags`, archived
 * included).
 */
async function tagsOf(db: ScopedDatabaseReader, contactId: Id<'contacts'>) {
  const rows = await db
    .query('contactTags')
    .withIndex('by_tenant_contact', (q) => q.eq('contactId', contactId))
    .collect()
  const out = rows.map((r) => ({ key: r.key, tagId: r.tagId, name: r.name }))
  return out.sort((a, b) =>
    normaliseTagName(a.name).localeCompare(normaliseTagName(b.name)),
  )
}

/** A contact's identifier rows, unnamed (`nameIdentifiers` names them). */
async function identifierRows(
  db: ScopedDatabaseReader,
  contactId: Id<'contacts'>,
): Promise<Array<IdentifierRow>> {
  const rows = await db
    .query('contactIdentifiers')
    .withIndex('by_tenant_contact', (q) => q.eq('contactId', contactId))
    .collect()
  return rows.map((r) => ({ key: r.key, typeId: r.typeId, value: r.value }))
}

/**
 * A contact's identifiers with their type names, by type name then value.
 * A row of an archived type says so (`typeActive: false`).
 */
async function identifiersOf(
  db: ScopedDatabaseReader,
  contactId: Id<'contacts'>,
) {
  const rows = await identifierRows(db, contactId)
  // Rows share a few types: read each type once, not once per row (every
  // save re-runs this, and a read costs the same however small).
  const typeIds = [...new Set(rows.map((r) => r.typeId))]
  const types = new Map(
    (await Promise.all(typeIds.map((id) => db.get(id)))).map((t, i) => [
      typeIds[i],
      t,
    ]),
  )
  return nameIdentifiers(rows, (id) => types.get(id))
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
/**
 * How many matching contacts a tag-filtered `list` collects (then sorts by
 * name), reading assignments in the order they were made.
 */
export const LIST_TAG_SCAN = 200
/**
 * The most `contactSearch` hits one search reads. Convex ranks rows that
 * match any term; those missing a term are dropped after, so it reads
 * more than it returns.
 */
export const LIST_SEARCH_SCAN = 2 * LIST_LIMIT
/**
 * The most rows a filter that the index can't hold (a tag, or a kind under
 * a source filter) reads looking for matches before it stops and says so.
 */
export const LIST_SCAN_CAP = 1000

/**
 * Read `rows` until `want` of them pass `keep` or LIST_SCAN_CAP have been
 * read. `keep` takes a batch, so its reads run concurrently; a batch is
 * the rows still wanted, so with nothing filtered out this reads `want`
 * rows, as `take(want)` would. `exhausted`: every row was read; `capped`:
 * the cap stopped it short of `want`, so a match may lie beyond.
 */
async function scan<TRow, TKept>(
  rows: AsyncIterable<TRow>,
  keep: (batch: Array<TRow>) => Promise<Array<TKept | null>>,
  want: number,
) {
  const kept: Array<TKept> = []
  const it = rows[Symbol.asyncIterator]()
  let read = 0
  let exhausted = false
  while (kept.length < want && read < LIST_SCAN_CAP && !exhausted) {
    const batch: Array<TRow> = []
    const size = Math.min(want - kept.length, LIST_SCAN_CAP - read)
    while (batch.length < size) {
      const next = await it.next()
      if (next.done) {
        exhausted = true
        break
      }
      batch.push(next.value)
    }
    read += batch.length
    for (const k of await keep(batch)) if (k !== null) kept.push(k)
  }
  return {
    kept,
    read,
    exhausted,
    capped: !exhausted && kept.length < want,
  }
}

/** The contacts list's source filter: one part of a code, at its level. */
const sourceFilter = v.object({
  level: v.union(
    v.literal('category'),
    v.literal('detail'),
    v.literal('version'),
  ),
  id: v.id('sourceCodes'),
})
type SourceFilter = Infer<typeof sourceFilter>

/** The `contactSearch` field a source filter's level matches on. */
const SOURCE_FIELD = {
  category: 'acquisitionCategoryId',
  detail: 'acquisitionDetailId',
  version: 'acquisitionCodeId',
} as const

/**
 * The `contactSearch` indexes serving a source filter without search text,
 * by level: every row, or archived ones left out by the range (`live`).
 */
const SOURCE_INDEX = {
  category: {
    all: 'by_tenant_acquisitionCategory_sort',
    live: 'by_tenant_acquisitionCategory_archived_sort',
  },
  detail: {
    all: 'by_tenant_acquisitionDetail_sort',
    live: 'by_tenant_acquisitionDetail_archived_sort',
  },
  version: {
    all: 'by_tenant_acquisitionCode_sort',
    live: 'by_tenant_acquisitionCode_archived_sort',
  },
} as const

type Kind = Doc<'contacts'>['kind']

/**
 * The contacts a browse (no search text, no tag) shows, in name order,
 * with archived and kind in the index range: nothing read is then hidden,
 * so a window or page never fills with rows that don't show.
 */
function browse(
  db: ScopedDatabaseReader,
  { kind, includeArchived }: { kind?: Kind; includeArchived?: boolean },
) {
  const contacts = db.query('contacts')
  if (includeArchived) {
    return kind
      ? contacts.withIndex('by_tenant_kind_sort', (q) => q.eq('kind', kind))
      : contacts.withIndex('by_tenant_sort')
  }
  return kind
    ? contacts.withIndex('by_tenant_kind_archived_sort', (q) =>
        q.eq('kind', kind).eq('archived', false),
      )
    : contacts.withIndex('by_tenant_archived_sort', (q) =>
        q.eq('archived', false),
      )
}

/**
 * `browse` under a source filter: `contactSearch` rows in name order,
 * archived in the range. A kind filter is the caller's, per row.
 */
function browseSource(
  db: ScopedDatabaseReader,
  source: SourceFilter,
  includeArchived?: boolean,
) {
  const field = SOURCE_FIELD[source.level]
  const indexes = SOURCE_INDEX[source.level]
  const rows = db.query('contactSearch')
  return includeArchived
    ? rows.withIndex(indexes.all, (q) => q.eq(field, source.id))
    : rows.withIndex(indexes.live, (q) =>
        q.eq(field, source.id).eq('archived', false),
      )
}

/**
 * Whether a contact's acquisition code falls under `source`, for the
 * exact matches (email, identifier) that bypass the search index. Each
 * distinct code is described once per call.
 */
function underSource(db: ScopedDatabaseReader, source: SourceFilter) {
  const described = new Map<string, ReturnType<typeof describe>>()
  return async (c: Doc<'contacts'>) => {
    const codeId = c.acquisitionCodeId
    if (!codeId) return false
    if (source.level === 'version') return codeId === source.id
    let d = described.get(codeId)
    if (!d) described.set(codeId, (d = describe(db, codeId)))
    const code = await d
    return (
      (source.level === 'detail' ? code?.detailId : code?.categoryId) ===
      source.id
    )
  }
}

/** One contacts-list row: a contact with its first email and tag ids. */
async function listRow(
  db: ScopedDatabaseReader,
  c: Doc<'contacts'>,
  tagIdsRead: Promise<Array<Id<'tags'>>>,
) {
  const [email, tagIds] = await Promise.all([
    db
      .query('contactEmails')
      .withIndex('by_tenant_contact', (q) => q.eq('contactId', c._id))
      .first(),
    tagIdsRead,
  ])
  return {
    _id: c._id,
    kind: c.kind,
    displayName: c.displayName,
    sortName: c.sortName,
    archived: c.archived,
    email: email?.address ?? null,
    tagIds,
  }
}

/** A contact's tag ids. */
async function tagIdsOf(db: ScopedDatabaseReader, contactId: Id<'contacts'>) {
  const rows = await db
    .query('contactTags')
    .withIndex('by_tenant_contact', (q) => q.eq('contactId', contactId))
    .collect()
  return rows.map((t) => t.tagId)
}

/**
 * The contacts list while browsing (no search text, no tag), a page at a
 * time in name order, at most LIST_LIMIT rows a page; archived hidden
 * unless asked, optionally one kind and one part of a source code
 * (`source`: a category, detail or version). Each row carries its tag ids
 * (names come from `tags`).
 *
 * Archived and kind sit in the `contacts` index range, and archived in a
 * source filter's `contactSearch` range, so those pages are full. A kind
 * under a source is checked per row, so such a page can be short, or even
 * empty, while more follow: only `isDone` ends the list, and the UI says
 * "none" only then. Search text or a tag filter goes to `search`.
 */
export const list = tenantQuery({
  args: {
    includeArchived: v.optional(v.boolean()),
    kind: v.optional(contactKind),
    source: v.optional(sourceFilter),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { includeArchived, kind, source, paginationOpts }) => {
    const opts = {
      ...paginationOpts,
      numItems: Math.min(paginationOpts.numItems, LIST_LIMIT),
    }
    let result: { page: Array<Doc<'contacts'>> } & Omit<
      PaginationResult<unknown>,
      'page'
    >
    if (source) {
      const hits = await browseSource(ctx.db, source, includeArchived).paginate(
        opts,
      )
      const found = await Promise.all(
        hits.page
          .filter((h) => !kind || h.kind === kind)
          .map((h) => ctx.db.get(h.contactId)),
      )
      result = { ...hits, page: found.filter((c) => c !== null) }
    } else {
      result = await browse(ctx.db, { kind, includeArchived }).paginate(opts)
    }
    return {
      ...result,
      page: await Promise.all(
        result.page.map((c) => listRow(ctx.db, c, tagIdsOf(ctx.db, c._id))),
      ),
    }
  },
})

/**
 * The contacts list with search text or a tag filter: one window of at
 * most LIST_LIMIT rows, not paged. Optionally also of one kind and under
 * one part of a source code; archived hidden unless asked. Rows as `list`.
 *
 * A search finds a contact by anything in its `contactSearch` text (names,
 * emails and their parts, phones, postcodes, street, town, identifiers,
 * tags): every word must match, the last as a prefix. Exact matches come
 * first: an email address, then an identifier, then a phone number
 * (normalised), then the rest in Convex's relevance order. That order
 * can't be resumed from a cursor, hence one window. The search index holds
 * the kind, archived and source filters; a tag filter checks the
 * LIST_SEARCH_SCAN hits read.
 *
 * Without search text, the index holds every filter it can (see `browse`
 * and `browseSource`); what it can't, a tag or a kind under a source, is
 * checked row by row as the read goes on (`scan`) until enough match or
 * LIST_SCAN_CAP rows have been read. A tag filter alone reads the tag's
 * assignments that way, collecting LIST_TAG_SCAN matches; larger tags page
 * through `byTag`.
 *
 * `truncated` says more contacts may match than `rows` holds (a cap or
 * scan limit was hit), so the UI can say it shows only some of them.
 * `tooBroad` says that happened with no row to show: a match may lie
 * beyond the `checked` rows read, so the UI asks the user to narrow it
 * instead of saying nothing matches.
 */
export const search = tenantQuery({
  args: {
    search: v.optional(v.string()),
    includeArchived: v.optional(v.boolean()),
    tagId: v.optional(v.id('tags')),
    kind: v.optional(contactKind),
    source: v.optional(sourceFilter),
  },
  handler: async (
    ctx,
    { search: text, includeArchived, tagId, kind, source },
  ) => {
    const term = text?.trim()
    // Every contact in `rows` passes every filter, in display order.
    let rows: Array<Doc<'contacts'>>
    // More contacts may match than `rows` holds.
    let truncated: boolean
    // Rows the capped read looked at, for the UI's "none in the first N".
    let checked = 0
    const fits = (c: { kind: Doc<'contacts'>['kind']; archived: boolean }) =>
      (!kind || c.kind === kind) && (includeArchived || !c.archived)
    // A contact's tag ids, read once per call: the tag filter and the row's
    // shape both need them.
    const tagReads = new Map<Id<'contacts'>, Promise<Array<Id<'tags'>>>>()
    const tagsOfRow = (id: Id<'contacts'>) => {
      let read = tagReads.get(id)
      if (!read) tagReads.set(id, (read = tagIdsOf(ctx.db, id)))
      return read
    }
    const tagged = async (id: Id<'contacts'>) =>
      !tagId || (await tagsOfRow(id)).includes(tagId)
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
                const ofKind = kind ? live.eq('kind', kind) : live
                return source
                  ? ofKind.eq(SOURCE_FIELD[source.level], source.id)
                  : ofKind
              })
              .take(LIST_SEARCH_SCAN)
          : Promise.resolve([]),
      ])
      // Relevance order can't be resumed past the window with the phone
      // ranking intact, so the window is fixed and a full one that shows
      // nothing is `tooBroad`.
      const scanFull = hits.length === LIST_SEARCH_SCAN
      checked = hits.length
      const matched = hits.filter((h) => matchesAll(h.text, terms))
      const byPhone = phone
        ? matched.filter((h) => h.phones.includes(phone))
        : []
      // Exact matches first, each contact once; then read only as many
      // full-text hits as can still be shown (all of them under a tag
      // filter, which drops hits after).
      const seen = new Set<Id<'contacts'>>()
      const once = (id: Id<'contacts'>) =>
        !seen.has(id) && Boolean(seen.add(id))
      const inSource = source ? underSource(ctx.db, source) : null
      const candidates = [...byEmail, ...byIdentifier].filter(fits)
      const sourced = inSource
        ? await Promise.all(candidates.map(inSource))
        : null
      const exact = candidates.filter(
        (c, i) => (!sourced || sourced[i]) && once(c._id),
      )
      const rest = [...byPhone, ...matched].map((h) => h.contactId).filter(once)
      const wanted = tagId ? rest : rest.slice(0, LIST_LIMIT + 1 - exact.length)
      const found = await Promise.all(wanted.map((id) => ctx.db.get(id)))
      const all = [...exact, ...found.filter((c) => c !== null)]
      const onTag = await Promise.all(all.map((c) => tagged(c._id)))
      rows = all.filter((_, i) => onTag[i])
      truncated = scanFull || rows.length > LIST_LIMIT
    } else if (source) {
      const read = await scan(
        browseSource(ctx.db, source, includeArchived),
        async (batch) => {
          const live = batch.filter(fits)
          const onTag = await Promise.all(live.map((h) => tagged(h.contactId)))
          return live.filter((_, i) => onTag[i])
        },
        LIST_LIMIT + 1,
      )
      checked = read.read
      const found = await Promise.all(
        read.kept.map((h) => ctx.db.get(h.contactId)),
      )
      rows = found.filter((c) => c !== null)
      truncated = read.capped || rows.length > LIST_LIMIT
    } else if (tagId) {
      const read = await scan(
        ctx.db
          .query('contactTags')
          .withIndex('by_tenant_tag', (q) => q.eq('tagId', tagId)),
        async (batch) =>
          (await Promise.all(batch.map((r) => ctx.db.get(r.contactId)))).map(
            (c) => (c && fits(c) ? c : null),
          ),
        LIST_TAG_SCAN,
      )
      checked = read.read
      rows = read.kept.sort((a, b) => a.sortName.localeCompare(b.sortName))
      truncated = !read.exhausted || rows.length > LIST_LIMIT
    } else {
      rows = await browse(ctx.db, { kind, includeArchived }).take(
        LIST_LIMIT + 1,
      )
      truncated = rows.length > LIST_LIMIT
    }
    const shaped = await Promise.all(
      rows
        .slice(0, LIST_LIMIT)
        .map((c) => listRow(ctx.db, c, tagsOfRow(c._id))),
    )
    return {
      rows: shaped,
      truncated,
      tooBroad: truncated && shaped.length === 0,
      checked,
    }
  },
})

/**
 * The whole aggregate: root, children and counters, with every read that
 * doesn't depend on another run concurrently. The contact page assembles
 * the same view from the per-slice queries (`getRoot` …) instead. Advisory
 * warnings are `contactWarnings(view, sharedAddresses)`, computed by the
 * caller, so the shared-address lookup (two more read levels) stays off a
 * save's critical path.
 */
async function contactView(
  db: ScopedDatabaseReader,
  id: Id<'contacts'>,
  /** The contact, when the caller has read it: its code is read alongside. */
  known?: Doc<'contacts'>,
) {
  const emails = emailRows(db, id)
  const [contact, kids, tagList, identifierList, knownAcquisition] =
    await Promise.all([
      known ?? db.get(id),
      children(db, id, emails),
      tagsOf(db, id),
      identifiersOf(db, id),
      known && acquisitionOf(db, known.acquisitionCodeId),
    ])
  if (!contact) return null
  return {
    contact,
    ...kids,
    tags: tagList,
    identifiers: identifierList,
    acquisition:
      knownAcquisition !== undefined
        ? knownAcquisition
        : await acquisitionOf(db, contact.acquisitionCodeId),
  }
}

/**
 * The contact's acquisition code described (its three names, the full
 * code, whether it is archived), or null when uncoded. Names are read
 * live, so a renamed part shows its new name.
 */
async function acquisitionOf(
  db: ScopedDatabaseReader,
  codeId: Id<'sourceCodes'> | undefined,
) {
  return codeId ? describe(db, codeId) : null
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

/**
 * The contact page reads its contact one slice at a time, through the four
 * queries below (and `getAcquisition` when it carries a code); the SPA assembles `get`'s view from them. The client sees
 * a save once every query the save invalidated has re-run, so a save should
 * re-run only the slices whose rows it wrote. Every save bumps its slice's
 * counter on the root, so `getRoot` re-runs on all of them and reads
 * nothing else.
 */
export const getRoot = tenantQuery({
  args: { id: v.id('contacts') },
  handler: async (ctx, { id }) => ctx.db.get(id),
})

/** Emails, phones and addresses, primary first: methods and addresses saves. */
export const getChannels = tenantQuery({
  args: { id: v.id('contacts') },
  handler: async (ctx, { id }) => children(ctx.db, id, emailRows(ctx.db, id)),
})

/** The contact's tags with their names, alphabetical. */
export const getTags = tenantQuery({
  args: { id: v.id('contacts') },
  handler: async (ctx, { id }) => tagsOf(ctx.db, id),
})

/**
 * The contact's identifier rows, unnamed, so it reads one level: the SPA
 * names them (`nameIdentifiers`) from `listIdentifierTypes` with archived
 * types included, which is never truncated.
 */
export const getIdentifiers = tenantQuery({
  args: { id: v.id('contacts') },
  handler: async (ctx, { id }) => identifierRows(ctx.db, id),
})

/**
 * A code described (`get`'s `acquisition`), by the id the contact page
 * takes from `getRoot`'s `acquisitionCodeId`: it reads only the code's
 * three rows, so it re-runs on a rename or archive of that code, never on
 * a save of the contact. Null for an id that isn't a version of this
 * tenant.
 */
export const getAcquisition = tenantQuery({
  args: { codeId: v.id('sourceCodes') },
  handler: async (ctx, { codeId }) => acquisitionOf(ctx.db, codeId),
})

/** The whole view in one query: imports, tests, and `byClientKey`'s shape. */
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
    return contact && contactView(ctx.db, contact._id, contact)
  },
})

/** Revisions one `history` page reads at most (newest first). */
export const HISTORY_PAGE_LIMIT = 10

/**
 * History as *moments*: revisions from one action (sharing a command group)
 * collapse into a single entry listing the slices it touched. Newest first,
 * one page of HISTORY_PAGE_LIMIT revisions, so its cost on open doesn't
 * depend on how long the history is. The SPA fetches it rather than
 * subscribing (a subscribed page would re-run inside every save's wait),
 * again whenever the contact's root changes, keeping the newest page's
 * end with `endCursor` as a live subscription would: the page grows by one
 * read per revision saved meanwhile, and that keeps older pages contiguous.
 * A group can straddle a page boundary: the client joins adjacent moments
 * with the same `key` (`joinMoments`).
 */
export const history = tenantQuery({
  args: { id: v.id('contacts'), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { id, paginationOpts }) => {
    // `paginationOpts.id` only tells subscriptions apart; it is not a read
    // option.
    const { id: _subscription, ...opts } = paginationOpts
    const result = await ctx.db
      .query('revisions')
      .withIndex('by_tenant_entity', (q) =>
        q.eq('entity', 'contacts').eq('entityId', id),
      )
      .order('desc')
      .paginate({
        ...opts,
        numItems: Math.min(opts.numItems, HISTORY_PAGE_LIMIT),
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
