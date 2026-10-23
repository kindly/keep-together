import { useEffect, useRef, useState } from 'react'
import { formatNumber } from '../../convex/contacts/number'

/** The copy shortcut as this platform's keyboard writes it. */
const copyKeys = () =>
  /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? '⌘C' : 'Ctrl+C'

/**
 * The contact number as staff write it (`100016`), with a copy button for
 * pasting it into an email or a spreadsheet. Nothing until the contact has
 * a number (one created before numbers, not yet backfilled).
 *
 * The clipboard API needs a secure context; served over plain http (a
 * local build over Tailscale) it is missing, so the button selects the
 * number instead, ready for Ctrl+C (⌘C on a Mac). Either outcome is also
 * announced through a polite live region.
 */
export function ContactNumber({ sequence }: { sequence: number | undefined }) {
  // A fresh object per click, so a repeat click restarts the reset timer.
  const [status, setStatus] = useState<
    { kind: 'copied' } | { kind: 'selected'; keys: string } | null
  >(null)
  const text = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (status === null) return
    const t = setTimeout(() => setStatus(null), 2000)
    return () => clearTimeout(t)
  }, [status])
  if (sequence === undefined) return null
  const written = formatNumber(sequence)
  const select = () => {
    const range = document.createRange()
    if (!text.current) return
    range.selectNodeContents(text.current)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    setStatus({ kind: 'selected', keys: copyKeys() })
  }
  const label =
    status === null
      ? 'copy'
      : status.kind === 'copied'
        ? 'copied'
        : `press ${status.keys}`
  return (
    <p className="flex items-center gap-2 text-sm text-neutral-600">
      contact no.{' '}
      <span
        ref={text}
        data-testid="contact-number"
        className="font-mono text-neutral-900 select-all"
      >
        {written}
      </span>
      <button
        type="button"
        // Starts with the visible text, so the name follows the state.
        aria-label={`${label}: contact number ${written}`}
        onClick={() => {
          // Typed as always there, but [SecureContext]: absent over http.
          if (!('clipboard' in navigator)) return select()
          navigator.clipboard
            .writeText(written)
            .then(() => setStatus({ kind: 'copied' }), select)
        }}
        className="rounded border border-neutral-300 px-1.5 text-xs hover:bg-neutral-50"
      >
        {label}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {status === null
          ? ''
          : status.kind === 'copied'
            ? `contact number ${written} copied`
            : `contact number ${written} selected, press ${status.keys} to copy`}
      </span>
    </p>
  )
}
