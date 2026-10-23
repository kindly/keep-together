/**
 * Payload validators for the giving contracts. The blocking tier
 * (rules.ts) refuses only what can't be stored or breaks an invariant;
 * the rest is warnings (ADR 0015).
 */
import { v } from 'convex/values'
import type { ObjectType } from 'convex/values'
import { contributionMethod, contributionStatus } from '../lib/appSchema'

/** A share of the gift under one source code (a version), in pence. */
export const allocationRow = v.object({
  key: v.optional(v.string()), // omitted = new row
  sourceCodeId: v.id('sourceCodes'),
  amount: v.int64(),
})

/**
 * The `giving.gift` slice. `contactId` is set on create and never changes
 * (g3q2): a wrong donor is void and record again.
 */
export const giftFields = {
  contactId: v.id('contacts'),
  receivedOn: v.string(), // ISO date
  amount: v.int64(), // pence
  method: contributionMethod,
  reference: v.optional(v.string()), // card only
  allocations: v.array(allocationRow),
}

/** The `giving.status` slice. */
export const statusFields = { status: contributionStatus }

export type GiftPayload = ObjectType<typeof giftFields>
export type StatusPayload = ObjectType<typeof statusFields>
