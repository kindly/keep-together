/**
 * Reading source codes: the Settings tree, the picker, and one code by its
 * version id. Each is one pass over the tenant's parts (code.ts).
 */
import { v } from 'convex/values'
import { tenantQuery } from '../lib/tenancy'
import { describe as describeCode, pickerEntries, resolveAll } from './code'
import type { ResolvedPart } from './code'
import { codeMatches, pickerOrder } from './rules'

/**
 * Every part in tree order, archived ones included, for the Settings tab:
 * its full code, whether it shows in the picker (`visible`: it and every
 * part above it active), `used` (delete or only archive) and the counter
 * a save needs.
 */
export const tree = tenantQuery({
  args: {},
  handler: async (ctx) =>
    (await resolveAll(ctx.db)).map((p) => ({
      _id: p._id,
      level: p.level,
      parentId: p.parentId,
      name: p.name,
      code: p.code,
      description: p.description,
      startDate: p.startDate,
      endDate: p.endDate,
      isActive: p.isActive,
      visible: p.visible,
      used: p.used,
      saveVersion: p.saveVersion,
    })),
})

/**
 * Every part in tree order with only what the contacts list's source
 * filter shows: id, level, parent, name, archived or not. Archived parts
 * are included (contacts keep codes archived since). Slimmer than `tree`,
 * which carries Settings' editing fields to every open list page.
 */
export const filterOptions = tenantQuery({
  args: {},
  handler: async (ctx) =>
    (await resolveAll(ctx.db)).map((p) => ({
      _id: p._id,
      level: p.level,
      parentId: p.parentId,
      name: p.name,
      isActive: p.isActive,
    })),
})

/** The most codes one picker call returns. */
export const PICKER_LIMIT = 50

/**
 * Assignable codes matching `search` anywhere in the full code, any case:
 * versions only, none archived or under an archived parent. In date first,
 * then not started, then ended (dates guide, never block), by code within
 * each. `today` (YYYY-MM-DD, the caller's date) is an argument because a
 * query never reads the clock.
 */
export const picker = tenantQuery({
  args: { today: v.string(), search: v.optional(v.string()) },
  handler: async (ctx, { today, search }) =>
    pickerResult(await resolveAll(ctx.db), today, search ?? ''),
})

/** `picker`'s answer from the resolved parts: no reads of its own. */
export function pickerResult(
  parts: Array<ResolvedPart>,
  today: string,
  search: string,
) {
  const matches = pickerEntries(parts, today)
    .filter((e) => codeMatches(e.code, search))
    .sort(pickerOrder)
  return {
    codes: matches.slice(0, PICKER_LIMIT),
    truncated: matches.length > PICKER_LIMIT,
  }
}

/** One code by its version id (null: not a version of this tenant). */
export const describe = tenantQuery({
  args: { id: v.id('sourceCodes') },
  handler: async (ctx, { id }) => describeCode(ctx.db, id),
})
