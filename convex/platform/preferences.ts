/**
 * Per-tenant preferences: plain, non-secret switches an admin sets on the
 * Settings page (secrets go in `tenantSettings`, encrypted). One row per
 * tenant at most, created by the first save; no row means every default.
 *
 * `staffCanManageTags` and `staffCanManageIdentifierTypes` (both default
 * off, independent): whether staff, as well as admins, may create, rename
 * and archive / reactivate the tenant's tags, and its identifier types
 * (the rule is in lib/lists). Each is its own contract with its own
 * counter, so switching one never conflicts with the other. Putting tags
 * and identifiers on contacts is ordinary staff editing either way;
 * viewers never write.
 */
import { ConvexError, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { defineContract, executeContract } from '../lib/contracts'
import type { ContractCtx } from '../lib/contracts'
import { tenantPreferences } from '../lib/lists'
import type { ScopedDatabaseWriter } from '../lib/tenancy'
import { tenantMutation } from '../lib/tenancy'

/** A new row: every switch at its default, every counter at 0. */
const DEFAULTS = {
  staffCanManageTags: false,
  tagsVersion: 0,
  staffCanManageIdentifierTypes: false,
  identifierTypesVersion: 0,
}

export const tagsFields = { staffCanManageTags: v.boolean() }

export const tags = defineContract({
  name: 'tenantPreferences.tags',
  entity: 'tenantPreferences',
  version: 1,
  counter: 'tagsVersion',
  fields: tagsFields,
  apply: async (ctx, p, root) => {
    if (!root) return ctx.db.insert('tenantPreferences', { ...DEFAULTS, ...p })
    await ctx.db.patch('tenantPreferences', root._id, p)
    return root._id
  },
})

export const identifierTypesFields = {
  staffCanManageIdentifierTypes: v.boolean(),
}

export const identifierTypes = defineContract({
  name: 'tenantPreferences.identifierTypes',
  entity: 'tenantPreferences',
  version: 1,
  counter: 'identifierTypesVersion',
  fields: identifierTypesFields,
  apply: async (ctx, p, root) => {
    if (!root) return ctx.db.insert('tenantPreferences', { ...DEFAULTS, ...p })
    await ctx.db.patch('tenantPreferences', root._id, p)
    return root._id
  },
})

/**
 * The tenant's preferences row, for `platform/tenants:mine`, which reads
 * across the caller's tenants with the raw db.
 */
export async function preferencesFor(
  ctx: QueryCtx,
  tenantId: Doc<'tenants'>['_id'],
) {
  return ctx.db
    .query('tenantPreferences')
    .withIndex('by_tenant', (q) => q.eq('tenantId', tenantId))
    .unique()
}

/**
 * Two-phase split, step (a): copy a row's old single switch
 * (`staffCanManageLists`, which covered both lists) into both new ones,
 * each through its contract with source `system` so the copy has a
 * revision, then unset the old fields. Each counter starts at 0 ("row
 * exists, no revision of this slice yet"), as a create leaves the other
 * slice's. False on a row with nothing to split. Run by
 * platform/migrations:splitStaffCanManageLists, and by a save that reaches
 * a row before the migration does. Goes with the tightening.
 */
export async function splitStaffCanManageLists(
  db: ScopedDatabaseWriter,
  row: Doc<'tenantPreferences'>,
): Promise<boolean> {
  if (row.staffCanManageLists === undefined && row.listsVersion === undefined)
    return false
  const on = row.staffCanManageLists ?? false
  const ctx: ContractCtx = { db, userId: null, role: null }
  const opts = { entityId: row._id, expected: 0, source: 'system' as const }
  if (row.tagsVersion === undefined) {
    await db.patch('tenantPreferences', row._id, { tagsVersion: 0 })
    await executeContract(ctx, tags, { staffCanManageTags: on }, opts)
  }
  if (row.identifierTypesVersion === undefined) {
    await db.patch('tenantPreferences', row._id, { identifierTypesVersion: 0 })
    await executeContract(
      ctx,
      identifierTypes,
      { staffCanManageIdentifierTypes: on },
      opts,
    )
  }
  await db.patch('tenantPreferences', row._id, {
    staffCanManageLists: undefined,
    listsVersion: undefined,
  })
  return true
}

/**
 * Read the row for a switch save. A row the split hasn't reached yet is
 * split first; its caller saw the old switch, which the split carried over
 * unchanged, so a save that sent no `expected` edits the split's state.
 */
async function rowForSave(
  db: ScopedDatabaseWriter,
  counter: 'tagsVersion' | 'identifierTypesVersion',
  expected: number | undefined,
) {
  const row = await tenantPreferences(db)
  if (!row || !(await splitStaffCanManageLists(db, row))) {
    return { row, expected }
  }
  const split = (await tenantPreferences(db))!
  return { row: split, expected: expected ?? split[counter] }
}

/** The caller saw no row (the default), but another admin saved first. */
function staleIfUnseen(
  row: Doc<'tenantPreferences'> | null,
  expected: number | undefined,
  contract: string,
  current: number | undefined,
) {
  if (row && expected === undefined) {
    throw new ConvexError({ kind: 'stale' as const, contract, current })
  }
}

/** Turn "staff can manage tags" on or off. Admin only. */
export const setStaffCanManageTags = tenantMutation({
  minRole: 'admin',
  args: { expected: v.optional(v.number()), ...tagsFields },
  handler: async (ctx, { expected: sent, ...payload }) => {
    const { row, expected } = await rowForSave(ctx.db, 'tagsVersion', sent)
    staleIfUnseen(row, expected, tags.name, row?.tagsVersion)
    return executeContract(ctx, tags, payload, {
      entityId: row?._id,
      expected,
      source: 'ui',
    })
  },
})

/** Turn "staff can manage identifier types" on or off. Admin only. */
export const setStaffCanManageIdentifierTypes = tenantMutation({
  minRole: 'admin',
  args: { expected: v.optional(v.number()), ...identifierTypesFields },
  handler: async (ctx, { expected: sent, ...payload }) => {
    const { row, expected } = await rowForSave(
      ctx.db,
      'identifierTypesVersion',
      sent,
    )
    staleIfUnseen(
      row,
      expected,
      identifierTypes.name,
      row?.identifierTypesVersion,
    )
    return executeContract(ctx, identifierTypes, payload, {
      entityId: row?._id,
      expected,
      source: 'ui',
    })
  },
})
