import { useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import type { Doc, Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import { coveringDeclaration } from '../../convex/giftaid/rules'
import { localToday } from '../components/source-code-picker'
import { formatDay } from './gifts'

export type ContactDeclarations = FunctionReturnType<
  typeof api.giftaid.queries.byContact
>
export type Declaration = ContactDeclarations['declarations'][number]

/**
 * A contact's Gift Aid declarations as of today, newest first, and which
 * is current. One subscription however many parts of a page ask (the
 * args are the same), so the Gifts panel's marks cost nothing extra.
 */
export function useDeclarations(
  tenantId: Id<'tenants'>,
  contactId: Id<'contacts'> | undefined,
): ContactDeclarations | undefined {
  return useQuery(
    api.giftaid.queries.byContact,
    contactId ? { tenantId, contactId, today: localToday() } : 'skip',
  )
}

export const SCOPE_LABELS: Record<Doc<'giftAidDeclarations'>['scope'], string> =
  {
    thisGift: 'This gift only',
    future: 'This and future gifts',
    futureAndPast4y: 'This, future and past 4 years',
  }

export const METHOD_LABELS: Record<
  Doc<'giftAidDeclarations'>['method'],
  string
> = {
  staffTickedNoEvidence: 'Ticked by staff, no evidence yet',
  paperForm: 'Paper form',
  onScreenByDonor: 'On screen by the donor',
  oral: 'Made orally',
}

/** "declaration of 3 Mar 2026 (paper form)". */
export function describeDeclaration(
  d: Pick<Declaration, 'madeOn' | 'method'>,
): string {
  return `declaration of ${formatDay(d.madeOn)} (${METHOD_LABELS[d.method].toLowerCase()})`
}

/**
 * The declaration covering a saved gift (rule 1: derived from the chain,
 * never stored on the gift), or null. Undefined while loading.
 */
export function giftCoverage(
  declarations: ContactDeclarations | undefined,
  gift: { _id: Id<'contributions'>; receivedOn: string },
): Declaration | null | undefined {
  if (!declarations) return undefined
  return coveringDeclaration(declarations.declarations, {
    date: gift.receivedOn,
    contributionId: gift._id,
  })
}
