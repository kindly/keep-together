import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useConvex, useMutation, useQuery } from 'convex/react'
import { ConvexError } from 'convex/values'
import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { api } from '../../convex/_generated/api'
import { useCanWrite, useTenant } from '../lib/tenant'
import { seedContact } from '../lib/contact-seed'
import { DetailsFields } from '../components/contact-form'
import type { Payloads } from '../../convex/contacts/validators'

export const Route = createFileRoute('/t/$slug/contacts/new')({
  component: NewContact,
})

const blank = (kind: Payloads['details']['kind']): Payloads['details'] => ({
  kind,
  title: '',
  firstName: '',
  lastName: '',
  nickname: '',
  name: '',
  isDeceased: false,
})

function NewContact() {
  const tenant = useTenant()
  const canWrite = useCanWrite()
  const navigate = useNavigate()
  const create = useMutation(api.contacts.mutations.create)
  // Minted once per form: a double submit lands on the existing contact.
  const clientKey = useMemo(() => crypto.randomUUID(), [])
  // Watch for the contact this form creates: it arrives with the create's
  // result, so the contact page can render without a second round trip.
  const convex = useConvex()
  // Where a create lands: fetch the contact page's code now, while the form
  // is filled in, not after the create (its first visit costs 30–70 ms).
  const router = useRouter()
  useEffect(() => {
    void router.loadRouteChunk(
      router.routesById['/t/$slug/contacts/$contactId'],
    )
  }, [router])
  const watchArgs = { tenantId: tenant._id, clientKey }
  useQuery(api.contacts.queries.byClientKey, watchArgs)
  const toContact = async (id: string) => {
    const view = convex
      .watchQuery(api.contacts.queries.byClientKey, watchArgs)
      .localQueryResult()
    if (view?.contact._id === id) seedContact(id, view)
    await navigate({
      to: '/t/$slug/contacts/$contactId',
      params: { slug: tenant.slug, contactId: id },
    })
  }
  const [details, setDetails] = useState(blank('individual'))
  const [problems, setProblems] = useState<
    Array<{ field: string; message: string }>
  >([])
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await toContact(
        await create({ tenantId: tenant._id, clientKey, ...details }),
      )
    } catch (err) {
      const data =
        err instanceof ConvexError
          ? (err.data as Record<string, unknown>)
          : null
      if (data?.kind === 'invalid') {
        setProblems(data.problems as Array<{ field: string; message: string }>)
      } else if (data?.kind === 'rejected' && data.reason === 'duplicate') {
        await toContact(String(data.message))
      } else {
        setError(data ? String(data.message ?? data.kind) : 'Could not save')
      }
    }
  }

  if (!canWrite) {
    return (
      <main className="mx-auto max-w-2xl p-6 text-sm text-neutral-600">
        You have view-only access to {tenant.name}, so you can't add contacts.
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-xl font-semibold">New contact</h1>
      <form onSubmit={onSubmit} noValidate className="mt-6 flex flex-col gap-4">
        <label className="flex items-center gap-3 text-sm">
          Kind
          <select
            value={details.kind}
            onChange={(e) =>
              setDetails(blank(e.target.value as Payloads['details']['kind']))
            }
            className="rounded border border-neutral-300 px-2 py-1"
          >
            <option value="individual">Individual</option>
            <option value="organization">Organisation</option>
          </select>
        </label>
        <DetailsFields
          value={details}
          onChange={setDetails}
          problems={problems}
          conflicts={[]}
        />
        {error && <p className="text-sm text-red-700">{error}</p>}
        <button
          type="submit"
          className="self-start rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700"
        >
          Create
        </button>
      </form>
    </main>
  )
}
