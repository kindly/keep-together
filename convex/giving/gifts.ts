/**
 * What other modules may know about a gift. They read gifts only through
 * these functions, never the `contributions` table.
 */
import type { Doc, Id } from '../_generated/dataModel'
import type { ScopedDatabaseReader } from '../lib/tenancy'

/**
 * A gift's donor, date and status (giftaid's "this gift only" declaration
 * check), or null for a missing or another tenant's id. One read.
 */
export async function describeGift(
  db: ScopedDatabaseReader,
  id: Id<'contributions'>,
): Promise<{
  contactId: Id<'contacts'>
  receivedOn: string
  status: Doc<'contributions'>['status']
} | null> {
  const gift = await db.get(id)
  return (
    gift && {
      contactId: gift.contactId,
      receivedOn: gift.receivedOn,
      status: gift.status,
    }
  )
}
