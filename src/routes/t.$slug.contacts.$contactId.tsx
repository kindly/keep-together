import { createFileRoute } from '@tanstack/react-router'
import { useEffect } from 'react'
import type { Id } from '../lib/domain/ids'
import { useTenant } from '../lib/tenant'
import { contactSeed, dropContactSeed } from '../lib/contact-seed'
import { FEATURES, preloadContact, useContact } from '../lib/data'
import { ContactForm } from '../components/contact-form'
import { ContactGiftAid } from '../components/contact-giftaid'
import { BankPayers } from '../components/bank-payers'
import { ContactGifts } from '../components/contact-gifts'
import { ContactDirectDebit } from '../components/direct-debit'
import { RegularGiftTerms } from '../components/regular-terms'
import { ContactStandingOrders } from '../components/standing-orders'
import { ContactHistory } from '../components/contact-history'
import { ContactNotes } from '../components/contact-notes'
import { LeaveGuard } from '../components/leave-guard'
import { UnsavedWorkProvider, useUnsavedWork } from '../lib/unsaved'

export const Route = createFileRoute('/t/$slug/contacts/$contactId')({
  component: ContactPage,
  // Every read the page makes, at once, as the navigation starts (or on
  // hover), not one waterfall step per component as they mount.
  loader: ({ context, params }) =>
    preloadContact(context, params.slug, params.contactId),
})

function ContactPage() {
  const tenant = useTenant()
  const { contactId } = Route.useParams()
  const id = contactId as Id<'contacts'>
  // The form, note editors and composer report here; the guard reads it.
  const work = useUnsavedWork()
  const { view: live, fields } = useContact(id)
  // Straight from the new-contact form: its view until the queries answer.
  const data = live === undefined ? contactSeed(id) : live
  useEffect(() => {
    if (live !== undefined) dropContactSeed(id)
  }, [id, live])
  if (data === undefined)
    return <main className="p-6 text-sm text-neutral-500">Loading…</main>
  if (data === null) return <main className="p-6">No such contact.</main>
  return (
    <UnsavedWorkProvider work={work}>
      <main className="mx-auto grid max-w-5xl gap-8 p-6 md:grid-cols-[1fr_18rem]">
        <div className="flex flex-col gap-8">
          {/* A new instance per group and contact: its reducer and the
              last held / shared answers belong to the contact they came
              from, and must never show on the next one. */}
          <ContactForm
            key={`${tenant._id}:${id}`}
            id={id}
            data={data}
            // Only the seed shows before the definitions answer: its own
            // values stand, the dropdowns appear a moment later.
            fields={fields ?? []}
          />
          {FEATURES.notes && <ContactNotes contactId={id} />}
          {FEATURES.gifts && (
            <ContactGifts
              contactId={id}
              individual={data.contact.kind === 'individual'}
            />
          )}
          {/* Nothing while GoCardless is off here. */}
          {FEATURES.gifts && (
            <ContactDirectDebit contactId={id}>
              {(gift) => <RegularGiftTerms gift={gift} />}
            </ContactDirectDebit>
          )}
          {/* Standing orders: the donor's own bank, no provider. */}
          {FEATURES.gifts && <ContactStandingOrders contactId={id} />}
          {/* Staff and admins: from statement lines (bank transfers 6b). */}
          {FEATURES.gifts && <BankPayers contactId={id} />}
          {/* Only a person can make a Gift Aid declaration (HMRC 3.6.7). */}
          {FEATURES.gifts && data.contact.kind === 'individual' && (
            <ContactGiftAid contactId={id} />
          )}
        </div>
        {/* Keyed like the form: a restore notice belongs to its contact. */}
        <ContactHistory
          key={`${tenant._id}:${id}`}
          id={id}
          archived={data.contact.archived}
          archiveVersion={data.contact.archiveVersion}
        />
      </main>
      <LeaveGuard work={work} />
    </UnsavedWorkProvider>
  )
}
