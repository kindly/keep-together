import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation } from 'convex/react'
import { ConvexError } from 'convex/values'
import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { api } from '../../convex/_generated/api'
import { useCanWrite, useTenant } from '../lib/tenant'
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
  externalIdentifier: '',
})

function NewContact() {
  const tenant = useTenant()
  const canWrite = useCanWrite()
  const navigate = useNavigate()
  const create = useMutation(api.contacts.mutations.create)
  // Minted once per form: a double submit lands on the existing contact.
  const clientKey = useMemo(() => crypto.randomUUID(), [])
  const [details, setDetails] = useState(blank('individual'))
  const [problems, setProblems] = useState<
    Array<{ field: string; message: string }>
  >([])
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      const id = await create({ tenantId: tenant._id, clientKey, ...details })
      await navigate({
        to: '/t/$slug/contacts/$contactId',
        params: { slug: tenant.slug, contactId: id },
      })
    } catch (err) {
      const data =
        err instanceof ConvexError
          ? (err.data as Record<string, unknown>)
          : null
      if (data?.kind === 'invalid') {
        setProblems(data.problems as Array<{ field: string; message: string }>)
      } else if (data?.kind === 'rejected' && data.reason === 'duplicate') {
        await navigate({
          to: '/t/$slug/contacts/$contactId',
          params: { slug: tenant.slug, contactId: String(data.message) },
        })
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
