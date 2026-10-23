import { Link } from '@tanstack/react-router'
import type { Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import { METHOD_LABELS, formatDay, formatPence } from '../lib/gifts'
import { giftCoverage, useDeclarations } from '../lib/giftaid'
import { usePagedQuery } from '../lib/paged-list'
import { useTenant } from '../lib/tenant'

/** Gifts a page of the panel asks for (`byContact` caps it at 50). */
export const GIFTS_PAGE_SIZE = 20

/**
 * A contact's gifts, newest date first, a page at a time like the
 * contacts list (cash gifts step 5), each a link to its gift. A void
 * gift is struck through and marked; an individual's gift says whether a
 * declaration covers it (derived from their Gift Aid declarations, the
 * same subscription as the Gift Aid panel's).
 */
export function ContactGifts({
  contactId,
  individual,
}: {
  contactId: Id<'contacts'>
  /** Only an individual's gifts can be Gift Aided. */
  individual: boolean
}) {
  const tenant = useTenant()
  // In a fixed key order: page 0's args must be the same every render.
  const gifts = usePagedQuery(
    api.giving.queries.byContact,
    { tenantId: tenant._id, contactId },
    GIFTS_PAGE_SIZE,
    'contact gifts',
  )
  const declarations = useDeclarations(
    tenant._id,
    individual ? contactId : undefined,
  )
  return (
    <section aria-labelledby="contact-gifts">
      <h2 id="contact-gifts" className="mb-3 text-lg font-medium">
        Gifts
      </h2>
      {gifts.rows === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : gifts.rows.length === 0 ? (
        <p className="text-sm text-neutral-500">No gifts yet.</p>
      ) : (
        <ul className="divide-y divide-neutral-200 rounded border border-neutral-200 bg-white">
          {gifts.rows.map((g) => {
            const isVoid = g.status === 'void'
            const covered =
              individual && !isVoid && giftCoverage(declarations, g)
            return (
              <li key={g._id} className="text-sm">
                <Link
                  to="/t/$slug/gifts/$giftId"
                  params={{ slug: tenant.slug, giftId: g._id }}
                  className="flex items-baseline gap-3 px-3 py-2 hover:bg-neutral-50"
                >
                  <span className="w-24 shrink-0 text-neutral-600">
                    {formatDay(g.receivedOn)}
                  </span>
                  <span
                    className={`w-24 shrink-0 ${isVoid ? 'text-neutral-500 line-through' : ''}`}
                  >
                    {formatPence(g.amount)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-neutral-600">
                    {METHOD_LABELS[g.method]}
                    {' · '}
                    {g.allocations.map((a) => a.code ?? '?').join(', ')}
                  </span>
                  {isVoid && <span className="text-xs text-red-700">void</span>}
                  {covered && (
                    <span
                      title="Covered by a Gift Aid declaration"
                      className="rounded bg-green-100 px-1 text-xs text-green-800"
                    >
                      Gift Aid
                    </span>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
      {gifts.status === 'more' && (
        <button
          type="button"
          onClick={gifts.loadMore}
          className="mt-2 text-xs text-neutral-600 underline"
        >
          Load more
        </button>
      )}
      {gifts.rows !== undefined && gifts.status === 'loading' && (
        <p className="mt-2 text-xs text-neutral-500">Loading…</p>
      )}
    </section>
  )
}
