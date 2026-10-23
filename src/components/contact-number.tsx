import { useEffect, useRef, useState } from 'react'
import { formatNumber } from '../../convex/contacts/number'

/**
 * The contact number as staff write it (`100016`), with a copy button for
 * pasting it into an email or a spreadsheet. Nothing until the contact has
 * a number (one created before numbers, not yet backfilled).
 *
 * The clipboard API needs a secure context; served over plain http (a
 * local build over Tailscale) it is missing, so the button selects the
 * number instead, ready for Ctrl+C.
 */
export function ContactNumber({ sequence }: { sequence: number | undefined }) {
  const [copied, setCopied] = useState<'copied' | 'selected' | null>(null)
  const text = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (copied === null) return
    const t = setTimeout(() => setCopied(null), 2000)
    return () => clearTimeout(t)
  }, [copied])
  if (sequence === undefined) return null
  const written = formatNumber(sequence)
  const select = () => {
    const range = document.createRange()
    if (!text.current) return
    range.selectNodeContents(text.current)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    setCopied('selected')
  }
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
        aria-label={`copy contact number ${written}`}
        onClick={() => {
          // Typed as always there, but [SecureContext]: absent over http.
          if (!('clipboard' in navigator)) return select()
          navigator.clipboard
            .writeText(written)
            .then(() => setCopied('copied'), select)
        }}
        className="rounded border border-neutral-300 px-1.5 text-xs hover:bg-neutral-50"
      >
        {copied === 'copied'
          ? 'copied'
          : copied === 'selected'
            ? 'press Ctrl+C'
            : 'copy'}
      </button>
    </p>
  )
}
