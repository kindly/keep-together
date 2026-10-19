/**
 * Source codes (plan: factory/plans/source-codes.sv). One `sourceCodes`
 * row per part: a category, a detail under it, a version under that. A
 * version's id IS the source code: contacts and gifts store that id, and
 * everything else is derived from it here.
 *
 * The full code (`Street-Wesser-001`) is never stored: a rename at any
 * time would otherwise rewrite every row under the part. `describe`
 * joins it from three reads; the tree and the picker join every code in
 * one in-memory pass over the tenant's rows (at most SOURCE_CODE_LIMIT).
 *
 * Other modules use `describe` and `markUsed`, never the table.
 */
import { ConvexError, v } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import { defineContract, invalid, registry, rejected } from '../lib/contracts'
import type { ScopedDatabaseReader, ScopedDatabaseWriter } from '../lib/tenancy'
import { validate } from 'convex-helpers/validators'
import {
  SOURCE_CODE_LIMIT,
  childLevel,
  dateStatus,
  effectiveDates,
  joinCode,
  normaliseSourceName,
  prepareSourceCode,
} from './rules'
import type { DateStatus } from './rules'
import { sourceCodeCreateFields, sourceCodeFields } from './validators'

/**
 * A part of a source code: name, description, dates, archived or not.
 * Create takes the parent (`createWith`), which fixes the level for good.
 * Names are unique among siblings case-insensitively and carry no hyphen,
 * so a full code is unique per tenant. Only details and versions have
 * dates. `used` is system-owned (`markUsed`): created false, never touched
 * here, so every save and restore preserves it.
 *
 * Creating a detail also creates its first version: that is the create
 * mutation's command group (`createPart`), not this apply, which writes
 * only its own row.
 */
export const code = defineContract({
  name: 'sources.code',
  entity: 'sourceCodes',
  version: 1,
  managesList: 'sourceCodes',
  counter: 'saveVersion',
  fields: sourceCodeFields,
  prepare: prepareSourceCode,
  apply: async (ctx, p, root, command) => {
    let parentId: Id<'sourceCodes'> | undefined
    let level: Doc<'sourceCodes'>['level']
    if (root) {
      parentId = root.parentId
      level = root.level
    } else {
      const createWith = command.createWith ?? {}
      validate(v.object(sourceCodeCreateFields), createWith, { throw: true })
      parentId = (createWith as { parentId?: Id<'sourceCodes'> }).parentId
      // Another tenant's id reads as null through the scoped db.
      const parent = parentId ? await ctx.db.get(parentId) : null
      if (parentId && !parent) {
        throw rejected('unknown_parent', 'The parent code must exist')
      }
      const under = childLevel(parent?.level ?? null)
      if (!under) {
        throw rejected('too_deep', 'A version has no parts under it')
      }
      level = under
    }
    if (level === 'category' && (p.startDate || p.endDate)) {
      throw invalid([
        { field: 'startDate', message: 'Only details and versions have dates' },
      ])
    }
    const nameNormalized = normaliseSourceName(p.name)
    const clash = await ctx.db
      .query('sourceCodes')
      .withIndex('by_tenant_parent', (q) =>
        q.eq('parentId', parentId).eq('nameNormalized', nameNormalized),
      )
      .first()
    if (clash && clash._id !== root?._id) {
      throw rejected(
        'duplicate_source_name',
        `${clash.name} already exists here`,
      )
    }
    const fields = {
      name: p.name,
      nameNormalized,
      description: p.description,
      startDate: p.startDate,
      endDate: p.endDate,
      isActive: p.isActive,
    }
    if (root) {
      await ctx.db.patch('sourceCodes', root._id, fields)
      return root._id
    }
    const held = await ctx.db
      .query('sourceCodes')
      .withIndex('by_tenant_parent')
      .take(SOURCE_CODE_LIMIT)
    if (held.length >= SOURCE_CODE_LIMIT) {
      throw rejected(
        'source_code_limit',
        `A group can have at most ${SOURCE_CODE_LIMIT} source code parts, archived ones included`,
      )
    }
    return ctx.db.insert('sourceCodes', {
      ...fields,
      level,
      parentId,
      used: false,
      saveVersion: 0,
    })
  },
})

/** Everything restore needs to know about this module. */
export const sourceContracts = registry(code)

// ── one code, by its version id ────────────────────────────────────────────

export type SourceCodeDescription = {
  /** The full code, names joined by hyphens, e.g. `Street-Wesser-001`. */
  code: string
  versionId: Id<'sourceCodes'>
  detailId: Id<'sourceCodes'>
  categoryId: Id<'sourceCodes'>
  versionName: string
  detailName: string
  categoryName: string
  /** False if the version or either parent is archived. */
  isActive: boolean
  /**
   * The version's dates, each bound falling back to its detail's: what the
   * picker's "ended" / "not started" uses.
   */
  startDate?: string
  endDate?: string
}

/** A version and its two parents, or null if `id` isn't this tenant's version. */
async function chain(
  db: ScopedDatabaseReader,
  id: Id<'sourceCodes'>,
): Promise<
  [Doc<'sourceCodes'>, Doc<'sourceCodes'>, Doc<'sourceCodes'>] | null
> {
  const version = await db.get(id)
  if (!version || version.level !== 'version' || !version.parentId) return null
  const detail = await db.get(version.parentId)
  if (!detail?.parentId) return null
  const category = await db.get(detail.parentId)
  return category ? [version, detail, category] : null
}

/**
 * The code a version id stands for, read at call time (renames show
 * everywhere at once). Null for a missing or other tenant's id, or a part
 * that isn't a version. Three reads.
 */
export async function describe(
  db: ScopedDatabaseReader,
  versionId: Id<'sourceCodes'>,
): Promise<SourceCodeDescription | null> {
  const parts = await chain(db, versionId)
  if (!parts) return null
  const [version, detail, category] = parts
  return {
    code: joinCode([category.name, detail.name, version.name]),
    versionId: version._id,
    detailId: detail._id,
    categoryId: category._id,
    versionName: version.name,
    detailName: detail.name,
    categoryName: category.name,
    isActive: version.isActive && detail.isActive && category.isActive,
    ...effectiveDates(version, detail),
  }
}

/**
 * Check a code can be assigned and set its `used` marker: on the version,
 * its detail and its category, each only if not yet set (after the first
 * use, a read-only check, so a popular code is no write hot spot). Never
 * cleared. Runs in the caller's transaction; idempotent.
 *
 * `used` is system-owned, written here and nowhere else: no contract, no
 * revision, no list-manager check (staff assigning a code needn't manage
 * the list).
 *
 * Throws `invalid` (field `sourceCode`) unless `versionId` is a version of
 * this tenant that is not archived and not under an archived parent. Out
 * of date is fine: dates guide, never block. `allowArchived` is for
 * restore, which may put back a code archived since (the identifiers rule).
 */
export async function markUsed(
  ctx: { db: ScopedDatabaseWriter },
  versionId: Id<'sourceCodes'>,
  opts: { allowArchived?: boolean } = {},
): Promise<void> {
  const parts = await chain(ctx.db, versionId)
  if (!parts) {
    throw invalid([
      { field: 'sourceCode', message: 'Pick a full source code (a version)' },
    ])
  }
  if (!opts.allowArchived && parts.some((p) => !p.isActive)) {
    throw invalid([
      { field: 'sourceCode', message: 'That source code is archived' },
    ])
  }
  for (const part of parts) {
    if (!part.used) await ctx.db.patch('sourceCodes', part._id, { used: true })
  }
}

// ── every code, one pass ───────────────────────────────────────────────────

export type ResolvedPart = Doc<'sourceCodes'> & {
  /** The names from the category down to this part, joined. */
  code: string
  /** False if this part or anything above it is archived. */
  visible: boolean
  /** Its category; its detail (itself, for those levels). */
  categoryId: Id<'sourceCodes'>
  detailId?: Id<'sourceCodes'>
}

/**
 * The tenant's parts in tree order (each category by name, then its
 * details by name, each followed by its versions by name), with full
 * codes and visibility resolved. One indexed read of at most
 * SOURCE_CODE_LIMIT rows.
 */
export async function resolveAll(
  db: ScopedDatabaseReader,
): Promise<Array<ResolvedPart>> {
  const rows = await db
    .query('sourceCodes')
    .withIndex('by_tenant_parent')
    .take(SOURCE_CODE_LIMIT)
  const children = new Map<string, Array<Doc<'sourceCodes'>>>()
  for (const row of rows) {
    const key = row.parentId ?? ''
    const list = children.get(key) ?? []
    list.push(row)
    children.set(key, list)
  }
  const out: Array<ResolvedPart> = []
  const walk = (
    parentKey: string,
    above: {
      names: Array<string>
      visible: boolean
      ids: Array<Id<'sourceCodes'>>
    },
  ) => {
    const list = (children.get(parentKey) ?? []).sort((a, b) =>
      a.nameNormalized.localeCompare(b.nameNormalized),
    )
    for (const row of list) {
      const names = [...above.names, row.name]
      const visible = above.visible && row.isActive
      const ids = [...above.ids, row._id]
      out.push({
        ...row,
        code: joinCode(names),
        visible,
        categoryId: ids[0],
        detailId: ids[1],
      })
      walk(row._id, { names, visible, ids })
    }
  }
  walk('', { names: [], visible: true, ids: [] })
  return out
}

export type PickerEntry = {
  versionId: Id<'sourceCodes'>
  code: string
  description?: string
  status: DateStatus
  startDate?: string
  endDate?: string
}

/** The assignable codes: visible versions, with their date status on `today`. */
export function pickerEntries(
  parts: Array<ResolvedPart>,
  today: string,
): Array<PickerEntry> {
  const byId = new Map(parts.map((p) => [p._id as string, p]))
  return parts
    .filter((p) => p.level === 'version' && p.visible)
    .map((p) => {
      const detail = byId.get(p.parentId!)!
      const dates = effectiveDates(p, detail)
      return {
        versionId: p._id,
        code: p.code,
        description: p.description ?? detail.description,
        status: dateStatus(dates, today),
        ...dates,
      }
    })
}

// ── delete ─────────────────────────────────────────────────────────────────

/**
 * Delete a part that has never been used, with everything under it. A
 * `used` marker anywhere below is also on this part (`markUsed` marks
 * both parents), so an unmarked part has only unmarked parts under it;
 * the check covers them anyway. Once used, a part can only be archived:
 * history still names it.
 *
 * Not a contract (there is no root left to carry a counter): the one
 * other writer of this table. Nothing references an unused part, so
 * nothing dangles; its revisions stay as history. The caller checks the
 * list-manager rule, which a contract would have.
 */
export async function deletePart(
  ctx: { db: ScopedDatabaseWriter },
  id: Id<'sourceCodes'>,
  expected: number,
): Promise<{ deleted: number }> {
  const part = await ctx.db.get(id)
  if (!part) throw new ConvexError({ kind: 'not_found' as const })
  if (part.saveVersion !== expected) {
    throw new ConvexError({
      kind: 'stale' as const,
      contract: code.name,
      current: part.saveVersion,
    })
  }
  // At most two levels below: a category's details, then their versions.
  const doomed = [part]
  let level = [part]
  while (level.length) {
    const below = await Promise.all(
      level.map((p) =>
        ctx.db
          .query('sourceCodes')
          .withIndex('by_tenant_parent', (q) => q.eq('parentId', p._id))
          .collect(),
      ),
    )
    level = below.flat()
    doomed.push(...level)
  }
  if (doomed.some((p) => p.used)) {
    throw rejected(
      'used',
      'This code has been used, so it can only be archived',
    )
  }
  for (const p of doomed.reverse()) await ctx.db.delete('sourceCodes', p._id)
  return { deleted: doomed.length }
}
