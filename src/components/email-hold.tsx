import { useMutation } from 'convex/react'
import { useState } from 'react'
import { api } from '../../convex/_generated/api'
import type { Hold } from '../lib/email-hold'
import { holdLine, releaseFailure } from '../lib/email-hold'
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
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    if (!hold) return
    setOpen(false)
    setError(null)
    try {
      await release({
        tenantId: tenant._id,
        address,
        expected: hold.saveVersion,
        note,
      })
      setNote('')
    } catch (err) {
      setError(releaseFailure(err))
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
              onClick={() => setOpen(true)}
              className="ml-auto text-neutral-600 underline"
            >
              Release
            </button>
          )}
        </div>
      )}
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
      <AlertDialog open={open} onOpenChange={setOpen}>
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
              placeholder="They've fixed their mailbox"
              onChange={(e) => setNote(e.target.value)}
              className="rounded border border-neutral-300 px-3 py-1.5"
            />
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
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
