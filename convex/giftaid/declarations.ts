/**
 * Gift Aid declarations (cash gifts plan, step 1b): one
 * `giftAidDeclarations` root per declaration, a dated chain per contact
 * (rule 1). Two contracts partition it:
 *
 *   giftaid.declaration  — what was declared; create-only, never edited
 *   giftaid.cancellation — from when it no longer applies
 *
 * Coverage is derived from the chain at read time (rules.ts) and never
 * stored on a gift. Other modules use `coverage` and `currentDeclaration`,
 * never the table; this module reads gifts only through giving's
 * `describeGift`.
 */
import type { Doc, Id } from '../_generated/dataModel'
import { describeGift } from '../giving/gifts'
import { defineContract, registry, rejected } from '../lib/contracts'
import type { ScopedDatabaseReader } from '../lib/tenancy'
import {
  DECLARATION_LIMIT,
  coveringDeclaration,
  currentOf,
  prepareCancellation,
  prepareDeclaration,
} from './rules'
import type { GiftRef } from './rules'
import { cancellationFields, declarationFields } from './validators'

/**
 * A declaration as made. Refused for anyone but an individual (HMRC
 * 3.6.7: not in a company's or joint names), and for a "this gift only"
 * declaration whose gift isn't this contact's. Never updated: a mistake
 * is a cancellation plus a new declaration, so restore of a revision is
 * refused too. `enteredBy` is the actor, set here once.
 */
export const declaration = defineContract({
  name: 'giftaid.declaration',
  entity: 'giftAidDeclarations',
  version: 1,
  counter: 'declarationVersion',
  fields: declarationFields,
  prepare: prepareDeclaration,
  apply: async (ctx, p, root, command) => {
    if (root) {
      throw rejected(
        'immutable',
        'A declaration can’t be changed: record a cancellation, then a new declaration',
      )
    }
    const [contact, held, gift] = await Promise.all([
      // Another tenant's ids read as null through the scoped db.
      ctx.db.get(p.contactId),
      chain(ctx.db, p.contactId),
      p.contributionId ? describeGift(ctx.db, p.contributionId) : null,
    ])
    if (!contact) throw rejected('unknown_contact', 'Contact must exist')
    if (contact.kind !== 'individual') {
      throw rejected(
        'not_individual',
        'Only a person can make a Gift Aid declaration',
      )
    }
    if (p.contributionId && gift?.contactId !== p.contactId) {
      throw rejected(
        'unknown_gift',
        'A “this gift only” declaration must name one of this contact’s gifts',
      )
    }
    if (held.length >= DECLARATION_LIMIT) {
      throw rejected(
        'declaration_limit',
        `A contact can have at most ${DECLARATION_LIMIT} declarations`,
      )
    }
    return ctx.db.insert('giftAidDeclarations', {
      ...p,
      enteredBy: command.actor ?? undefined,
      declarationVersion: 0,
      cancellationVersion: 0,
    })
  },
})

/**
 * When the declaration stops applying: gifts on or after `cancelledFrom`
 * aren't covered by it (3.8.2). Clearing it undoes a cancellation
 * recorded by mistake.
 */
export const cancellation = defineContract({
  name: 'giftaid.cancellation',
  entity: 'giftAidDeclarations',
  version: 1,
  counter: 'cancellationVersion',
  fields: cancellationFields,
  prepare: prepareCancellation,
  apply: async (ctx, p, root) => {
    if (!root) {
      throw rejected(
        'no_root',
        'giftaid.cancellation targets an existing declaration',
      )
    }
    await ctx.db.patch('giftAidDeclarations', root._id, {
      cancelledFrom: p.cancelledFrom,
      cancellationNote: p.note,
    })
    return root._id
  },
})

/** Everything restore needs to know about this module. */
export const giftaidContracts = registry(declaration, cancellation)

// ── reading the chain ──────────────────────────────────────────────────────

/** A contact's declarations, oldest first by date made. One indexed read. */
export function chain(
  db: ScopedDatabaseReader,
  contactId: Id<'contacts'>,
): Promise<Array<Doc<'giftAidDeclarations'>>> {
  return db
    .query('giftAidDeclarations')
    .withIndex('by_tenant_contact_madeOn', (q) => q.eq('contactId', contactId))
    .take(DECLARATION_LIMIT)
}

/** What other modules learn about a declaration. */
export type DeclarationSummary = {
  id: Id<'giftAidDeclarations'>
  scope: Doc<'giftAidDeclarations'>['scope']
  method: Doc<'giftAidDeclarations'>['method']
  madeOn: string
  cancelledFrom?: string
}

function summary(d: Doc<'giftAidDeclarations'>): DeclarationSummary {
  return {
    id: d._id,
    scope: d.scope,
    method: d.method,
    madeOn: d.madeOn,
    cancelledFrom: d.cancelledFrom,
  }
}

/**
 * The declaration covering a gift by `contactId` dated `date`, or null.
 * Pass the gift's id so a "this gift only" declaration can match it. A
 * gift not yet saved has no id and can only be covered by an enduring
 * declaration. Whether the declaration's method and snapshot are enough
 * for a claim is the claim step's question, not this one.
 */
export async function coverage(
  ctx: { db: ScopedDatabaseReader },
  contactId: Id<'contacts'>,
  date: string,
  contributionId?: Id<'contributions'>,
): Promise<DeclarationSummary | null> {
  const gift: GiftRef = { date, contributionId }
  const found = coveringDeclaration(await chain(ctx.db, contactId), gift)
  return found && summary(found)
}

/**
 * The enduring declaration in force on `today` (the caller's date: a
 * query never reads the clock), or null. The gift form shows "✓ covered"
 * instead of the tick when there is one (g2q6).
 */
export async function currentDeclaration(
  ctx: { db: ScopedDatabaseReader },
  contactId: Id<'contacts'>,
  today: string,
): Promise<DeclarationSummary | null> {
  const found = currentOf(await chain(ctx.db, contactId), today)
  return found && summary(found)
}
