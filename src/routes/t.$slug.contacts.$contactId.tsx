import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useRef } from 'react'
import type { Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import { assembleView } from '../../convex/contacts/view'
import { cachedTenant, useTenant } from '../lib/tenant'
import { useQuery } from '../lib/query-cache'
import { contactSeed, dropContactSeed } from '../lib/contact-seed'
import type { ContactView } from '../lib/contact-seed'
import type { SourceCodeDescription } from '../../convex/sources/code'
import type { FieldDefinition } from '../../convex/contacts/fieldTypes'
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
    convex.prewarmQuery({
      query: api.contacts.fields.list,
      args: { tenantId: tenant._id },
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
  fields: Array<FieldDefinition> | undefined,
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
  // The code's description last shown on this contact. A save that
  // changes the code moves the root a moment before the new description
  // may answer (the picker subscribes to it before saving, so usually
  // not): meanwhile the page keeps the last one rather than dropping to
  // "Loading…". Only the description is held, never the root or other
  // slices, so counters stay current; the picker shows its pending code
  // until the description catches up with the root (ContactAcquisition).
  const lastAcquisition = useRef<{
    id: Id<'contacts'>
    acquisition: SourceCodeDescription | null
  } | null>(null)
  const live = codeId ? described : null
  if (live !== undefined) lastAcquisition.current = { id, acquisition: live }
  const acquisition =
    live === undefined && lastAcquisition.current?.id === id
      ? lastAcquisition.current.acquisition
      : live
  // Shared with the form's type picker (archived types included).
  const types = useQuery(api.contacts.queries.listIdentifierTypes, {
    tenantId,
    includeInactive: true,
  })
  return useMemo(() => {
    if (root === null) return null
    if (
      root === undefined ||
      channels === undefined ||
      tags === undefined ||
      identifiers === undefined ||
      acquisition === undefined ||
      types === undefined ||
      fields === undefined
    )
      return undefined
    return assembleView({
      root,
      channels,
      tags,
      identifiers,
      types,
      acquisition,
      fields,
    })
  }, [root, channels, tags, identifiers, acquisition, types, fields])
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
  // The field definitions name the contact's values and are the form's
  // dropdowns: one subscription for both.
  const fields = useQuery(api.contacts.fields.list, { tenantId: tenant._id })
  const live = useContactView(tenant._id, id, fields)
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
          <ContactNotes contactId={id} />
        </div>
        {/* Keyed like the form: a restore notice belongs to its contact. */}
        <ContactHistory
          key={`${tenant._id}:${id}`}
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
