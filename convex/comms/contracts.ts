/**
 * Comms contracts. `comms.suppression` is an address's suppression state
 * in one tenant (domain rule 5: suppression is centralised here). Apply
 * functions are pure state application.
 */
import { v } from 'convex/values'
import type { ObjectType } from 'convex/values'
import { defineContract, invalid, registry, rejected } from '../lib/contracts'
import { suppressionReason } from '../schema'
import { normaliseEmail } from '../contacts/rules'

/** The longest note an admin can give for a release. */
export const SUPPRESSION_NOTE_MAX = 500

export const suppressionFields = {
  addressNormalized: v.string(),
  suppressed: v.boolean(),
  reason: suppressionReason,
  eventRef: v.optional(v.string()),
  note: v.optional(v.string()),
}

export type SuppressionPayload = ObjectType<typeof suppressionFields>

export function prepareSuppression(p: SuppressionPayload): SuppressionPayload {
  const out = {
    ...p,
    addressNormalized: normaliseEmail(p.addressNormalized),
    note: p.note?.trim() || undefined,
  }
  if (!out.addressNormalized) {
    throw invalid([{ field: 'addressNormalized', message: 'Address needed' }])
  }
  // A suppression says why; only a release is a release.
  if (out.suppressed === (out.reason === 'release')) {
    throw invalid([
      {
        field: 'reason',
        message: out.suppressed
          ? 'Only a bounce suppresses'
          : 'Lifting a suppression is a release',
      },
    ])
  }
  if (out.note && out.note.length > SUPPRESSION_NOTE_MAX) {
    throw invalid([
      {
        field: 'note',
        message: `At most ${SUPPRESSION_NOTE_MAX} characters`,
      },
    ])
  }
  return out
}

/**
 * An address's suppression in the tenant. The row is created by the first
 * suppression and never deleted; a release sets `suppressed: false`. Who
 * and when are on the revisions (actor, source, time), why in the payload.
 * Writers: comms/suppressions (the system suppresses, an admin releases).
 */
export const suppression = defineContract({
  name: 'comms.suppression',
  entity: 'emailSuppressions',
  version: 1,
  counter: 'saveVersion',
  fields: suppressionFields,
  prepare: prepareSuppression,
  apply: async (ctx, p, root, command) => {
    const state = {
      suppressed: p.suppressed,
      reason: p.reason,
      since: command.at,
      eventRef: p.eventRef,
      note: p.note,
    }
    if (!root) {
      const existing = await ctx.db
        .query('emailSuppressions')
        .withIndex('by_tenant_addressNormalized', (q) =>
          q.eq('addressNormalized', p.addressNormalized),
        )
        .first()
      if (existing) {
        throw rejected('duplicate', 'This address already has a suppression')
      }
      return ctx.db.insert('emailSuppressions', {
        addressNormalized: p.addressNormalized,
        ...state,
        saveVersion: 0,
      })
    }
    if (root.addressNormalized !== p.addressNormalized) {
      throw rejected('immutable', 'A suppression is for one address')
    }
    await ctx.db.patch('emailSuppressions', root._id, state)
    return root._id
  },
})

/** Everything restore needs to know about this module. */
export const commsContracts = registry(suppression)
