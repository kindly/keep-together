import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { AuthForm, field, input, linkButton } from '../components/auth-steps'
import { LINK_EXPIRED } from '../lib/auth-errors'
import { resetCheck, resetComplete, resetRequest } from '../lib/data'
import { useLinkToken } from '../lib/link-token'

export const Route = createFileRoute('/reset')({ component: Reset })

/**
 * `/reset`: ask for a link. `/reset#<token>` (from the email): choose a
 * new password. The answer to a request is the same whether or not the
 * address has an account.
 */
function Reset() {
  const token = useLinkToken()
  return (
    <main className="mx-auto flex max-w-sm flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Reset your password</h1>
      {token ? <NewPassword token={token} /> : <Request />}
      <Link to="/sign-in" className={`self-start ${linkButton}`}>
        Back to sign in
      </Link>
    </main>
  )
}

function Request() {
  const [sent, setSent] = useState(false)
  if (sent)
    return (
      <p className="text-sm text-neutral-600">
        If that address has an account, we've emailed it a link. It works
        once, for 15 minutes.
      </p>
    )
  return (
    <AuthForm
      submit="Email me a link"
      onSubmit={async (d) => {
        await resetRequest(field(d, 'email'))
        setSent(true)
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
    </AuthForm>
  )
}

function NewPassword({ token }: { token: string }) {
  const [valid, setValid] = useState<boolean | null>(null)
  const [done, setDone] = useState(false)
  useEffect(() => {
    resetCheck(token).then(
      (r) => setValid(r.valid),
      () => setValid(false),
    )
  }, [token])
  if (valid === null)
    return <p className="text-sm text-neutral-500">Checking the link…</p>
  if (!valid) return <p className="text-sm text-red-700">{LINK_EXPIRED}</p>
  if (done)
    return (
      <p className="text-sm text-neutral-600">
        Password changed, and you're signed out everywhere. Sign in with the
        new one.
      </p>
    )
  return (
    <AuthForm
      submit="Set password"
      onSubmit={async (d) => {
        await resetComplete(token, field(d, 'password'))
        setDone(true)
      }}
    >
      <p className="text-sm text-neutral-500">At least 8 characters.</p>
      <input
        name="password"
        type="password"
        required
        autoComplete="new-password"
        placeholder="New password"
        className={input}
      />
    </AuthForm>
  )
}
