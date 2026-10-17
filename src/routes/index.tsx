import { Link, createFileRoute } from '@tanstack/react-router'
import { useAuthActions } from '@convex-dev/auth/react'
import {
  AuthLoading,
  Authenticated,
  Unauthenticated,
  useMutation,
  useQuery,
} from 'convex/react'
import { ConvexError } from 'convex/values'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { api } from '../../convex/_generated/api'
import { PASSWORD_MIN_LENGTH } from '../../convex/lib/password'
import { authErrorMessage } from '../lib/auth-errors'

export const Route = createFileRoute('/')({ component: Home })

// Slice zero: sign in, see your groups, create one. Plain Tailwind for now;
// shadcn components arrive with the first designed page.
function Home() {
  return (
    <main className="mx-auto max-w-lg p-6">
      <h1 className="text-2xl font-semibold">keep-together</h1>
      <AuthLoading>
        <p className="mt-6 text-sm text-neutral-500">Loading…</p>
      </AuthLoading>
      <Unauthenticated>
        <SignIn />
      </Unauthenticated>
      <Authenticated>
        <Groups />
      </Authenticated>
    </main>
  )
}

function SignIn() {
  const { signIn } = useAuthActions()
  const [flow, setFlow] = useState<'signIn' | 'signUp'>('signIn')
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    data.set('flow', flow)
    setError(null)
    try {
      await signIn('password', data)
    } catch (err) {
      console.error(err)
      setError(authErrorMessage(err))
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-3">
      <input
        name="email"
        type="email"
        required
        autoComplete="email"
        placeholder="Email"
        className="rounded border border-neutral-300 px-3 py-2"
      />
      <input
        name="password"
        type="password"
        required
        autoComplete={flow === 'signIn' ? 'current-password' : 'new-password'}
        placeholder="Password"
        aria-describedby={flow === 'signUp' ? 'password-rule' : undefined}
        className="rounded border border-neutral-300 px-3 py-2"
      />
      {flow === 'signUp' && (
        <p id="password-rule" className="text-sm text-neutral-600">
          At least {PASSWORD_MIN_LENGTH} characters.
        </p>
      )}
      <button
        type="submit"
        className="rounded bg-neutral-900 px-3 py-2 text-white hover:bg-neutral-700"
      >
        {flow === 'signIn' ? 'Sign in' : 'Create account'}
      </button>
      <button
        type="button"
        className="text-sm text-neutral-600 underline"
        onClick={() => {
          setFlow(flow === 'signIn' ? 'signUp' : 'signIn')
          setError(null)
        }}
      >
        {flow === 'signIn'
          ? 'New here? Create an account'
          : 'Have an account? Sign in'}
      </button>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </form>
  )
}

function Groups() {
  const { signOut } = useAuthActions()
  const tenants = useQuery(api.platform.tenants.mine)
  const create = useMutation(api.platform.tenants.create)
  const [error, setError] = useState<string | null>(null)

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const data = new FormData(form)
    setError(null)
    try {
      await create({
        name: String(data.get('name') ?? ''),
        slug: String(data.get('slug') ?? ''),
      })
      form.reset()
    } catch (err) {
      const kind =
        err instanceof ConvexError
          ? (err.data as { kind?: string }).kind
          : undefined
      setError(
        kind === 'taken'
          ? 'That short name is already taken.'
          : kind === 'invalid'
            ? 'Short name: lowercase letters, digits and hyphens, 3–40 characters.'
            : 'Could not create the group.',
      )
    }
  }

  return (
    <section className="mt-6 flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-medium">Your groups</h2>
        {tenants === undefined ? (
          <p className="mt-2 text-sm text-neutral-500">Loading…</p>
        ) : tenants.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">
            You don't belong to a group yet.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-neutral-200 rounded border border-neutral-200">
            {tenants.map((t) => (
              <li
                key={t._id}
                className="flex items-baseline justify-between px-3 py-2"
              >
                <Link
                  to="/t/$slug/contacts"
                  params={{ slug: t.slug }}
                  className="underline"
                >
                  {t.name}
                </Link>
                <span className="text-xs text-neutral-500">
                  {t.slug} · {t.role}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form onSubmit={onCreate} className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Create a group</h2>
        <input
          name="name"
          required
          placeholder="Name, e.g. Anytown Village Hall"
          className="rounded border border-neutral-300 px-3 py-2"
        />
        <input
          name="slug"
          required
          pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]"
          placeholder="Short name, e.g. anytown-hall"
          className="rounded border border-neutral-300 px-3 py-2"
        />
        <button
          type="submit"
          className="rounded bg-neutral-900 px-3 py-2 text-white hover:bg-neutral-700"
        >
          Create
        </button>
        {error && <p className="text-sm text-red-700">{error}</p>}
      </form>

      <button
        type="button"
        onClick={() => void signOut()}
        className="self-start text-sm text-neutral-600 underline"
      >
        Sign out
      </button>
    </section>
  )
}
