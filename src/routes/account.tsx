import { Link, Navigate, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import {
  AuthForm,
  EnrolForm,
  RecoveryCodesNotice,
  StepUpForm,
  field,
  input,
  linkButton,
  primary,
} from '../components/auth-steps'
import { authErrorMessage, needsStepUp } from '../lib/auth-errors'
import {
  SessionLoading,
  SignedIn,
  SignedOut,
  useAccount,
  useAccountActions,
  useSignOut,
} from '../lib/data'

export const Route = createFileRoute('/account')({ component: Account })

/** Your account: password, second step, recovery codes, sign out. */
function Account() {
  return (
    <main className="mx-auto flex max-w-lg flex-col gap-8 p-6">
      <h1 className="text-2xl font-semibold">Your account</h1>
      <SessionLoading>
        <p className="text-sm text-neutral-500">Loading…</p>
      </SessionLoading>
      <SignedOut>
        <Navigate to="/sign-in" replace />
      </SignedOut>
      <SignedIn>
        <Signed />
      </SignedIn>
    </main>
  )
}

function Signed() {
  const account = useAccount()
  const actions = useAccountActions()
  const signOut = useSignOut()
  const [codes, setCodes] = useState<Array<string> | null>(null)
  const [after, setAfter] = useState<(() => Promise<void>) | null>(null)
  const [stepUp, setStepUp] = useState<(() => Promise<void>) | null>(null)
  const [enrolling, setEnrolling] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  /** Run `f`; if it needs a recent sign-in, ask for one and run it again. */
  async function guarded(f: () => Promise<void>) {
    setNotice(null)
    try {
      await f()
    } catch (err) {
      if (needsStepUp(err)) setStepUp(() => f)
      else setNotice(authErrorMessage(err))
    }
  }

  if (!account) return <p className="text-sm text-neutral-500">Loading…</p>
  if (codes)
    return (
      <RecoveryCodesNotice
        codes={codes}
        onDone={() => {
          setCodes(null)
          void after?.()
          setAfter(null)
        }}
      />
    )
  if (stepUp)
    return (
      <StepUpForm
        method={account.method}
        onCancel={() => setStepUp(null)}
        onDone={async () => {
          const f = stepUp
          setStepUp(null)
          await guarded(f)
        }}
      />
    )
  if (enrolling)
    return (
      <EnrolForm
        onEnrolled={(c, done) => {
          setEnrolling(false)
          setCodes(c)
          setAfter(() => done)
        }}
      />
    )

  return (
    <>
      <section className="flex flex-col gap-1 text-sm">
        <p>
          Signed in as <strong>{account.email}</strong>
        </p>
        <p>
          Second step:{' '}
          {account.method === 'totp'
            ? 'authenticator app'
            : account.method === 'email'
              ? 'emailed code'
              : 'none'}
          {' · '}
          {account.recoveryCodesLeft} recovery codes left
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Change password</h2>
        <AuthForm
          submit="Change password"
          onSubmit={async (d) => {
            await actions.changePassword(field(d, 'current'), field(d, 'new'))
            setNotice('Password changed. Your other sessions are signed out.')
          }}
        >
          <input
            name="current"
            type="password"
            required
            autoComplete="current-password"
            placeholder="Current password"
            className={input}
          />
          <input
            name="new"
            type="password"
            required
            autoComplete="new-password"
            placeholder="New password (at least 8 characters)"
            className={input}
          />
        </AuthForm>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Second step</h2>
        <button
          type="button"
          className={primary}
          onClick={() =>
            void guarded(async () => {
              setCodes(await actions.newRecoveryCodes())
            })
          }
        >
          New recovery codes
        </button>
        <button
          type="button"
          className={primary}
          onClick={() =>
            // Changing method needs a recent sign-in: the server says so
            // on the first enrol call; ask first instead.
            setStepUp(() => async () => setEnrolling(true))
          }
        >
          Change how you sign in
        </button>
      </section>

      {notice && (
        <p role="status" className="text-sm text-neutral-700">
          {notice}
        </p>
      )}

      <section className="flex gap-4">
        <Link to="/" className={linkButton}>
          Back to your group
        </Link>
        <button
          type="button"
          className={linkButton}
          onClick={() => void signOut()}
        >
          Sign out
        </button>
      </section>
    </>
  )
}
