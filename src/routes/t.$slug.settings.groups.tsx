import { Link, createFileRoute } from '@tanstack/react-router'
import { useMyTenants, useTenant } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/settings/groups')({
  component: SwitchGroup,
})

/**
 * Settings → Switch group: the caller's groups, each opening at its home.
 * The tab shows only to people in more than one group (cash-gifts g2q4);
 * signing in lands in the last one used, so this is the only list.
 */
function SwitchGroup() {
  const current = useTenant()
  const tenants = useMyTenants() ?? []
  const byName = [...tenants].sort((a, b) => a.name.localeCompare(b.name))
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">Switch group</h2>
      <ul className="divide-y divide-neutral-200 rounded border border-neutral-200 bg-white">
        {byName.map((t) => (
          <li
            key={t._id}
            className="flex items-baseline justify-between px-3 py-2"
          >
            {t._id === current._id ? (
              <span aria-current="true" className="font-medium">
                {t.name}{' '}
                <span className="text-xs text-neutral-500">(this group)</span>
              </span>
            ) : (
              <Link
                to="/t/$slug"
                params={{ slug: t.slug }}
                className="underline"
              >
                {t.name}
              </Link>
            )}
            <span className="text-xs text-neutral-500">
              {t.slug} · {t.role}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
