import { useMutation } from 'convex/react'
import { ConvexError } from 'convex/values'
import { useState } from 'react'
import { api } from '../../convex/_generated/api'
import { useIsAdmin, useTenant } from '../lib/tenant'

const LABELS = {
  tags: {
    label: 'Staff can manage tags',
    help: 'When off, only admins create, rename and archive tags. Staff can always put tags on contacts.',
  },
  identifierTypes: {
    label: 'Staff can manage identifier types',
    help: 'When off, only admins create, rename and archive identifier types. Staff can always add identifiers to contacts.',
  },
}

/**
 * One list's admin-only "staff can manage …" switch, at the top of that
 * list's settings tab; renders nothing for anyone else. Each list has its
 * own switch and counter, so they never conflict.
 */
export function StaffListSwitch({
  kind,
}: {
  kind: 'tags' | 'identifierTypes'
}) {
  const isAdmin = useIsAdmin()
  const tenant = useTenant()
  const [error, setError] = useState<string | null>(null)
  // No optimistic update: the switch moves when the server's answer
  // arrives through `mine`, with the counter the next save needs.
  const saveTags = useMutation(api.platform.preferences.setStaffCanManageTags)
  const saveTypes = useMutation(
    api.platform.preferences.setStaffCanManageIdentifierTypes,
  )
  if (!isAdmin) return null

  const checked =
    kind === 'tags'
      ? tenant.staffCanManageTags
      : tenant.staffCanManageIdentifierTypes

  async function toggle(on: boolean) {
    setError(null)
    try {
      if (kind === 'tags') {
        await saveTags({
          tenantId: tenant._id,
          expected: tenant.tagsVersion ?? undefined,
          staffCanManageTags: on,
        })
      } else {
        await saveTypes({
          tenantId: tenant._id,
          expected: tenant.identifierTypesVersion ?? undefined,
          staffCanManageIdentifierTypes: on,
        })
      }
    } catch (err) {
      const errKind =
        err instanceof ConvexError
          ? (err.data as { kind?: string }).kind
          : undefined
      setError(
        errKind === 'stale'
          ? 'Another admin changed this just now; check it and try again'
          : 'Could not save',
      )
    }
  }

  return (
    <div className="flex flex-col gap-1 rounded border border-neutral-200 bg-white px-4 py-3">
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          onChange={(e) => void toggle(e.target.checked)}
          className="peer sr-only"
        />
        <span
          aria-hidden
          className="relative h-5 w-9 shrink-0 rounded-full bg-neutral-300 transition-colors peer-checked:bg-neutral-900 peer-focus-visible:ring-2 peer-focus-visible:ring-neutral-500 peer-focus-visible:ring-offset-2 after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4"
        />
        <span className="text-sm font-medium">{LABELS[kind].label}</span>
      </label>
      <p className="text-sm text-neutral-600">{LABELS[kind].help}</p>
      {error && (
        <span role="alert" className="text-sm text-red-700">
          {error}
        </span>
      )}
    </div>
  )
}
