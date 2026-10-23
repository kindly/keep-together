import { v } from 'convex/values'
import type { ObjectType } from 'convex/values'

/**
 * Which gifts a declaration covers (HMRC detailed guidance 3.6.2, 3.9):
 * the gift it was made with, it and every later gift, or those plus the
 * gifts of the 4 years before it (HMRC's model enduring wording, the
 * default: plan g2q5).
 */
export const declarationScope = v.union(
  v.literal('thisGift'),
  v.literal('future'),
  v.literal('futureAndPast4y'),
)

/**
 * How the declaration was made, recorded honestly even when HMRC's
 * conditions aren't met yet (plan chat 3): an oral one only takes effect
 * once the donor is sent a written record (3.10.1), and staff ticking a
 * box is not "on screen by the donor". A later claim step decides which
 * count; nothing gets rewritten.
 */
export const declarationMethod = v.union(
  v.literal('paperForm'),
  v.literal('onScreenByDonor'),
  v.literal('oral'),
)

/**
 * The `giftaid.declaration` slice: everything a declaration says. Create
 * only: a declaration is never edited (the chain is add-only, g1q1).
 * `firstName` … `postcode` are a snapshot of the name and home address it
 * was made under (3.6.2: house number or name and postcode suffice): the
 * audit record, kept through erasure for HMRC's 6 years (3.30). Claims
 * use the contact's current address (g2q7).
 */
export const declarationFields = {
  contactId: v.id('contacts'),
  scope: declarationScope,
  // `thisGift` only, and then required: the gift it was made with.
  contributionId: v.optional(v.id('contributions')),
  madeOn: v.string(), // ISO date
  method: declarationMethod,
  firstName: v.string(),
  lastName: v.string(),
  addressLine1: v.string(),
  postcode: v.string(),
}

export type DeclarationPayload = ObjectType<typeof declarationFields>

/**
 * The `giftaid.cancellation` slice. Absent `cancelledFrom` = not cancelled.
 * A cancellation covers gifts on or after its date (3.8.2).
 */
export const cancellationFields = {
  cancelledFrom: v.optional(v.string()), // ISO date
  note: v.optional(v.string()),
}

export type CancellationPayload = ObjectType<typeof cancellationFields>
