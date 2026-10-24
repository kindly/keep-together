import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { AuthForm, field, input, linkButton } from '../components/auth-steps'
import { LINK_EXPIRED, authErrorMessage } from '../lib/auth-errors'
import { inviteCheck, useSignInSteps } from '../lib/data'
import type { InviteInfo } from '../lib/data'
import { useLinkToken } from '../lib/link-token'

export const Route = createFileRoute('/invite')({ component: Invite })

/**
 * `/invite#<token>` (from the email): join the group. New to
 * keep-together: choose a password, then set up a second step. Already
 * have an account: your password, then your code.
 */
function Invite() {
  const token = useLinkToken()
  const [info, setInfo] = useState<InviteInfo | string | null>(null)
  const steps = useSignInSteps()
  const navigate = useNavigate()
  useEffect(() => {
    if (!token) return setInfo(LINK_EXPIRED)
    inviteCheck(token).then(setInfo, (err: unknown) =>
      setInfo(authErrorMessage(err)),
    )
  }, [token])

  let body
  if (info === null) {
    body = <p className="text-sm text-neutral-500">Checking the invite…</p>
  } else if (typeof info === 'string') {
    body = <p className="text-sm text-red-700">{info}</p>
  } else {
    body = (
      <section className="flex flex-col gap-3">
        <p>
          Join <strong>{info.group}</strong> as {info.role}, signing in as{' '}
          <strong>{info.email}</strong>.
        </p>
        <AuthForm
          submit="Accept invite"
          onSubmit={async (d) => {
            await steps.acceptInvite(token ?? '', field(d, 'password'))
            await navigate({ to: '/sign-in' })
          }}
        >
          {!info.hasAccount && (
            <p className="text-sm text-neutral-500">
              Choose a password: at least 8 characters.
            </p>
          )}
          <input
            name="password"
            type="password"
            required
            autoComplete={info.hasAccount ? 'current-password' : 'new-password'}
            placeholder={info.hasAccount ? 'Your password' : 'New password'}
            className={input}
          />
        </AuthForm>
      </section>
    )
  }
  return (
    <main className="mx-auto flex max-w-sm flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">You're invited</h1>
      {body}
      <Link to="/sign-in" className={`self-start ${linkButton}`}>
        Sign in instead
      </Link>
    </main>
  )
}
