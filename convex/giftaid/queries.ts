/**
 * Reading Gift Aid declarations: the contact page's Gift Aid panel.
 */
import { v } from 'convex/values'
import { tenantQuery } from '../lib/tenancy'
import { chain } from './declarations'
import { currentOf } from './rules'
import { declarationWarnings } from './warnings'

/**
 * A contact's declarations, newest first by date made, each with its
 * warnings (none on a voided one: it never applied, so nothing to fix); and which one is current on `today` (the caller's date: a
 * query never reads the clock), if any. At most DECLARATION_LIMIT, which
 * the contract enforces, so nothing is cut off.
 */
export const byContact = tenantQuery({
  args: { contactId: v.id('contacts'), today: v.string() },
  handler: async (ctx, { contactId, today }) => {
    const declarations = await chain(ctx.db, contactId)
    const current = currentOf(declarations, today)
    return {
      declarations: declarations.reverse().map((d) => ({
        ...d,
        warnings: d.voidedAt === undefined ? declarationWarnings(d) : [],
      })),
      currentId: current?._id ?? null,
    }
  },
})
