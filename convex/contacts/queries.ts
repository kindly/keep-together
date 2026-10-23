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
} from './rules'
import { contactKind } from '../lib/appSchema'
import { matchesAll, parseSearch } from './search'
import { parseNumber } from './number'
import type { AlsoUsedBy } from './warnings'
import { groupsToRead, toMoments } from './history'
import { describe } from '../sources/code'
import { nameFieldValues, nameIdentifiers } from './view'
import type { IdentifierRow } from './view'
import { fieldsBySlot } from './fieldDefs'
import { optionIdsOf } from './fieldValues'
import { invalid, rejected } from '../lib/contracts'
import { slotFieldName } from '../lib/fieldSlots'
import type { FieldSlot, SlotFieldName } from '../lib/fieldSlots'

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

/**
 * The contact whose number `sequence` is, if any: an exact read of
 * `by_tenant_number`, never a prefix. Numbers are unique per tenant, so
 * the first row is the only one.
 */
async function contactWithNumber(
  db: ScopedDatabaseReader,
  sequence: number,
): Promise<Array<Doc<'contacts'>>> {
  const contact = await db
    .query('contacts')
    .withIndex('by_tenant_number', (q) => q.eq('number', sequence))
    .first()
  return contact ? [contact] : []
}

/** The most rows `list` returns, and `list` asks for a page. */
export const LIST_LIMIT = 100
/**
 * The most rows one `list` page shows. A page pinned to a range that has
 * grown past it comes back marked `SplitRequired`, with no rows, for the
 * client to split. Just over a page: each row shown costs about 0.8 ms on
 * a dev deployment (measured when it was its first email and its tags, two
 * index reads; now just the email), so a page that grew by more than a few
 * rows would break the 100 ms server rule (qc/README.md); its halves don't
 * (QC "Load more", 2026-10-23).
 */
export const LIST_PAGE_MAX_ROWS = LIST_LIMIT + 10
/**
 * The most `contactSearch` hits one search reads. Convex ranks rows that
 * match any term; those missing a term are dropped after, so it reads
 * more than it returns.
 */
export const LIST_SEARCH_SCAN = 2 * LIST_LIMIT
/**
 * The most rows a filter that the index can't hold (a kind under a source
 * filter, or a second field filter) reads looking for matches before it stops and says so.
 */
export const LIST_SCAN_CAP = 1000

/**
 * Read `rows` until `want` of them pass `keep` or LIST_SCAN_CAP have been
 * read. `keep` takes a batch, so its reads run concurrently; a batch is
 * the rows still wanted, so with nothing filtered out this reads `want`
 * rows, as `take(want)` would, plus one to see if any are left.
 * `exhausted`: every row was read; `capped`:
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
  // Stopped on the last row? One more index row says, so "may be more"
  // is never claimed of a list that is all here.
  if (!exhausted && (await it.next()).done) exhausted = true
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
 * The contacts list's field filter: one field's option, or `null` for
 * "not set". Several combine (all must hold): the first is the index range
 * while browsing, the rest are checked per row (g1q10).
 *
 * Known weakness (review L4, left as is): the range is the first filter
 * even when it is "not set", which usually matches most contacts. Then
 * "not set + one option" reads mostly rows the second filter drops: `list`
 * pages come back short and `search` may stop at LIST_SCAN_CAP
 * (`tooBroad`). Preferring a set value as the range would fix it; for now
 * the UI should put set values first.
 */
const fieldFilter = v.object({
  fieldId: v.id('contactFields'),
  optionId: v.union(v.id('contactFieldOptions'), v.null()),
})

/** A field filter resolved to the slot it reads; `undefined` = not set. */
type SlotFilter = {
  slot: SlotFieldName
  optionId: Id<'contactFieldOptions'> | undefined
}

/**
 * Field filters, checked and resolved to slots. The field must be this
 * tenant's and hold a slot, the option must be its own, and each field
 * appears once: anything else is refused, not silently matched against
 * nothing (another tenant's ids read as null through the scoped db).
 */
async function slotFilters(
  db: ScopedDatabaseReader,
  filters: Array<Infer<typeof fieldFilter>> | undefined,
): Promise<Array<SlotFilter>> {
  if (!filters?.length) return []
  if (new Set(filters.map((f) => f.fieldId)).size !== filters.length) {
    throw invalid([
      { field: 'fields', message: 'Filter each field at most once' },
    ])
  }
  return Promise.all(
    filters.map(async ({ fieldId, optionId }) => {
      const [field, option] = await Promise.all([
        db.get(fieldId),
        optionId ? db.get(optionId) : null,
      ])
      if (!field || field.slot === undefined) {
        throw rejected('unknown_field', 'That field does not exist')
      }
      if (optionId && option?.fieldId !== fieldId) {
        throw rejected(
          'unknown_option',
          `That option is not one of ${field.label}'s`,
        )
      }
      return {
        slot: slotFieldName(field.slot as FieldSlot),
        optionId: optionId ?? undefined,
      }
    }),
  )
}

/** Whether a contact or its `contactSearch` row passes every field filter. */
const matchesFields =
  (filters: Array<SlotFilter>) =>
  (row: Partial<Record<SlotFieldName, Id<'contactFieldOptions'>>>) =>
    filters.every((f) => row[f.slot] === f.optionId)

/**
 * Field filters the search index holds; the rest are checked per row. A
 * search query takes at most 8 filters, and tenant, archived, kind and
 * source can take 4 of them.
 */
const SEARCH_INDEX_FIELD_FILTERS = 4

/**
 * `browse` under a field filter: `contactSearch` rows in name order, the
 * field's value (and archived) in the range. Other filters are the
 * caller's, per row.
 */
function browseField(
  db: ScopedDatabaseReader,
  filter: SlotFilter,
  includeArchived?: boolean,
) {
  const rows = db.query('contactSearch')
  const { slot, optionId } = filter
  return includeArchived
    ? rows.withIndex(`by_tenant_${slot}_sort`, (q) => q.eq(slot, optionId))
    : rows.withIndex(`by_tenant_${slot}_archived_sort`, (q) =>
        q.eq(slot, optionId).eq('archived', false),
      )
}

/**
 * The contacts a browse (no search text) shows, in name order,
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

/**
 * One contacts-list row: a contact with its number, its first email and its
 * field values (option ids, in slot order; labels come from the field
 * definitions, so a rename shows without a write here).
 */
async function listRow(db: ScopedDatabaseReader, c: Doc<'contacts'>) {
  const email = await db
    .query('contactEmails')
    .withIndex('by_tenant_contact', (q) => q.eq('contactId', c._id))
    .first()
  return {
    _id: c._id,
    kind: c.kind,
    displayName: c.displayName,
    sortName: c.sortName,
    // The contact number's sequence (formatNumber shows it); null until the
    // backfill reaches a contact created before numbers.
    number: c.number ?? null,
    archived: c.archived,
    email: email?.address ?? null,
    fieldOptionIds: optionIdsOf(c),
  }
}

/**
 * The contacts list while browsing (no search text), a page at a
 * time in name order, at most LIST_LIMIT rows a page; archived hidden
 * unless asked, optionally one kind and one part of a source code
 * (`source`: a category, detail or version), and any number of dropdown
 * field values (`fields`, each an option or "not set"). Each row carries
 * its field values.
 *
 * Archived and kind sit in the `contacts` index range, and archived in a
 * source filter's `contactSearch` range, so those pages are full. A kind
 * under a source is checked per row, so such a page can be short, or even
 * empty, while more follow: only `isDone` ends the list, and the UI says
 * "none" only then. With no source, the first field filter is the range
 * (its `contactSearch` index pair, archived included); a kind and the
 * other field filters are checked per row, as is every field filter under
 * a source. Search text goes to `search`.
 */
export const list = tenantQuery({
  args: {
    includeArchived: v.optional(v.boolean()),
    kind: v.optional(contactKind),
    source: v.optional(sourceFilter),
    fields: v.optional(v.array(fieldFilter)),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (
    ctx,
    { includeArchived, kind, source, fields, paginationOpts },
  ) => {
    const byField = await slotFilters(ctx.db, fields)
    const opts = {
      ...paginationOpts,
      numItems: Math.min(paginationOpts.numItems, LIST_LIMIT),
      // Asks a page pinned with `endCursor` to stop short past this, with
      // `SplitRequired` and a `splitCursor`. convex-test does; the real
      // backend reads the whole pinned range regardless, so `tooBig` below
      // makes the same answer of an oversized page.
      maximumRowsRead: LIST_PAGE_MAX_ROWS,
    }
    let result: { page: Array<Doc<'contacts'>> } & Omit<
      PaginationResult<unknown>,
      'page'
    >
    if (source || byField.length) {
      const hits = await (
        source
          ? browseSource(ctx.db, source, includeArchived)
          : browseField(ctx.db, byField[0], includeArchived)
      ).paginate(opts)
      if (tooBig(hits)) return toSplit(hits)
      const fieldsMatch = matchesFields(byField)
      const found = await Promise.all(
        hits.page
          .filter((h) => (!kind || h.kind === kind) && fieldsMatch(h))
          .map((h) => ctx.db.get(h.contactId)),
      )
      result = { ...hits, page: found.filter((c) => c !== null) }
    } else {
      result = await browse(ctx.db, { kind, includeArchived }).paginate(opts)
      if (tooBig(result)) return toSplit(result)
    }
    return {
      ...result,
      page: await Promise.all(result.page.map((c) => listRow(ctx.db, c))),
    }
  },
})

/**
 * A page to split rather than show: cut short (`SplitRequired`), or a
 * pinned range that has grown past LIST_PAGE_MAX_ROWS, which the real
 * backend returns in full. Either way only with a `splitCursor` to split
 * at; without one the page is shown as it is.
 */
export function tooBig(
  p: Omit<PaginationResult<unknown>, 'page'> & { page: Array<unknown> },
) {
  return (
    !!p.splitCursor &&
    (p.pageStatus === 'SplitRequired' || p.page.length > LIST_PAGE_MAX_ROWS)
  )
}

/**
 * Logged by a `list` call that read a grown pinned range in full: the one
 * call the QC server rule excepts (qc/budgets.ts SERVER_EXCEPTIONS, human
 * 2026-10-23), found by this line in the call's own log.
 */
export const GROWN_PAGE_LOG = 'contacts list: grown page read in full'

/**
 * A page the client splits at its `splitCursor` (paged-list.ts) and never
 * shows: no rows, so none is shaped (two reads each, ~0.8 ms a row). Its
 * range is still read in full when the backend returned it so.
 */
export function toSplit(
  p: Omit<PaginationResult<unknown>, 'page'> & { page: Array<unknown> },
): Omit<PaginationResult<unknown>, 'page'> & { page: Array<never> } {
  if (p.page.length > LIST_PAGE_MAX_ROWS) {
    console.log(`${GROWN_PAGE_LOG}: ${p.page.length} rows`)
  }
  return { ...p, page: [], pageStatus: 'SplitRequired' }
}

/**
 * The contacts list with search text: one window of at most LIST_LIMIT
 * rows, not paged (without text, the same window over the filters; the
 * SPA browses those with `list`). Optionally also of one kind and under
 * one part of a source code; archived hidden unless asked. Rows as `list`.
 *
 * A search finds a contact by anything in its `contactSearch` text (names,
 * emails and their parts, phones, postcodes, street, town, identifiers):
 * every word must match, the last as a prefix. Exact matches come
 * first: a contact number (`parseNumber`: the written six digits or the
 * five-digit sequence), an email address, an identifier, then a phone
 * number (normalised), then the rest in Convex's relevance order. A
 * six-digit entry is read both ways, as a number and as a phone. That order
 * can't be resumed from a cursor, hence one window. The search index holds
 * the kind, archived and source filters and up to
 * SEARCH_INDEX_FIELD_FILTERS field values; "not set" and any
 * further field filters check the LIST_SEARCH_SCAN hits read.
 *
 * Without search text, the index holds every filter it can (see `browse`
 * `browseSource` and `browseField`); what it can't, a kind under a
 * source or field, or a second field filter, is
 * checked row by row as the read goes on (`scan`) until enough match or
 * LIST_SCAN_CAP rows have been read.
 *
 * `numberMatch` is the row its contact number found (always the first),
 * for a "contact no." badge; a picker offers it first, highlighted, and
 * never picks it by itself (g2q5). `invalidNumber` is the hint for six
 * digits whose check digit is wrong; the other matches still show.
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
    kind: v.optional(contactKind),
    source: v.optional(sourceFilter),
    fields: v.optional(v.array(fieldFilter)),
  },
  handler: async (
    ctx,
    { search: text, includeArchived, kind, source, fields },
  ) => {
    const term = text?.trim()
    const byField = await slotFilters(ctx.db, fields)
    const fieldsMatch = matchesFields(byField)
    // The set values the search index can hold; "not set" is checked per
    // row with the rest.
    const indexed = byField
      .filter((f) => f.optionId !== undefined)
      .slice(0, SEARCH_INDEX_FIELD_FILTERS)
    // Every contact in `rows` passes every filter, in display order.
    let rows: Array<Doc<'contacts'>>
    // More contacts may match than `rows` holds.
    let truncated: boolean
    // Rows the capped read looked at, for the UI's "none in the first N".
    let checked = 0
    let numberMatch: Id<'contacts'> | null = null
    let invalidNumber: string | null = null
    const fits = (
      c: {
        kind: Doc<'contacts'>['kind']
        archived: boolean
      } & Partial<Record<SlotFieldName, Id<'contactFieldOptions'>>>,
    ) =>
      (!kind || c.kind === kind) &&
      (includeArchived || !c.archived) &&
      fieldsMatch(c)
    if (term) {
      const { terms, phone } = parseSearch(term)
      const number = parseNumber(term)
      if (number && 'invalid' in number) invalidNumber = number.hint
      const [byNumber, byEmail, byIdentifier, hits] = await Promise.all([
        number && 'sequence' in number
          ? contactWithNumber(ctx.db, number.sequence)
          : Promise.resolve([]),
        contactsWithEmail(ctx.db, term).then((r) => r.contacts),
        contactsWithIdentifier(ctx.db, term),
        terms.length
          ? ctx.db
              .query('contactSearch')
              .withSearchIndex('search_text', (q) => {
                const s = q.search('text', terms.join(' '))
                const live = includeArchived ? s : s.eq('archived', false)
                const ofKind = kind ? live.eq('kind', kind) : live
                let filtered = source
                  ? ofKind.eq(SOURCE_FIELD[source.level], source.id)
                  : ofKind
                for (const f of indexed)
                  filtered = filtered.eq(f.slot, f.optionId)
                return filtered
              })
              .take(LIST_SEARCH_SCAN)
          : Promise.resolve([]),
      ])
      // Relevance order can't be resumed past the window with the phone
      // ranking intact, so the window is fixed and a full one that shows
      // nothing is `tooBroad`.
      const scanFull = hits.length === LIST_SEARCH_SCAN
      checked = hits.length
      const matched = hits.filter(
        (h) => matchesAll(h.text, terms) && fieldsMatch(h),
      )
      const byPhone = phone
        ? matched.filter((h) => h.phones.includes(phone))
        : []
      // Exact matches first, each contact once; then read only as many
      // full-text hits as can still be shown.
      const seen = new Set<Id<'contacts'>>()
      const once = (id: Id<'contacts'>) =>
        !seen.has(id) && Boolean(seen.add(id))
      const inSource = source ? underSource(ctx.db, source) : null
      const candidates = [...byNumber, ...byEmail, ...byIdentifier].filter(fits)
      const sourced = inSource
        ? await Promise.all(candidates.map(inSource))
        : null
      const exact = candidates.filter(
        (c, i) => (!sourced || sourced[i]) && once(c._id),
      )
      if (byNumber.length && exact[0]?._id === byNumber[0]._id) {
        numberMatch = byNumber[0]._id
      }
      const rest = [...byPhone, ...matched].map((h) => h.contactId).filter(once)
      const wanted = rest.slice(0, LIST_LIMIT + 1 - exact.length)
      const found = await Promise.all(wanted.map((id) => ctx.db.get(id)))
      rows = [...exact, ...found.filter((c) => c !== null)]
      truncated = scanFull || rows.length > LIST_LIMIT
    } else if (source || byField.length) {
      const read = await scan(
        source
          ? browseSource(ctx.db, source, includeArchived)
          : browseField(ctx.db, byField[0], includeArchived),
        async (batch) => batch.filter(fits),
        LIST_LIMIT + 1,
      )
      checked = read.read
      const found = await Promise.all(
        read.kept.map((h) => ctx.db.get(h.contactId)),
      )
      rows = found.filter((c) => c !== null)
      truncated = read.capped || rows.length > LIST_LIMIT
    } else {
      rows = await browse(ctx.db, { kind, includeArchived }).take(
        LIST_LIMIT + 1,
      )
      truncated = rows.length > LIST_LIMIT
    }
    const shaped = await Promise.all(
      rows.slice(0, LIST_LIMIT).map((c) => listRow(ctx.db, c)),
    )
    return {
      rows: shaped,
      truncated,
      tooBroad: truncated && shaped.length === 0,
      checked,
      numberMatch,
      invalidNumber,
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
  const [contact, kids, identifierList, knownAcquisition, bySlot] =
    await Promise.all([
      known ?? db.get(id),
      children(db, id, emails),
      identifiersOf(db, id),
      known && acquisitionOf(db, known.acquisitionCodeId),
      fieldsBySlot(db),
    ])
  if (!contact) return null
  const optionIds = optionIdsOf(contact)
  const [acquisition, options] = await Promise.all([
    knownAcquisition !== undefined
      ? knownAcquisition
      : acquisitionOf(db, contact.acquisitionCodeId),
    Promise.all(optionIds.map((o) => db.get(o))),
  ])
  const optionById = new Map(optionIds.map((o, i) => [o, options[i]]))
  return {
    contact,
    ...kids,
    identifiers: identifierList,
    acquisition,
    fields: nameFieldValues(
      contact,
      (slot) => bySlot.get(slot),
      (o) => optionById.get(o),
    ),
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
 * The contact page reads its contact one slice at a time, through the three
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
