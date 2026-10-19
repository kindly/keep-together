import { v } from 'convex/values'
import type { ObjectType } from 'convex/values'

/**
 * The `sources.code` slice: everything about a part an editor can change.
 * The level and parent are fixed at create (`sourceCodeCreateFields`), and
 * `used` is system-owned.
 */
export const sourceCodeFields = {
  name: v.string(),
  description: v.optional(v.string()),
  startDate: v.optional(v.string()), // ISO date; detail and version only
  endDate: v.optional(v.string()),
  isActive: v.boolean(),
}

export type SourceCodePayload = ObjectType<typeof sourceCodeFields>

/** Create-only: absent makes a category; a category's id a detail; a detail's a version. */
export const sourceCodeCreateFields = {
  parentId: v.optional(v.id('sourceCodes')),
}
