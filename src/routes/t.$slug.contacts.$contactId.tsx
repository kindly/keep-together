import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useRef } from 'react'
import type { Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import { assembleView } from '../../convex/contacts/view'
import { cachedTenant, useTenant } from '../lib/tenant'
import { useQuery } from '../lib/query-cache'
import { contactSeed, dropContactSeed } from '../lib/contact-seed'
import type { ContactView } from '../lib/contact-seed'
import { ContactForm } from '../components/contact-form'
import { ContactHistory } from '../components/contact-history'
import { ContactNotes } from '../components/contact-notes'
import { LeaveGuard } from '../components/leave-guard'
import { UnsavedWorkProvider, useUnsavedWork } from '../lib/unsaved'

export const Route = createFileRoute('/t/$slug/contacts/$contactId')({
  component: ContactPage,
  // Every query the page subscribes to, at once, as the navigation starts
  // (or on hover), not one waterfall step per component as they mount.
  // Not `history`: it is fetched, never subscribed (ContactHistory), and a
  // prewarm would hold a subscription that every save then waits on.
  loader: ({ context: { convex }, params }) => {
    const tenant = cachedTenant(convex, params.slug)
    if (!tenant) return
    const args = {
      tenantId: tenant._id,
      id: params.contactId as Id<'contacts'>,
    }
    for (const query of SLICE_QUERIES) convex.prewarmQuery({ query, args })
    convex.prewarmQuery({
      query: api.contacts.queries.listIdentifierTypes,
      args: { tenantId: tenant._id, includeInactive: true },
    })
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

const SLICE_QUERIES = [
  api.contacts.queries.getRoot,
  api.contacts.queries.getChannels,
  api.contacts.queries.getTags,
  api.contacts.queries.getIdentifiers,
] as const

/**
 * `get`'s view, assembled from one query per slice, so a save re-runs (and
 * waits for) only the slices it wrote plus the root, not the whole view.
 * The parts come from one consistent snapshot: Convex applies a save's
 * re-runs in a single transition. The form doesn't rely on that alone: a
 * slice's rows arriving apart from its counter are still merged (`server`
 * in contact-form-state). Undefined until every part has answered, null
 * when there is no such contact (in this tenant).
 */
function useContactView(
  tenantId: Id<'tenants'>,
  id: Id<'contacts'>,
): ContactView | null | undefined {
  const args = { tenantId, id }
  const root = useQuery(api.contacts.queries.getRoot, args)
  const channels = useQuery(api.contacts.queries.getChannels, args)
  const tags = useQuery(api.contacts.queries.getTags, args)
  const identifiers = useQuery(api.contacts.queries.getIdentifiers, args)
  // By the code's id, not the contact's, so a contact save doesn't re-run
  // it; an uncoded contact subscribes to nothing.
  const codeId = root?.acquisitionCodeId
  const described = useQuery(
    api.contacts.queries.getAcquisition,
    codeId ? { tenantId, codeId } : 'skip',
  )
  const acquisition = codeId ? described : null
  // Shared with the form's type picker (archived types included).
  const types = useQuery(api.contacts.queries.listIdentifierTypes, {
    tenantId,
    includeInactive: true,
  })
  // The last whole view: a save that changes the code moves the root a
  // moment before the new code's description may answer (the picker
  // subscribes to it before saving, so usually not); show the last view
  // meanwhile, not "Loading…".
  const last = useRef<{ id: Id<'contacts'>; view: ContactView } | null>(null)
  const view = useMemo(() => {
    if (root === null) return null
    if (
      root === undefined ||
      channels === undefined ||
      tags === undefined ||
      identifiers === undefined ||
      acquisition === undefined ||
      types === undefined
    )
      return undefined
    return assembleView({
      root,
      channels,
      tags,
      identifiers,
      types,
      acquisition,
    })
  }, [root, channels, tags, identifiers, acquisition, types])
  if (view) last.current = { id, view }
  if (view === undefined && last.current?.id === id && root?._id === id) {
    return last.current.view
  }
  return view
}

/**
 * Changes whenever the root does: every contract on the contact bumps its
 * own counter (a `…Version` field) there, so this is what tells the
 * history panel to fetch again.
 */
function rootVersion(contact: ContactView['contact']) {
  return Object.entries(contact)
    .filter(([field]) => field.endsWith('Version'))
    .map(([field, n]) => `${field}:${String(n)}`)
    .join(' ')
}

function ContactPage() {
  const tenant = useTenant()
  const { contactId } = Route.useParams()
  const id = contactId as Id<'contacts'>
  // The form, note editors and composer report here; the guard reads it.
  const work = useUnsavedWork()
  const live = useContactView(tenant._id, id)
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
          <ContactForm key={`${tenant._id}:${id}`} id={id} data={data} />
          <ContactNotes contactId={id} />
        </div>
        <ContactHistory
          id={id}
          version={rootVersion(data.contact)}
          archived={data.contact.archived}
          archiveVersion={data.contact.archiveVersion}
        />
      </main>
      <LeaveGuard work={work} />
    </UnsavedWorkProvider>
  )
}
