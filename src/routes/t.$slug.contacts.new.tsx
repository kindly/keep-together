import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useCanWrite, useTenant } from '../lib/tenant'
import { FEATURES, useCreateContact } from '../lib/data'
import { DetailsFields } from '../components/contact-form'
import { SourceCodePicker } from '../components/source-code-picker'
import type { PickerEntry } from '../components/source-code-picker'
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
  // Idempotent per form: a double submit lands on the existing contact.
  const create = useCreateContact()
  // Where a create lands: fetch the contact page's code now, while the form
  // is filled in, not after the create (its first visit costs 30–70 ms).
  const router = useRouter()
  useEffect(() => {
    void router.loadRouteChunk(
      router.routesById['/t/$slug/contacts/$contactId'],
    )
  }, [router])
  const toContact = async (id: string) => {
    await navigate({
      to: '/t/$slug/contacts/$contactId',
      params: { slug: tenant.slug, contactId: id },
    })
  }
  const [details, setDetails] = useState(blank('individual'))
  const [code, setCode] = useState<PickerEntry | null>(null)
  const [problems, setProblems] = useState<
    Array<{ field: string; message: string }>
  >([])
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const outcome = await create(details, code?.versionId)
    if (outcome.type === 'created') await toContact(outcome.id)
    else if (outcome.type === 'invalid') setProblems(outcome.problems)
    else setError(outcome.message)
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
        {FEATURES.sourceCodes && (
          <section className="flex flex-col gap-1">
            <h2 className="text-sm text-neutral-600">
              Source code{' '}
              <span className="text-xs text-neutral-500">
                (how they were recruited)
              </span>
            </h2>
            <SourceCodePicker
              value={code && { ...code, isActive: true }}
              onPick={setCode}
              onClear={() => setCode(null)}
            />
            {problems
              .filter((p) => p.field === 'sourceCode')
              .map((p) => (
                <span key={p.message} className="text-xs text-red-700">
                  {p.message}
                </span>
              ))}
          </section>
        )}
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
