/**
 * Gift writes. Every one runs the giving contracts; nothing deletes a gift
 * (a mistake is void). Staff and admins only (the constructors' default):
 * a viewer never writes.
 */
import { ConvexError, v } from 'convex/values'
import type { Id } from '../_generated/dataModel'
import {
  addFirstEmail,
  addHomeAddress,
  createContact,
  describeDonor,
  fillAcquisition,
} from '../contacts/donors'
import { makeDeclaration } from '../giftaid/mutations'
import {
  HMRC_MODEL_WORDING_VERSION,
  declarationMethod,
  declarationScope,
} from '../giftaid/validators'
import { contactKind } from '../lib/appSchema'
import {
  commandGroup,
  executeContract,
  invalid,
  rejected,
  restore,
} from '../lib/contracts'
import type { CommandGroup, ContractCtx } from '../lib/contracts'
import { tenantMutation } from '../lib/tenancy'
import { describe } from '../sources/code'
import { gift, givingContracts, status } from './contracts'
import { formatPence } from './rules'
import { giftFields, statusFields } from './validators'
import type { GiftPayload } from './validators'

/**
 * The command group's name for a new gift, with the code as it reads now
 * (history keeps it through renames): "gift £20 cash, Street-Wesser-001".
 */
export async function giftGroupName(
  ctx: ContractCtx,
  p: Pick<GiftPayload, 'amount' | 'method' | 'allocations'>,
): Promise<string> {
  const codes = await Promise.all(
    p.allocations.map((a) => describe(ctx.db, a.sourceCodeId)),
  )
  const named = codes.filter((c) => c !== null).map((c) => c.code)
  const head = `gift ${formatPence(p.amount)} ${p.method}`
  return named.length ? `${head}, ${named.join(', ')}` : head
}

/**
 * Record a gift in the caller's transaction: `giving.gift`, then
 * `giving.status` (completed), so status history starts with the gift.
 * Runs under `group`, or one of its own named by `giftGroupName`. A
 * refusal throws, rolling back the caller's whole mutation. For commands
 * that compose it (recordGift).
 */
export async function createGift(
  ctx: ContractCtx,
  p: GiftPayload,
  opts: { group?: CommandGroup } = {},
): Promise<Id<'contributions'>> {
  const group =
    opts.group ?? (await commandGroup(ctx, await giftGroupName(ctx, p)))
  const { id } = await executeContract(ctx, gift, p, { source: 'ui', group })
  await executeContract(
    ctx,
    status,
    { status: 'completed' },
    { entityId: id, expected: 0, source: 'ui', group },
  )
  return id
}

/** A gift from an existing contact. */
export const create = tenantMutation({
  args: giftFields,
  handler: async (ctx, payload) => createGift(ctx, payload),
})

/** Correct a gift. Stale only if the gift's fields changed since `expected`. */
export const save = tenantMutation({
  args: { id: v.id('contributions'), expected: v.number(), ...giftFields },
  handler: async (ctx, { id, expected, ...payload }) =>
    executeContract(ctx, gift, payload, {
      entityId: id,
      expected,
      source: 'ui',
    }),
})

/** Void or un-void. Re-sending the current status is a no-op. */
export const setStatus = tenantMutation({
  args: { id: v.id('contributions'), expected: v.number(), ...statusFields },
  handler: async (ctx, { id, expected, status: next }) => {
    const current = await ctx.db.get(id)
    if (!current) throw new ConvexError({ kind: 'not_found' as const })
    if (current.status === next) {
      return { id, counter: current.statusVersion }
    }
    return executeContract(
      ctx,
      status,
      { status: next },
      { entityId: id, expected, source: 'ui' },
    )
  },
})

/** Restore one stored gift revision as a new command. */
export const restoreRevision = tenantMutation({
  args: { revisionId: v.id('revisions') },
  handler: async (ctx, { revisionId }) =>
    restore(ctx, givingContracts, revisionId),
})

/** The record-gift page's inline new contact (g1q3): the minimum fields. */
const newContactFields = v.object({
  kind: contactKind,
  firstName: v.string(), // people
  lastName: v.string(), // people
  name: v.string(), // organisations and households
  email: v.optional(v.string()),
  clientKey: v.optional(v.string()), // a double submit is refused
})

const { contactId: _, ...giftOnlyFields } = giftFields

/**
 * The record-gift page's one save (g1q4): in one mutation and one command
 * group named like a gift ("gift £20 cash, Street-Wesser-001"):
 *
 *   1. `contact` is an existing contact's id, or a new contact, created
 *      with the gift's code as its acquisition code (and its email);
 *      `home` (line 1 and postcode) is added to its addresses (g3q3);
 *   2. the gift (`giving.gift`, then `giving.status` completed);
 *   3. an existing contact with no acquisition code gets the gift's code
 *      (g2q1); one it already has stays;
 *   4. with `giftAid`, a declaration (individuals only) whose snapshot is
 *      the contact's name and primary address as just saved. Defaults:
 *      the tick's method `staffTickedNoEvidence`, scope
 *      `futureAndPast4y` (g2q5), made on the gift's date, HMRC's current
 *      wording.
 *
 * The gift's code is its first allocation's (the page sends one). Any
 * refusal throws, so nothing of the save is left behind: no contact, no
 * contact number, no gift, no group.
 */
export const recordGift = tenantMutation({
  args: {
    contact: v.union(v.id('contacts'), newContactFields),
    home: v.optional(v.object({ line1: v.string(), postcode: v.string() })),
    ...giftOnlyFields,
    giftAid: v.optional(
      v.object({
        scope: v.optional(declarationScope),
        method: v.optional(declarationMethod),
        madeOn: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { contact, home, giftAid, ...fields }) => {
    const codeId = fields.allocations.at(0)?.sourceCodeId
    if (!codeId) {
      throw invalid([{ field: 'allocations', message: 'Pick a source code' }])
    }
    const group = await commandGroup(ctx, await giftGroupName(ctx, fields))

    let contactId: Id<'contacts'>
    if (typeof contact === 'string') {
      contactId = contact
      if (!(await describeDonor(ctx.db, contactId))) {
        throw rejected('unknown_contact', 'Contact must exist')
      }
    } else {
      const { email, clientKey, ...names } = contact
      contactId = await createContact(
        ctx,
        { ...names, clientKey, title: '', nickname: '', isDeceased: false },
        { acquisitionCodeId: codeId, group },
      )
      if (email?.trim()) await addFirstEmail(ctx, contactId, email, group)
    }
    if (home && (home.line1.trim() || home.postcode.trim())) {
      await addHomeAddress(ctx, contactId, home, group)
    }

    const giftId = await createGift(ctx, { ...fields, contactId }, { group })
    if (typeof contact === 'string') {
      await fillAcquisition(ctx, contactId, codeId, group)
    }

    let declarationId: Id<'giftAidDeclarations'> | null = null
    if (giftAid) {
      const donor = (await describeDonor(ctx.db, contactId))!
      const scope = giftAid.scope ?? 'futureAndPast4y'
      const made = await makeDeclaration(
        ctx,
        {
          contactId,
          scope,
          contributionId: scope === 'thisGift' ? giftId : undefined,
          madeOn: giftAid.madeOn ?? fields.receivedOn,
          method: giftAid.method ?? 'staffTickedNoEvidence',
          wordingVersion: HMRC_MODEL_WORDING_VERSION,
          firstName: donor.firstName,
          lastName: donor.lastName,
          addressLine1: donor.home.line1,
          postcode: donor.home.postcode,
        },
        'ui',
        group,
      )
      declarationId = made.id
    }
    return { contactId, giftId, declarationId }
  },
})
