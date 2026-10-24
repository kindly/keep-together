import { useState } from 'react'
import type { FormEvent } from 'react'
import { useDevLogin } from '../lib/data/rust/hooks'

/**
 * Sign-in on the Rust backend: the spike's stub session (`POST
 * /api/dev/login`, refused unless the server runs with `KEEP_DEV_AUTH=1`).
 * An email and no password; groups are made with `POST /api/dev/tenants`.
 */
export function DevSignIn() {
  const login = useDevLogin()
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const email = String(new FormData(e.currentTarget).get('email') ?? '')
    setError(null)
    try {
      await login(email)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in')
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-3">
      <p className="text-sm text-neutral-600">
        Development sign-in (Rust backend): no password.
      </p>
      <input
        name="email"
        type="email"
        required
        autoComplete="email"
        placeholder="Email"
        className="rounded border border-neutral-300 px-3 py-2"
      />
      <button
        type="submit"
        className="rounded bg-neutral-900 px-3 py-2 text-white hover:bg-neutral-700"
      >
        Sign in
      </button>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </form>
  )
}
