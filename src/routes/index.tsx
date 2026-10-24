import { Navigate, createFileRoute } from '@tanstack/react-router'
import { useAuthActions } from '@convex-dev/auth/react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { PASSWORD_MIN_LENGTH } from '../../convex/lib/password'
import { authErrorMessage } from '../lib/auth-errors'
import { landingTenant } from '../lib/tenant'
import {
  BACKEND,
  SessionLoading,
  SignedIn,
  SignedOut,
  useMyTenants,
  useSignOut,
} from '../lib/data'
import { DevSignIn } from '../components/dev-sign-in'

export const Route = createFileRoute('/')({ component: Home })

// Sign in, then straight into a group: never a list of groups (cash-gifts
// g2q3, g3q1). Groups are created by the operator from the CLI (README,
// "Create a tenant"); switching between them is in Settings.
function Home() {
  return (
    <main className="mx-auto max-w-lg p-6">
      <h1 className="text-2xl font-semibold">keep-together</h1>
      <SessionLoading>
        <p className="mt-6 text-sm text-neutral-500">Loading…</p>
      </SessionLoading>
      <SignedOut>{BACKEND === 'rust' ? <DevSignIn /> : <SignIn />}</SignedOut>
      <SignedIn>
        <Landing />
      </SignedIn>
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

/** Into the group last used (else the first by name), or "no group yet". */
function Landing() {
  const signOut = useSignOut()
  const tenants = useMyTenants()
  if (tenants === undefined)
    return <p className="mt-6 text-sm text-neutral-500">Loading…</p>
  const landing = landingTenant(tenants)
  if (landing)
    return <Navigate to="/t/$slug" params={{ slug: landing.slug }} replace />
  return (
    <section className="mt-6 flex flex-col gap-6">
      <p className="text-sm text-neutral-500">
        You don't belong to a group yet. Ask your group's admin for an invite.
      </p>
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
