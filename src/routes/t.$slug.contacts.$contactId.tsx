import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import type { Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import { useTenant } from '../lib/tenant'
import { ContactForm } from '../components/contact-form'
import { ContactHistory } from '../components/contact-history'

export const Route = createFileRoute('/t/$slug/contacts/$contactId')({
  component: ContactPage,
})

function ContactPage() {
  const tenant = useTenant()
  const { contactId } = Route.useParams()
  const id = contactId as Id<'contacts'>
  const data = useQuery(api.contacts.queries.get, { tenantId: tenant._id, id })
  if (data === undefined)
    return <main className="p-6 text-sm text-neutral-500">Loading…</main>
  if (data === null) return <main className="p-6">No such contact.</main>
  return (
    <main className="mx-auto grid max-w-5xl gap-8 p-6 md:grid-cols-[1fr_18rem]">
      <ContactForm id={id} data={data} />
      <ContactHistory
        id={id}
        archived={data.contact.archived}
        archiveVersion={data.contact.archiveVersion}
      />
    </main>
  )
}
