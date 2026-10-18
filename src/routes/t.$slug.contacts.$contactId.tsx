import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { useEffect } from 'react'
import type { Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import { cachedTenant, useTenant } from '../lib/tenant'
import { contactSeed, dropContactSeed } from '../lib/contact-seed'
import { ContactForm } from '../components/contact-form'
import { ContactHistory } from '../components/contact-history'
import { ContactNotes } from '../components/contact-notes'

export const Route = createFileRoute('/t/$slug/contacts/$contactId')({
  component: ContactPage,
  // Every query the page subscribes to, at once, as the navigation starts
  // (or on hover), not one waterfall step per component as they mount.
  loader: ({ context: { convex }, params }) => {
    const tenant = cachedTenant(convex, params.slug)
    if (!tenant) return
    const args = {
      tenantId: tenant._id,
      id: params.contactId as Id<'contacts'>,
    }
    convex.prewarmQuery({ query: api.contacts.queries.get, args })
    convex.prewarmQuery({ query: api.contacts.queries.history, args })
    convex.prewarmQuery({ query: api.contacts.notes.forContact, args })
    convex.prewarmQuery({
      query: api.platform.tenants.members,
      args: { tenantId: tenant._id },
    })
    convex.prewarmQuery({
      query: api.contacts.queries.tags,
      args: { tenantId: tenant._id, includeInactive: true },
    })
  },
})

function ContactPage() {
  const tenant = useTenant()
  const { contactId } = Route.useParams()
  const id = contactId as Id<'contacts'>
  const live = useQuery(api.contacts.queries.get, { tenantId: tenant._id, id })
  // Straight from the new-contact form: its view until `get` answers.
  const data = live === undefined ? contactSeed(id) : live
  useEffect(() => {
    if (live !== undefined) dropContactSeed(id)
  }, [id, live])
  if (data === undefined)
    return <main className="p-6 text-sm text-neutral-500">Loading…</main>
  if (data === null) return <main className="p-6">No such contact.</main>
  return (
    <main className="mx-auto grid max-w-5xl gap-8 p-6 md:grid-cols-[1fr_18rem]">
      <div className="flex flex-col gap-8">
        <ContactForm id={id} data={data} />
        <ContactNotes contactId={id} />
      </div>
      <ContactHistory
        id={id}
        archived={data.contact.archived}
        archiveVersion={data.contact.archiveVersion}
      />
    </main>
  )
}
