import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { StepUpForm, input, linkButton, primary } from '../components/auth-steps'
import { authErrorMessage, needsStepUp } from '../lib/auth-errors'
import {
  useAuthState,
  useMemberActions,
  useMembersPage,
} from '../lib/data'
import type { Role } from '../lib/data'
import { useTenant } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/settings/members')({
  component: Members,
})

const ROLES: Array<Role> = ['admin', 'staff', 'viewer']

/**
 * Who belongs to the group. Every member sees the list; admins invite,
 * change roles, remove, and reset someone's second step, each after a
 * sign-in within the hour (else they confirm it's them first). A group
 * always keeps one admin.
 */
function Members() {
  const tenant = useTenant()
  const page = useMembersPage(tenant.slug)
  const actions = useMemberActions(tenant.slug)
  const auth = useAuthState()
  const admin = tenant.role === 'admin'
  const [stepUp, setStepUp] = useState<(() => Promise<void>) | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function guarded(f: () => Promise<void>, done?: string) {
    setNotice(null)
    try {
      await f()
      if (done) setNotice(done)
    } catch (err) {
      if (needsStepUp(err)) setStepUp(() => () => guarded(f, done))
      else setNotice(authErrorMessage(err))
    }
  }

  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const d = new FormData(form)
    const email = String(d.get('email') ?? '')
    const role = String(d.get('role') ?? 'staff') as Role
    await guarded(async () => {
      await actions.invite(email, role)
      form.reset()
    }, `Invite sent to ${email}.`)
  }

  if (!page) return <p className="text-sm text-neutral-500">Loading…</p>
  return (
    <section className="flex flex-col gap-6">
      {stepUp && (
        <StepUpForm
          method={auth?.method ?? null}
          onCancel={() => setStepUp(null)}
          onDone={async () => {
            const f = stepUp
            setStepUp(null)
            await f()
          }}
        />
      )}
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-neutral-500">
            <th className="py-2 font-normal">Email</th>
            <th className="py-2 font-normal">Role</th>
            {admin && <th className="py-2 font-normal">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {page.members.map((m) => (
            <tr key={m.userId} className="border-b border-neutral-100">
              <td className="py-2">
                {m.email}
                {m.you && <span className="text-neutral-500"> (you)</span>}
              </td>
              <td className="py-2">
                {admin ? (
                  <select
                    aria-label={`Role of ${m.email}`}
                    value={m.role}
                    className="rounded border border-neutral-300 px-2 py-1"
                    onChange={(e) => {
                      const role = e.target.value as Role
                      void guarded(() => actions.setRole(m.userId, role, m.you))
                    }}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                ) : (
                  m.role
                )}
              </td>
              {admin && (
                <td className="flex gap-3 py-2">
                  <button
                    type="button"
                    className={linkButton}
                    onClick={() =>
                      window.confirm(`Remove ${m.email} from ${tenant.name}?`) &&
                      void guarded(
                        () => actions.remove(m.userId),
                        `${m.email} removed.`,
                      )
                    }
                  >
                    Remove
                  </button>
                  <button
                    type="button"
                    className={linkButton}
                    onClick={() =>
                      window.confirm(
                        `Reset ${m.email}'s second step? They'll set it up again at their next sign-in.`,
                      ) &&
                      void guarded(
                        () => actions.reset2fa(m.userId),
                        `${m.email} will set up their second step again.`,
                      )
                    }
                  >
                    Reset 2FA
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {page.invites.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">Invited</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {page.invites.map((i) => (
              <li key={i.id} className="flex gap-3">
                <span>
                  {i.email} as {i.role}
                  {i.expiresAt < Date.now() && (
                    <span className="text-neutral-500"> (expired)</span>
                  )}
                </span>
                {admin && (
                  <button
                    type="button"
                    className={linkButton}
                    onClick={() =>
                      void guarded(() => actions.revokeInvite(i.id))
                    }
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {admin && (
        <form onSubmit={(e) => void invite(e)} className="flex flex-col gap-3">
          <h2 className="font-medium">Invite someone</h2>
          <div className="flex flex-wrap gap-2">
            <input
              name="email"
              type="email"
              required
              placeholder="Email"
              aria-label="Email to invite"
              className={`${input} grow`}
            />
            <select
              name="role"
              defaultValue="staff"
              aria-label="Role"
              className="rounded border border-neutral-300 px-2 py-2"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <button type="submit" className={primary}>
              Send invite
            </button>
          </div>
        </form>
      )}
      {notice && (
        <p role="status" className="text-sm text-neutral-700">
          {notice}
        </p>
      )}
    </section>
  )
}
