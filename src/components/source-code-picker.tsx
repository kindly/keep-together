import { useQuery as useLiveQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { api } from '../../convex/_generated/api'
import { dateStatus } from '../../convex/sources/rules'
import type { DateStatus } from '../../convex/sources/rules'
import { useTenant } from '../lib/tenant'

export type PickerEntry = FunctionReturnType<
  typeof api.sources.queries.picker
>['codes'][number]

/** A code as the picker shows it: picked just now, or described on a contact. */
export type ShownCode = {
  code: string
  /** False if the version or a parent is archived. */
  isActive: boolean
  startDate?: string
  endDate?: string
}

/** Today in the browser's time zone, YYYY-MM-DD: the picker's date hints. */
export function localToday(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const STATUS_HINT: Record<DateStatus, string | null> = {
  current: null,
  notStarted: 'not started',
  ended: 'ended',
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-neutral-100 px-1.5 text-xs text-neutral-600">
      {children}
    </span>
  )
}

/**
 * A source code picker (source codes plan, step 5): the current code with
 * its "archived" / "ended" / "not started" marks and a clear button, and a
 * search box listing assignable codes as you type (anywhere in the full
 * code, any case; in date first). An archived code a contact still carries
 * shows, marked, but the list never offers one (`sources.picker`).
 *
 * It sits inside forms: Enter picks the highlighted code and never
 * submits. Options take the click without the input losing focus.
 */
export function SourceCodePicker({
  value,
  onPick,
  onClear,
  pending,
  disabled,
  label = 'Source code',
}: {
  value: ShownCode | null
  onPick: (entry: PickerEntry) => void
  onClear: () => void
  /** A pick is saving: shown beside the code. */
  pending?: boolean
  disabled?: boolean
  label?: string
}) {
  const tenant = useTenant()
  const listId = useId()
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const today = localToday()
  // Not cached (lib/query-cache): the args change with every keystroke.
  // Until the new answer comes, the last one stands.
  const now = useLiveQuery(
    api.sources.queries.picker,
    open ? { tenantId: tenant._id, today, search } : 'skip',
  )
  const last = useRef(now)
  if (now !== undefined) last.current = now
  const found = open ? (now ?? last.current) : undefined
  const codes = found?.codes ?? []

  function pick(entry: PickerEntry) {
    setOpen(false)
    setSearch('')
    setActive(0)
    onPick(entry)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      const entry = codes.at(active)
      if (open && entry) pick(entry)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((i) => Math.min(i + 1, Math.max(codes.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  const status = value ? dateStatus(value, today) : null
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div
        className="flex flex-wrap items-center gap-2"
        data-testid="source-code"
      >
        {value ? (
          <>
            <span className="font-mono">{value.code}</span>
            {!value.isActive && <Hint>archived</Hint>}
            {status && STATUS_HINT[status] && (
              <Hint>{STATUS_HINT[status]}</Hint>
            )}
            {pending ? (
              <span className="text-xs text-neutral-500">saving…</span>
            ) : (
              <button
                type="button"
                aria-label={`clear ${label.toLowerCase()}`}
                onClick={onClear}
                disabled={disabled}
                className="text-neutral-500 hover:text-neutral-900"
              >
                ×
              </button>
            )}
          </>
        ) : (
          <span className="text-neutral-500">
            {pending ? 'saving…' : 'No source code.'}
          </span>
        )}
      </div>
      <div className="relative max-w-md">
        <input
          type="text"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          value={search}
          disabled={disabled}
          placeholder={value ? 'Change code…' : 'Type to search codes'}
          onChange={(e) => {
            setSearch(e.target.value)
            setActive(0)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          className="w-full rounded border border-neutral-300 px-3 py-1.5"
        />
        {open && found && (
          <ul
            id={listId}
            role="listbox"
            aria-label={`${label} matches`}
            className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded border border-neutral-200 bg-white shadow"
          >
            {codes.length === 0 && (
              <li className="px-3 py-2 text-neutral-500">No codes match.</li>
            )}
            {codes.map((entry, i) => (
              <li
                key={entry.versionId}
                role="option"
                aria-selected={i === active}
                // Keep focus in the input, so the click lands as a pick.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(entry)}
                onMouseEnter={() => setActive(i)}
                className={`flex cursor-pointer flex-col px-3 py-1.5 ${i === active ? 'bg-neutral-100' : ''}`}
              >
                <span className="flex items-center gap-2">
                  <span className="font-mono">{entry.code}</span>
                  {STATUS_HINT[entry.status] && (
                    <Hint>{STATUS_HINT[entry.status]}</Hint>
                  )}
                </span>
                {entry.description && (
                  <span className="truncate text-xs text-neutral-500">
                    {entry.description}
                  </span>
                )}
              </li>
            ))}
            {found.truncated && (
              <li className="px-3 py-1.5 text-xs text-neutral-500">
                More codes match: type more to narrow.
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  )
}
