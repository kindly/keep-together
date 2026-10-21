/**
 * Per-tenant preferences: plain, non-secret switches an admin sets on the
 * Settings page (secrets go in `tenantSettings`, encrypted). One row per
 * tenant at most, created by the first save; no row means every default.
 *
 * `staffCanManageTags`, `staffCanManageIdentifierTypes` and
 * `staffCanManageSourceCodes` (each default off, independent): whether
 * staff, as well as admins, may create, rename and archive / reactivate
 * the tenant's tags, its identifier types, and its source codes (the rule
 * is in lib/lists). Each is its own contract with its own
 * counter, so switching one never conflicts with the other. Putting tags
 * and identifiers on contacts is ordinary staff editing either way;
 * viewers never write.
 */
import { ConvexError, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { defineContract, executeContract } from '../lib/contracts'
import { tenantPreferences } from '../lib/lists'
import { tenantMutation } from '../lib/tenancy'

/** A new row: every switch at its default, every counter at 0. */
const DEFAULTS = {
  staffCanManageTags: false,
  tagsVersion: 0,
  staffCanManageIdentifierTypes: false,
  identifierTypesVersion: 0,
  staffCanManageSourceCodes: false,
  sourceCodesVersion: 0,
  staffCanManageFields: false,
  fieldsVersion: 0,
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

export const sourceCodesFields = { staffCanManageSourceCodes: v.boolean() }

export const sourceCodes = defineContract({
  name: 'tenantPreferences.sourceCodes',
  entity: 'tenantPreferences',
  version: 1,
  counter: 'sourceCodesVersion',
  fields: sourceCodesFields,
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
  handler: async (ctx, { expected, ...payload }) => {
    const row = await tenantPreferences(ctx.db)
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
  handler: async (ctx, { expected, ...payload }) => {
    const row = await tenantPreferences(ctx.db)
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

/** Turn "staff can manage source codes" on or off. Admin only. */
export const setStaffCanManageSourceCodes = tenantMutation({
  minRole: 'admin',
  args: { expected: v.optional(v.number()), ...sourceCodesFields },
  handler: async (ctx, { expected, ...payload }) => {
    const row = await tenantPreferences(ctx.db)
    staleIfUnseen(row, expected, sourceCodes.name, row?.sourceCodesVersion)
    return executeContract(ctx, sourceCodes, payload, {
      entityId: row?._id,
      expected,
      source: 'ui',
    })
  },
})
