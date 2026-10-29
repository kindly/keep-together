import { Link } from '@tanstack/react-router'
import { STATUS_LABELS, isReceived } from '../lib/domain/gift-status'
import type { Id } from '../lib/domain/ids'
import { useContactGifts } from '../lib/data'
import { METHOD_LABELS, formatDay, formatPence } from '../lib/gifts'
import { giftCoverage, useDeclarations } from '../lib/giftaid'
import { useTenant } from '../lib/tenant'

/**
 * A contact's gifts, newest date first, a page at a time like the
 * contacts list (cash gifts step 5), each a link to its gift. Every
 * payment attempt is listed (ADR 0025): one that isn't money received
 * (pending, failed, charged back, void…) is struck through and marked
 * with its status; an individual's received gift says whether a
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
  const gifts = useContactGifts(contactId)
  const declarations = useDeclarations(individual ? contactId : undefined)
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
            const received = isReceived(g.status)
            const covered =
              individual && received && giftCoverage(declarations, g)
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
                    className={`w-24 shrink-0 ${received ? '' : 'text-neutral-500 line-through'}`}
                  >
                    {formatPence(g.amount)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-neutral-600">
                    {METHOD_LABELS[g.method]}
                    {' · '}
                    {g.allocations.map((a) => a.code ?? '?').join(', ')}
                  </span>
                  {!received && (
                    <span
                      data-status={g.status}
                      className={`text-xs ${g.status === 'pending' ? 'text-amber-700' : 'text-red-700'}`}
                    >
                      {STATUS_LABELS[g.status]}
                    </span>
                  )}
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
