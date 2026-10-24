import { useState } from 'react'
import { useSetStaffCanManage } from '../lib/data'
import type { ListKind } from '../lib/data/rust-types/ListKind'
import { useIsAdmin, useTenant } from '../lib/tenant'

const LABELS = {
  identifierTypes: {
    label: 'Staff can manage identifier types',
    help: 'When off, only admins create, rename and archive identifier types. Staff can always add identifiers to contacts.',
  },
  sourceCodes: {
    label: 'Staff can manage source codes',
    help: 'When off, only admins add, rename, archive and delete source codes. Staff can always put a code on a contact.',
  },
  fields: {
    label: 'Staff can manage fields',
    help: 'When off, only admins add, rename, archive and retire fields and their options. Staff can always set a field on a contact.',
  },
} satisfies Record<ListKind, { label: string; help: string }>

/**
 * One list's admin-only "staff can manage …" switch, at the top of that
 * list's settings tab; renders nothing for anyone else. Each list has its
 * own switch and counter, so they never conflict.
 */
export function StaffListSwitch({ kind }: { kind: ListKind }) {
  const isAdmin = useIsAdmin()
  const tenant = useTenant()
  const [error, setError] = useState<string | null>(null)
  // No optimistic update: the switch moves when the server's answer
  // arrives through the groups refetch, with the counter the next save
  // needs.
  const save = useSetStaffCanManage(tenant)
  if (!isAdmin) return null

  const checked = {
    identifierTypes: tenant.staffCanManageIdentifierTypes,
    sourceCodes: tenant.staffCanManageSourceCodes,
    fields: tenant.staffCanManageFields,
  }[kind]

  async function toggle(on: boolean) {
    setError(null)
    const outcome = await save(kind, on)
    if (outcome === 'stale')
      setError('Another admin changed this just now; check it and try again')
    else if (outcome === 'failed') setError('Could not save')
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
