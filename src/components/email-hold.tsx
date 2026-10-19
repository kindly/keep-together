import { useMutation } from 'convex/react'
import { useRef, useState } from 'react'
import { api } from '../../convex/_generated/api'
import { SUPPRESSION_NOTE_MAX } from '../../convex/comms/rules'
import type { Hold } from '../lib/email-hold'
import {
  NO_LONGER_HELD,
  holdKey,
  holdLine,
  isNotHeld,
  releaseFailure,
} from '../lib/email-hold'
import { useIsAdmin, useTenant } from '../lib/tenant'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog'

/**
 * An email row's hold: the "On hold" badge and why, and for admins a
 * Release button with a confirm dialog (ADR 0021). Rendered for every
 * email row, held or not, so a release's error outlives the badge it
 * removed. No optimistic update: the badge goes when `held` says so.
 *
 * An error belongs to the hold it was about (`holdKey`): it shows until
 * the row's address or hold changes, or the admin tries again or cancels.
 */
export function EmailHold({
  address,
  hold,
}: {
  address: string
  hold: Hold | undefined
}) {
  const tenant = useTenant()
  const isAdmin = useIsAdmin()
  const release = useMutation(api.comms.suppressions.release)
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState<{ text: string; key: string } | null>(null)
  const [pending, setPending] = useState(false)
  // Synchronous, unlike `pending`: a second click on the closing dialog
  // must not send a second release.
  const inFlight = useRef(false)
  const key = holdKey(address, hold)
  const current = useRef(key)
  current.current = key

  // The hold went while the dialog was open (released elsewhere, or the
  // address edited): close it and say so, rather than a dead button.
  if (open && !hold && !pending) {
    setOpen(false)
    setError({ text: NO_LONGER_HELD, key })
  }

  async function confirm() {
    if (inFlight.current) return
    setOpen(false)
    setError(null)
    if (!hold) {
      setError({ text: NO_LONGER_HELD, key })
      return
    }
    inFlight.current = true
    setPending(true)
    try {
      await release({
        tenantId: tenant._id,
        address,
        expected: hold.saveVersion,
        note,
      })
      setNote('')
    } catch (err) {
      // Not held any more: what the admin asked for, whoever did it.
      if (isNotHeld(err)) setNote('')
      else setError({ text: releaseFailure(err), key: current.current })
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }

  return (
    <>
      {hold && (
        <div className="flex items-center gap-2 text-xs">
          <span
            className="rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-800"
            title={holdLine(hold)}
          >
            On hold
          </span>
          <span className="text-neutral-600">{holdLine(hold)}</span>
          {isAdmin && (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setError(null)
                setOpen(true)
              }}
              className="ml-auto text-neutral-600 underline"
            >
              Release
            </button>
          )}
        </div>
      )}
      {error?.key === key && (
        <span role="alert" className="text-xs text-red-700">
          {error.text}
        </span>
      )}
      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) setError(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Release {address}?</AlertDialogTitle>
            <AlertDialogDescription>
              We'll send to this address again. If it still bounces, it goes
              back on hold.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-600">Note (optional)</span>
            <input
              type="text"
              value={note}
              maxLength={SUPPRESSION_NOTE_MAX}
              placeholder="They've fixed their mailbox"
              onChange={(e) => setNote(e.target.value)}
              className="rounded border border-neutral-300 px-3 py-1.5"
            />
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              // Not a close: confirm closes it itself.
              onClick={(e) => {
                e.preventDefault()
                void confirm()
              }}
            >
              Release
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
