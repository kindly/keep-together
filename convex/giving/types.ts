/**
 * Shapes the giving queries return, for the SPA (and its stubs while the
 * queries are being built). Amounts are `bigint` pence (rule 7): format
 * them, never do float arithmetic on them.
 */
import type { Doc, Id } from '../_generated/dataModel'

/** One row of `giving/queries:myRecent`: the caller's last gifts, newest first. */
export type RecentGift = {
  _id: Id<'contributions'>
  /** When it was entered (ms since epoch); the list's order. */
  _creationTime: number
  contactId: Id<'contacts'>
  /** The contact's display name as it reads now. */
  contactName: string
  amount: bigint
  receivedOn: string // ISO date
  method: Doc<'contributions'>['method']
  /** `void` gifts stay in the list, marked. */
  status: Doc<'contributions'>['status']
}
