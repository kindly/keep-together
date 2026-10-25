import { useState } from 'react'
import { useAddressLookup, useAddressLookupOn } from '../lib/data'
import type { LookupAddress, LookupOutcome } from '../lib/data'
import { useCanWrite } from '../lib/tenant'

/** What each outcome other than a list says. */
const MESSAGES = {
  none: 'No addresses for that postcode',
  unavailable: 'Lookup unavailable: type the address',
  cap: 'Lookups used up this month: type the address',
} as const

/** An address on one line, for the pick list. */
export const oneLine = (a: LookupAddress) =>
  [a.line1, a.line2, a.line3, a.town, a.postcode].filter(Boolean).join(', ')

/**
 * "Find address" for one address row: a postcode, then the addresses at
 * it; a pick hands the address to `onPick`, which fills the row (an edit
 * like typing, so it autosaves). Typing the address by hand always works.
 * Hidden for viewers and when the deployment has no lookup.
 */
export function FindAddress({
  postcode,
  onPick,
}: {
  /** The row's postcode, to start from. */
  postcode: string
  onPick: (address: LookupAddress) => void
}) {
  const on = useAddressLookupOn()
  const canWrite = useCanWrite()
  const lookup = useAddressLookup()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<LookupOutcome | null>(null)
  if (!on || !canWrite) return null

  const find = async () => {
    if (busy || !query.trim()) return
    setBusy(true)
    setOutcome(null)
    try {
      setOutcome(await lookup(query))
    } finally {
      setBusy(false)
    }
  }
  const close = () => {
    setOpen(false)
    setOutcome(null)
  }

  if (!open)
    return (
      <button
        type="button"
        onClick={() => {
          setQuery(postcode)
          setOpen(true)
        }}
        className="self-start text-sm text-blue-700 hover:underline"
      >
        Find address
      </button>
    )

  const message =
    outcome === null || outcome.kind === 'found'
      ? null
      : outcome.kind === 'invalid'
        ? outcome.message
        : MESSAGES[outcome.kind]
  return (
    <div className="flex flex-col gap-2 rounded border border-neutral-200 p-2">
      <div className="flex gap-2">
        <input
          type="text"
          aria-label="Postcode to look up"
          placeholder="Postcode"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Not the contact form's submit.
            if (e.key === 'Enter') {
              e.preventDefault()
              void find()
            }
          }}
          className="w-32 rounded border border-neutral-300 px-3 py-1.5"
        />
        <button
          type="button"
          onClick={() => void find()}
          disabled={busy || !query.trim()}
          className="rounded border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {busy ? 'Finding…' : 'Find'}
        </button>
        <button
          type="button"
          onClick={close}
          className="text-sm text-neutral-600 hover:underline"
        >
          Cancel
        </button>
      </div>
      {message && (
        <p role="status" className="text-sm text-amber-800">
          {message}
        </p>
      )}
      {outcome?.kind === 'found' && (
        // Not a <ul>: the section's rows are its `ul > li`.
        <div
          role="group"
          aria-label="Addresses found"
          className="flex flex-col"
        >
          {outcome.addresses.map((a, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                onPick(a)
                close()
              }}
              className="w-full rounded px-2 py-1 text-left text-sm hover:bg-neutral-100"
            >
              {oneLine(a)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
