import { Navigate, createFileRoute } from '@tanstack/react-router'
import { landingTenant } from '../lib/tenant'
import {
  SessionLoading,
  SignedIn,
  SignedOut,
  useMyTenants,
  useSignOut,
} from '../lib/data'

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
      <SignedOut>
        <Navigate to="/sign-in" replace />
      </SignedOut>
      <SignedIn>
        <Landing />
      </SignedIn>
    </main>
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
