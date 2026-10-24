import { Link, Navigate, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import {
  AuthForm,
  CodeInput,
  EnrolForm,
  RecoveryCodesNotice,
  SecondFactorForm,
  field,
  input,
  linkButton,
} from '../components/auth-steps'
import {
  useAuthState,
  useSignInNotice,
  useSignInSteps,
  useSignOut,
} from '../lib/data'

export const Route = createFileRoute('/sign-in')({ component: SignIn })

/**
 * Sign in: email and password, then the second step (a code from the
 * app or the email), or setting one up the first time. Staff accounts
 * come from invites; there is no sign-up.
 */
function SignIn() {
  const state = useAuthState()
  const signOut = useSignOut()
  const [codes, setCodes] = useState<{
    codes: Array<string>
    done: () => Promise<void>
  } | null>(null)

  let body
  if (codes) {
    body = (
      <RecoveryCodesNotice
        codes={codes.codes}
        onDone={() => void codes.done().then(() => setCodes(null))}
      />
    )
  } else if (!state) {
    body = <p className="text-sm text-neutral-500">Loading…</p>
  } else if (state.stage === 'signed_in') {
    return <Navigate to="/" replace />
  } else if (state.stage === 'second_factor') {
    body = <SecondFactorForm method={state.method} email={state.email} />
  } else if (state.stage === 'enrol') {
    body = (
      <EnrolForm
        needsEmailCode={state.needsEmailCode}
        onEnrolled={(c, done) => setCodes({ codes: c, done })}
      />
    )
  } else {
    body = <PasswordForm />
  }
  const partial =
    !codes && (state?.stage === 'second_factor' || state?.stage === 'enrol')

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">keep-together</h1>
      {body}
      {partial && (
        <button
          type="button"
          className={`self-start ${linkButton}`}
          onClick={() => void signOut()}
        >
          Start again
        </button>
      )}
    </main>
  )
}

function PasswordForm() {
  const steps = useSignInSteps()
  const notice = useSignInNotice()
  // Too many sign-ins for this address lately: the server emailed a code
  // (if the password was right); it goes with the same email and password.
  const [pending, setPending] = useState<{
    email: string
    password: string
  } | null>(null)

  if (pending) {
    return (
      <section className="flex flex-col gap-3">
        <p className="text-sm text-neutral-600">
          There have been several sign-ins for {pending.email} lately, so we've
          emailed it a 6-digit code as well. Enter it to carry on.
        </p>
        <AuthForm
          submit="Continue"
          onSubmit={async (d) => {
            await steps.signIn(
              pending.email,
              pending.password,
              field(d, 'code'),
            )
          }}
        >
          <CodeInput label="Emailed code" />
        </AuthForm>
        <button
          type="button"
          className={`self-start ${linkButton}`}
          onClick={() => setPending(null)}
        >
          Start again
        </button>
      </section>
    )
  }
  return (
    <section className="flex flex-col gap-3">
      {notice && (
        <p role="alert" className="text-sm text-red-700">
          {notice}
        </p>
      )}
      <AuthForm
        submit="Sign in"
        onSubmit={async (d) => {
          const email = field(d, 'email')
          const password = field(d, 'password')
          const state = await steps.signIn(email, password)
          if (state.stage === 'check_email') setPending({ email, password })
        }}
      >
        <input
          name="email"
          type="email"
          required
          autoComplete="username"
          placeholder="Email"
          className={input}
        />
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          placeholder="Password"
          className={input}
        />
      </AuthForm>
      <Link to="/reset" className={`self-start ${linkButton}`}>
        Forgot your password?
      </Link>
      <p className="text-sm text-neutral-500">
        New here? Ask your group's admin for an invite.
      </p>
    </section>
  )
}
