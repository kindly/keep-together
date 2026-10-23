/**
 * Gift reads: the Donations menu's recent gifts, a contact's gifts panel,
 * one gift, and its history. Viewers may read them all.
 */
import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import { tenantQuery } from '../lib/tenancy'
import type { ScopedDatabaseReader } from '../lib/tenancy'
import { groupsToRead, toMoments } from '../contacts/history'
import { describe } from '../sources/code'
import type { RecentGift } from './types'

/** Gifts in "my recent gifts" (the menu and the group home page). */
export const RECENT_LIMIT = 10

/**
 * The caller's last RECENT_LIMIT gifts, newest entered first, void ones
 * included (marked by `status`). Only gifts the caller entered.
 */
export const myRecent = tenantQuery({
  args: {},
  handler: async (ctx): Promise<Array<RecentGift>> => {
    // Always set for a member; null would otherwise match system gifts.
    const userId = ctx.userId
    if (!userId) return []
    const gifts = await ctx.db
      .query('contributions')
      .withIndex('by_tenant_enteredBy', (q) => q.eq('enteredBy', userId))
      .order('desc')
      .take(RECENT_LIMIT)
    const contacts = await Promise.all(
      gifts.map((g) => ctx.db.get(g.contactId)),
    )
    return gifts.map((g, i) => ({
      _id: g._id,
      _creationTime: g._creationTime,
      contactId: g.contactId,
      contactName: contacts[i]?.displayName ?? '',
      amount: g.amount,
      receivedOn: g.receivedOn,
      method: g.method,
      status: g.status,
    }))
  },
})

/**
 * A code lookup for one query: each code is read once however many rows
 * share it (`describe` is a chain of reads per call).
 */
function codeReader(db: ScopedDatabaseReader) {
  const codes = new Map<Id<'sourceCodes'>, Promise<string | null>>()
  return (id: Id<'sourceCodes'>) => {
    let code = codes.get(id)
    if (!code) {
      code = describe(db, id).then((d) => d?.code ?? null)
      codes.set(id, code)
    }
    return code
  }
}

/** Each allocation with its code as it reads now (null: not this tenant's). */
async function describeAllocations(
  codeOf: ReturnType<typeof codeReader>,
  gift: Doc<'contributions'>,
) {
  return Promise.all(
    gift.allocations.map(async (a) => ({
      ...a,
      code: await codeOf(a.sourceCodeId),
    })),
  )
}

/** The most gifts one `byContact` page holds. */
export const BY_CONTACT_LIMIT = 50

/**
 * A contact's gifts, newest date first, a page at a time like the contacts
 * list (`numItems` capped; a page pinned with `endCursor` stops short with
 * `SplitRequired` past twice that, for the client to split). Each row
 * carries its codes as they read now.
 */
export const byContact = tenantQuery({
  args: {
    contactId: v.id('contacts'),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { contactId, paginationOpts }) => {
    const result = await ctx.db
      .query('contributions')
      .withIndex('by_tenant_contact_receivedOn', (q) =>
        q.eq('contactId', contactId),
      )
      .order('desc')
      .paginate({
        ...paginationOpts,
        numItems: Math.min(paginationOpts.numItems, BY_CONTACT_LIMIT),
        maximumRowsRead: 2 * BY_CONTACT_LIMIT,
      })
    const codeOf = codeReader(ctx.db)
    return {
      ...result,
      page: await Promise.all(
        result.page.map(async (g) => ({
          ...g,
          allocations: await describeAllocations(codeOf, g),
        })),
      ),
    }
  },
})

/**
 * One gift for its page: the gift, its donor's name and kind, and each
 * allocation's code. Null for a missing or another tenant's id. Warnings
 * come from `giftWarnings(gift, today)` in the SPA (a query can't read the
 * clock).
 */
export const get = tenantQuery({
  args: { id: v.id('contributions') },
  handler: async (ctx, { id }) => {
    const gift = await ctx.db.get(id)
    if (!gift) return null
    const [contact, allocations] = await Promise.all([
      ctx.db.get(gift.contactId),
      describeAllocations(codeReader(ctx.db), gift),
    ])
    return {
      ...gift,
      allocations,
      contact: contact && {
        _id: contact._id,
        displayName: contact.displayName,
        kind: contact.kind,
      },
    }
  },
})

/** Revisions one `history` page reads at most (newest first). */
export const HISTORY_PAGE_LIMIT = 10

/**
 * A gift's history as moments, like the contact's (`contacts/queries:
 * history`): revisions of one action collapse into one entry naming the
 * slices (`gift`, `status`). Newest first, a page at a time; the client
 * joins a group cut by a page boundary (`joinMoments`).
 */
export const history = tenantQuery({
  args: { id: v.id('contributions'), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { id, paginationOpts }) => {
    // `paginationOpts.id` only tells subscriptions apart; not a read option.
    const { id: _subscription, ...opts } = paginationOpts
    const result = await ctx.db
      .query('revisions')
      .withIndex('by_tenant_entity', (q) =>
        q.eq('entity', 'contributions').eq('entityId', id),
      )
      .order('desc')
      .paginate({
        ...opts,
        numItems: Math.min(opts.numItems, HISTORY_PAGE_LIMIT),
      })
    const groupNames = new Map(
      await Promise.all(
        groupsToRead(result.page).map(
          async (g) => [g, (await ctx.db.get(g))?.name] as const,
        ),
      ),
    )
    return { ...result, page: toMoments(result.page, groupNames) }
  },
})
