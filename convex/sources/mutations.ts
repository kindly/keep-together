/**
 * Managing the source-code list: admins, and staff while the tenant's
 * "staff can manage source codes" switch is on (the contract is
 * `managesList: 'sourceCodes'`; lib/lists). Assigning a code to a contact
 * or gift is ordinary staff editing, through `markUsed`.
 */
import { v } from 'convex/values'
import type { Id } from '../_generated/dataModel'
import { commandGroup, executeContract } from '../lib/contracts'
import type { CommandGroup, ContractCtx, Source } from '../lib/contracts'
import { requireListManager } from '../lib/lists'
import { tenantMutation } from '../lib/tenancy'
import { code, deletePart } from './code'
import { FIRST_VERSION_NAME } from './rules'
import { sourceCodeFields } from './validators'
import type { SourceCodePayload } from './validators'

/**
 * A new part under `parentId` (none: a category). A new detail comes with
 * its first version, `001`, in one command group, so it can be assigned
 * at once (plan g2q4).
 */
export async function createPart(
  ctx: ContractCtx,
  parentId: Id<'sourceCodes'> | undefined,
  payload: SourceCodePayload,
  source: Source,
  inGroup?: CommandGroup,
): Promise<{ id: Id<'sourceCodes'>; versionId?: Id<'sourceCodes'> }> {
  const parent = parentId ? await ctx.db.get(parentId) : null
  if (parent?.level !== 'category') {
    const { id } = await executeContract(ctx, code, payload, {
      source,
      group: inGroup,
      createWith: { parentId },
    })
    return { id }
  }
  const group =
    inGroup ?? (await commandGroup(ctx, `create ${payload.name.trim()}`))
  const { id } = await executeContract(ctx, code, payload, {
    source,
    group,
    createWith: { parentId },
  })
  const { id: versionId } = await executeContract(
    ctx,
    code,
    { name: FIRST_VERSION_NAME, isActive: true },
    { source, group, createWith: { parentId: id } },
  )
  return { id, versionId }
}

/** Add a category, a detail (with version `001`) or a version. */
export const create = tenantMutation({
  args: {
    parentId: v.optional(v.id('sourceCodes')),
    ...sourceCodeFields,
  },
  handler: async (ctx, { parentId, ...payload }) =>
    createPart(ctx, parentId, payload, 'ui'),
})

/** Rename, describe, date, archive or reactivate a part. */
export const save = tenantMutation({
  args: {
    id: v.id('sourceCodes'),
    expected: v.number(),
    ...sourceCodeFields,
  },
  handler: async (ctx, { id, expected, ...payload }) =>
    executeContract(ctx, code, payload, {
      entityId: id,
      expected,
      source: 'ui',
    }),
})

/** Delete a never-used part and everything under it (`deletePart`). */
export const remove = tenantMutation({
  args: { id: v.id('sourceCodes'), expected: v.number() },
  handler: async (ctx, { id, expected }) => {
    await requireListManager(ctx, 'sourceCodes')
    return deletePart(ctx, id, expected)
  },
})
