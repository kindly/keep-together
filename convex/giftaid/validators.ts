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
 * box is not "on screen by the donor". `staffTickedNoEvidence` is staff
 * ticking with no form in hand: the honest default, which the gift form's
 * tick (step 3) records unless staff pick another method. A later claim
 * step excludes those until evidence is recorded, and decides which of the
 * others count; nothing gets rewritten. `onScreenByDonor` is refused until
 * a donor-facing screen exists (rules `prepareDeclaration`).
 */
export const declarationMethod = v.union(
  v.literal('staffTickedNoEvidence'),
  v.literal('paperForm'),
  v.literal('onScreenByDonor'),
  v.literal('oral'),
)

/**
 * The HMRC model declaration wording the donor agreed to (3.6.2 needs the
 * tax explanation). HMRC revised the model declarations in October 2015
 * for use from 6 April 2016: https://www.gov.uk/guidance/gift-aid-declarations-claiming-tax-back-on-donations
 * (model declarations linked there). Bump this when HMRC publishes new
 * wording; each declaration keeps the version it was made under.
 */
export const HMRC_MODEL_WORDING_VERSION = 'hmrc-2016-04'

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
  // The gift it was made with, which it always covers; required for
  // `thisGift`. Absent for a declaration made on its own (contact page).
  contributionId: v.optional(v.id('contributions')),
  madeOn: v.string(), // ISO date
  method: declarationMethod,
  // Which wording the donor agreed to; `HMRC_MODEL_WORDING_VERSION` today.
  wordingVersion: v.string(),
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

/**
 * The `giftaid.void` slice: the declaration was recorded in error (wrong
 * contact, never made). Create-only: once voided it never applied to any
 * gift, and coverage ignores it everywhere. Who and when are the command's
 * actor and time; `reason` is why.
 */
export const voidFields = {
  reason: v.string(),
}

export type VoidPayload = ObjectType<typeof voidFields>
