import { useConvex, useMutation } from 'convex/react'
import { ConvexError } from 'convex/values'
import { useEffect, useState } from 'react'
import type { Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import type { SourceCodeDescription } from '../../convex/sources/code'
import { useTenant } from '../lib/tenant'
import { useHistoryHold } from './contact-history'
import { SourceCodePicker } from './source-code-picker'
import type { ShownCode } from './source-code-picker'

/** A user-facing line for a refused `setAcquisition`. */
function failure(err: unknown): string {
  if (!(err instanceof ConvexError)) return 'Could not save the source code'
  const d = err.data as {
    kind?: string
    message?: string
    problems?: Array<{ message: string }>
  }
  if (d.kind === 'stale')
    return 'Someone else changed the source code just now: check it and pick again'
  if (d.kind === 'invalid' && d.problems?.length)
    return d.problems.map((p) => p.message).join('; ')
  return d.message ?? d.kind ?? 'Could not save the source code'
}

/**
 * The contact's acquisition code (source codes plan, step 5): how they
 * were recruited. Saved on pick or clear through `setAcquisition`, outside
 * the form's autosave: it is one choice, never typed into, and its own
 * named action in history. A code archived since still shows, marked.
 * A set code is changed by removing it (after a confirm), then picking.
 */
export function ContactAcquisition({
  id,
  counter,
  codeId: carried,
  acquisition,
  disabled,
}: {
  id: Id<'contacts'>
  counter: number
  /** The code the contact's root carries now. */
  codeId: Id<'sourceCodes'> | undefined
  /** Its description, which may lag the root by a moment after a save. */
  acquisition: SourceCodeDescription | null
  disabled: boolean
}) {
  const tenant = useTenant()
  const convex = useConvex()
  const setAcquisition = useMutation(api.contacts.mutations.setAcquisition)
  const history = useHistoryHold(id)
  // The pick being saved, shown until the save has landed and the code's
  // description has caught up with the root: the page holds the last
  // description while the new one loads, and showing that would flip
  // new → old → new.
  // `savedAt` is the counter the save left on the root, once it landed.
  const [pending, setPending] = useState<{
    shown: ShownCode | null
    savedAt: number | null
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const caughtUp = (acquisition?.versionId ?? null) === (carried ?? null)
  const settled =
    pending?.savedAt != null && counter >= pending.savedAt && caughtUp
  useEffect(() => {
    if (settled) setPending(null)
  }, [settled])

  async function save(
    codeId: Id<'sourceCodes'> | null,
    shown: ShownCode | null,
  ) {
    setError(null)
    setPending({ shown, savedAt: null })
    // The page reads the new code's description by its id once the root
    // carries it: subscribe now, so it is there when the save lands.
    if (codeId) {
      convex.prewarmQuery({
        query: api.contacts.queries.getAcquisition,
        args: { tenantId: tenant._id, codeId },
      })
    }
    // No history fetch may be subscribed when the save commits (see
    // ContactForm's save).
    history.hold()
    try {
      const result = await setAcquisition({
        tenantId: tenant._id,
        id,
        expected: counter,
        codeId,
      })
      // An unchanged code bumps nothing: there is nothing to wait for.
      setPending(
        result.counter === counter ? null : { shown, savedAt: result.counter },
      )
    } catch (err) {
      setError(failure(err))
      setPending(null)
    } finally {
      history.release()
    }
  }

  const showPending = pending !== null && !settled
  const shown = showPending ? pending.shown : acquisition
  return (
    <section>
      <h2 className="mb-3 text-lg font-medium">Source code</h2>
      <p className="mb-2 text-xs text-neutral-500">How they were recruited.</p>
      <SourceCodePicker
        value={shown}
        pending={showPending}
        disabled={disabled || showPending}
        onPick={(entry) =>
          void save(entry.versionId, {
            code: entry.code,
            isActive: true,
            startDate: entry.startDate,
            endDate: entry.endDate,
          })
        }
        onClear={() => void save(null, null)}
        confirmClear={{
          title: "Remove this contact's source code?",
          description:
            'It records how they were recruited and is used in reports.',
        }}
      />
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {error}
        </p>
      )}
    </section>
  )
}
