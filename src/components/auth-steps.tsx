import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { authErrorMessage } from '../lib/auth-errors'
import { useSignInSteps } from '../lib/data'
import type { Method } from '../lib/data'

/**
 * The pieces of the sign-in flow that several pages share: the code
 * form, setting up a second factor, the recovery codes, and step-up.
 */

export const input = 'rounded border border-neutral-300 px-3 py-2'
export const primary =
  'rounded bg-neutral-900 px-3 py-2 text-white hover:bg-neutral-700 disabled:opacity-50'
export const linkButton = 'text-sm text-neutral-600 underline'

/** A form whose submit runs `action`, showing its error, if any. */
export function AuthForm({
  onSubmit,
  children,
  submit,
}: {
  onSubmit: (data: FormData) => Promise<void>
  children: ReactNode
  submit: string
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function handle(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await onSubmit(new FormData(e.currentTarget))
    } catch (err) {
      setError(authErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={handle} className="flex flex-col gap-3">
      {children}
      <button type="submit" className={primary} disabled={busy}>
        {submit}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </form>
  )
}

export const field = (data: FormData, name: string) =>
  String(data.get(name) ?? '')

export function CodeInput({
  label,
  name = 'code',
}: {
  label: string
  name?: string
}) {
  return (
    <input
      name={name}
      required
      autoComplete="one-time-code"
      inputMode="text"
      placeholder={label}
      aria-label={label}
      className={input}
    />
  )
}

/** The second step of a sign-in: a code from the app or the email. */
export function SecondFactorForm({
  method,
  email,
}: {
  method: Method | null
  email: string | null
}) {
  const steps = useSignInSteps()
  const [sent, setSent] = useState<string | null>(null)
  return (
    <section className="flex flex-col gap-4">
      <p className="text-sm text-neutral-600">
        {method === 'email'
          ? `We've emailed a 6-digit code to ${email ?? 'you'}.`
          : 'Enter the 6-digit code from your authenticator app.'}{' '}
        Or use one of your recovery codes.
      </p>
      <AuthForm
        submit="Verify"
        onSubmit={async (d) => {
          await steps.secondFactor(field(d, 'code'))
        }}
      >
        <CodeInput label="Code" />
      </AuthForm>
      {method === 'email' && (
        <button
          type="button"
          className={`self-start ${linkButton}`}
          onClick={() =>
            void steps.sendCode().then(
              () => setSent('A new code is on its way.'),
              (err: unknown) => setSent(authErrorMessage(err)),
            )
          }
        >
          Send a new code
        </button>
      )}
      {sent && <p className="text-sm text-neutral-600">{sent}</p>}
    </section>
  )
}

/**
 * Set up a second factor: an authenticator app (QR code) or emailed
 * codes. `onEnrolled` gets the recovery codes and a `done` that moves the
 * session on (signed in): call it once they've been seen.
 * `needsEmailCode`: after a 2FA reset, the code we emailed at sign-in goes
 * with the app's code (the emailed method's own code is that proof).
 */
export function EnrolForm({
  onEnrolled,
  needsEmailCode = false,
}: {
  onEnrolled: (codes: Array<string>, done: () => Promise<void>) => void
  needsEmailCode?: boolean
}) {
  const steps = useSignInSteps()
  const [method, setMethod] = useState<Method | null>(null)
  const [totp, setTotp] = useState<{ secret: string; qrSvg: string } | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)

  async function choose(m: Method) {
    setError(null)
    try {
      if (m === 'totp') setTotp(await steps.enrolTotp())
      else await steps.enrolEmail()
      setMethod(m)
    } catch (err) {
      setError(authErrorMessage(err))
    }
  }

  // The app's code and, after a reset, the one emailed at sign-in.
  const proof = needsEmailCode && method === 'totp'

  if (!method) {
    return (
      <section className="flex flex-col gap-3">
        <p className="text-sm text-neutral-600">
          Set up a second step for signing in. You'll need it every time.
        </p>
        {needsEmailCode && (
          <p className="text-sm text-neutral-600">
            Your second step was reset, so we've also emailed you a code to
            confirm it's you.
          </p>
        )}
        <button
          type="button"
          className={primary}
          onClick={() => void choose('totp')}
        >
          Use an authenticator app
        </button>
        <button
          type="button"
          className={primary}
          onClick={() => void choose('email')}
        >
          Email me a code each time
        </button>
        {error && <p className="text-sm text-red-700">{error}</p>}
      </section>
    )
  }
  return (
    <section className="flex flex-col gap-4">
      {method === 'totp' && totp ? (
        <>
          <p className="text-sm text-neutral-600">
            Scan this with your authenticator app, then enter the code it shows.
          </p>
          <img
            alt="QR code for your authenticator app"
            className="h-48 w-48 self-center"
            src={`data:image/svg+xml;utf8,${encodeURIComponent(totp.qrSvg)}`}
          />
          <p className="text-xs text-neutral-500">
            Can't scan? Enter this key:{' '}
            <code className="break-all" data-testid="totp-secret">
              {totp.secret}
            </code>
          </p>
        </>
      ) : (
        <p className="text-sm text-neutral-600">
          We've emailed you a 6-digit code. Enter it to confirm.
        </p>
      )}
      <AuthForm
        submit="Confirm"
        onSubmit={async (d) => {
          const out = await steps.confirmEnrolment(
            method,
            field(d, 'code'),
            proof ? field(d, 'emailCode') : undefined,
          )
          onEnrolled(out.recoveryCodes, out.done)
        }}
      >
        <CodeInput label={proof ? "The app's code" : 'Code'} />
        {proof && <CodeInput name="emailCode" label="The emailed code" />}
      </AuthForm>
      <button
        type="button"
        className={`self-start ${linkButton}`}
        onClick={() => setMethod(null)}
      >
        Choose another way
      </button>
    </section>
  )
}

/** The recovery codes, shown once. */
export function RecoveryCodesNotice({
  codes,
  onDone,
}: {
  codes: Array<string>
  onDone: () => void
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">Your recovery codes</h2>
      <p className="text-sm text-neutral-600">
        Each one signs you in once if you lose your second step. Keep them
        somewhere safe: you won't see them again.
      </p>
      <ul
        aria-label="Recovery codes"
        className="grid grid-cols-2 gap-1 rounded border border-neutral-200 bg-white p-3 font-mono text-sm"
      >
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <button type="button" className={primary} onClick={onDone}>
        I've saved them
      </button>
    </section>
  )
}

/** Password and a code again, for an admin action after an hour. */
export function StepUpForm({
  method,
  onDone,
  onCancel,
}: {
  method: Method | null
  onDone: () => Promise<void>
  onCancel: () => void
}) {
  const steps = useSignInSteps()
  const [sent, setSent] = useState(false)
  return (
    <section
      role="dialog"
      aria-label="Confirm it's you"
      className="flex flex-col gap-3 rounded border border-neutral-300 bg-white p-4"
    >
      <h2 className="font-medium">Confirm it's you</h2>
      <p className="text-sm text-neutral-600">
        Admin changes need a recent sign-in. Enter your password and a code.
      </p>
      {method === 'email' && (
        <button
          type="button"
          className={`self-start ${linkButton}`}
          onClick={() => void steps.sendCode().then(() => setSent(true))}
        >
          {sent ? 'Code sent: send another' : 'Email me a code'}
        </button>
      )}
      <AuthForm
        submit="Confirm"
        onSubmit={async (d) => {
          await steps.stepUp(field(d, 'password'), field(d, 'code'))
          await onDone()
        }}
      >
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          placeholder="Password"
          className={input}
        />
        <CodeInput label="Code" />
      </AuthForm>
      <button
        type="button"
        className={`self-start ${linkButton}`}
        onClick={onCancel}
      >
        Cancel
      </button>
    </section>
  )
}
